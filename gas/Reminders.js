/**
 * Stenlille Herrefrisør — påmindelser før kundens tid.
 *
 * En tidsstyret trigger kører hvert 15. minut og sender en påmindelse til
 * kunder hvis tid ligger ca. REMINDER_HOURS timer ude i fremtiden. Hver
 * booking mærkes med [mindet] i kalenderbeskrivelsen, så ingen får to.
 *
 * Email er gratis. SMS koster penge hos alle danske udbydere, så SMS sendes
 * kun hvis SMS_TOKEN er sat i Script Properties — ellers springes det over
 * uden fejl, og kunden får bare mailen.
 *
 * Kør setupTriggers() én gang i editoren for at starte påmindelserne.
 */

var REMINDER_HOURS = 3;         // så tæt på tiden får kunden besked
var REMINDER_SPAN_MIN = 20;     // vindue der er lidt bredere end trigger-intervallet

function setupTriggers() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('sendReminders').timeBased().everyMinutes(15).create();
  Logger.log('Påmindelser aktiveret: sendReminders kører hvert 15. minut og varsler ' +
    REMINDER_HOURS + ' timer før kundens tid.');
}

function sendReminders() {
  var now = new Date();
  var from = new Date(now.getTime() + (REMINDER_HOURS * 60 - REMINDER_SPAN_MIN) * 60000);
  var to = new Date(now.getTime() + REMINDER_HOURS * 3600000);

  var evs = getCalendar_().getEvents(from, to);
  for (var i = 0; i < evs.length; i++) {
    var ev = evs[i];
    if (ev.getStartTime() < from) continue;            // rager kun ind i vinduet
    var desc = ev.getDescription() || '';
    if (desc.indexOf('[mindet]') !== -1) continue;     // allerede varslet
    if (desc.indexOf('[gebyr:') !== -1) continue;      // sent afbud — ingen påmindelse

    var name = descField_(desc, 'Kunde') || descField_(desc, 'Booket af') || 'du';
    var email = descField_(desc, 'Email');
    var phone = descField_(desc, 'Telefon');
    var token = (desc.match(/\[token:([^\]]+)\]/) || [])[1] || '';
    var what = ev.getTitle().replace(/^✂️\s*/, '').split(' — ')[0];
    var time = Utilities.formatDate(ev.getStartTime(), TZ, 'HH:mm');

    try { remindByEmail_(email, name, what, time, ev.getId(), token); } catch (e) { /* fortsæt */ }
    try { sendSms_(phone, 'Stenlille Herrefrisør: husk din tid i dag kl. ' + time +
      ' (' + what + '). Kan du ikke komme, så meld afbud senest ' + FREE_CANCEL_HOURS +
      ' timer før. Tlf. ' + SALON_PHONE); } catch (e) { /* SMS er valgfri */ }

    try { ev.setDescription(desc + '\n[mindet]'); } catch (e) { /* undgår dobbelt-varsel næste kørsel */ }
  }
}

function remindByEmail_(email, name, what, time, bookingId, token) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
  var props = PropertiesService.getScriptProperties();
  var site = props.getProperty('SITE_URL') || 'https://stenlilleherrefrisor.dk';
  var cancelUrl = site + '/?annuller=' + encodeURIComponent(bookingId) + '&t=' + encodeURIComponent(token);

  MailApp.sendEmail({
    to: email,
    subject: 'Husk din tid i dag kl. ' + time + ' ✂️',
    htmlBody:
      '<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#1d1a14">' +
      '<h2 style="color:#1c3329;border-bottom:2px solid #c19a45;padding-bottom:8px">Stenlille Herrefrisør</h2>' +
      '<p>Hej ' + esc_(name) + ',</p>' +
      '<p>Bare en venlig påmindelse: du har tid til <b>' + esc_(what) + '</b> i dag kl. <b>' + time + '</b>.</p>' +
      '<p>Hovedgaden 54, 4295 Stenlille</p>' +
      '<p style="background:#f4f6f2;border-left:3px solid #c19a45;padding:10px 14px">' +
      'Kan du ikke nå det? <a href="' + cancelUrl + '" style="color:#8d6d28">Meld afbud her</a> — ' +
      'afbud er gratis indtil ' + FREE_CANCEL_HOURS + ' timer før din tid.</p>' +
      '<p style="color:#999;font-size:13px;margin-top:24px">Vi ses!<br>' +
      'Stenlille Herrefrisør · Hovedgaden 54, 4295 Stenlille · +45 ' + SALON_PHONE + '</p>' +
      '</div>'
  });
}

/**
 * SMS via GatewayAPI. Sender kun hvis SMS_TOKEN er sat i Script Properties —
 * uden token er hele SMS-delen slået fra, og driften er gratis.
 *
 * Sådan tændes den senere:
 *   SMS_TOKEN   = API-nøglen fra udbyderen
 *   SMS_SENDER  = afsendernavn, højst 11 tegn (fx "Stenlille")
 */
function sendSms_(phone, text) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SMS_TOKEN');
  if (!token) return false;

  var to = normPhone_(phone);
  if (to.length !== 8) return false;
  var sender = (props.getProperty('SMS_SENDER') || 'Stenlille').slice(0, 11);

  var res = UrlFetchApp.fetch('https://gatewayapi.com/rest/mtsms', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(token + ':') },
    payload: JSON.stringify({ sender: sender, message: text, recipients: [{ msisdn: Number('45' + to) }] }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 300) {
    logBooking_([new Date(), '', '', 'SMS-FEJL', '', '', to, '', res.getContentText().slice(0, 200), '', 'smsfejl']);
    return false;
  }
  return true;
}
