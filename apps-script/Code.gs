/**
 * Check-in Presenze — Google Apps Script backend
 *
 * Deploy: Extensions → Apps Script → incolla questo file →
 * Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone.
 *
 * Il client invia POST con Content-Type text/plain (simple request, no preflight).
 * Qui il body JSON va letto da e.postData.contents e parsato manualmente.
 */

var SHEET_NAME = 'Presenze';

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.appendRow([
      'id', 'timestamp_server', 'nome', 'iso', 'timestamp_locale', 'tz',
      'lat', 'lon', 'accuracy', 'geo_skipped', 'maps_url', 'device_id',
    ]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * POST — registra un check-in.
 * Dedupe tramite la colonna "id" (chiave di idempotenza generata dal client).
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var payload = parseBody(e);
    if (!payload || !payload.nome) {
      return json({ ok: false, error: 'payload non valido' });
    }

    var sh = getSheet();
    var idCol = 1;
    var ids = sh.getRange(1, idCol, Math.max(sh.getLastRow(), 1), 1)
                .getValues().map(function (r) { return r[0]; });

    if (ids.indexOf(payload.id) !== -1) {
      // già registrato → risposta idempotente, niente duplicati
      return json({ ok: true, duplicate: true, id: payload.id });
    }

    sh.appendRow([
      payload.id,
      new Date().toISOString(),       // orario server (autorevole)
      payload.nome,
      payload.iso || '',
      payload.timestamp || '',
      payload.tz || '',
      payload.lat != null ? payload.lat : '',
      payload.lon != null ? payload.lon : '',
      payload.accuracy != null ? payload.accuracy : '',
      payload.geoSkipped ? 'yes' : 'no',
      payload.mapsUrl || '',
      payload.deviceId || '',
    ]);

    return json({ ok: true, id: payload.id });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * GET — verifica la registrazione di un check-in.
 * Usato dal client: ?v=<id> restituisce { ok:true, id:... } se presente nel foglio.
 */
function doGet(e) {
  var v = e && e.parameter && e.parameter.v;
  if (!v) return json({ ok: true, service: 'checkin-presenze' });

  var sh = getSheet();
  var last = sh.getLastRow();
  if (last < 2) return json({ ok: false, id: v });

  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === v) return json({ ok: true, id: v });
  }
  return json({ ok: false, id: v });
}

function parseBody(e) {
  if (!e || !e.postData) return null;
  // Preferisci il parsing esplicito: con text/plain e.postData.json può essere assente.
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
