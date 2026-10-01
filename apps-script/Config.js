/**
 * ============================================================================
 * Config.gs — Single source of truth for sheet names, schemas and settings.
 * ============================================================================
 * Nothing anywhere else in this project should contain a hard-coded sheet
 * name, column name or deadline. If you need a new tunable, add it to
 * DEFAULT_CONFIG below and read it with CFG.get('YourKey').
 *
 * Column access is by HEADER NAME (see SheetDB.gs), not index, so inserting a
 * column in the middle of a sheet will never break the code.
 * ============================================================================
 */

/** PropertiesService key holding the bound spreadsheet id. */
var PROP_SPREADSHEET_ID = 'SPREADSHEET_ID';

/** PropertiesService key prefix used by the ID sequence generator. */
var PROP_SEQ_PREFIX = 'SEQ_';

/** Sheet (table) names. */
var SHEETS = {
  STAFF:           'Staff',
  TASKS:           'Tasks',
  DAILY_REPORTS:   'DailyTaskReports',
  ATTENDANCE:      'Attendance',
  STRIKES:         'Strikes',
  SUSPENSIONS:     'Suspensions',
  PERIOD_REPORTS:  'PeriodReports',
  PAYROLL:         'Payroll',
  UPLOADS:         'Uploads',
  NOTIFICATIONS:   'Notifications',
  HOLIDAYS:        'Holidays',
  CONFIG:          'Config',
  LOGS:            'Logs',
  EMAIL_TEMPLATES: 'EmailTemplates'
};

/**
 * Header row for every sheet. Setup.gs creates the tabs from this map and
 * repairs any sheet whose headers have drifted.
 */
var SCHEMA = {};

SCHEMA[SHEETS.STAFF] = [
  'StaffID', 'Name', 'Email', 'Phone', 'Role', 'Department', 'Position',
  'DateAdded', 'Status', 'StrikeCount', 'FlaggedStatus', 'SuspendedAt',
  'SuspensionCount', 'TotalStrikesIssued', 'ClearedAt', 'ClearedBy',
  'ClearanceNote', 'PinHash', 'PinSalt', 'LastLogin', 'PhotoUrl', 'Notes',
  'MonthlySalary', 'AccessLevel', 'CanAssignTasks'
];

SCHEMA[SHEETS.TASKS] = [
  'TaskID', 'Title', 'Description', 'TaskType', 'Priority', 'AssignedTo',
  'AssignedToName', 'AssignedBy', 'StartDate', 'DueDate', 'OriginalDueDate',
  'AmountAllocated', 'Status', 'ReportedProgress', 'ValidatedProgress',
  'PayableAmount', 'AcknowledgedAt', 'SubmittedAt', 'ValidatedAt',
  'ValidatedBy', 'CompletedAt', 'MetricScore', 'AdminRating', 'AdminComment',
  'RolloverCount', 'WarningsIssued', 'IsPriority', 'ParentTaskID',
  'AttachmentUrl', 'CreatedAt', 'LastUpdated',
  'EscalatedTo', 'EscalatedToName', 'EscalatedBy', 'EscalatedAt',
  'EscalationStatus', 'ResolvedAt'
];

SCHEMA[SHEETS.DAILY_REPORTS] = [
  'ReportID', 'TaskID', 'StaffID', 'ReportDate', 'ReportText',
  'ProgressPercent', 'HoursSpent', 'Blockers', 'AttachmentUrl', 'SubmittedAt',
  'OnTime', 'ReviewStatus', 'ReviewedBy', 'ReviewedAt', 'ReviewComment'
];

SCHEMA[SHEETS.ATTENDANCE] = [
  'AttendanceID', 'StaffID', 'StaffName', 'Date', 'LoginTime', 'LogoutTime',
  'Status', 'MinutesLate', 'Notes', 'RecordedAt'
];

