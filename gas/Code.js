/**
 * Stenlille Herrefrisør — Booking-backend (Google Apps Script)
 *
 * API (fetch POST med Content-Type: text/plain for at undgå CORS-preflight):
 *   { action: 'getServices' }                          → { services: [...] }
 *   { action: 'getAvailability', date, serviceIds }    → { slots: ['10:10', ...], open: bool }
 *     (serviceIds: array — flere personer bookes i forlængelse af hinanden;
 *      serviceId (ental) understøttes stadig)
 *   { action: 'createBooking', persons: [{serviceId, name}], date, time, name, phone, email?, note? }
 *                                                      → { ok, bookingId, cancelToken, schedule }
 *   { action: 'cancelBooking', bookingId, cancelToken }→ { ok }  (bookingId kan være kommasepareret)
 *
 * Script Properties:
 *   CALENDAR_ID   — id på den dedikerede booking-kalender (oprettes af setup())
 *   BARBER_EMAIL  — frisørens email (modtager bekræftelser/afbud)
 *   SHEET_ID      — booking-log-regneark (oprettes automatisk)
 *   SITE_URL      — bruges til annullér-links i mails
 */

var TZ = 'Europe/Copenhagen';
var CAL_NAME = 'Stenlille Herrefrisør Booking';
var SLOT_STEP_MIN = 10;        // granularitet for ledige tider
var LEAD_TIME_MIN = 60;        // man kan tidligst booke 1 time frem
var HORIZON_DAYS = 28;         // hvor langt frem der kan bookes

// Ydelser — samme priser som salonens prisliste
var SERVICES = [
  { id: 1, name: 'Herreklipning',          desc: 'Klassisk klipning tilpasset dit hår og din stil. Inkl. vask og finish.', price: 250, minutes: 20 },
  { id: 2, name: 'Herreklipning + skæg',   desc: 'Komplet pakke med klipning og professionel skægtrimning.',               price: 400, minutes: 30 },
  { id: 3, name: 'Skægtrimning',           desc: 'Præcis trimning og formgivning af dit skæg.',                            price: 200, minutes: 15 },
  { id: 4, name: 'Dameklipning',           desc: 'Klipning af kort eller langt hår — eller bare spidserne.',               price: 250, minutes: 20 },
  { id: 5, name: 'Voks',                   desc: 'Fjernelse af hår — næse, ører og ansigt.',                               price: 50,  minutes: 10 },
  { id: 6, name: 'Maskinklipning',         desc: 'Hurtig og præcis maskinklipning — clean og frisk look. (Fade-klipning indgår som Herreklipning)', price: 150, minutes: 15 }
];

// Åbningstider (0 = søndag … 6 = lørdag). null = lukket.
var HOURS = {
  0: null,
  1: { open: '10:10', close: '18:00' },
  2: { open: '10:10', close: '18:00' },
  3: { open: '10:10', close: '18:00' },
  4: { open: '10:10', close: '18:00' },
  5: { open: '10:10', close: '18:00' },
  6: { open: '09:10', close: '14:00' }
};

/* ---------- Entry points ---------- */

function doGet() {
  return json_({ ok: true, ts: Date.now() });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ error: 'bad request' }); }

  try {
    switch (req.action) {
      case 'getServices':     return json_({ services: SERVICES });
      case 'getAvailability': return json_(getAvailability(req.date, req.serviceIds || req.serviceId));
      case 'createBooking':   return json_(createBooking(req));
      case 'cancelBooking':   return json_(cancelBooking(req.bookingId, req.cancelToken));
      default:                return json_({ error: 'unknown action' });
    }
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Kalender ---------- */

function getCalendar_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('CALENDAR_ID');
  if (id) {
    var cal = CalendarApp.getCalendarById(id);
    if (cal) return cal;
  }
  // Findes en kalender med navnet i forvejen?
  var existing = CalendarApp.getCalendarsByName(CAL_NAME);
  var cal2 = existing.length ? existing[0] : CalendarApp.createCalendar(CAL_NAME, { timeZone: TZ });
  props.setProperty('CALENDAR_ID', cal2.getId());
  return cal2;
}

/* ---------- Ledige tider ---------- */

var DAYS_DA = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
var MONTHS_DA = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];

