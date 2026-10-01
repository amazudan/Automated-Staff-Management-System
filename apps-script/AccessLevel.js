function setupAccessLevel() {
  var ss = SheetDB.spreadsheet();
  var staffSheet = ss.getSheetByName(SHEETS.STAFF);
  if (!staffSheet) throw new Error('Staff sheet not found.');

  var lastCol = staffSheet.getLastColumn();
  var headers = staffSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });

  if (headers.indexOf('AccessLevel') === -1) {
    staffSheet.getRange(1, lastCol + 1).setValue('AccessLevel');
    // Default every existing staff member to 'Full' so nobody loses access.
    var lastRow = staffSheet.getLastRow();
    if (lastRow > 1) {
      var col = lastCol + 1;
      var values = [];
      for (var i = 0; i < lastRow - 1; i++) values.push(['Full']);
      staffSheet.getRange(2, col, values.length, 1).setValues(values);
    }
    Logger.log('AccessLevel column added, defaulted existing staff to Full.');
  } else {
    Logger.log('AccessLevel column already exists — nothing changed.');
  }
}