SCHEMA[SHEETS.STRIKES] = [
  'StrikeID', 'StaffID', 'StaffName', 'Date', 'TaskID', 'Category', 'Reason',
  'StrikeNumber', 'PenaltyApplied', 'PenaltyAmount', 'Status', 'IssuedAt',
  'ClearedAt', 'ClearedBy', 'ClearanceNote'
];

SCHEMA[SHEETS.SUSPENSIONS] = [
  'SuspensionID', 'StaffID', 'StaffName', 'StartDate', 'Reason',
  'TriggerStrikeID', 'Status', 'LiftedAt', 'LiftedBy', 'ClearanceNote',
  'RecordedAt'
];

SCHEMA[SHEETS.PERIOD_REPORTS] = [
  'ReportID', 'StaffID', 'StaffName', 'PeriodType', 'PeriodLabel',
  'PeriodStart', 'PeriodEnd', 'WorkingDays', 'DaysPresent', 'DaysLate',
  'DaysAbsent', 'AttendanceRate', 'TasksAssigned', 'TasksCompleted',
  'TasksPendingValidation', 'TasksInProgress', 'TasksFailed',
  'TasksRolledOver', 'CompletionRate', 'AvgValidatedProgress',
  'AvgMetricScore', 'DailyReportsExpected', 'DailyReportsSubmitted',
  'OnTimeReports', 'StrikesIssued', 'ActiveStrikes', 'Suspensions',
  'GrossAllocated', 'EarnedAmount', 'PenaltyTotal', 'NetPayable',
  'Strengths', 'Weaknesses', 'Remark', 'GeneratedAt', 'GeneratedBy'
];

SCHEMA[SHEETS.PAYROLL] = [
  'PayrollID', 'StaffID', 'StaffName', 'PeriodType', 'PeriodLabel',
  'PeriodStart', 'PeriodEnd', 'TasksConsidered', 'GrossAllocated',
  'ProgressEarned', 'Penalties', 'Adjustments', 'NetPay', 'Status',
  'ApprovedBy', 'ApprovedAt', 'PaidAt', 'Reference', 'Notes', 'CreatedAt',
  'GuaranteedSalary', 'Forfeited', 'LateDeduction'
];

SCHEMA[SHEETS.UPLOADS] = [
  'UploadID', 'StaffID', 'UploaderEmail', 'UploaderRole', 'TaskID',
  'FileName', 'MimeType', 'SizeBytes', 'DriveFileID', 'DriveUrl', 'Category',
  'Visibility', 'AudienceStaffIDs', 'Description', 'UploadedAt', 'Status'
];

SCHEMA[SHEETS.NOTIFICATIONS] = [
  'NotificationID', 'StaffID', 'Audience', 'Type', 'Severity', 'Title',
  'Message', 'Link', 'Read', 'CreatedAt'
];

SCHEMA[SHEETS.HOLIDAYS] = ['Date', 'Name', 'Recurring'];

SCHEMA[SHEETS.CONFIG] = ['Key', 'Value', 'Category', 'Description'];

SCHEMA[SHEETS.LOGS] = ['Timestamp', 'Level', 'Source', 'Message', 'Details', 'User'];

SCHEMA[SHEETS.EMAIL_TEMPLATES] = [
  'TemplateID', 'Name', 'Subject', 'Body', 'CreatedBy', 'CreatedAt', 'UpdatedAt'
];

/* ---------------------------------------------------------------------------
 * Controlled vocabularies
 * ------------------------------------------------------------------------- */

/**
 * Task lifecycle.
 *
 * NOTE ON NAMING: the master prompt used "Pending" for a freshly assigned
 * task. The client-facing dashboard needs "Pending" to mean "submitted, yet
 * to be validated". To keep both unambiguous we use:
 *   ASSIGNED            = created / live, not yet acknowledged  (prompt's "Pending")
 *   PENDING_VALIDATION  = staff submitted, admin has not validated
 */
