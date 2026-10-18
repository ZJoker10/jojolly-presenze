/**
 * Check-in Presenze — Google Apps Script backend (v3)
 *
 * ── SETUP ────────────────────────────────────────────────────────────────────
 * 1. Extensions → Apps Script → incolla questo file.
 * 2. Project Settings → Script properties:
 *      ADMIN_PIN      = <PIN per admin.html>            (obbligatorio)
 *      MANAGER_EMAIL  = <email per il digest giornaliero>
 *      SITE_LAT       = <latitudine cantiere>           (opzionale, geofence)
 *      SITE_LON       = <longitudine cantiere>
 *      SITE_RADIUS_M  = 100                             (opzionale, default 100)
 * 3. Esegui una volta setupTriggers() → crea il trigger digest alle 18:00
 *    (modifica DIGEST_HOUR prima, se vuoi un'altra ora).
 * 4. Deploy → New deployment → Web app → Execute as: Me → Anyone.
 *
 * ── API ──────────────────────────────────────────────────────────────────────
 *   POST  { id, sessionId, event:'IN'|'OUT', nome, iso, notes, lat, lon, ... }
 *   GET   ?v=<id>                          → verifica invio
 *   GET   ?events=YYYY-MM-DD&pin=<PIN>     → eventi del giorno (admin)
 *   GET   ?mine=<nome>&date=YYYY-MM-DD     → timeline lavoratore
 *   GET   ?site=1                          → perimetro autorizzato (pubblico)
 */

var SHEET_NAME = 'Presenze';
var DIGEST_HOUR = 18;   // ora locale del digest (0-23)

var COLUMNS = [
  'id', 'session_id', 'event', 'timestamp_server', 'iso', 'timestamp_locale',
  'tz', 'nome', 'lat', 'lon', 'accuracy', 'geo_skipped', 'notes',
  'maps_url', 'device_id', 'location_ok',
];

// ── SHEET + MIGRAZIONE SCHEMA ────────────────────────────────────────────────
function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);

  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.appendRow(COLUMNS);
    sh.setFrozenRows(1);
    return sh;
  }

  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  // Schema v1 (prima di IN/OUT): archivia e ricrea pulito
  if (header.indexOf('event') === -1) {
    sh.setName(SHEET_NAME + '_v1_archivio');
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(COLUMNS);
    sh.setFrozenRows(1);
    return sh;
  }

  // v2 → v3: aggiungi la colonna location_ok mancante
  if (header.indexOf('location_ok') === -1) {
    sh.getRange(1, header.length + 1).setValue('location_ok');
  }
  return sh;
}

function prop(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

function getPin() { return prop('ADMIN_PIN'); }

// ── GEOFENCE ─────────────────────────────────────────────────────────────────
function siteConfig() {
  var lat = prop('SITE_LAT'), lon = prop('SITE_LON');
  if (!lat || !lon) return null;
  return {
    lat: parseFloat(lat),
    lon: parseFloat(lon),
    radius: parseFloat(prop('SITE_RADIUS_M') || '100') || 100,
  };
}

/** Haversine → true/false fuori perimetro, null se il perimetro non è configurato. */
function withinSite(lat, lon) {
  var s = siteConfig();
  if (!s || lat === null || lat === undefined || lat === '' ||
      lon === null || lon === undefined || lon === '') return null;
  var R = 6371000;
  var φ1 = s.lat * Math.PI / 180, φ2 = lat * Math.PI / 180;
  var Δφ = (lat - s.lat) * Math.PI / 180;
  var Δλ = (lon - s.lon) * Math.PI / 180;
  var a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
          Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  var d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return d <= s.radius;
}

// ── POST: registrа evento entrata/uscita ─────────────────────────────────────
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
      return json({ ok: true, duplicate: true, id: id });   // idempotente
    }

    var orphanOut = (event === 'OUT' && p.sessionId && ids.indexOf(p.sessionId) === -1);

    var lok = withinSite(p.lat, p.lon);           // true / false / null
    var lokStr = lok === null ? '' : (lok ? 'yes' : 'no');

    sh.appendRow([
      id,
      p.sessionId || id,
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
      lokStr,
    ]);

    return json({ ok: true, id: id, event: event, orphanOut: orphanOut, locationOk: lok });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ── GET: verifica / admin / timeline / perimetro ─────────────────────────────
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
    var evs = readEvents(par.events);
    return json({
      ok: true, date: par.events,
      site: siteConfig(),           // il front-end admin può mostrare il perimetro
      events: evs,
      summary: summarize(evs),
    });
  }

  // Timeline lavoratore: ?mine=<nome>&date=YYYY-MM-DD
  if (par.mine) {
    var date = par.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var rows = readEvents(date).filter(function (ev) {
      return ev.nome.toLowerCase() === String(par.mine).toLowerCase();
    });
    return json({ ok: true, date: date, events: rows });
  }

  // Perimetro autorizzato: ?site=1 (usato dalla pagina lavoratore per avvisare)
  if (par.site) {
    var s = siteConfig();
    return json(s ? { ok: true, site: s } : { ok: false, site: null });
  }

  return json({ ok: true, service: 'checkin-presenze', version: 3 });
}

