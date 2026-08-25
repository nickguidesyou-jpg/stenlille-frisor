/**
 * Stenlille Herrefrisør — AI-booking.
 *
 * Kunden skriver i fritekst ("jeg vil gerne booke to klipninger på lørdag"),
 * og modellen oversætter det til et bookingudkast. Den stiller selv de
 * spørgsmål der mangler svar på.
 *
 * Ansvarsfordeling — vigtig:
 *   Modellen håndterer SPROG. Den bestemmer aldrig hvad der er ledigt, og
 *   den opretter aldrig noget. Ledige tider kommer fra getAvailability, og
 *   selve bookingen sker gennem createBooking efter at kunden har trykket
 *   på en rigtig bekræft-knap. Finder modellen på en tid der ikke findes,
 *   bliver den afvist af den almindelige race-guard som alle andre.
 *
 * Siden er offentlig, så alle kald koster ejeren penge. Derfor: daglig
 * kvote, loft over samtalelængde, korte svar og en billig model.
 * Uden ANTHROPIC_KEY i Script Properties er hele funktionen slået fra.
 *
 * Action:
 *   { action:'assistant', messages:[{role,content}], slots:[...] }
 *     → { reply, draft:{serviceIds,date,time,name,phone,email}, ready }
 */

var AI_MODEL        = 'claude-haiku-4-5-20251001';
var AI_DAILY_LIMIT  = 250;   // maks. kald pr. døgn på tværs af alle besøgende
var AI_MAX_MESSAGES = 24;    // en booking skal aldrig kræve flere end det
var AI_MAX_CHARS    = 400;   // pr. kundebesked

function aiEnabled_() {
  return !!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY');
}

function aiQuotaTake_() {
  var props = PropertiesService.getScriptProperties();
  var key = 'AI_CALLS_' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var used = parseInt(props.getProperty(key) || '0', 10);
  if (used >= AI_DAILY_LIMIT) return false;
  props.setProperty(key, String(used + 1));
  return true;
}

function aiSystemPrompt_(slots) {
  var svc = SERVICES.map(function (s) {
    var fee = feeForService_(s);
    return '- id ' + s.id + ': ' + s.name + ', ' + s.price + ' kr., ' + s.minutes + ' min.' +
      (fee ? ' (afbudsgebyr ' + fee + ' kr.)' : ' (fritaget for afbudsgebyr)');
  }).join('\n');

  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var todayName = DAYS_DA[Number(Utilities.formatDate(new Date(), TZ, 'u')) % 7];

  return [
    'Du er bookingassistent for Stenlille Herrefrisør, Hovedgaden 54, 4295 Stenlille.',
    'Du skriver kort, venligt og på dansk. Du dur ikke til smalltalk — du hjælper med at booke tid.',
    '',
    'BEHANDLINGER:',
    svc,
    '',
    'ÅBNINGSTIDER: mandag-fredag 10:10-18:00, lørdag 09:10-14:00, søndag lukket.',
    'I DAG er det ' + todayName + ' den ' + today + '. Der kan bookes op til ' + HORIZON_DAYS + ' dage frem.',
    '',
    'AFBUDSREGLER: gratis afbud indtil ' + FREE_CANCEL_HOURS + ' timer før. Senere afbud koster',
    'gebyret for behandlingen på MobilePay ' + MOBILEPAY_NUMBER + ', og kunden kan ikke booke igen før det er betalt.',
    'Voks er fritaget. Nævn kun reglerne hvis kunden spørger — de står alligevel til godkendelse før bekræftelse.',
    '',
    'SÅDAN ARBEJDER DU:',
    '1. Find ud af hvilke behandlinger og hvor mange personer. Flere personer bookes i forlængelse af hinanden, højst 5.',
    '2. Find ud af hvilken dag. Omsæt "på lørdag", "i morgen" osv. til en dato i formatet YYYY-MM-DD.',
    '3. Når du kender behandlinger og dato, får du en liste med LEDIGE TIDER. Foreslå 2-3 af dem.',
    '   Du må ALDRIG nævne et klokkeslæt der ikke står på listen. Er listen tom, foreslå en anden dag.',
    '4. Bed derefter om navn, telefonnummer og email. Alle tre er påkrævet.',
    '5. Når alt er udfyldt, sætter du ready til true og skriver en kort opsummering.',
    '',
    'Stil ét spørgsmål ad gangen. Gentag ikke noget kunden allerede har oplyst.',
    slots && slots.length ? '\nLEDIGE TIDER på den valgte dato: ' + slots.join(', ')
      : (slots ? '\nLEDIGE TIDER på den valgte dato: ingen — dagen er optaget eller lukket.' : ''),
    '',
    'Svar KUN med JSON i præcis denne form, uden markdown og uden tekst udenom:',
    '{"reply":"din besked til kunden","draft":{"serviceIds":[1],"date":"YYYY-MM-DD eller null",' +
      '"time":"HH:MM eller null","name":"","phone":"","email":""},"ready":false}',
    'serviceIds er ét id pr. person. To klipninger = [1,1].',
    'Felter du endnu ikke kender, skal være null eller tom streng — gæt aldrig.'
  ].join('\n');
}