function fmtWhen_(d) {
  // fx "torsdag d. 9. juli 2026 kl. 10:30" (Utilities.formatDate giver engelske navne)
  var p = Utilities.formatDate(d, TZ, 'u d M yyyy HH:mm').split(' ');
  return DAYS_DA[Number(p[0]) % 7] + ' d. ' + p[1] + '. ' + MONTHS_DA[Number(p[2]) - 1] + ' ' + p[3] + ' kl. ' + p[4];
}

function parseHM_(dateStr, hm) {
  // dateStr: 'YYYY-MM-DD', hm: 'HH:mm' → Date i salonens tidszone (håndterer sommertid)
  var probe = new Date(dateStr + 'T12:00:00Z');
  var z = Utilities.formatDate(probe, TZ, 'Z'); // fx '+0200'
  return new Date(dateStr + 'T' + hm + ':00' + z.slice(0, 3) + ':' + z.slice(3));
}

function svcById_(id) {
  return SERVICES.filter(function (s) { return s.id === Number(id); })[0];
}

function totalMinutes_(serviceIds) {
  // serviceIds: enkelt id eller array (flere personer efter hinanden)
  var ids = Array.isArray(serviceIds) ? serviceIds : [serviceIds];
  if (!ids.length || ids.length > 5) return null;
  var total = 0;
  for (var i = 0; i < ids.length; i++) {
    var svc = svcById_(ids[i]);
    if (!svc) return null;
    total += svc.minutes;
  }
  return total;
}

function getAvailability(dateStr, serviceIds) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return { error: 'ugyldig dato' };
  var minutes = totalMinutes_(serviceIds);
  if (minutes === null) return { error: 'ukendt ydelse' };

  var now = new Date();
  var dayStart = parseHM_(dateStr, '00:00');
  var maxDate = new Date(now.getTime() + HORIZON_DAYS * 86400000);
  if (dayStart > maxDate) return { open: false, slots: [] };

  var dow = Number(Utilities.formatDate(dayStart, TZ, 'u')) % 7; // 1=man..7=søn → 0=søn
  var hours = HOURS[dow];
  if (!hours) return { open: false, slots: [] };

  var openT = parseHM_(dateStr, hours.open);
  var closeT = parseHM_(dateStr, hours.close);
  var earliest = new Date(now.getTime() + LEAD_TIME_MIN * 60000);

  var busy = getCalendar_().getEvents(openT, closeT).map(function (ev) {
    return { s: ev.getStartTime().getTime(), e: ev.getEndTime().getTime() };
  });

  var slots = [];
  for (var t = openT.getTime(); t + minutes * 60000 <= closeT.getTime(); t += SLOT_STEP_MIN * 60000) {
    if (t < earliest.getTime()) continue;
    var end = t + minutes * 60000;
    var conflict = busy.some(function (b) { return t < b.e && end > b.s; });
    if (!conflict) slots.push(Utilities.formatDate(new Date(t), TZ, 'HH:mm'));
  }
  return { open: true, slots: slots };
}

/* ---------- Opret booking ---------- */