var TASK_STATUS = {
  SCHEDULED:          'Scheduled',
  ASSIGNED:           'Assigned',
  ACKNOWLEDGED:       'Acknowledged',
  IN_PROGRESS:        'InProgress',
  PENDING_VALIDATION: 'PendingValidation',
  COMPLETED:          'Completed',
  FAILED:             'Failed',
  CANCELLED:          'Cancelled'
};

/** Statuses that roll up into the dashboard's three headline buckets. */
var TASK_BUCKETS = {
  COMPLETED:  [TASK_STATUS.COMPLETED],
  PENDING:    [TASK_STATUS.PENDING_VALIDATION],
  IN_PROGRESS: [TASK_STATUS.ASSIGNED, TASK_STATUS.ACKNOWLEDGED, TASK_STATUS.IN_PROGRESS]
};

/** Statuses that still require work from the staff member. */
var TASK_OPEN_STATUSES = [
  TASK_STATUS.ASSIGNED, TASK_STATUS.ACKNOWLEDGED, TASK_STATUS.IN_PROGRESS
];

var TASK_TYPE = {
  DAILY:   'Daily',
  WEEKLY:  'Weekly',
  MONTHLY: 'Monthly',
  PROJECT: 'Project'
};

var PRIORITY_LADDER = ['Low', 'Normal', 'High', 'Critical'];

var STAFF_STATUS = {
  ACTIVE:    'Active',
  INACTIVE:  'Inactive',
  SUSPENDED: 'Suspended'
};

/**
 * Roles.
 * The four live roles are Management, Operations, Software Developer and Staff.
 * Legacy 'Admin' / 'Manager' rows are still honoured everywhere (see Auth.js):
 * a legacy Admin behaves as Management, a legacy Manager as Operations.
 */
var ROLES = {
  MANAGEMENT: 'Management',
  OPERATIONS: 'Operations',
  DEVELOPER:  'Software Developer',
  STAFF:      'Staff',
  ADMIN:      'Admin',      // legacy → treated as Management
  MANAGER:    'Manager'     // legacy → treated as Operations
};

/** The four roles offered in the UI when creating or editing staff. */
var ASSIGNABLE_ROLES = [ROLES.MANAGEMENT, ROLES.OPERATIONS, ROLES.DEVELOPER, ROLES.STAFF];

var ATTENDANCE_STATUS = {
  ON_TIME: 'OnTime',
  LATE:    'Late',
  ABSENT:  'Absent',
  LEAVE:   'Leave',
  HOLIDAY: 'Holiday'
};

var STRIKE_CATEGORY = {
  MISSED_DAILY_REPORT: 'MissedDailyReport',
  MISSED_ATTENDANCE:   'MissedAttendance',
  TASK_ROLLOVER:       'TaskRollover',
  TASK_FAILED:         'TaskFailed',
  MANUAL:              'Manual'
};

var PERIOD_TYPES = [
  'Daily', 'Weekly', 'Monthly', 'Quarterly', 'HalfYearly', 'Yearly'
];

/* ---------------------------------------------------------------------------
 * Default configuration — seeded into the Config sheet on first setup.
 * Edit values in the SHEET (not here) once the system is live.
 * ------------------------------------------------------------------------- */