function assistantTurn(req) {
  if (!aiEnabled_()) return { error: 'ai_off' };

  var msgs = Array.isArray(req.messages) ? req.messages : [];
  if (!msgs.length) return { error: 'ingen besked' };
  if (msgs.length > AI_MAX_MESSAGES)
    return { error: 'for_lang', reply: 'Samtalen er blevet lang — ring til os på ' + SALON_PHONE + ', så finder vi en tid.' };

  // Normalisér og beskær: modellen skal aldrig se andet end korte kunde-/assistentbeskeder
  var clean = [];
  for (var i = 0; i < msgs.length; i++) {
    var role = msgs[i].role === 'assistant' ? 'assistant' : 'user';
    var content = String(msgs[i].content || '').slice(0, AI_MAX_CHARS);
    if (content) clean.push({ role: role, content: content });
  }
  if (!clean.length || clean[clean.length - 1].role !== 'user') return { error: 'ingen besked' };

  if (!aiQuotaTake_())
    return { error: 'kvote', reply: 'Assistenten har travlt lige nu. Book i stedet via knappen "Book tid online" — eller ring på ' + SALON_PHONE + '.' };

  var body = {
    model: AI_MODEL,
    max_tokens: 700,
    system: aiSystemPrompt_(req.slots),
    messages: clean
  };

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    contentType: 'application/json',
    headers: {
      'x-api-key': PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY'),
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() >= 300) {
    logBooking_([new Date(), '', '', 'AI-FEJL', '', '', '', '', res.getContentText().slice(0, 200), '', 'aifejl']);
    return { error: 'ai_fejl', reply: 'Jeg kan ikke tænke lige nu. Brug knappen "Book tid online", eller ring på ' + SALON_PHONE + '.' };
  }

  var out;
  try {
    var data = JSON.parse(res.getContentText());
    var text = (data.content || []).map(function (c) { return c.text || ''; }).join('').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    out = JSON.parse(text);
  } catch (e) {
    return { error: 'ai_svar', reply: 'Der gik kludder i den. Prøv at skrive det igen — eller brug "Book tid online".' };
  }

  return sanitiseDraft_(out);
}

/** Modellens output er data, ikke sandhed — alt valideres før frontenden ser det. */
function sanitiseDraft_(out) {
  var d = (out && out.draft) || {};
  var ids = [];
  if (Array.isArray(d.serviceIds)) {
    for (var i = 0; i < d.serviceIds.length && ids.length < 5; i++) {
      if (svcById_(d.serviceIds[i])) ids.push(Number(d.serviceIds[i]));
    }
  }
  var date = /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) ? d.date : null;
  var time = /^\d{2}:\d{2}$/.test(String(d.time || '')) ? d.time : null;
  var email = String(d.email || '').trim();

  var draft = {
    serviceIds: ids,
    date: date,
    time: time,
    name: String(d.name || '').trim().slice(0, 80),
    phone: normPhone_(d.phone).slice(0, 12),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
  };

  // "ready" er kun sandt hvis alt reelt er der — modellen må ikke skynde på processen
  var ready = !!(draft.serviceIds.length && draft.date && draft.time &&
                 draft.name && draft.phone.length >= 8 && draft.email);

  return {
    ok: true,
    reply: String((out && out.reply) || '').slice(0, 900),
    draft: draft,
    ready: ready
  };
}
