/**
 * ============================================================================
 * SheetDB.gs — tiny record layer over Google Sheets.
 * ============================================================================
 * Rows come back as plain objects keyed by header name, plus a hidden `__row`
 * property holding the 1-based sheet row so updates never need a re-scan.
 *
 *   var open = SheetDB.find(SHEETS.TASKS, function (t) {
 *     return t.Status === TASK_STATUS.IN_PROGRESS;
 *   });
 *   SheetDB.updateRowAt(SHEETS.TASKS, open[0].__row, { Status: 'Completed' });
 *
 * All writes go through SheetDB.withLock() so two staff submitting at the same
 * instant cannot clobber each other.
 * ============================================================================
 */

var SheetDB = (function () {
  var ssCache = null;
  var tableCache = {};   // sheetName -> { headers: [], rows: [] }

  /** The spreadsheet acting as our database. */
  function ss() {
    if (ssCache) return ssCache;
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty(PROP_SPREADSHEET_ID);
    if (id) {
      ssCache = SpreadsheetApp.openById(id);
    } else {
      ssCache = SpreadsheetApp.getActiveSpreadsheet();
      if (!ssCache) {
        throw new Error(
          'No database spreadsheet is bound to this script. Run setupSystem() ' +
          'once from the editor, or set the SPREADSHEET_ID script property.');
      }
      props.setProperty(PROP_SPREADSHEET_ID, ssCache.getId());
    }
    return ssCache;
  }

  /** Load a whole tab into the per-execution cache. */
  function load(name) {
    if (tableCache[name]) return tableCache[name];
    var sh = ss().getSheetByName(name);
    if (!sh) throw new Error('Sheet "' + name + '" not found. Run setupSystem().');

    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastCol === 0) {
      tableCache[name] = { headers: [], rows: [] };
      return tableCache[name];
    }

    var values = sh.getRange(1, 1, Math.max(lastRow, 1), lastCol).getValues();
    var headers = values[0].map(function (h) { return String(h).trim(); });
    var rows = [];

    for (var r = 1; r < values.length; r++) {
      var raw = values[r];
      // Skip fully blank rows so deleted records do not pollute results.
      var blank = true;
      for (var c = 0; c < raw.length; c++) {
        if (raw[c] !== '' && raw[c] !== null) { blank = false; break; }
      }
      if (blank) continue;

      var obj = { __row: r + 1, __sheet: name };
      for (var h = 0; h < headers.length; h++) {
        if (headers[h]) obj[headers[h]] = raw[h];
      }
      rows.push(obj);
    }

    tableCache[name] = { headers: headers, rows: rows };
    return tableCache[name];
  }

  return {
    /** Raw Spreadsheet handle (used by Setup.gs). */
    spreadsheet: ss,

    /** Raw Sheet handle. */
    sheet: function (name) {
      var sh = ss().getSheetByName(name);
      if (!sh) throw new Error('Sheet "' + name + '" not found. Run setupSystem().');
      return sh;
    },

    headers: function (name) { return load(name).headers.slice(); },

    /** Every non-blank row as an object. */
    readAll: function (name) { return load(name).rows.slice(); },

    /** Rows matching a predicate. */
    find: function (name, predicate) {
      return load(name).rows.filter(predicate);
    },

    /** First row matching a predicate, or null. */
    findOne: function (name, predicate) {
      var rows = load(name).rows;
      for (var i = 0; i < rows.length; i++) {
        if (predicate(rows[i])) return rows[i];
      }
      return null;
    },

    /** Lookup by primary key column. */
    findById: function (name, idColumn, id) {
      var wanted = String(id || '').trim();
      if (!wanted) return null;
      return this.findOne(name, function (r) {
        return String(r[idColumn]).trim() === wanted;
      });
    },

    count: function (name) { return load(name).rows.length; },

    /** Append one record. Missing keys are written as ''. Returns the record. */
    insert: function (name, record) {
      var t = load(name);
      var sh = this.sheet(name);
      var row = t.headers.map(function (h) {
        var v = record[h];
        return (v === undefined || v === null) ? '' : v;
      });
      sh.appendRow(row);
      this.invalidate(name);
      return record;
    },

    /** Append many records in one write (much faster than looping insert). */
    insertMany: function (name, records) {
      if (!records || !records.length) return 0;
      var t = load(name);
      var sh = this.sheet(name);
      var matrix = records.map(function (record) {
        return t.headers.map(function (h) {
          var v = record[h];
          return (v === undefined || v === null) ? '' : v;
        });
      });
      sh.getRange(sh.getLastRow() + 1, 1, matrix.length, t.headers.length)
        .setValues(matrix);
      this.invalidate(name);
      return matrix.length;
    },

    /** Patch specific columns on a known sheet row. */
    updateRowAt: function (name, rowNumber, patch) {
      var t = load(name);
      var sh = this.sheet(name);
      var keys = Object.keys(patch);
      for (var i = 0; i < keys.length; i++) {
        var col = t.headers.indexOf(keys[i]);
        if (col === -1) continue;   // unknown column — ignore rather than throw
        var v = patch[keys[i]];
        sh.getRange(rowNumber, col + 1).setValue(v === undefined || v === null ? '' : v);
      }
      this.invalidate(name);
      return true;
    },

    /** Patch by primary key. Returns false when the id is unknown. */
    updateById: function (name, idColumn, id, patch) {
      var row = this.findById(name, idColumn, id);
      if (!row) return false;
      return this.updateRowAt(name, row.__row, patch);
    },

    deleteRowAt: function (name, rowNumber) {
      this.sheet(name).deleteRow(rowNumber);
      this.invalidate(name);
      return true;
    },

    /** Forget the cache for one tab (or all tabs when name is omitted). */
    invalidate: function (name) {
      if (name) delete tableCache[name];
      else tableCache = {};
    },

    /**
     * Generate the next id for a table, e.g. nextId('TSK', SHEETS.TASKS, 'TaskID')
     * -> 'TSK-000042'. The counter lives in script properties and is seeded
     * from the highest id already present, so it survives property resets.
     */
    nextId: function (prefix, sheetName, idColumn, pad) {
      var props = PropertiesService.getScriptProperties();
      var key = PROP_SEQ_PREFIX + prefix;
      var current = parseInt(props.getProperty(key), 10);

      if (isNaN(current)) {
        current = 0;
        try {
          this.readAll(sheetName).forEach(function (r) {
            var m = String(r[idColumn] || '').match(/(\d+)\s*$/);
            if (m) current = Math.max(current, parseInt(m[1], 10));
          });
        } catch (e) { /* sheet may not exist yet */ }
      }

      var next = current + 1;
      props.setProperty(key, String(next));
      var width = pad || 5;
      var digits = String(next);
      while (digits.length < width) digits = '0' + digits;
      return prefix + '-' + digits;
    },

    /**
     * Run fn while holding the script lock. Every mutating operation in this
     * project is wrapped in this to prevent concurrent-write corruption.
     */
    withLock: function (fn, timeoutMs) {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(timeoutMs || 20000)) {
        throw new Error('The system is busy processing another request. Please retry in a moment.');
      }
      try {
        this.invalidate();       // always read fresh data inside the lock
        return fn();
      } finally {
        lock.releaseLock();
      }
    }
  };
})();

