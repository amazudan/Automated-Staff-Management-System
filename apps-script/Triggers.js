/**
 * ============================================================================
 * Triggers.gs — every time-driven automation entry point.
 * ============================================================================
 * INSTALL: run installAllTriggers() once from the Apps Script editor, or use
 *          the spreadsheet menu "Staff MS → Install triggers".
 *
 *   Hour (Config)                    Function                    What it does
 *   --------------------------------------------------------------------------
 *   TriggerActivateHour       06:00   activateScheduledTasks   Scheduled -> Assigned
 *   TriggerAttendanceReminder 08:00   sendAttendanceReminder   nudge non-signers
 *   TriggerReportCheckHour    19:00   checkDailyReports        strike missing reports
 *   TriggerAttendanceSweep    21:00   sweepAttendance          mark absentees
 *   TriggerRolloverHour       22:00   processDailyRollover     roll + warn + strike
 *   TriggerPeriodReportHour   02:00   generateMonthlyReports   1st of the month
 *                             02:00   generateWeeklyReports    every Monday
 *
 * Every entry point is:
 *   • wrapped in try/catch so one failure never kills the trigger,
 *   • idempotent (safe to run twice on the same day — duplicate strikes for the
 *     same staff+category+task+date are suppressed by StrikeService.issue),
 *   • guarded by LockService so a manual run cannot collide with the schedule.
 * ============================================================================
 */

/* ---------------------------------------------------------------------------
 * Installation
 * ------------------------------------------------------------------------- */

/** The full trigger plan. Hours come from Config, never hard-coded here. */
function triggerPlan_() {
  return [
    { fn: 'activateScheduledTasks', type: 'daily',   hour: CFG.num('TriggerActivateHour', 6),
      description: 'Activate tasks whose start date has arrived' },
    { fn: 'sendAttendanceReminder', type: 'daily',   hour: CFG.num('TriggerAttendanceReminderHour', 8),
      description: 'Remind staff who have not signed attendance' },
    { fn: 'checkDailyReports',      type: 'daily',   hour: CFG.num('TriggerReportCheckHour', 19),
      description: 'Strike staff who filed no daily report' },
    { fn: 'sweepAttendance',        type: 'daily',   hour: CFG.num('TriggerAttendanceSweepHour', 21),
      description: 'Mark staff with no sign-in as Absent' },
    { fn: 'processDailyRollover',   type: 'daily',   hour: CFG.num('TriggerRolloverHour', 22),
      description: 'Roll over incomplete daily tasks with a warning' },
    { fn: 'generateWeeklyReports',  type: 'weekly',  hour: CFG.num('TriggerPeriodReportHour', 2),
      weekDay: ScriptApp.WeekDay.MONDAY,
      description: 'Weekly report for the week just ended' },
    { fn: 'generateMonthlyReports', type: 'monthly', hour: CFG.num('TriggerPeriodReportHour', 2),
      monthDay: 1,
      description: 'Monthly reports, period rollups and draft payroll' }
  ];
}

/**
 * Create every trigger, replacing any existing copy of the same function so
 * repeated runs cannot produce duplicates.
 * @return {Object} installation summary.
 */
function installAllTriggers() {
  removeAllTriggers();

  var installed = [];
  triggerPlan_().forEach(function (t) {
    var hour = Math.max(0, Math.min(23, Math.round(t.hour)));
    var builder = ScriptApp.newTrigger(t.fn).timeBased();

    if (t.type === 'weekly') {
      builder = builder.onWeekDay(t.weekDay).atHour(hour);
    } else if (t.type === 'monthly') {
      builder = builder.onMonthDay(t.monthDay).atHour(hour);
    } else {
      builder = builder.everyDays(1).atHour(hour);
    }

    builder.inTimezone(getTz()).create();
    installed.push(t.fn + ' @ ' + (hour < 10 ? '0' : '') + hour + ':00 (' + t.type + ')');
  });

  Log.info('Triggers', 'Installed ' + installed.length + ' trigger(s)', installed.join(' | '));
  return { installed: installed.length, detail: installed, timezone: getTz() };
}

/** Delete every trigger owned by this script. */
function removeAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Log.info('Triggers', 'Removed ' + triggers.length + ' trigger(s)');
  return { removed: triggers.length };
}

/** What is currently installed — shown on the admin Settings screen. */
function listInstalledTriggers() {
  return ScriptApp.getProjectTriggers().map(function (t) {
    return {
      handler: t.getHandlerFunction(),
      source: String(t.getEventType()),
      id: t.getUniqueId()
    };
  });
}

/* ---------------------------------------------------------------------------
 * Shared wrapper
 * ------------------------------------------------------------------------- */

/**
 * Run a trigger body safely: locked, logged, and never allowed to throw out
 * of the trigger (an uncaught error mails the owner a failure notice and, on
 * repeat, Google disables the trigger).
 */
