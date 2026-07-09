/**
 * Stenlille Herrefrisør — Booking-backend (Google Apps Script)
 *
 * API (fetch POST med Content-Type: text/plain for at undgå CORS-preflight):
 *   { action: 'getServices' }                          → { services: [...] }
 *   { action: 'getAvailability', date, serviceId }     → { slots: ['10:10', ...], open: bool }
 *   { action: 'createBooking', serviceId, date, time, name, phone, email?, note? }
 *                                                      → { ok, bookingId, cancelToken }
 *   { action: 'cancelBooking', bookingId, cancelToken }→ { ok }
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
      case 'getAvailability': return json_(getAvailability(req.date, req.serviceId));
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

function getAvailability(dateStr, serviceId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return { error: 'ugyldig dato' };
  var svc = SERVICES.filter(function (s) { return s.id === Number(serviceId); })[0];
  if (!svc) return { error: 'ukendt ydelse' };

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
  for (var t = openT.getTime(); t + svc.minutes * 60000 <= closeT.getTime(); t += SLOT_STEP_MIN * 60000) {
    if (t < earliest.getTime()) continue;
    var end = t + svc.minutes * 60000;
    var conflict = busy.some(function (b) { return t < b.e && end > b.s; });
    if (!conflict) slots.push(Utilities.formatDate(new Date(t), TZ, 'HH:mm'));
  }
  return { open: true, slots: slots };
}

/* ---------- Opret booking ---------- */

function createBooking(req) {
  var svc = SERVICES.filter(function (s) { return s.id === Number(req.serviceId); })[0];
  if (!svc) return { error: 'ukendt ydelse' };
  var name = String(req.name || '').trim();
  var phone = String(req.phone || '').trim();
  var email = String(req.email || '').trim();
  var note = String(req.note || '').trim();
  if (!name || !phone) return { error: 'navn og telefon er påkrævet' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.date)) || !/^\d{2}:\d{2}$/.test(String(req.time)))
    return { error: 'ugyldig dato/tid' };

  // Slottet skal stadig være ledigt (race-guard)
  var avail = getAvailability(req.date, svc.id);
  if (!avail.slots || avail.slots.indexOf(req.time) === -1)
    return { error: 'taken', message: 'Tiden er desværre lige blevet optaget — vælg en anden.' };

  var start = parseHM_(req.date, req.time);
  var end = new Date(start.getTime() + svc.minutes * 60000);
  var token = Utilities.getUuid();

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var ev;
  try {
    // Dobbelt-tjek under lås
    var clash = getCalendar_().getEvents(start, end);
    if (clash.length) return { error: 'taken', message: 'Tiden er desværre lige blevet optaget — vælg en anden.' };
    ev = getCalendar_().createEvent(
      '✂️ ' + svc.name + ' — ' + name,
      start, end,
      { description:
          'Kunde: ' + name + '\nTelefon: ' + phone +
          (email ? '\nEmail: ' + email : '') +
          (note ? '\nBemærkning: ' + note : '') +
          '\nPris: ' + svc.price + ' kr.' +
          '\n[token:' + token + ']' }
    );
  } finally {
    lock.releaseLock();
  }

  logBooking_([new Date(), req.date, req.time, svc.name, svc.price, name, phone, email, note, ev.getId(), 'booket']);
  sendMails_(svc, req.date, req.time, name, phone, email, note, ev.getId(), token);

  return { ok: true, bookingId: ev.getId(), cancelToken: token };
}

/* ---------- Annullér ---------- */