function createBooking(req) {
  var name = String(req.name || '').trim();
  var phone = String(req.phone || '').trim();
  var email = String(req.email || '').trim();
  var note = String(req.note || '').trim();
  if (!name || !phone) return { error: 'navn og telefon er påkrævet' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.date)) || !/^\d{2}:\d{2}$/.test(String(req.time)))
    return { error: 'ugyldig dato/tid' };

  // Personer: array [{serviceId, name}] — eller gammelt format med ét serviceId
  var rawPersons = Array.isArray(req.persons) && req.persons.length
    ? req.persons : [{ serviceId: req.serviceId, name: name }];
  if (rawPersons.length > 5) return { error: 'højst 5 personer pr. booking' };
  var persons = [];
  for (var i = 0; i < rawPersons.length; i++) {
    var svc = svcById_(rawPersons[i].serviceId);
    if (!svc) return { error: 'ukendt ydelse' };
    var pName = String(rawPersons[i].name || '').trim() || (i === 0 ? name : 'Person ' + (i + 1));
    persons.push({ svc: svc, name: pName });
  }
  var totalMin = persons.reduce(function (a, p) { return a + p.svc.minutes; }, 0);

  // Hele blokken skal stadig være ledig (race-guard)
  var avail = getAvailability(req.date, persons.map(function (p) { return p.svc.id; }));
  if (!avail.slots || avail.slots.indexOf(req.time) === -1)
    return { error: 'taken', message: 'Tiden er desværre lige blevet optaget — vælg en anden.' };

  var blockStart = parseHM_(req.date, req.time);
  var blockEnd = new Date(blockStart.getTime() + totalMin * 60000);
  var token = Utilities.getUuid();
  var groupNote = persons.length > 1 ? ' (gruppe: ' + persons.length + ' personer)' : '';

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var events = [];
  try {
    // Dobbelt-tjek under lås
    var clash = getCalendar_().getEvents(blockStart, blockEnd);
    if (clash.length) return { error: 'taken', message: 'Tiden er desværre lige blevet optaget — vælg en anden.' };
    var t = blockStart.getTime();
    for (var j = 0; j < persons.length; j++) {
      var p = persons[j];
      var s = new Date(t), e = new Date(t + p.svc.minutes * 60000);
      events.push(getCalendar_().createEvent(
        '✂️ ' + p.svc.name + ' — ' + p.name + groupNote,
        s, e,
        { description:
            'Kunde: ' + p.name + '\nBooket af: ' + name + '\nTelefon: ' + phone +
            (email ? '\nEmail: ' + email : '') +
            (note ? '\nBemærkning: ' + note : '') +
            '\nPris: ' + p.svc.price + ' kr.' +
            '\n[token:' + token + ']' }
      ));
      t = e.getTime();
    }
  } finally {
    lock.releaseLock();
  }

  var schedule = [];
  var t2 = blockStart.getTime();
  for (var k = 0; k < persons.length; k++) {
    schedule.push({ name: persons[k].name, service: persons[k].svc.name,
      time: Utilities.formatDate(new Date(t2), TZ, 'HH:mm'), price: persons[k].svc.price });
    logBooking_([new Date(), req.date, schedule[k].time, persons[k].svc.name, persons[k].svc.price,
      persons[k].name, phone, email, note, events[k].getId(), 'booket']);
    t2 += persons[k].svc.minutes * 60000;
  }

  var ids = events.map(function (ev) { return ev.getId(); }).join(',');
  sendMails_(persons, schedule, req.date, req.time, name, phone, email, note, ids, token);

  return { ok: true, bookingId: ids, cancelToken: token, schedule: schedule };
}

/* ---------- Annullér ---------- */

function cancelBooking(bookingId, cancelToken) {
  if (!bookingId || !cancelToken) return { error: 'mangler id/token' };
  var ids = String(bookingId).split(',');
  var cancelled = [];
  for (var i = 0; i < ids.length; i++) {
    var ev = getCalendar_().getEventById(ids[i]);
    if (!ev) continue; // allerede annulleret
    if ((ev.getDescription() || '').indexOf('[token:' + cancelToken + ']') === -1)
      return { error: 'ugyldigt annullérings-link' };
    if (ev.getStartTime() < new Date()) return { error: 'Tiden er allerede passeret.' };
    var title = ev.getTitle();
    var when = fmtWhen_(ev.getStartTime());
    ev.deleteEvent();
    cancelled.push(title + ' (' + when + ')');
    logBooking_([new Date(), '', '', '', '', '', '', '', 'ANNULLERET: ' + title + ' (' + when + ')', ids[i], 'annulleret']);
  }
  if (!cancelled.length) return { error: 'Bookingen findes ikke — måske er den allerede annulleret.' };

  var barber = PropertiesService.getScriptProperties().getProperty('BARBER_EMAIL');
  if (barber) {
    MailApp.sendEmail(barber, 'Afbud: ' + cancelled[0],
      'Kunden har annulleret:\n\n' + cancelled.join('\n') +
      '\n\nTiden er fjernet fra kalenderen og kan bookes af andre.');
  }
  return { ok: true };
}

/* ---------- Mails ---------- */

