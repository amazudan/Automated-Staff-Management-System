/**
 * ============================================================================
 * Setup.gs — one-time installer and repair tool.
 * ============================================================================
 * Run setupSystem() once from the Apps Script editor. It is idempotent: run it
 * again any time to repair missing tabs, headers or config keys without
 * touching existing data.
 * ============================================================================
 */

/**
 * Creates/repairs every tab, seeds config, registers the first admin.
 * @return {Object} summary of what was created.
 */
function setupSystem() {
  var summary = { spreadsheetUrl: '', created: [], repaired: [], configAdded: [], admin: '' };

  // 1. Resolve (or create) the database spreadsheet ---------------------------
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var existingId = props.getProperty(PROP_SPREADSHEET_ID);
    if (existingId) {
      ss = SpreadsheetApp.openById(existingId);
    } else {
      ss = SpreadsheetApp.create('Staff Management System — Database');
      Logger.log('Created database spreadsheet: ' + ss.getUrl());
    }
  }
  props.setProperty(PROP_SPREADSHEET_ID, ss.getId());
  SheetDB.invalidate();
  summary.spreadsheetUrl = ss.getUrl();

  // 2. Create or repair every tab -------------------------------------------
  Object.keys(SCHEMA).forEach(function (name) {
    var headers = SCHEMA[name];
    var sh = ss.getSheetByName(name);

    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      summary.created.push(name);
    } else {
      var lastCol = Math.max(sh.getLastColumn(), 1);
      var existing = sh.getRange(1, 1, 1, lastCol).getValues()[0]
        .map(function (h) { return String(h).trim(); });
      var missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
      if (missing.length) {
        // Append only the missing headers so existing columns keep their data.
        sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
        summary.repaired.push(name + ' (+' + missing.join(', ') + ')');
      }
    }

    styleHeader_(sh, Math.max(headers.length, sh.getLastColumn()));
  });

  // Remove the default empty sheet a brand-new spreadsheet ships with.
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);

  // Diagnostics tab stays out of the way.
  var logs = ss.getSheetByName(SHEETS.LOGS);
  if (logs) logs.hideSheet();

  SheetDB.invalidate();

  // 3. Seed configuration ---------------------------------------------------
  var cfgSheet = ss.getSheetByName(SHEETS.CONFIG);
  var present = {};
  SheetDB.readAll(SHEETS.CONFIG).forEach(function (r) {
    present[String(r.Key).trim()] = true;
  });
  var toAdd = DEFAULT_CONFIG.filter(function (row) { return !present[row[0]]; });
  if (toAdd.length) {
    cfgSheet.getRange(cfgSheet.getLastRow() + 1, 1, toAdd.length, 4).setValues(toAdd);
    summary.configAdded = toAdd.map(function (r) { return r[0]; });
  }
  cfgSheet.setColumnWidth(1, 230).setColumnWidth(2, 190).setColumnWidth(4, 480);
  SheetDB.invalidate();
  CFG.flush();

  // 4. Make sure at least one admin exists ---------------------------------
  var owner = '';
  try { owner = Session.getEffectiveUser().getEmail() || ''; } catch (e) { owner = ''; }
  var staffRows = SheetDB.readAll(SHEETS.STAFF);
  var hasAdmin = staffRows.some(function (s) {
    return String(s.Role).trim() === ROLES.ADMIN;
  });

  if (!hasAdmin && Util.isEmail(owner)) {
    var pin = Util.randomPin();
    var salt = Util.randomToken(16);
    SheetDB.insert(SHEETS.STAFF, {
      StaffID: SheetDB.nextId('STF', SHEETS.STAFF, 'StaffID', 4),
      Name: owner.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      }),
      Email: owner,
      Phone: '',
      Role: ROLES.ADMIN,
      Department: 'Management',
      Position: 'Administrator',
      DateAdded: Util.today(),
      Status: STAFF_STATUS.ACTIVE,
      StrikeCount: 0,
      FlaggedStatus: false,
      SuspendedAt: '',
      SuspensionCount: 0,
      TotalStrikesIssued: 0,
      ClearedAt: '', ClearedBy: '', ClearanceNote: '',
      PinHash: Util.hash(pin, salt),
      PinSalt: salt,
      LastLogin: '', PhotoUrl: '',
      Notes: 'Auto-created by setupSystem().'
    });
    summary.admin = owner + ' (PIN: ' + pin + ' — change it in the portal)';
    Logger.log('Admin created: ' + owner + ' with PIN ' + pin);
  } else {
    summary.admin = hasAdmin ? 'Admin already present' : 'No admin created (owner email unavailable)';
  }

  // 5. Seed a couple of holidays so attendance rates are believable --------
  if (SheetDB.count(SHEETS.HOLIDAYS) === 0) {
    SheetDB.insertMany(SHEETS.HOLIDAYS, [
      { Date: new Date(new Date().getFullYear(), 0, 1),  Name: 'New Year\'s Day', Recurring: true },
      { Date: new Date(new Date().getFullYear(), 11, 25), Name: 'Christmas Day',   Recurring: true }
    ]);
  }

  Log.info('Setup', 'setupSystem completed', JSON.stringify(summary));
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

