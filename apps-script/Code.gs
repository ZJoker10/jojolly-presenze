/**
 * Check-in Presenze — Google Apps Script backend (v2)
 *
 * Deploy: Extensions → Apps Script → incolla questo file →
 * Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone.
 *
 * PIN admin: Project Settings → Script properties → aggiungi
 *   ADMIN_PIN = <la tua password>          (usata da admin.html)
 *
 * Endpoint:
 *   POST  { id, sessionId, event: 'IN'|'OUT', nome, iso, notes, lat, lon, ... }
 *   GET   ?v=<id>                              → verifica check-in
 *   GET   ?events=YYYY-MM-DD&pin=<PIN>         → eventi del giorno (admin)
 *   GET   ?mine=<nome>&date=YYYY-MM-DD         → timeline del lavoratore (pubblico)
 */

var SHEET_NAME = 'Presenze';

var COLUMNS = [
  'id', 'session_id', 'event', 'timestamp_server', 'iso', 'timestamp_locale',
  'tz', 'nome', 'lat', 'lon', 'accuracy', 'geo_skipped', 'notes',
  'maps_url', 'device_id',
];

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.appendRow(COLUMNS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function getPin() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') || '';
}

// ── POST: registra un evento entrata/uscita ──────────────────────────────────
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var p = parseBody(e);
    if (!p || !p.nome) return json({ ok: false, error: 'payload non valido' });

    var event = (p.event === 'OUT') ? 'OUT' : 'IN';
    var notes = String(p.notes || '').substring(0, 500);
    var id = p.id || Utilities.getUuid();

    var sh = getSheet();
    var ids = getIdColumn(sh);
    if (ids.indexOf(id) !== -1) {
      // idempotenza: già registrato, niente duplicati
      return json({ ok: true, duplicate: true, id: id });
    }

    // Uscita senza entrata aperta → comunque registrata, ma segnalata
    var orphanOut = false;
    if (event === 'OUT' && p.sessionId && ids.indexOf(p.sessionId) === -1) {
      orphanOut = true;
    }

    sh.appendRow([
      id,
      p.sessionId || id,                 // IN: sessione = se stesso; OUT: id dell'IN
      event,
      new Date().toISOString(),
      p.iso || '',
      p.timestamp || '',
      p.tz || '',
      p.nome,
      p.lat != null ? p.lat : '',
      p.lon != null ? p.lon : '',
      p.accuracy != null ? p.accuracy : '',
      p.geoSkipped ? 'yes' : 'no',
      notes,
      p.mapsUrl || '',
      p.deviceId || '',
    ]);

    return json({ ok: true, id: id, event: event, orphanOut: orphanOut });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ── GET: verifica / admin / timeline lavoratore ──────────────────────────────
function doGet(e) {
  var par = (e && e.parameter) || {};

  // Verifica invio: ?v=<id>
  if (par.v) {
    var found = getIdColumn(getSheet()).indexOf(par.v) !== -1;
    return json({ ok: found, id: par.v });
  }

  // Admin: ?events=YYYY-MM-DD&pin=XXXX
  if (par.events) {
    if (!getPin()) return json({ ok: false, error: 'ADMIN_PIN non configurato nelle Script properties' });
    if (String(par.pin || '') !== getPin()) return json({ ok: false, error: 'PIN errato' });
    return json({ ok: true, date: par.events, events: readEvents(par.events) });
  }

  // Timeline lavoratore: ?mine=<nome>&date=YYYY-MM-DD
  if (par.mine) {
    var date = par.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var rows = readEvents(date).filter(function (ev) {
      return ev.nome.toLowerCase() === String(par.mine).toLowerCase();
    });
    return json({ ok: true, date: date, events: rows });
  }

  return json({ ok: true, service: 'checkin-presenze', version: 2 });
}

/** Legge tutti gli eventi di una data e li arricchisce con stato/durate. */
function readEvents(dateStr) {
  var sh = getSheet();
  var last = sh.getLastRow();
  if (last < 2) return [];

  var tz = Session.getScriptTimeZone();
  var values = sh.getRange(2, 1, last - 1, COLUMNS.length).getValues();
  var cols = {};
  COLUMNS.forEach(function (c, i) { cols[c] = i; });

  var events = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var iso = String(r[cols.iso] || '');
    if (!iso) continue;
    if (iso.substring(0, 10) !== dateStr) continue;

    events.push({
      id: r[cols.id],
      sessionId: r[cols.session_id],
      event: r[cols.event] === 'OUT' ? 'OUT' : 'IN',
      nome: r[cols.nome],
      iso: iso,
      timestamp: r[cols.timestamp_locale],
      serverTime: r[cols.timestamp_server] instanceof Date
        ? r[cols.timestamp_server].toISOString() : String(r[cols.timestamp_server] || ''),
      lat: r[cols.lat] === '' ? null : Number(r[cols.lat]),
      lon: r[cols.lon] === '' ? null : Number(r[cols.lon]),
      accuracy: r[cols.accuracy] === '' ? null : Number(r[cols.accuracy]),
      geoSkipped: r[cols.geo_skipped] === 'yes',
      notes: r[cols.notes] || '',
      mapsUrl: r[cols.maps_url] || '',
    });
  }

  events.sort(function (a, b) { return a.iso < b.iso ? -1 : 1; });

  // Stato sessione: IN senza OUT successivo = ancora presente
  var openSessions = {};
  events.forEach(function (ev) {
    if (ev.event === 'IN') openSessions[ev.sessionId] = true;
    else delete openSessions[ev.sessionId];
  });
  events.forEach(function (ev) { ev.open = !!openSessions[ev.sessionId]; });

  // Durata per sessione (IN → OUT)
  var ins = {};
  events.forEach(function (ev) {
    if (ev.event === 'IN') ins[ev.sessionId] = ev;
    else {
      var start = ins[ev.sessionId];
      if (start) {
        var mins = Math.round((Date.parse(ev.iso) - Date.parse(start.iso)) / 60000);
        ev.durationMin = mins;
        start.durationMin = mins;
        start.closedBy = ev.id;
      }
    }
  });

  return events;
}

function getIdColumn(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return r[0]; });
}

function parseBody(e) {
  if (!e || !e.postData) return null;
  try {
    if (e.postData.contents) return JSON.parse(e.postData.contents);
  } catch (err) {}
  try {
    if (e.postData.json) return e.postData.json;
  } catch (err) {}
  return null;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