function runTrigger_(name, body) {
  var started = new Date();
  try {
    var result = SheetDB.withLock(body, 60000);
    Log.info('Triggers', name + ' finished in ' +
      (new Date() - started) + 'ms', Util.serialise(result));
    return { ok: true, trigger: name, result: result };
  } catch (err) {
    Log.exception('Trigger:' + name, err);
    try {
      NotificationService.pushAdmins('TriggerFailure', 'danger',
        'Automation failed: ' + name, String(err && err.message ? err.message : err));
    } catch (e) { /* logging already captured it */ }
    return { ok: false, trigger: name, error: String(err && err.message ? err.message : err) };
  }
}

/* ---------------------------------------------------------------------------
 * Daily entry points
 * ------------------------------------------------------------------------- */

/** 06:00 — Scheduled tasks whose StartDate has arrived become Assigned. */
function activateScheduledTasks() {
  return runTrigger_('activateScheduledTasks', function () {
    return TaskService.activateScheduled();
  });
}

/** 08:00 — email anyone who has not signed attendance yet. */
function sendAttendanceReminder() {
  return runTrigger_('sendAttendanceReminder', function () {
    return AttendanceService.remindUnsigned();
  });
}

/** 19:00 — strike staff who filed no daily report on a live task. */
function checkDailyReports() {
  return runTrigger_('checkDailyReports', function () {
    return DailyReportService.checkMissed();
  });
}

/** 21:00 — mark everyone without a sign-in Absent for today. */
function sweepAttendance() {
  return runTrigger_('sweepAttendance', function () {
    return AttendanceService.sweepAbsences();
  });
}

/**
 * 22:00 — REQUIREMENT 1. Incomplete daily tasks roll into the next working
 * day as priority work with a warning and a strike, until they are completed
 * or the 3rd strike suspends the account. Non-daily tasks past their due date
 * are failed in the same pass.
 */
function processDailyRollover() {
  return runTrigger_('processDailyRollover', function () {
    var rollover = TaskService.processRollover();
    var overdue = CFG.bool('FailOverdueNonDailyTasks', true)
      ? TaskService.failOverdue()
      : { failed: 0, skipped: 'disabled' };
    return { rollover: rollover, overdue: overdue };
  });
}

/* ---------------------------------------------------------------------------
 * Period reports (requirement 4)
 * ------------------------------------------------------------------------- */

/**
 * Build + persist reports for a period and email the rollup to admins.
 * @param {string} periodType Daily|Weekly|Monthly|Quarterly|HalfYearly|Yearly
 * @param {Date}   refDate    any date inside the period being reported
 */
function generatePeriodReports_(periodType, refDate, actor) {
  var outcome = ReportService.generateAll(periodType, refDate, actor || 'trigger');
  var report = outcome.report;

  if (CFG.bool('EmailPeriodReportToAdmins', true)) {
    var admins = StaffService.adminEmails();
    if (admins.length) {
      var pdf = null;
      try { pdf = ReportService.exportPdf(periodType, refDate, '', actor || 'trigger'); }
      catch (e) { Log.exception('generatePeriodReports_/exportPdf', e); }
      Notify.periodReport(admins,
        periodType + ' report — ' + report.periodLabel,
        ReportService.toHtml(report),
        pdf ? pdf.url : '');
    }
  }

  NotificationService.pushAdmins('ReportReady', 'info',
    periodType + ' report ready — ' + report.periodLabel,
    outcome.persisted + ' staff report(s) saved. ' +
    report.totals.tasksCompleted + ' task(s) completed, ' +
    Util.fmtMoney(report.totals.netPayable) + ' payable.');

  return outcome;
}

/** Email each staff member their own report for the period. */
function emailStaffReports_(report) {
  if (!CFG.bool('EmailMonthlyReportToStaff', true)) return { sent: 0, skipped: true };
  var sent = 0;
  report.staff.forEach(function (entry) {
    if (!Util.isEmail(entry.email)) return;
    try {
      Notify.periodReport(entry.email,
        'Your ' + report.periodType.toLowerCase() + ' report — ' + report.periodLabel,
        ReportService.toHtml({
          periodType: report.periodType,
          periodLabel: report.periodLabel,
          periodStart: report.periodStart,
          periodEnd: report.periodEnd,
          generatedAt: report.generatedAt,
          company: report.company,
          currency: report.currency,
          totals: report.totals,
          staff: [entry]
        }), '');
      NotificationService.push(entry.staffId, 'ReportReady', 'info',
        'Your ' + report.periodType.toLowerCase() + ' report is ready',
        entry.appraisal.remark);
      sent++;
    } catch (e) { Log.exception('emailStaffReports_(' + entry.staffId + ')', e); }
  });
  return { sent: sent };
}

/**
 * 1st of the month, 02:00 — the master-prompt trigger. Reports for the month
 * that just ended, plus any quarter/half-year/year that also just ended, plus
 * a draft payroll run and the monthly strike reset (if that policy is on).
 */