// ── LETTURA + SESSIONI + RIEPILOGO ───────────────────────────────────────────
function readEvents(dateStr) {
  var sh = getSheet();
  var last = sh.getLastRow();
  if (last < 2) return [];

  var values = sh.getRange(2, 1, last - 1, COLUMNS.length).getValues();
  var cols = {};
  COLUMNS.forEach(function (c, i) { cols[c] = i; });

  var events = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var iso = String(r[cols.iso] || '');
    if (!iso || iso.substring(0, 10) !== dateStr) continue;

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
      locationOk: r[cols.location_ok] === 'yes' ? true
                : r[cols.location_ok] === 'no' ? false : null,
    });
  }

  events.sort(function (a, b) { return a.iso < b.iso ? -1 : 1; });

  // Stato sessioni
  var open = {};
  events.forEach(function (ev) {
    if (ev.event === 'IN') open[ev.sessionId] = true;
    else delete open[ev.sessionId];
  });
  events.forEach(function (ev) { ev.open = !!open[ev.sessionId]; });

  // Durate IN → OUT
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

function summarize(events) {
  var sessions = {};
  events.forEach(function (ev) {
    if (!sessions[ev.sessionId]) sessions[ev.sessionId] = { nome: ev.nome, in: null, out: null };
    if (ev.event === 'IN') sessions[ev.sessionId].in = ev;
    else sessions[ev.sessionId].out = ev;
  });
  var totalMin = 0, openCount = 0, violations = [];
  Object.keys(sessions).forEach(function (k) {
    var s = sessions[k];
    if (s.in && s.out) totalMin += Math.round((Date.parse(s.out.iso) - Date.parse(s.in.iso)) / 60000);
    if (s.in && !s.out) openCount++;
    [s.in, s.out].forEach(function (ev) {
      if (ev && ev.locationOk === false) violations.push(ev.nome + ' @ ' +
        new Date(ev.iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
    });
  });
  return {
    totalMin: totalMin,
    openCount: openCount,
    uniqueWorkers: Object.keys(sessions).reduce(function (acc, k) {
      if (acc.indexOf(sessions[k].nome) === -1) acc.push(sessions[k].nome);
      return acc;
    }, []),
    geofenceViolations: violations,
  };
}

function getIdColumn(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return r[0]; });
}

// ── DIGEST GIORNALIERO (email) ───────────────────────────────────────────────
/** Esegui una volta dall'editor per creare il trigger quotidiano. */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyDigest').timeBased()
    .atHour(DIGEST_HOUR).everyDays(1).inTimezone(Session.getScriptTimeZone())
    .create();
  Logger.log('Trigger digest creato alle %s:00 (%s)', DIGEST_HOUR, Session.getScriptTimeZone());
}

/** Esegui a mano per provare l'email. */
function sendDailyDigestNow() { sendDailyDigest(); }

function sendDailyDigest() {
  var to = prop('MANAGER_EMAIL') || Session.getActiveUser().getEmail();
  if (!to) { Logger.log('MANAGER_EMAIL non configurato: digest saltato.'); return; }

  var tz = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var events = readEvents(today);
  var sum = summarize(events);

  var subject = '📅 Presenze ' + today + ' — ' + sum.uniqueWorkers.length + ' lavoratori' +
    (sum.openCount ? ' (' + sum.openCount + ' ancora presenti)' : '');

  var lines = [];
  lines.push('RIEPILOGO PRESENZE — ' + today);
  lines.push('====================================');
  lines.push('');
  lines.push('Lavoratori unici: ' + sum.uniqueWorkers.length);
  lines.push('Ore lavorate:     ' + (sum.totalMin / 60).toFixed(1) + ' h');
  lines.push('Sessioni aperte:  ' + sum.openCount);
  lines.push('');

  if (sum.openCount > 0) {
    lines.push('⚠ ANCORA PRESENSENZA (manca uscita):');
    events.forEach(function (ev) {
      if (ev.event === 'IN' && ev.open) {
        lines.push('  • ' + ev.nome + ' — entrata alle ' +
          Utilities.formatDate(new Date(ev.iso), tz, 'HH:mm'));
      }
    });
    lines.push('');
  }

  if (sum.geofenceViolations.length) {
    lines.push('⚠ FUORI PERIMETRO (' + (prop('SITE_RADIUS_M') || '100') + ' m):');
    sum.geofenceViolations.forEach(function (v) { lines.push('  • ' + v); });
    lines.push('');
  }

  lines.push('DETTAGLIO SESSIONI');
  lines.push('------------------------------------');
  var sessions = {};
  events.forEach(function (ev) {
    if (!sessions[ev.sessionId]) sessions[ev.sessionId] = { nome: ev.nome, in: null, out: null };
    if (ev.event === 'IN') sessions[ev.sessionId].in = ev;
    else sessions[ev.sessionId].out = ev;
  });
  Object.keys(sessions).forEach(function (k) {
    var s = sessions[k];
    if (!s.in && !s.out) return;
    var tIn = s.in ? Utilities.formatDate(new Date(s.in.iso), tz, 'HH:mm') : '--:--';
    var tOut = s.out ? Utilities.formatDate(new Date(s.out.iso), tz, 'HH:mm') : 'ancora qui';
    var d = (s.in && s.out)
      ? Math.round((Date.parse(s.out.iso) - Date.parse(s.in.iso)) / 60000)
      : null;
    var durTxt = d != null ? (Math.floor(d / 60) + 'h' + ('0' + (d % 60)).slice(-2)) : '—';
    var note = (s.in && s.in.notes) ? '  📝 ' + s.in.notes : '';
    lines.push('  ' + s.nome + '  ' + tIn + ' → ' + tOut + '  (' + durTxt + ')' + note);
  });

  if (!events.length) lines.push('  Nessun evento registrato oggi.');

  lines.push('');
  lines.push('Fonte: Google Sheets — ' + SHEET_NAME);

  MailApp.sendEmail(to, subject, lines.join('\n'));
  Logger.log('Digest inviato a %s', to);
}

// ── UTIL ─────────────────────────────────────────────────────────────────────
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