function sendMails_(persons, schedule, dateStr, time, name, phone, email, note, bookingIds, token) {
  var props = PropertiesService.getScriptProperties();
  var barber = props.getProperty('BARBER_EMAIL');
  var site = props.getProperty('SITE_URL') || 'https://stenlilleherrefrisor.dk';
  var when = fmtWhen_(parseHM_(dateStr, time));
  var cancelUrl = site + '/?annuller=' + encodeURIComponent(bookingIds) + '&t=' + encodeURIComponent(token);
  var totalPrice = schedule.reduce(function (a, s) { return a + s.price; }, 0);
  var multi = schedule.length > 1;

  var rowsHtml = schedule.map(function (s) {
    return '<tr><td style="padding:4px 12px 4px 0;color:#777">kl. ' + s.time + '</td>' +
      '<td><b>' + esc_(s.service) + '</b>' + (multi ? ' — ' + esc_(s.name) : '') +
      ' <span style="color:#777">(' + s.price + ' kr.)</span></td></tr>';
  }).join('');
  var rowsText = schedule.map(function (s) {
    return 'kl. ' + s.time + '  ' + s.service + (multi ? ' — ' + s.name : '') + '  (' + s.price + ' kr.)';
  }).join('\n');

  if (email) {
    MailApp.sendEmail({
      to: email,
      subject: (multi ? 'Jeres tider' : 'Din tid') + ' hos Stenlille Herrefrisør er bekræftet ✂️',
      htmlBody:
        '<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#1d1a14">' +
        '<h2 style="color:#b8973a;border-bottom:2px solid #b8973a;padding-bottom:8px">Stenlille Herrefrisør</h2>' +
        '<p>Hej ' + esc_(name) + ',</p>' +
        '<p>' + (multi ? 'Jeres tider er bekræftet — I bookes i forlængelse af hinanden' : 'Din tid er bekræftet') + ':</p>' +
        '<p><b>' + when + '</b></p>' +
        '<table style="border-collapse:collapse">' + rowsHtml +
        '<tr><td style="padding:4px 12px 4px 0;color:#777">I alt</td><td><b>' + totalPrice + ' kr.</b> (betales i salonen)</td></tr>' +
        '<tr><td style="padding:4px 12px 4px 0;color:#777">Adresse</td><td>Hovedgaden 54, 4295 Stenlille</td></tr>' +
        '</table>' +
        (note ? '<p style="color:#777">Din bemærkning: ' + esc_(note) + '</p>' : '') +
        '<p>Bliver ' + (multi ? 'I' : 'du') + ' forhindret? <a href="' + cancelUrl + '" style="color:#b8973a">Annullér ' +
        (multi ? 'tiderne' : 'din tid') + ' her</a> — så kan andre få dem.</p>' +
        '<p style="color:#999;font-size:13px;margin-top:24px">Vi glæder os til at se ' + (multi ? 'jer' : 'dig') + '!<br>' +
        'Stenlille Herrefrisør · Hovedgaden 54, 4295 Stenlille · +45 42 94 55 67</p>' +
        '</div>'
    });
  }

  if (barber) {
    MailApp.sendEmail(barber,
      'Ny booking' + (multi ? ' (' + schedule.length + ' personer)' : '') + ': ' + name + ' — ' + when,
      'Ny online booking:\n\n' + when + '\n' + rowsText + '\nI alt: ' + totalPrice + ' kr.\n\n' +
      'Booket af: ' + name + '\n' +
      'Telefon: ' + phone + '\n' +
      (email ? 'Email: ' + email + '\n' : '') +
      (note ? 'Bemærkning: ' + note + '\n' : '') +
      '\nTiderne ligger i kalenderen "' + CAL_NAME + '".');
  }
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------- Booking-log (Sheet) ---------- */

function logBooking_(row) {
  try {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty('SHEET_ID');
    var ss;
    if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
    if (!ss) {
      ss = SpreadsheetApp.create('Stenlille Herrefrisør — Bookinger');
      ss.getActiveSheet().appendRow(['Oprettet', 'Dato', 'Tid', 'Behandling', 'Pris', 'Navn', 'Telefon', 'Email', 'Bemærkning', 'BookingId', 'Status']);
      props.setProperty('SHEET_ID', ss.getId());
    }
    ss.getSheets()[0].appendRow(row);
  } catch (e) { /* log må aldrig vælte en booking */ }
}

/* ---------- Engangs-opsætning ----------
 * Kør denne manuelt i editoren én gang: opretter kalender + log-ark
 * og udløser Googles scope-godkendelse (Kalender, Mail, Sheets).
 */
function setup() {
  var cal = getCalendar_();
  logBooking_([new Date(), '', '', 'SETUP', '', '', '', '', 'Backend initialiseret', '', 'setup']);
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('BARBER_EMAIL')) props.setProperty('BARBER_EMAIL', '');
  Logger.log('Kalender: ' + cal.getId());
  Logger.log('Husk at sætte BARBER_EMAIL i Script Properties, og del evt. kalenderen "' + CAL_NAME + '" med frisøren.');
}