function generateMonthlyReports() {
  return runTrigger_('generateMonthlyReports', function () {
    var lastMonth = Util.addMonths(Util.today(), -1);
    var out = { monthly: null, quarterly: null, halfYearly: null, yearly: null,
                staffEmails: null, payroll: null, strikeReset: null };

    out.monthly = generatePeriodReports_('Monthly', lastMonth, 'trigger');
    out.staffEmails = emailStaffReports_(out.monthly.report);

    // A month that closes a quarter / half / year closes those periods too.
    var month = lastMonth.getMonth() + 1;                 // 1-12
    if (month % 3 === 0) out.quarterly = generatePeriodReports_('Quarterly', lastMonth, 'trigger');
    if (month === 6 || month === 12) out.halfYearly = generatePeriodReports_('HalfYearly', lastMonth, 'trigger');
    if (month === 12) out.yearly = generatePeriodReports_('Yearly', lastMonth, 'trigger');

    if (CFG.bool('AutoRunPayrollWithReports', true)) {
      out.payroll = PayrollService.runPeriod('Monthly', lastMonth, 'trigger');
    }

    // No-op unless Config.StrikeResetPolicy = 'Monthly'.
    out.strikeReset = StrikeService.monthlyReset();
    return out;
  });
}

/** Every Monday, 02:00 — report on the week that just ended. */
function generateWeeklyReports() {
  return runTrigger_('generateWeeklyReports', function () {
    return generatePeriodReports_('Weekly', Util.addDays(Util.today(), -3), 'trigger');
  });
}

/** Manual: quarterly rollup for the quarter containing refDate (or last one). */
function generateQuarterlyReports() {
  return runTrigger_('generateQuarterlyReports', function () {
    return generatePeriodReports_('Quarterly', Util.addMonths(Util.today(), -1), 'manual');
  });
}

/** Manual: half-year rollup. */
function generateHalfYearlyReports() {
  return runTrigger_('generateHalfYearlyReports', function () {
    return generatePeriodReports_('HalfYearly', Util.addMonths(Util.today(), -1), 'manual');
  });
}

/** Manual: full-year rollup. */
function generateYearlyReports() {
  return runTrigger_('generateYearlyReports', function () {
    return generatePeriodReports_('Yearly', Util.addMonths(Util.today(), -1), 'manual');
  });
}

/* ---------------------------------------------------------------------------
 * Manual "run everything now" helpers (spreadsheet menu + admin Settings)
 * ------------------------------------------------------------------------- */

/**
 * Run the whole daily chain in schedule order. Used by the menu item and the
 * admin dashboard's "Run automation now" button, and handy for testing.
 */
function runDailyAutomationNow() {
  var steps = [
    { name: 'activateScheduledTasks', run: activateScheduledTasks },
    { name: 'checkDailyReports',      run: checkDailyReports },
    { name: 'sweepAttendance',        run: sweepAttendance },
    { name: 'processDailyRollover',   run: processDailyRollover }
  ];
  var results = steps.map(function (s) { return s.run(); });
  var failed = results.filter(function (r) { return !r.ok; });

  Log.info('Triggers', 'runDailyAutomationNow — ' +
    (results.length - failed.length) + '/' + results.length + ' step(s) ok');

  return {
    ran: results.length,
    failed: failed.length,
    steps: results.map(function (r) {
      return { trigger: r.trigger, ok: r.ok, error: r.error || '', result: r.result };
    })
  };
}

/** Menu helper: generate reports for the month that just ended, right now. */
function generateMonthlyReportsNow() {
  var out = generateMonthlyReports();
  try {
    SpreadsheetApp.getUi().alert(out.ok
      ? 'Monthly reports generated for ' + out.result.monthly.report.periodLabel + '.\n\n' +
        out.result.monthly.persisted + ' staff report(s) saved to PeriodReports.'
      : 'Report generation failed:\n\n' + out.error);
  } catch (e) { /* no UI when run headless */ }
  return out;
}

/** Menu helper: run one named trigger by name from the admin Settings screen. */
function runTriggerByName(name) {
  var map = {
    activateScheduledTasks: activateScheduledTasks,
    sendAttendanceReminder: sendAttendanceReminder,
    checkDailyReports: checkDailyReports,
    sweepAttendance: sweepAttendance,
    processDailyRollover: processDailyRollover,
    generateWeeklyReports: generateWeeklyReports,
    generateMonthlyReports: generateMonthlyReports,
    generateQuarterlyReports: generateQuarterlyReports,
    generateHalfYearlyReports: generateHalfYearlyReports,
    generateYearlyReports: generateYearlyReports,
    runDailyAutomationNow: runDailyAutomationNow
  };
  if (!map[name]) throw new Error('Unknown automation: ' + name);
  return map[name]();
}
