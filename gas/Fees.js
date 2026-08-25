/**
 * Stenlille Herrefrisør — afbudsregler, gebyr og opslag af bookinger.
 *
 * Regel: afbud er gratis indtil FREE_CANCEL_HOURS timer før tiden.
 * Senere end det kan kunden ikke aflyse online — i stedet registreres et
 * gebyr, frisøren får besked, og kunden kan ikke booke igen før gebyret
 * er markeret betalt i arket "Gebyrer".
 *
 * Actions (routes fra doPost i Code.js):
 *   { action:'findBooking', phone }                    → { found, bookingId, cancelToken, when, what, hoursLeft } | { none:true }
 *   { action:'getBooking', bookingId, cancelToken }    → { found, when, what, hoursLeft, fee }
 *   { action:'cancelBooking', bookingId, cancelToken } → { ok } | { error:'too_late', fee, ... }
 */

var FREE_CANCEL_HOURS = 2;          // gratis afbud indtil 2 timer før
var MOBILEPAY_NUMBER  = '868311';   // frisørens MobilePay-boks
var SALON_PHONE       = '42 94 55 67';

/* Gebyr pr. behandling ved afbud senere end FREE_CANCEL_HOURS.
 * Frisørens egne tal: Herreklipning 100 kr., Herreklipning + skæg 200 kr.
 * De øvrige fire har han ikke nævnt — de står til min(pris, 100).
 * Vil han have andre beløb, er det kun denne linje der skal rettes. */
var LATE_FEE = { 1: 100, 2: 200, 3: 100, 4: 100, 5: 50, 6: 100 };

var FEE_SHEET = 'Gebyrer';
var FEE_HEADERS = ['Oprettet', 'Navn', 'Telefon', 'Behandling', 'Tidspunkt', 'Gebyr kr.', 'Betalt', 'BookingId'];

/* ---------- Små hjælpere ---------- */

function normPhone_(phone) {
  var d = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (d.length === 10 && d.indexOf('45') === 0) d = d.slice(2); // +45 12345678
  return d;
}

function descField_(desc, label) {
  var m = String(desc || '').match(new RegExp(label + ':\\s*([^\\n]*)'));
  return m ? m[1].trim() : '';
}

function svcFromEvent_(ev) {
  var desc = ev.getDescription() || '';
  var m = desc.match(/\[svc:(\d+)\]/);
  if (m) { var s = svcById_(m[1]); if (s) return s; }
  // Ældre bookinger uden [svc:]-mærke: match på titlen
  var title = ev.getTitle();
  for (var i = 0; i < SERVICES.length; i++) {
    if (title.indexOf(SERVICES[i].name) !== -1) return SERVICES[i];
  }
  return null;
}

function feeForService_(svc) {
  if (!svc) return 100;
  var f = LATE_FEE[svc.id];
  return f == null ? Math.min(svc.price, 100) : f;
}

function feeForEvent_(ev) {
  return feeForService_(svcFromEvent_(ev));
}

/** Samlet gebyr for en booking under oprettelse — bruges i bekræftelsesmailen. */
function feeText_(persons) {
  var total = 0;
  for (var i = 0; i < persons.length; i++) total += feeForService_(persons[i].svc);
  return total + ' kr.';
}

/* ---------- Gebyr-ark ---------- */

