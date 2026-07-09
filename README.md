# Stenlille Herrefrisør — hjemmeside med online booking

Live: https://stenlilleherrefrisor.dk (GitHub Pages) · Backend: Google Apps Script (booking → Google Kalender + email)

- `index.html` — hele frontenden (priser, galleri, booking-flow)
- `gas/Code.js` — booking-API (getAvailability/createBooking/cancelBooking)
- `img/` — hero + galleri (webp)

## Deploy
Frontend: `git push` (GitHub Pages, main). Backend: `cd gas && clasp push && clasp deploy -i <deploymentId> -d "..."`.

## Booking-model
Ledige tider = åbningstider minus events i Google Kalenderen **"Stenlille Herrefrisør Booking"**.
Frisøren blokerer tider ved at oprette events i kalenderen. Hver booking = kalender-event + mail til kunde og frisør + række i log-arket.
Script Properties: `BARBER_EMAIL`, `CALENDAR_ID`, `SHEET_ID`, `SITE_URL`.

OBS: Priser/åbningstider er hardcodet to steder — `SERVICES`/`HOURS` i `gas/Code.js` og `SERVICES`/`#hoursTable` i `index.html`. Ret begge.