/** Header styling shared by every tab. */
function styleHeader_(sh, cols) {
  if (!sh || cols < 1) return;
  var range = sh.getRange(1, 1, 1, cols);
  range.setFontWeight('bold')
       .setBackground('#14532D')
       .setFontColor('#FFFFFF')
       .setVerticalAlignment('middle');
  sh.setRowHeight(1, 30);
  sh.setFrozenRows(1);
}

/**
 * Optional: load a small realistic dataset so the dashboards are not empty on
 * first launch. Safe to skip in production.
 */
function seedDemoData() {
  return SheetDB.withLock(function () {
    var created = { staff: [], tasks: 0 };

    var people = [
      ['Alexandra Deff',      'alexandra.deff@example.com',      'Engineering', 'Frontend Developer', 320000],
      ['Edwin Adenike',       'edwin.adenike@example.com',       'Engineering', 'Backend Developer',  300000],
      ['Isaac Oluwatemilorun', 'isaac.oluwa@example.com',        'Product',     'QA Analyst',         240000],
      ['David Oshodi',        'david.oshodi@example.com',        'Design',      'UI Designer',        260000]
    ];

    people.forEach(function (p) {
      if (SheetDB.findOne(SHEETS.STAFF, function (s) {
        return String(s.Email).toLowerCase() === p[1];
      })) return;
      var res = StaffService.create({
        name: p[0], email: p[1], role: ROLES.STAFF,
        department: p[2], position: p[3], phone: '',
        monthlySalary: p[4]
      }, 'setupSystem', { silent: true });
      created.staff.push(res.staffId + ' ' + p[0] + ' PIN:' + res.pin);
    });

    SheetDB.invalidate();
    var staff = SheetDB.find(SHEETS.STAFF, function (s) {
      return String(s.Role) === ROLES.STAFF;
    });

    // No amounts here: each task's allocation is derived from the assignee's
    // guaranteed monthly salary once the task lands in the month.
    var samples = [
      ['Develop API Endpoints', TASK_TYPE.WEEKLY,  'High',     0,  6],
      ['Onboarding Flow',       TASK_TYPE.WEEKLY,  'Normal',   0,  8],
      ['Build Dashboard',       TASK_TYPE.PROJECT, 'Critical', -2, 10],
      ['Optimize Page Load',    TASK_TYPE.DAILY,   'Normal',   0,  0],
      ['Cross-Browser Testing', TASK_TYPE.DAILY,   'High',    -1,  -1]
    ];

    samples.forEach(function (s, i) {
      var who = staff[i % Math.max(staff.length, 1)];
      if (!who) return;
      TaskService.create({
        title: s[0],
        description: 'Auto-generated demo task for dashboard preview.',
        taskType: s[1],
        priority: s[2],
        assignedTo: who.StaffID,
        startDate: Util.dateKey(Util.addDays(Util.today(), s[3])),
        dueDate: Util.dateKey(Util.addDays(Util.today(), s[4]))
      }, 'setupSystem', { silent: true });
      created.tasks++;
    });

    Log.info('Setup', 'seedDemoData completed', JSON.stringify(created));
    return created;
  });
}

/** Spreadsheet menu so an admin can drive the system without the editor. */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Staff MS')
      .addItem('Run setup / repair', 'setupSystem')
      .addItem('Install automation triggers', 'installAllTriggers')
      .addItem('Remove automation triggers', 'removeAllTriggers')
      .addSeparator()
      .addItem('Run daily automation now', 'runDailyAutomationNow')
      .addItem('Generate monthly reports now', 'generateMonthlyReports')
      .addSeparator()
      .addItem('Seed demo data', 'seedDemoData')
      .addToUi();
  } catch (e) { /* not container-bound */ }
}
function setupCanAssignTasks() {
  var staffSheet = SheetDB.spreadsheet().getSheetByName(SHEETS.STAFF);
  var lastCol = staffSheet.getLastColumn();
  var headers = staffSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  if (headers.indexOf('CanAssignTasks') === -1) {
    staffSheet.getRange(1, lastCol + 1).setValue('CanAssignTasks');
    var lastRow = staffSheet.getLastRow();
    if (lastRow > 1) {
      var vals = []; for (var i = 0; i < lastRow - 1; i++) vals.push([false]);
      staffSheet.getRange(2, lastCol + 1, vals.length, 1).setValues(vals);
    }
    Logger.log('CanAssignTasks column added, defaulted to FALSE.');
  }
}