/* ---------------------------------------------------------------------------
 * Log — append-only diagnostics written to the hidden Logs tab.
 * Deliberately does NOT read Config, so it is safe to call from anywhere.
 * ------------------------------------------------------------------------- */
var Log = (function () {
  var MAX_ROWS = 5000;

  function write(level, source, message, details) {
    var line = '[' + level + '] ' + source + ' :: ' + message;
    Logger.log(line + (details ? ' | ' + details : ''));
    try {
      var sh = SheetDB.spreadsheet().getSheetByName(SHEETS.LOGS);
      if (!sh) return;
      var user = '';
      try { user = Session.getActiveUser().getEmail() || ''; } catch (e) { user = ''; }
      sh.appendRow([
        new Date(), level, source, String(message).substring(0, 4000),
        details ? String(details).substring(0, 8000) : '', user
      ]);
      // Cheap rotation so the tab never grows unbounded.
      var last = sh.getLastRow();
      if (last > MAX_ROWS + 1) sh.deleteRows(2, last - MAX_ROWS - 1);
    } catch (err) {
      Logger.log('Log.write failed: ' + err);
    }
  }

  return {
    info:  function (source, message, details) { write('INFO',  source, message, details); },
    warn:  function (source, message, details) { write('WARN',  source, message, details); },
    error: function (source, message, details) { write('ERROR', source, message, details); },
    /** Log a caught exception with its stack. */
    exception: function (source, err) {
      write('ERROR', source, err && err.message ? err.message : String(err),
            err && err.stack ? err.stack : '');
    }
  };
})();