var DEFAULT_CONFIG = [
  // --- Organisation -------------------------------------------------------
  ['CompanyName',                  'EasyTech',        'Organisation', 'Shown in the UI header and all emails.'],
  ['CompanyLogoUrl',               '',                'Organisation', 'Direct image URL (https://...) for the company logo. When set it replaces the tick beside the company name in the app and in emails. Blank = show the tick.'],
  ['Currency',                     '₦',          'Organisation', 'Currency symbol used in the UI.'],
  ['CurrencyCode',                 'NGN',             'Organisation', 'ISO code used in reports and payslips.'],
  ['AdminEmails',                  '',                'Organisation', 'Comma-separated admin recipients for alerts. Blank = every Staff row with Role=Admin.'],
  ['Timezone',                     'Africa/Lagos',    'Organisation', 'Timezone for all date maths, deadlines and triggers.'],

  // --- Working calendar ---------------------------------------------------
  ['WorkWeekDays',                 '1,2,3,4,5',       'Calendar',     'Working days. 0=Sunday .. 6=Saturday.'],
  ['AttendanceDeadline',           '09:00',           'Calendar',     'Sign-in at or before this time counts as OnTime.'],
  ['AttendanceGraceMinutes',       '5',               'Calendar',     'Minutes of grace added to AttendanceDeadline before Late is recorded.'],
  ['DailyReportDeadline',          '18:00',           'Calendar',     'Daily task report must be submitted by this time.'],

  // --- Task rules ---------------------------------------------------------
  ['RolloverEnabled',              'TRUE',            'Tasks',        'Roll incomplete Daily tasks to the next working day.'],
  ['RolloverStrikePerDay',         'TRUE',            'Tasks',        'Issue one strike per rollover day.'],
  ['RolloverEscalatePriority',     'TRUE',            'Tasks',        'Bump priority one level on each rollover (Normal->High->Critical).'],
  ['MaxRolloverDays',              '3',               'Tasks',        'After this many rollovers the task stops rolling (see FailTaskOnFinalStrike).'],
  ['FailTaskOnFinalStrike',        'TRUE',            'Tasks',        'Mark the task Failed when the final rollover strike lands.'],
  ['FailOverdueNonDailyTasks',     'TRUE',            'Tasks',        'Weekly/Monthly/Project tasks become Failed once DueDate passes.'],
  ['StrikeOnFailedTask',           'TRUE',            'Tasks',        'Issue a strike when a non-daily task fails.'],
  ['RequireAcknowledgement',       'TRUE',            'Tasks',        'Task must be acknowledged before progress can be reported.'],
  ['RequireDailyReportToSubmit',   'TRUE',            'Tasks',        'A task needs at least one daily report before it can be submitted for validation.'],

  // --- Strikes, suspension ------------------------------------------------
  ['StrikeLimit',                  '3',               'Discipline',   'Active strikes that trigger suspension.'],
  ['StrikeResetPolicy',            'ManualClearanceOnly', 'Discipline', 'ManualClearanceOnly | Monthly. Cleared strikes are never deleted.'],
  ['Strike1PenaltyPercent',        '0',               'Discipline',   'Percent of the task amount deducted on strike 1.'],
  ['Strike2PenaltyPercent',        '0',               'Discipline',   'Percent of the task amount deducted on strike 2.'],
  ['Strike3PenaltyPercent',        '0',               'Discipline',   'Percent deducted on strike 3. Suspension is the primary penalty.'],
  ['SuspensionBlocksNewTasks',     'TRUE',            'Discipline',   'Suspended staff cannot be assigned new tasks.'],
  ['SuspensionBlocksPortal',       'TRUE',            'Discipline',   'Suspended staff can view but not act in the portal.'],
  ['StrikeOnAbsence',              'FALSE',           'Discipline',   'Issue a strike for an unexcused absence.'],

  // --- Pay ----------------------------------------------------------------
  ['PayProgressSource',            'AdminValidated',  'Payroll',      'AdminValidated | ReportedProgress. Confirmed decision: AdminValidated.'],
  ['MinProgressForPay',            '0',               'Payroll',      'Validated progress below this percent pays nothing.'],
  ['PayRoundTo',                   '2',               'Payroll',      'Decimal places for money.'],
  ['DefaultPayrollPeriod',         'Monthly',         'Payroll',      'Period used by the payroll screen on first load.'],
  ['LateDeductionPerDay',          '500',             'Payroll',      'Flat amount deducted from pay for each late sign-in in the period.'],

  // --- Guaranteed salary -> automatic task allocation ----------------------
  // Each staff member has a guaranteed monthly salary (Staff.MonthlySalary).
  // That figure is shared across the tasks whose DueDate falls in the month and
  // each task then pays out on its completion percentage, so nobody types an
  // allocation by hand. Set AutoAllocateFromSalary to FALSE to go back to
  // typing amounts per task.
  ['AutoAllocateFromSalary',       'TRUE',            'Payroll',      'TRUE: task allocations are derived from the guaranteed monthly salary. FALSE: enter the amount per task manually.'],
  ['DefaultMonthlySalary',         '0',               'Payroll',      'Guaranteed monthly salary used for staff with no figure of their own.'],
  ['TaskAllocationMode',           'Equal',           'Payroll',      'Equal: every task in the month gets the same share. Weighted: share by task priority using TaskAllocationWeights.'],
  ['TaskAllocationWeights',        'Low:1,Normal:1,High:1.5,Critical:2', 'Payroll', 'Priority weights used when TaskAllocationMode is Weighted.'],

  // --- Metric score weights (must total 100) ------------------------------
  ['MetricWeightReportTimeliness', '40',              'Scoring',      'Weight for on-time daily reports.'],
  ['MetricWeightOnTimeCompletion', '40',              'Scoring',      'Weight for finishing on or before DueDate.'],
  ['MetricWeightAdminRating',      '20',              'Scoring',      'Weight for the admin quality rating (0-100).'],
  ['DefaultAdminRating',           '80',              'Scoring',      'Rating used when the admin does not supply one.'],

  // --- Google Drive uploads ----------------------------------------------
  ['DriveRootFolderId',            '',                'Drive',        'Leave blank to auto-create a root folder on first upload.'],
  ['DriveRootFolderName',          'StaffMS-Uploads', 'Drive',        'Name used when auto-creating the root folder.'],
  ['DriveSharingMode',             'Explicit',        'Drive',        'Explicit = share only with uploader/admins/audience. LinkAnyone = anyone with the link can view.'],
  ['MaxUploadMB',                  '25',              'Drive',        'Largest single upload accepted.'],
  ['AllowedUploadExtensions',      'pdf,doc,docx,xls,xlsx,ppt,pptx,csv,txt,png,jpg,jpeg,gif,zip,mp4', 'Drive', 'Comma-separated whitelist. Blank = allow everything.'],

  // --- Auth ---------------------------------------------------------------
  ['AuthMode',                     'Hybrid',          'Auth',         'Hybrid | GoogleOnly | PinOnly. Confirmed decision: Hybrid.'],
  ['SessionTimeoutMinutes',        '480',             'Auth',         'PIN session lifetime.'],
  ['DefaultPin',                   '',                'Auth',         'Optional PIN given to new staff. Blank = a random PIN is generated and emailed.'],

  // --- Time-driven triggers (hour of day, 0-23, in Timezone) --------------
  ['TriggerActivateHour',          '6',               'Triggers',     'Hour to activate scheduled tasks whose StartDate has arrived.'],
  ['TriggerAttendanceReminderHour','8',               'Triggers',     'Hour to nudge staff who have not signed attendance. Keep it before AttendanceDeadline.'],
  ['TriggerReportCheckHour',       '19',              'Triggers',     'Hour to check for missing daily reports. Keep it after DailyReportDeadline.'],
  ['TriggerAttendanceSweepHour',   '21',              'Triggers',     'Hour to mark non-signers Absent.'],
  ['TriggerRolloverHour',          '22',              'Triggers',     'Hour to roll incomplete daily tasks into the next working day.'],
  ['TriggerPeriodReportHour',      '2',               'Triggers',     'Hour on the 1st of the month for report generation.'],
  ['AutoRunPayrollWithReports',    'TRUE',            'Triggers',     'Also build draft payroll when the monthly report runs.'],

  // --- Notifications ------------------------------------------------------
  ['EmailNotificationsEnabled',    'TRUE',            'Notifications', 'Master switch for all outbound email.'],
  ['SenderEmail',                  '',                'Notifications', 'Designated sender address for every outbound email. Must be the deploying Google account or one of its verified Gmail aliases to appear as the From address; otherwise it is used as Reply-To. Blank = the deploying account.'],
  ['SenderName',                   '',                'Notifications', 'Display name shown on outbound email. Blank = CompanyName.'],
  ['EmailPeriodReportToAdmins',    'TRUE',            'Notifications', 'Email the organisation-wide report to admins after each generation.'],
  ['NotifyStaffOnAssignment',      'TRUE',            'Notifications', 'Email staff when a task goes live.'],
  ['NotifyStaffOnStrike',          'TRUE',            'Notifications', 'Email staff on every strike.'],
  ['NotifyAdminOnStrike2',         'TRUE',            'Notifications', 'Copy admins from strike 2 onward.'],
  ['EmailMonthlyReportToStaff',    'TRUE',            'Notifications', 'Send each staff member their own monthly report.'],
  ['WebAppUrl',                    '',                'Notifications', 'Deployed web app URL. Used for links inside emails.']
];

