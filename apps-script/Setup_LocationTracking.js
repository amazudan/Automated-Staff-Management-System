function setupLocationTracking() {
  // ---- EDIT THESE THREE VALUES BEFORE RUNNING ----
  var OFFICE_LAT = 7.6318746;   // 47 Dallimore Rd, Ado Ekiti
  var OFFICE_LNG = 5.2200526;
  var GEOFENCE_RADIUS_M = 300;  // meters
  // -------------------------------------------------

  var ss = SheetDB.spreadsheet();
  var result = { columnsAdded: [], configWritten: [], skipped: [] };

  /* ---- 1. Add new columns to the Attendance sheet header row ---- */
  var attSheet = ss.getSheetByName(SHEETS.ATTENDANCE);
  if (!attSheet) throw new Error('Attendance sheet not found — check SHEETS.ATTENDANCE name.');

  var lastCol = attSheet.getLastColumn();
  var headerRange = attSheet.getRange(1, 1, 1, lastCol);
  var headers = headerRange.getValues()[0].map(function (h) { return String(h).trim(); });

  var newColumns = ['DeviceType', 'Latitude', 'Longitude', 'DistanceMeters', 'LocationFlagged'];
  var toAppend = newColumns.filter(function (c) { return headers.indexOf(c) === -1; });

  if (toAppend.length) {
    var startCol = lastCol + 1;
    attSheet.getRange(1, startCol, 1, toAppend.length).setValues([toAppend]);
    try { attSheet.getRange(1, startCol, 1, toAppend.length).setFontWeight('bold'); } catch (e) {}
    result.columnsAdded = toAppend;
  } else {
    result.skipped.push('Attendance columns already present — nothing added.');
  }

  /* ---- 2. Write / update the Config rows ---- */
  var cfgSheet = ss.getSheetByName(SHEETS.CONFIG);
  if (!cfgSheet) throw new Error('Config sheet not found — check SHEETS.CONFIG name.');

  var cfgData = cfgSheet.getDataRange().getValues();
  var cfgHeaders = cfgData[0].map(function (h) { return String(h).trim(); });
  var keyCol = cfgHeaders.indexOf('Key');
  var valCol = cfgHeaders.indexOf('Value');
  var catCol = cfgHeaders.indexOf('Category');
  var descCol = cfgHeaders.indexOf('Description');

  if (keyCol === -1 || valCol === -1) {
    throw new Error('Config sheet is missing expected Key/Value columns.');
  }

  var existingKeys = {};
  for (var i = 1; i < cfgData.length; i++) {
    var k = String(cfgData[i][keyCol]).trim();
    if (k) existingKeys[k] = i + 1;
  }

  var desiredRows = [
    { key: 'OfficeLatitude', value: OFFICE_LAT, category: 'Attendance',
      description: 'Office location (latitude) used for the sign-in geofence check.' },
    { key: 'OfficeLongitude', value: OFFICE_LNG, category: 'Attendance',
      description: 'Office location (longitude) used for the sign-in geofence check.' },
    { key: 'GeofenceRadiusMeters', value: GEOFENCE_RADIUS_M, category: 'Attendance',
      description: 'Sign-ins further than this many meters from the office are flagged.' }
  ];

  desiredRows.forEach(function (row) {
    if (existingKeys[row.key]) {
      result.skipped.push(row.key + ' already exists in Config — left unchanged.');
      return;
    }
    var newRow = [];
    newRow[keyCol] = row.key;
    newRow[valCol] = row.value;
    if (catCol > -1) newRow[catCol] = row.category;
    if (descCol > -1) newRow[descCol] = row.description;
    for (var c = 0; c < newRow.length; c++) if (newRow[c] === undefined) newRow[c] = '';
    cfgSheet.appendRow(newRow);
    result.configWritten.push(row.key);
  });

  try { CFG.flush(); } catch (e) {}

  Log.info('Setup', 'setupLocationTracking ran', JSON.stringify(result));
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}