function feeSheet_() {
  var ss = bookingSpreadsheet_();
  var sh = ss.getSheetByName(FEE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(FEE_SHEET);
    sh.appendRow(FEE_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Samlet ubetalt gebyr for et telefonnummer, eller null. */
function unpaidFeeFor_(phone) {
  var p = normPhone_(phone);
  if (p.length < 8) return null;
  try {
    var vals = feeSheet_().getDataRange().getValues();
    var total = 0;
    for (var i = 1; i < vals.length; i++) {
      if (normPhone_(vals[i][2]) !== p) continue;
      if (String(vals[i][6]).trim().toLowerCase() === 'ja') continue;
      total += Number(vals[i][5]) || 0;
    }
    return total > 0 ? { amount: total } : null;
  } catch (e) {
    return null; // et utilgængeligt ark må aldrig blokere en booking
  }
}

function addFee_(rec) {
  try {
    feeSheet_().appendRow([new Date(), rec.name, "'" + rec.phone, rec.service,
      rec.when, rec.amount, 'nej', rec.bookingId]);
  } catch (e) { /* gebyr-log må ikke vælte svaret til kunden */ }
}

/**
 * Marker et telefonnummers gebyrer som betalt. Kør manuelt i editoren:
 *   markPaid('42945567')
 * Frisøren kan også bare skrive "ja" i Betalt-kolonnen i arket.
 */
function markPaid(phone) {
  var p = normPhone_(phone);
  var sh = feeSheet_();
  var vals = sh.getDataRange().getValues();
  var n = 0;
  for (var i = 1; i < vals.length; i++) {
    if (normPhone_(vals[i][2]) !== p) continue;
    if (String(vals[i][6]).trim().toLowerCase() === 'ja') continue;
    sh.getRange(i + 1, 7).setValue('ja');
    n++;
  }
  Logger.log(n ? (n + ' gebyr(er) markeret betalt for ' + p) : 'Ingen ubetalte gebyrer for ' + p);
  return n;
}

/* ---------- Opslag ---------- */

function eventsForToken_(ids, token) {
  var cal = getCalendar_();
  var evs = [];
  for (var i = 0; i < ids.length; i++) {
    var ev = null;
    try { ev = cal.getEventById(ids[i]); } catch (e) { ev = null; }
    if (!ev) continue;
    if ((ev.getDescription() || '').indexOf('[token:' + token + ']') === -1) return null; // forkert token
    evs.push(ev);
  }
  return evs;
}

function summarise_(evs) {
  var start = null, titles = [], fee = 0;
  for (var i = 0; i < evs.length; i++) {
    var s = evs[i].getStartTime();
    if (!start || s < start) start = s;
    titles.push(evs[i].getTitle().replace(/^✂️\s*/, '').split(' — ')[0]);
    fee += feeForEvent_(evs[i]);
  }
  return { start: start, what: titles.join(' + '), fee: fee };
}

function getBooking(bookingId, cancelToken) {
  if (!bookingId || !cancelToken) return { error: 'mangler id/token' };
  var evs = eventsForToken_(String(bookingId).split(','), cancelToken);
  if (evs === null) return { error: 'ugyldigt link' };
  if (!evs.length) return { none: true };
  var s = summarise_(evs);
  var hours = (s.start.getTime() - Date.now()) / 3600000;
  return { found: true, bookingId: bookingId, cancelToken: cancelToken,
    when: fmtWhen_(s.start), what: s.what, fee: s.fee,
    hoursLeft: Math.round(hours * 10) / 10, tooLate: hours < FREE_CANCEL_HOURS };
}

/** Slår kundens førstkommende booking op ud fra telefonnummeret. */
function findBookingByPhone(phone) {
  var p = normPhone_(phone);
  if (p.length < 8) return { error: 'Skriv dit 8-cifrede telefonnummer.' };
  var now = new Date();
  var evs = getCalendar_().getEvents(now, new Date(now.getTime() + HORIZON_DAYS * 86400000));
  var token = null, ids = [];
  for (var i = 0; i < evs.length; i++) {
    var desc = evs[i].getDescription() || '';
    if (normPhone_(descField_(desc, 'Telefon')) !== p) continue;
    if (desc.indexOf('[gebyr:') !== -1) continue; // allerede registreret som sent afbud
    var m = desc.match(/\[token:([^\]]+)\]/);
    if (!m) continue;
    if (!token) token = m[1];
    if (m[1] !== token) continue;                 // kun den førstkommende booking
    ids.push(evs[i].getId());
  }
  if (!token) return { none: true };
  return getBooking(ids.join(','), token);
}

/* ---------- Annullér ---------- */

function cancelBooking(bookingId, cancelToken) {
  if (!bookingId || !cancelToken) return { error: 'mangler id/token' };
  var evs = eventsForToken_(String(bookingId).split(','), cancelToken);
  if (evs === null) return { error: 'ugyldigt annullérings-link' };
  if (!evs.length) return { error: 'Bookingen findes ikke — måske er den allerede annulleret.' };

  var s = summarise_(evs);
  if (s.start < new Date()) return { error: 'Tiden er allerede passeret.' };

  var hoursLeft = (s.start.getTime() - Date.now()) / 3600000;
  if (hoursLeft < FREE_CANCEL_HOURS) return registerLateCancel_(evs, s);

  var when = fmtWhen_(s.start);
  var cancelled = [];
  for (var i = 0; i < evs.length; i++) {
    cancelled.push(evs[i].getTitle());
    evs[i].deleteEvent();
  }
  logBooking_([new Date(), '', '', s.what, '', '', '', '',
    'ANNULLERET i god tid (' + when + ')', bookingId, 'annulleret']);

  var barber = PropertiesService.getScriptProperties().getProperty('BARBER_EMAIL');
  if (barber) {
    try {
      MailApp.sendEmail(barber, 'Afbud: ' + cancelled[0],
        'Kunden har annulleret i god tid:\n\n' + cancelled.join('\n') + '\n' + when +
        '\n\nTiden er fjernet fra kalenderen og kan bookes af andre.');
    } catch (e) { /* afbuddet er gennemført — mailfejl må ikke rulle det tilbage */ }
  }
  return { ok: true, when: when };
}

/**
 * Sent afbud: tiden bliver IKKE slettet (kunden må ikke aflyse så sent),
 * men den markeres i kalenderen, gebyret registreres, og frisøren får besked
 * med det samme, så han selv kan frigive tiden hvis han vil.
 */
function registerLateCancel_(evs, s) {
  var when = fmtWhen_(s.start);
  var already = (evs[0].getDescription() || '').indexOf('[gebyr:') !== -1;
  var name = descField_(evs[0].getDescription(), 'Booket af') || descField_(evs[0].getDescription(), 'Kunde');
  var phone = descField_(evs[0].getDescription(), 'Telefon');

  if (!already) {
    for (var i = 0; i < evs.length; i++) {
      var d = evs[i].getDescription() || '';
      try {
        evs[i].setTitle('⚠️ SENT AFBUD — ' + evs[i].getTitle());
        evs[i].setDescription(d + '\nSENT AFBUD meldt ' + fmtWhen_(new Date()) +
          '\nGebyr: ' + s.fee + ' kr. — MobilePay ' + MOBILEPAY_NUMBER + '\n[gebyr:' + s.fee + ']');
      } catch (e) { /* markering er kosmetik — gebyret registreres uanset */ }
    }
    addFee_({ name: name, phone: normPhone_(phone), service: s.what,
      when: when, amount: s.fee, bookingId: evs.map(function (e) { return e.getId(); }).join(',') });
    logBooking_([new Date(), '', '', s.what, s.fee, name, phone, '',
      'SENT AFBUD — gebyr ' + s.fee + ' kr. (' + when + ')', '', 'sent afbud']);

    var barber = PropertiesService.getScriptProperties().getProperty('BARBER_EMAIL');
    if (barber) {
      try {
        MailApp.sendEmail(barber, '⚠️ Sent afbud: ' + name + ' — ' + when,
          name + ' (' + phone + ') har meldt afbud mindre end ' + FREE_CANCEL_HOURS + ' timer før.\n\n' +
          s.what + '\n' + when + '\n\n' +
          'Gebyr: ' + s.fee + ' kr. via MobilePay ' + MOBILEPAY_NUMBER + '\n' +
          'Kunden kan ikke booke igen før gebyret er markeret betalt.\n\n' +
          'Når pengene er modtaget: åbn regnearket, fanen "' + FEE_SHEET + '",\n' +
          'og skriv "ja" i Betalt-kolonnen ud for linjen.\n\n' +
          'Tiden står stadig i kalenderen (markeret SENT AFBUD) — slet den selv,\n' +
          'hvis du vil kunne sælge den til en anden.');
      } catch (e) { /* mailfejl må ikke skjule svaret for kunden */ }
    }
  }

  return { error: 'too_late', tooLate: true, fee: s.fee, mobilepay: MOBILEPAY_NUMBER,
    when: when, what: s.what, hours: FREE_CANCEL_HOURS, salonPhone: SALON_PHONE };
}