function cancelBooking(bookingId, cancelToken) {
  if (!bookingId || !cancelToken) return { error: 'mangler id/token' };
  var ev = getCalendar_().getEventById(bookingId);
  if (!ev) return { error: 'Bookingen findes ikke — måske er den allerede annulleret.' };
  if ((ev.getDescription() || '').indexOf('[token:' + cancelToken + ']') === -1)
    return { error: 'ugyldigt annullérings-link' };
  if (ev.getStartTime() < new Date()) return { error: 'Tiden er allerede passeret.' };

  var title = ev.getTitle();
  var when = fmtWhen_(ev.getStartTime());
  ev.deleteEvent();
  logBooking_([new Date(), '', '', '', '', '', '', '', 'ANNULLERET: ' + title + ' (' + when + ')', bookingId, 'annulleret']);

  var barber = PropertiesService.getScriptProperties().getProperty('BARBER_EMAIL');
  if (barber) {
    MailApp.sendEmail(barber, 'Afbud: ' + title,
      'Kunden har annulleret sin tid ' + when + '.\n\nTiden er fjernet fra kalenderen og kan bookes af andre.');
  }
  return { ok: true };
}

/* ---------- Mails ---------- */

function sendMails_(svc, dateStr, time, name, phone, email, note, bookingId, token) {
  var props = PropertiesService.getScriptProperties();
  var barber = props.getProperty('BARBER_EMAIL');
  var site = props.getProperty('SITE_URL') || 'https://stenlilleherrefrisor.dk';
  var start = parseHM_(dateStr, time);
  var when = fmtWhen_(start);
  var cancelUrl = site + '/?annuller=' + encodeURIComponent(bookingId) + '&t=' + encodeURIComponent(token);

  if (email) {
    MailApp.sendEmail({
      to: email,
      subject: 'Din tid hos Stenlille Herrefrisør er bekræftet ✂️',
      htmlBody:
        '<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#1d1a14">' +
        '<h2 style="color:#b8973a;border-bottom:2px solid #b8973a;padding-bottom:8px">Stenlille Herrefrisør</h2>' +
        '<p>Hej ' + esc_(name) + ',</p>' +
        '<p>Din tid er bekræftet:</p>' +
        '<table style="border-collapse:collapse">' +
        '<tr><td style="padding:4px 12px 4px 0;color:#777">Behandling</td><td><b>' + esc_(svc.name) + '</b></td></tr>' +
        '<tr><td style="padding:4px 12px 4px 0;color:#777">Tidspunkt</td><td><b>' + when + '</b></td></tr>' +
        '<tr><td style="padding:4px 12px 4px 0;color:#777">Varighed</td><td>' + svc.minutes + ' min.</td></tr>' +
        '<tr><td style="padding:4px 12px 4px 0;color:#777">Pris</td><td>' + svc.price + ' kr. (betales i salonen)</td></tr>' +
        '<tr><td style="padding:4px 12px 4px 0;color:#777">Adresse</td><td>Hovedgaden 54, 4295 Stenlille</td></tr>' +
        '</table>' +
        (note ? '<p style="color:#777">Din bemærkning: ' + esc_(note) + '</p>' : '') +
        '<p>Bliver du forhindret? <a href="' + cancelUrl + '" style="color:#b8973a">Annullér din tid her</a> — så kan en anden få den.</p>' +
        '<p style="color:#999;font-size:13px;margin-top:24px">Vi glæder os til at se dig!<br>Stenlille Herrefrisør · Hovedgaden 54, 4295 Stenlille · +45 42 94 55 67</p>' +
        '</div>'
    });
  }

  if (barber) {
    MailApp.sendEmail(barber, 'Ny booking: ' + svc.name + ' — ' + name + ' (' + when + ')',
      'Ny online booking:\n\n' +
      'Behandling: ' + svc.name + ' (' + svc.minutes + ' min, ' + svc.price + ' kr.)\n' +
      'Tidspunkt: ' + when + '\n' +
      'Kunde: ' + name + '\n' +
      'Telefon: ' + phone + '\n' +
      (email ? 'Email: ' + email + '\n' : '') +
      (note ? 'Bemærkning: ' + note + '\n' : '') +
      '\nTiden ligger i kalenderen "' + CAL_NAME + '".');
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
