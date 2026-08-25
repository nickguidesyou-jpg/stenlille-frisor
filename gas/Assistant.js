/**
 * Stenlille Herrefrisør — AI-booking på en gratis model.
 *
 * Bruger Google Gemini, som har et gratis niveau: API-nøgle hentes på
 * https://aistudio.google.com/apikey uden betalingskort. Nøglen sættes som
 * GEMINI_KEY i Script Properties. Uden den er assistenten slået fra, og
 * chatten henviser til den almindelige bookingknap.
 *
 * PERSONOPLYSNINGER SENDES ALDRIG TIL MODELLEN.
 * Gratis niveauer hos alle udbydere forbeholder sig typisk ret til at bruge
 * data til at forbedre deres modeller. Derfor håndterer assistenten kun
 * behandling, dag og tidspunkt. Navn, telefon og email indtastes bagefter
 * i et almindeligt felt og går direkte til createBooking — de kommer aldrig
 * forbi Google.
 *
 * Modellen bestemmer heller ikke hvad der er ledigt: ledige tider hentes af
 * getAvailability og sendes med ind, og selve bookingen sker først når
 * kunden trykker bekræft.
 *
 * Action:
 *   { action:'assistant', messages:[{role,content}], slots:[...] }
 *     → { reply, draft:{serviceIds,date,time}, ready }
 */

var AI_DAILY_LIMIT  = 400;   // maks. kald pr. døgn — siden er offentlig
var AI_MAX_MESSAGES = 20;
var AI_MAX_CHARS    = 300;
var AI_DEFAULT_MODEL = 'gemini-2.0-flash';

function aiKey_()   { return PropertiesService.getScriptProperties().getProperty('GEMINI_KEY'); }
function aiEnabled_() { return !!aiKey_(); }
function aiModel_() {
  // Gør modelnavnet til en indstilling, så et udgået modelnavn kan rettes uden kodeændring
  return PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || AI_DEFAULT_MODEL;
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
    return '- id ' + s.id + ': ' + s.name + ', ' + s.price + ' kr., ' + s.minutes + ' min.';
  }).join('\n');
  var now = new Date();
  var today = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  var todayName = DAYS_DA[Number(Utilities.formatDate(now, TZ, 'u')) % 7];

  return [
    'Du er bookingassistent for Stenlille Herrefrisør. Du svarer kort og venligt på dansk.',
    '',
    'BEHANDLINGER:',
    svc,
    '',
    'ÅBNINGSTIDER: mandag-fredag 10:10-18:00, lørdag 09:10-14:00, søndag lukket.',
    'I dag er det ' + todayName + ' den ' + today + '. Der kan bookes op til ' + HORIZON_DAYS + ' dage frem.',
    '',
    'DIN OPGAVE er at finde tre ting: hvilke behandlinger, hvilken dag og hvilket klokkeslæt.',
    '1. Behandlinger: ét id pr. person. To klipninger = [1,1]. Højst 5 personer.',
    '2. Dag: omsæt "på lørdag", "i morgen" og lignende til datoformatet ÅÅÅÅ-MM-DD.',
    '3. Klokkeslæt: når behandlinger og dag er på plads, får du en liste med LEDIGE TIDER.',
    '   Foreslå 2-3 af dem. Nævn ALDRIG et klokkeslæt der ikke står på listen.',
    '   Er listen tom, sig at dagen er optaget og foreslå en anden dag.',
    '',
    'DU MÅ IKKE spørge om navn, telefonnummer eller email. Det klarer systemet bagefter.',
    'Spørger kunden om priser, åbningstider eller hvor salonen ligger, svarer du kort og hjælper videre.',
    'Handler det om afbud, siger du at de skal skrive "jeg vil aflyse min tid".',
    'Stil ét spørgsmål ad gangen, og gentag ikke noget kunden allerede har sagt.',
    '',
    slots == null ? '' :
      (slots.length ? 'LEDIGE TIDER på den valgte dato: ' + slots.join(', ')
                    : 'LEDIGE TIDER på den valgte dato: ingen — dagen er optaget eller lukket.'),
    '',
    'Svar altid med JSON i præcis denne form:',
    '{"reply":"din besked til kunden","serviceIds":[1],"date":"ÅÅÅÅ-MM-DD eller null","time":"TT:MM eller null"}',
    'Felter du ikke kender endnu, skal være null eller en tom liste. Gæt aldrig.'
  ].join('\n');
}

function assistantTurn(req) {
  if (!aiEnabled_()) return { error: 'ai_off' };

  var msgs = Array.isArray(req.messages) ? req.messages : [];
  if (!msgs.length) return { error: 'ingen besked' };
  if (msgs.length > AI_MAX_MESSAGES)
    return { error: 'for_lang', reply: 'Samtalen er blevet lang — prøv knappen "Book tid online", eller ring på ' + SALON_PHONE + '.' };

  var contents = [];
  for (var i = 0; i < msgs.length; i++) {
    var text = String(msgs[i].content || '').slice(0, AI_MAX_CHARS);
    if (!text) continue;
    contents.push({ role: msgs[i].role === 'assistant' ? 'model' : 'user', parts: [{ text: text }] });
  }
  if (!contents.length || contents[contents.length - 1].role !== 'user') return { error: 'ingen besked' };

  if (!aiQuotaTake_())
    return { error: 'kvote', reply: 'Assistenten har nået dagens grænse. Book via knappen "Book tid online" — eller ring på ' + SALON_PHONE + '.' };

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
            encodeURIComponent(aiModel_()) + ':generateContent?key=' + encodeURIComponent(aiKey_());

  var res = UrlFetchApp.fetch(url, {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify({
      systemInstruction: { parts: [{ text: aiSystemPrompt_(req.slots) }] },
      contents: contents,
      generationConfig: { temperature: 0.2, maxOutputTokens: 500, responseMimeType: 'application/json' }
    }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() >= 300) {
    logBooking_([new Date(), '', '', 'AI-FEJL', '', '', '', '', res.getContentText().slice(0, 200), '', 'aifejl']);
    return { error: 'ai_fejl', reply: 'Jeg kan ikke tænke lige nu. Brug knappen "Book tid online", eller ring på ' + SALON_PHONE + '.' };
  }

  var out;
  try {
    var data = JSON.parse(res.getContentText());
    var text = ((((data.candidates || [])[0] || {}).content || {}).parts || [])
      .map(function (p) { return p.text || ''; }).join('').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    out = JSON.parse(text);
  } catch (e) {
    return { error: 'ai_svar', reply: 'Der gik kludder i den. Prøv at skrive det igen — eller brug "Book tid online".' };
  }
  return sanitiseDraft_(out);
}

/** Modellens svar er data, ikke sandhed — alt valideres før frontenden ser det. */
function sanitiseDraft_(out) {
  out = out || {};
  var ids = [];
  if (Array.isArray(out.serviceIds)) {
    for (var i = 0; i < out.serviceIds.length && ids.length < 5; i++) {
      if (svcById_(out.serviceIds[i])) ids.push(Number(out.serviceIds[i]));
    }
  }
  var draft = {
    serviceIds: ids,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(out.date || '')) ? out.date : null,
    time: /^\d{2}:\d{2}$/.test(String(out.time || '')) ? out.time : null
  };
  return {
    ok: true,
    reply: String(out.reply || '').slice(0, 800),
    draft: draft,
    ready: !!(draft.serviceIds.length && draft.date && draft.time)
  };
}