/* ---------------------------------------------------------------------------
 * CFG — configuration accessor with per-execution caching.
 * ------------------------------------------------------------------------- */
var CFG = (function () {
  var cache = null;

  function load() {
    if (cache) return cache;
    cache = {};
    // Seed with defaults so a missing row never throws.
    DEFAULT_CONFIG.forEach(function (row) { cache[row[0]] = String(row[1]); });
    try {
      var rows = SheetDB.readAll(SHEETS.CONFIG);
      rows.forEach(function (r) {
        if (r.Key !== '' && r.Key !== null && r.Key !== undefined) {
          cache[String(r.Key).trim()] = r.Value === null || r.Value === undefined ? '' : String(r.Value);
        }
      });
    } catch (err) {
      // Config sheet not created yet — defaults are enough to run Setup.
      Logger.log('CFG.load fell back to defaults: ' + err);
    }
    return cache;
  }

  return {
    /** Raw string value. */
    get: function (key, fallback) {
      var v = load()[key];
      return (v === undefined || v === '') ? (fallback === undefined ? '' : fallback) : v;
    },
    /** Numeric value. */
    num: function (key, fallback) {
      var v = parseFloat(this.get(key, ''));
      return isNaN(v) ? (fallback === undefined ? 0 : fallback) : v;
    },
    /** Boolean value. Accepts TRUE/true/1/yes. */
    bool: function (key, fallback) {
      var v = String(this.get(key, '')).trim().toLowerCase();
      if (v === '') return fallback === undefined ? false : fallback;
      return v === 'true' || v === '1' || v === 'yes' || v === 'y';
    },
    /** Comma-separated value as a trimmed array. */
    list: function (key) {
      return String(this.get(key, '')).split(',')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s !== ''; });
    },
    /** Every key/value pair (used by the Settings screen). */
    all: function () {
      var snapshot = load(), out = {};
      Object.keys(snapshot).forEach(function (k) { out[k] = snapshot[k]; });
      return out;
    },
    /** Write one key back to the Config sheet and invalidate the cache. */
    set: function (key, value) {
      var rows = SheetDB.readAll(SHEETS.CONFIG);
      var match = null;
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].Key).trim() === key) { match = rows[i]; break; }
      }
      if (match) {
        SheetDB.updateRowAt(SHEETS.CONFIG, match.__row, { Value: value });
      } else {
        SheetDB.insert(SHEETS.CONFIG, { Key: key, Value: value, Category: 'Custom', Description: '' });
      }
      this.flush();
    },
    /** Drop the cache (call after bulk config writes). */
    flush: function () { cache = null; }
  };
})();

/** Script timezone honouring the Config override. */
function getTz() {
  return CFG.get('Timezone', Session.getScriptTimeZone() || 'Africa/Lagos');
}
