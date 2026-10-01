/**
 * ============================================================================
 * WebApp.gs — HtmlService entry point and the whole client API surface.
 * ============================================================================
 * The browser never touches the spreadsheet. It calls api_* functions through
 * google.script.run; each one is wrapped by withApi() which
 *
 *   • resolves the caller (Google SSO or PIN session token),
 *   • enforces the role gate,
 *   • wraps every write in SheetDB.withLock(),
 *   • catches everything and returns {ok:false, error:'...'} instead of an
 *     unhandled exception, so the UI can always show a clean message.
 *
 * Response envelope: { ok:boolean, data:any, error:string, authRequired:bool }
 * ============================================================================
 */

/* ---------------------------------------------------------------------------
 * HtmlService
 * ------------------------------------------------------------------------- */

function doGet(e) {
  var params = (e && e.parameter) || {};
  var page = String(params.page || '').toLowerCase();
  // Support a bare ?admin / ?management as shorthand for ?page=admin so a
  // simple "…/exec?admin" link opens the management entrance too.
  if (!page && (params.admin !== undefined || params.management !== undefined)) page = 'admin';
  if (page === 'management') page = 'admin';
  if (page !== 'admin') page = 'app';
  var company = CFG.get('CompanyName', 'Staff Management');
  var tpl = HtmlService.createTemplateFromFile('Index');
  tpl.bootPage = page;
  tpl.companyName = company;
  tpl.companyLogoUrl = String(CFG.get('CompanyLogoUrl', '')).trim();
  // Absolute /exec URL so the client can build cross-door links (already used
  // by Notifications; no extra OAuth scope).
  try { tpl.scriptUrl = ScriptApp.getService().getUrl() || ''; } catch (err) { tpl.scriptUrl = ''; }
  return tpl.evaluate()
    .setTitle(company + (page === 'admin' ? ' — Management' : ' — Workspace'))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Used by the templates: <?!= include('Styles') ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ---------------------------------------------------------------------------
 * API plumbing
 * ------------------------------------------------------------------------- */

/**
 * Run an API body with auth, locking and error handling.
 * @param {Object} o {token, admin:boolean, write:boolean, name:string}
 * @param {Function} body receives the resolved Staff row
 */
function withApi_(o, body) {
  try {
    var staff = o.management ? Auth.requireManagement(o.token)
  : o.admin ? Auth.requireAdmin(o.token)
  : o.taskManager ? Auth.requireTaskManager(o.token)
  : Auth.requireStaff(o.token);
    var run = function () { return body(staff); };
    var data = o.write ? SheetDB.withLock(run, 25000) : run();
    return { ok: true, data: data };
  } catch (err) {
    var message = String(err && err.message ? err.message : err);
    if (message === 'AUTH_REQUIRED') {
      return { ok: false, authRequired: true, error: 'Please sign in again.' };
    }
    Log.warn('API', (o.name || 'api') + ' failed', message);
    return { ok: false, error: message };
  }
}

/** Same envelope for calls that must work before anybody is signed in. */
function withPublic_(name, body) {
  try {
    return { ok: true, data: body() };
  } catch (err) {
    var message = String(err && err.message ? err.message : err);
    Log.warn('API', name + ' failed', message);
    return { ok: false, error: message };
  }
}

/* ---------------------------------------------------------------------------
 * Serialisers — the only shapes the browser ever sees
 * ------------------------------------------------------------------------- */

function mapTask_(t) {
  var todayKey = Util.dateKey(Util.today());
  var dueKey = Util.dateKey(t.DueDate);
  var open = TaskService.isOpen(t.Status);
  return {
    taskId: String(t.TaskID),
    title: String(t.Title),
    description: String(t.Description || ''),
    taskType: String(t.TaskType),
    priority: String(t.Priority),
    isPriority: Util.truthy(t.IsPriority),
    assignedTo: String(t.AssignedTo),
    assignedToName: String(t.AssignedToName || StaffService.name(t.AssignedTo)),
    assignedBy: String(t.AssignedBy || ''),
    startDate: Util.dateKey(t.StartDate),
    dueDate: dueKey,
    originalDueDate: Util.dateKey(t.OriginalDueDate),
    dueLabel: Util.fmtDate(t.DueDate),
    status: String(t.Status),
    bucket: TaskService.bucketOf(t.Status) || '',
    amountAllocated: Util.money(t.AmountAllocated),
    reportedProgress: Util.pct(t.ReportedProgress),
    validatedProgress: Util.pct(t.ValidatedProgress),
    effectiveProgress: TaskService.effectiveProgress(t),
    payable: TaskService.payableAmount(t),
    metricScore: t.MetricScore === '' ? null : Util.num(t.MetricScore, 0),
    adminRating: t.AdminRating === '' ? null : Util.num(t.AdminRating, 0),
    adminComment: String(t.AdminComment || ''),
    rolloverCount: Util.num(t.RolloverCount, 0),
    warnings: Util.num(t.WarningsIssued, 0),
    attachmentUrl: String(t.AttachmentUrl || ''),
    acknowledged: !!t.AcknowledgedAt,
    submittedAt: Util.fmtDateTime(t.SubmittedAt),
    validatedBy: String(t.ValidatedBy || ''),
    completedAt: Util.dateKey(t.CompletedAt),
    overdue: open && dueKey !== '' && dueKey < todayKey,
    dueToday: dueKey === todayKey,
    reportedToday: DailyReportService.existsFor(t.TaskID, todayKey),
    // Escalation (requirement 3) — the task stays assigned to its owner; these
    // fields describe the developer it was handed to and whether it is resolved.
    escalatedTo: String(t.EscalatedTo || ''),
    escalatedToName: String(t.EscalatedToName ||
      (t.EscalatedTo ? StaffService.name(t.EscalatedTo) : '')),
    escalatedBy: String(t.EscalatedBy || ''),
    escalatedAt: Util.fmtDateTime(t.EscalatedAt),
    escalationStatus: String(t.EscalationStatus || ''),
    escalated: String(t.EscalationStatus || '') === 'Open',
    resolved: String(t.EscalationStatus || '') === 'Resolved',
    resolvedAt: Util.dateKey(t.ResolvedAt),
    isFollowUp: /^\s*Follow-up:/i.test(String(t.Title || ''))
  };
}

function mapDailyReport_(r) {
  return {
    reportId: String(r.ReportID),
    taskId: String(r.TaskID),
    taskTitle: (function () {
      var t = TaskService.byId(r.TaskID);
      return t ? String(t.Title) : '(task removed)';
    })(),
    staffId: String(r.StaffID),
    staffName: StaffService.name(r.StaffID),
    reportDate: Util.dateKey(r.ReportDate),
    reportText: String(r.ReportText || ''),
    progressPercent: Util.pct(r.ProgressPercent),
    hoursSpent: Util.num(r.HoursSpent, 0),
    blockers: String(r.Blockers || ''),
    attachmentUrl: String(r.AttachmentUrl || ''),
    submittedAt: Util.fmtDateTime(r.SubmittedAt),
    onTime: Util.truthy(r.OnTime),
    reviewStatus: String(r.ReviewStatus || 'Pending'),
    reviewComment: String(r.ReviewComment || '')
  };
}

function mapStrike_(s) {
  return {
    strikeId: String(s.StrikeID),
    staffId: String(s.StaffID),
    staffName: StaffService.name(s.StaffID),
    date: Util.dateKey(s.Date),
    taskId: String(s.TaskID || ''),
    category: String(s.Category),
    reason: String(s.Reason),
    strikeNumber: Util.num(s.StrikeNumber, 0),
    penaltyPercent: Util.num(s.PenaltyPercent, 0),
    penaltyAmount: Util.money(s.PenaltyAmount),
    status: String(s.Status),
    issuedBy: String(s.IssuedBy || 'system'),
    clearedBy: String(s.ClearedBy || ''),
    clearedAt: Util.dateKey(s.ClearedAt),
    clearanceNote: String(s.ClearanceNote || '')
  };
}

function mapStaffRow_(s) {
  var board = TaskService.board(s.StaffID);
  return {
    staffId: String(s.StaffID),
    name: String(s.Name),
    email: String(s.Email),
    phone: String(s.Phone || ''),
    role: String(s.Role),
    department: String(s.Department || ''),
    position: String(s.Position || ''),
    status: String(s.Status),
    strikeCount: Util.num(s.StrikeCount, 0),
    flagged: Util.truthy(s.FlaggedStatus),
    suspended: String(s.Status) === STAFF_STATUS.SUSPENDED,
    suspendedAt: Util.dateKey(s.SuspendedAt),
    suspensionCount: Util.num(s.SuspensionCount, 0),
    totalStrikesIssued: Util.num(s.TotalStrikesIssued, 0),
    clearedAt: Util.dateKey(s.ClearedAt),
    clearedBy: String(s.ClearedBy || ''),
    clearanceNote: String(s.ClearanceNote || ''),
    lastLogin: Util.fmtDateTime(s.LastLogin),
    dateAdded: Util.dateKey(s.DateAdded),
    photoUrl: String(s.PhotoUrl || ''),
    notes: String(s.Notes || ''),
        monthlySalary: AllocationService.salaryOf(s),
    tasks: board,
    hasPin: !!s.PinHash,
    accessLevel: String(s.AccessLevel || 'Full'),
    canAssignTasks: Auth.isAdminRole(s.Role) || Util.truthy(s.CanAssignTasks),
    isManagement: Auth.isManagement(s.Role),
    isOperations: Auth.isOperations(s.Role),
    isDeveloper: Auth.isDeveloper(s.Role),
    canAccessPayroll: Auth.canAccessPayroll(s.Role)
  };
}

/** Config values the browser is allowed to know about. */
function clientConfig_() {
  return {
    companyName: CFG.get('CompanyName', 'Staff Management'),
    companyLogoUrl: String(CFG.get('CompanyLogoUrl', '')).trim(),
    currency: CFG.get('Currency', ''),
    timezone: getTz(),
    attendanceDeadline: CFG.get('AttendanceDeadline', '09:00'),
    dailyReportDeadline: CFG.get('DailyReportDeadline', '18:00'),
    strikeLimit: CFG.num('StrikeLimit', 3),
    maxRolloverDays: CFG.num('MaxRolloverDays', 3),
    payBasis: CFG.get('PayProgressSource', 'AdminValidated'),
    autoAllocateFromSalary: AllocationService.enabled(),
    allocationMode: AllocationService.mode(),
    defaultMonthlySalary: CFG.num('DefaultMonthlySalary', 0),
    maxUploadMB: CFG.num('MaxUploadMB', 25),
    allowedExtensions: CFG.list('AllowedUploadExtensions'),
    authMode: CFG.get('AuthMode', 'Hybrid'),
    periodTypes: ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'HalfYearly', 'Yearly'],
    taskTypes: [TASK_TYPE.DAILY, TASK_TYPE.WEEKLY, TASK_TYPE.MONTHLY, TASK_TYPE.PROJECT],
    priorities: PRIORITY_LADDER,
    statuses: TASK_STATUS,
    uploadCategories: UploadService.CATEGORIES,
    uploadVisibilities: UploadService.VISIBILITIES,
    today: Util.dateKey(Util.today()),
    roles: ASSIGNABLE_ROLES,
    escalationTargetRole: ROLES.DEVELOPER
  };
}

/* ---------------------------------------------------------------------------
 * Session
 * ------------------------------------------------------------------------- */

/**
 * First call from the browser. Never throws: an anonymous visitor gets
 * {signedIn:false} plus enough config to render the login screen.
 *
 * Requirement 8 — the login page always comes first. A session is proved by the
 * opaque token the browser holds, NOT by whichever Google account happens to be
 * signed in: the app runs as the deployment owner, so trusting the browser's
 * Google identity here would drop every visitor straight into the owner's
 * dashboard. googleMatch only tells the login screen whether the one-tap
 * "Continue as ..." button is worth offering.
 */
function api_bootstrap(token) {
  return withPublic_('bootstrap', function () {
    var staff = null;
    try { staff = Auth.staffByToken(token); } catch (e) { staff = null; }

    var setupNeeded = false;
    try { setupNeeded = SheetDB.count(SHEETS.STAFF) === 0; }
    catch (e) { setupNeeded = true; }   // tabs not created yet

    var googleEmail = '', googleMatch = false;
    try {
      googleEmail = Auth.googleEmail();
      if (googleEmail && CFG.get('AuthMode', 'Hybrid') !== 'PinOnly') {
        googleMatch = !!Auth.staffByEmail(googleEmail);
      }
    } catch (e) { googleEmail = ''; googleMatch = false; }

    return {
      signedIn: !!staff,
      googleEmail: googleEmail,
      googleMatch: googleMatch,
      profile: staff ? Auth.publicProfile(staff) : null,
      config: clientConfig_(),
      setupNeeded: setupNeeded
    };
  });
}

function api_login(payload) {
  return withPublic_('login', function () {
    payload = payload || {};
    var out = Auth.login(payload.email, payload.pin);
    return { token: out.token, profile: out.profile, config: clientConfig_() };
  });
}

/** One-tap sign-in for a Google account that is on staff. */
function api_loginGoogle() {
  return withPublic_('loginGoogle', function () {
    var out = Auth.loginWithGoogle();
    return { token: out.token, profile: out.profile, config: clientConfig_() };
  });
}

function api_logout(token) {
  return withPublic_('logout', function () { return Auth.logout(token); });
}

function api_changePin(token, payload) {
  return withApi_({ token: token, name: 'changePin', write: true }, function () {
    payload = payload || {};
    return Auth.changePin(token, payload.oldPin, payload.newPin);
  });
}

function api_resetPin(token, payload) {
  return withApi_({ token: token, admin: true, name: 'resetPin', write: true }, function () {
    return Auth.resetPin(token, (payload || {}).staffId);
  });
}

/* ---------------------------------------------------------------------------
 * Dashboards
 * ------------------------------------------------------------------------- */

/**
 * Requirement 3 — the admin dashboard. Three buckets (completed / pending
 * validation / in progress) plus attendance, discipline, money and charts.
 */
function api_adminDashboard(token, opts) {
  return withApi_({ token: token, admin: true, name: 'adminDashboard' }, function (admin) {
    opts = opts || {};
    TaskService.activateDueNow();   // scheduled tasks that are due go live now
    var periodType = opts.periodType || 'Monthly';
    var period = Util.resolvePeriod(periodType, opts.refDate);

    var tasks = TaskService.all().filter(function (t) {
      return String(t.Status) !== TASK_STATUS.CANCELLED;
    });
    var mapped = tasks.map(mapTask_);

    var byBucket = { completed: [], pending: [], inProgress: [], scheduled: [], failed: [] };
    mapped.forEach(function (t) {
      if (t.status === TASK_STATUS.SCHEDULED) byBucket.scheduled.push(t);
      else if (t.status === TASK_STATUS.FAILED) byBucket.failed.push(t);
      else if (t.bucket) byBucket[t.bucket].push(t);
    });

    var staffRows = StaffService.all().filter(function (s) {
      return String(s.Status) !== STAFF_STATUS.INACTIVE;
    });

    var performance = staffRows.map(function (s) {
      var stats = TaskService.statsFor(s.StaffID, period);
      var att = AttendanceService.statsFor(s.StaffID, period);
      var rep = DailyReportService.statsFor(s.StaffID, period);
      return {
        staffId: String(s.StaffID),
        name: String(s.Name),
        role: String(s.Role),
        department: String(s.Department || ''),
        photoUrl: String(s.PhotoUrl || ''),
        status: String(s.Status),
        strikeCount: Util.num(s.StrikeCount, 0),
        flagged: Util.truthy(s.FlaggedStatus),
        assigned: stats.assigned,
        completed: stats.completed,
        pendingValidation: stats.pendingValidation,
        inProgress: stats.inProgress,
        failed: stats.failed,
        completionRate: stats.completionRate,
        avgProgress: stats.avgProgress,
        avgMetricScore: stats.avgMetricScore,
        attendanceRate: att.attendanceRate,
        reportingRate: rep.submissionRate,
        grossAllocated: stats.grossAllocated,
        earned: stats.earned
      };
    }).sort(function (a, b) { return b.completionRate - a.completionRate; });

    return {
      period: {
        type: period.type, label: period.label,
        start: period.startKey, end: period.endKey
      },
      board: TaskService.board(null),
      buckets: {
        completed: byBucket.completed.slice(0, 50),
        pending: byBucket.pending.sort(function (a, b) {
          return String(a.submittedAt).localeCompare(String(b.submittedAt));
        }).slice(0, 50),
        inProgress: byBucket.inProgress.sort(function (a, b) {
          return String(a.dueDate).localeCompare(String(b.dueDate));
        }).slice(0, 50),
        scheduled: byBucket.scheduled.slice(0, 50),
        failed: byBucket.failed.slice(0, 50)
      },
      staffStats: StaffService.stats(),
      performance: performance,
      attendanceToday: AttendanceService.todayBoard(),
      // Every role except management signs attendance, and operations run the
      // admin dashboard — so hand the caller their own clock-in state here.
      // Management is exempt (exempt:true) and the client shows no card for it.
      myAttendance: {
        exempt: Auth.isAttendanceExempt(admin.Role),
        today: (function () {
          var r = AttendanceService.recordFor(admin.StaffID, Util.dateKey(Util.today()));
          return r ? {
            status: String(r.Status),
            loginTime: Util.fmtTime(r.LoginTime),
            logoutTime: Util.fmtTime(r.LogoutTime),
            minutesLate: Util.num(r.MinutesLate, 0)
          } : null;
        })(),
        signedIn: AttendanceService.hasSignedInToday(admin.StaffID),
        stats: (function () {
          var a = AttendanceService.statsFor(admin.StaffID, period);
          delete a.records;
          return a;
        })()
      },
      // Requirement 3 — only management sees payroll figures; operations run
      // the rest of the admin dashboard without pay data.
      payroll: Auth.isManagement(admin.Role)
        ? PayrollService.organisationSummary(period.type, period.start) : null,
      strikes: StrikeService.all().map(mapStrike_).sort(function (a, b) {
        return String(b.date).localeCompare(String(a.date));
      }).slice(0, 25),
      flagged: staffRows.filter(function (s) {
        return Util.truthy(s.FlaggedStatus) || String(s.Status) === STAFF_STATUS.SUSPENDED;
      }).map(mapStaffRow_),
      dailyReportsToday: DailyReportService.all().filter(function (r) {
        return Util.dateKey(r.ReportDate) === Util.dateKey(Util.today());
      }).map(mapDailyReport_),
      uploads: UploadService.stats(),
      recentUploads: UploadService.listFor(admin, {}).slice(0, 8),
      notifications: NotificationService.listFor(admin.StaffID, 12),
      unread: NotificationService.unreadCount(admin.StaffID),
      analytics: analyticsSeries_(period),
      assignableStaff: StaffService.assignable().map(function (s) {
        return { staffId: String(s.StaffID), name: String(s.Name),
                 department: String(s.Department || '') };
      }),
      generatedAt: Util.fmtDateTime(new Date())
    };
  });
}

/** The staff portal payload. */
function api_staffDashboard(token, opts) {
  return withApi_({ token: token, name: 'staffDashboard' }, function (staff) {
    opts = opts || {};
    // Requirement 3 — a task whose start date has arrived must be waiting for
    // the staff member even if the 6 a.m. activation trigger never fired.
    TaskService.activateDueNow();
    var period = Util.resolvePeriod(opts.periodType || 'Monthly', opts.refDate);
    var todayKey = Util.dateKey(Util.today());

    var mine = TaskService.forStaff(staff.StaffID)
      .filter(function (t) { return String(t.Status) !== TASK_STATUS.CANCELLED; })
      .map(mapTask_);

    var buckets = { completed: [], pending: [], inProgress: [], scheduled: [], failed: [] };
    mine.forEach(function (t) {
      if (t.status === TASK_STATUS.SCHEDULED) buckets.scheduled.push(t);
      else if (t.status === TASK_STATUS.FAILED) buckets.failed.push(t);
      else if (t.bucket) buckets[t.bucket].push(t);
    });

    var attendanceToday = AttendanceService.recordFor(staff.StaffID, todayKey);
    var pay = PayrollService.compute(staff.StaffID, period.type, period.start);

    return {
      profile: Auth.publicProfile(staff),
      period: { type: period.type, label: period.label,
                start: period.startKey, end: period.endKey },
      board: TaskService.board(staff.StaffID),
      buckets: buckets,
      // Requirement 3 — tasks handed to this person (a developer) to resolve.
      escalatedToMe: TaskService.forDeveloper(staff.StaffID).map(mapTask_),
      tasksNeedingReportToday: buckets.inProgress.filter(function (t) {
        return !t.reportedToday;
      }),
      attendance: {
        today: attendanceToday ? {
          status: String(attendanceToday.Status),
          loginTime: Util.fmtTime(attendanceToday.LoginTime),
          logoutTime: Util.fmtTime(attendanceToday.LogoutTime),
          minutesLate: Util.num(attendanceToday.MinutesLate, 0)
        } : null,
        signedIn: AttendanceService.hasSignedInToday(staff.StaffID),
        stats: (function () {
          var a = AttendanceService.statsFor(staff.StaffID, period);
          delete a.records;
          return a;
        })()
      },
      reporting: DailyReportService.statsFor(staff.StaffID, period),
      discipline: (function () {
        var d = StrikeService.statsFor(staff.StaffID, period);
        return {
          issued: d.issued, active: d.active, suspensions: d.suspensions,
          penaltyTotal: d.penaltyTotal, limit: CFG.num('StrikeLimit', 3),
          byCategory: d.byCategory,
          history: StrikeService.forStaff(staff.StaffID).map(mapStrike_)
            .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); }),
          lifetimeStrikes: Util.num(staff.TotalStrikesIssued, 0),
          lifetimeSuspensions: Util.num(staff.SuspensionCount, 0)
        };
      })(),
      pay: {
        periodLabel: pay.periodLabel,
        monthlySalary: pay.monthlySalary,
        guaranteed: pay.guaranteed,
        autoAllocated: pay.autoAllocated,
        grossAllocated: pay.grossAllocated,
        progressEarned: pay.progressEarned,
        forfeited: pay.forfeited,
        penalties: pay.penalties,
        adjustments: pay.adjustments,
        netPay: pay.netPay,
        heldPendingValidation: pay.unpaidBecauseUnvalidated,
        payoutRate: pay.payoutRate,
        payBasis: CFG.get('PayProgressSource', 'AdminValidated'),
        lines: pay.lines,
        history: PayrollService.historyFor(staff.StaffID)
      },
      myReports: DailyReportService.forStaff(staff.StaffID)
        .filter(function (r) { return Util.inPeriod(r.ReportDate, period); })
        .map(mapDailyReport_)
        .sort(function (a, b) { return String(b.reportDate).localeCompare(String(a.reportDate)); }),
      documents: UploadService.listFor(staff, {}).slice(0, 20),
      notifications: NotificationService.listFor(staff.StaffID, 15),
      unread: NotificationService.unreadCount(staff.StaffID),
      analytics: analyticsSeries_(period, staff.StaffID),
      generatedAt: Util.fmtDateTime(new Date())
    };
  });
}

/**
 * Chart data for the "Analytics" card: one bar per bucket inside the period
 * (day of week for Weekly/Daily, otherwise month/quarter buckets) plus the
 * semicircle gauge figures.
 */
function analyticsSeries_(period, staffId) {
  var tasks = (staffId ? TaskService.forStaff(staffId) : TaskService.all())
    .filter(function (t) { return String(t.Status) !== TASK_STATUS.CANCELLED; });

  var series = [];
  var pushBucket = function (label, from, to) {
    var fromKey = Util.dateKey(from), toKey = Util.dateKey(to);
    var completed = 0, total = 0, earned = 0;
    tasks.forEach(function (t) {
      var key = Util.dateKey(t.DueDate);
      if (!key || key < fromKey || key > toKey) return;
      total++;
      if (String(t.Status) === TASK_STATUS.COMPLETED) completed++;
      earned += TaskService.payableAmount(t);
    });
    series.push({ label: label, completed: completed, total: total,
                  earned: Util.money(earned) });
  };

  if (period.type === 'Weekly' || period.type === 'Daily') {
    var names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (var d = Util.startOfDay(period.start);
         Util.dateKey(d) <= period.endKey;
         d = Util.addDays(d, 1)) {
      pushBucket(names[d.getDay()], d, d);
    }
  } else if (period.type === 'Monthly') {
    // Four weekly bars inside the month.
    var wStart = Util.startOfDay(period.start), i = 1;
    while (Util.dateKey(wStart) <= period.endKey && i <= 6) {
      var wEnd = Util.addDays(wStart, 6);
      if (Util.dateKey(wEnd) > period.endKey) wEnd = Util.startOfDay(period.end);
      pushBucket('W' + i, wStart, wEnd);
      wStart = Util.addDays(wEnd, 1);
      i++;
    }
  } else {
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var m = Util.startOfDay(period.start);
    while (Util.dateKey(m) <= period.endKey) {
      var mEnd = Util.addDays(Util.addMonths(m, 1), -1);
      if (Util.dateKey(mEnd) > period.endKey) mEnd = Util.startOfDay(period.end);
      pushBucket(months[m.getMonth()], m, mEnd);
      m = Util.addDays(mEnd, 1);
    }
  }

  var inPeriodTasks = tasks.filter(function (t) { return Util.inPeriod(t.DueDate, period); });
  var counts = { completed: 0, pending: 0, inProgress: 0, other: 0 };
  inPeriodTasks.forEach(function (t) {
    var bucket = TaskService.bucketOf(t.Status);
    if (bucket) counts[bucket]++; else counts.other++;
  });
  var scored = inPeriodTasks.length || 1;

  return {
    series: series,
    gauge: {
      total: inPeriodTasks.length,
      completed: counts.completed,
      pending: counts.pending,
      inProgress: counts.inProgress,
      completedPct: Math.round(counts.completed / scored * 100),
      pendingPct: Math.round(counts.pending / scored * 100),
      inProgressPct: Math.round(counts.inProgress / scored * 100)
    }
  };
}

/* ---------------------------------------------------------------------------
 * Staff administration
 * ------------------------------------------------------------------------- */

function api_staffList(token) {
  return withApi_({ token: token, admin: true, name: 'staffList' }, function () {
    return StaffService.all().map(mapStaffRow_);
  });
}

/**
 * Light staff list for admin pickers (who to send a document to, who to assign
 * a task to). Deliberately cheap — no task boards, no strike maths.
 */
function api_staffDirectory(token) {
  return withApi_({ token: token, taskManager: true, name: 'staffDirectory' }, function () {
    return StaffService.all().filter(function (s) {
      return String(s.Status) !== STAFF_STATUS.INACTIVE;
    }).map(function (s) {
      return {
        staffId: String(s.StaffID),
        name: String(s.Name),
        email: String(s.Email),
        role: String(s.Role),
        department: String(s.Department || ''),
        status: String(s.Status)
      };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  });
}

function api_staffCreate(token, payload) {
  return withApi_({ token: token, admin: true, name: 'staffCreate', write: true },
    function (admin) {
      payload = payload || {};
      var role = String(payload.role || ROLES.STAFF).trim();
      if (!Auth.canGrantRole(admin.Role, role)) {
        throw new Error('Only management can grant the ' + role + ' role.');
      }
      return StaffService.create(payload, admin.Email);
    });
}

function api_staffUpdate(token, payload) {
  return withApi_({ token: token, admin: true, name: 'staffUpdate', write: true },
    function (admin) {
      payload = payload || {};
      if (payload.role !== undefined && !Auth.canGrantRole(admin.Role, payload.role)) {
        throw new Error('Only management can grant the ' + String(payload.role) + ' role.');
      }
      return StaffService.update(payload.staffId, payload, admin.Email);
    });
}

function api_staffSetStatus(token, payload) {
  return withApi_({ token: token, admin: true, name: 'staffSetStatus', write: true },
    function (admin) {
      payload = payload || {};
      return StaffService.setStatus(payload.staffId, payload.status, admin.Email, payload.note);
    });
}

/** Staff edits their own contact details. */
function api_updateMyProfile(token, payload) {
  return withApi_({ token: token, name: 'updateMyProfile', write: true }, function (staff) {
    payload = payload || {};
    return StaffService.update(staff.StaffID, {
      phone: payload.phone, department: staff.Department, position: staff.Position,
      photoUrl: payload.photoUrl
    }, staff.Email);
  });
}

/* ---------------------------------------------------------------------------
 * Discipline (requirement 2)
 * ------------------------------------------------------------------------- */

function api_strikeList(token, filters) {
  return withApi_({ token: token, admin: true, name: 'strikeList' }, function () {
    filters = filters || {};
    return SheetDB.find(SHEETS.STRIKES, function (s) {
      if (filters.staffId && String(s.StaffID) !== String(filters.staffId)) return false;
      if (filters.status && String(s.Status) !== filters.status) return false;
      return true;
    }).map(mapStrike_).sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });
  });
}

function api_strikeIssue(token, payload) {
  return withApi_({ token: token, admin: true, name: 'strikeIssue', write: true },
    function (admin) {
      payload = payload || {};
      return StrikeService.issueManual(payload.staffId, payload.reason, admin, payload.taskId);
    });
}

/**
 * Requirement 2 — manual clearance. The strike rows are marked Cleared, the
 * suspension is lifted, and the permanent counters are returned so the UI can
 * keep showing that the staff member HAS been struck/suspended before.
 */
function api_clearStrikes(token, payload) {
  return withApi_({ token: token, admin: true, name: 'clearStrikes', write: true },
    function (admin) {
      payload = payload || {};
      return StrikeService.clearRecord(payload.staffId, admin, payload.note);
    });
}

function api_suspendStaff(token, payload) {
  return withApi_({ token: token, admin: true, name: 'suspendStaff', write: true },
    function (admin) {
      payload = payload || {};
      return StrikeService.suspendManually(payload.staffId, payload.reason, admin);
    });
}

/* ---------------------------------------------------------------------------
 * Tasks
 * ------------------------------------------------------------------------- */

function api_taskList(token, filters) {
  return withApi_({ token: token, name: 'taskList' }, function (staff) {
    filters = filters || {};
    TaskService.activateDueNow();
    var isAdmin = Auth.isAdminRole(staff.Role);
    var scopeId = isAdmin ? (filters.staffId || '') : String(staff.StaffID);

    return SheetDB.find(SHEETS.TASKS, function (t) {
      if (scopeId && String(t.AssignedTo) !== scopeId) return false;
      if (filters.status && String(t.Status) !== filters.status) return false;
      if (filters.bucket && TaskService.bucketOf(t.Status) !== filters.bucket) return false;
      if (filters.taskType && String(t.TaskType) !== filters.taskType) return false;
      if (filters.from && Util.dateKey(t.DueDate) < filters.from) return false;
      if (filters.to && Util.dateKey(t.DueDate) > filters.to) return false;
      if (!filters.includeCancelled && String(t.Status) === TASK_STATUS.CANCELLED) return false;
      return true;
    }).map(mapTask_).sort(function (a, b) {
      return String(a.dueDate).localeCompare(String(b.dueDate));
    });
  });
}

function api_taskDetail(token, taskId) {
  return withApi_({ token: token, name: 'taskDetail' }, function (staff) {
    TaskService.activateDueNow();
    var task = TaskService.byId(taskId);
    if (!task) throw new Error('Task not found.');
    if (!Auth.isAdminRole(staff.Role) && String(task.AssignedTo) !== String(staff.StaffID)) {
      throw new Error('That task is not assigned to you.');
    }
    return {
      task: mapTask_(task),
      allocation: AllocationService.forTask(task),
      reports: DailyReportService.forTask(taskId).map(mapDailyReport_)
        .sort(function (a, b) { return String(b.reportDate).localeCompare(String(a.reportDate)); }),
      documents: UploadService.listFor(staff, { taskId: taskId })
    };
  });
}
function api_taskCreate(token, payload) {
  return withApi_({ token: token, taskManager: true, name: 'taskCreate', write: true },
    function (admin) {
      payload = payload || {};
      if (Array.isArray(payload.assignTo) && payload.assignTo.length > 1) {
        return TaskService.bulkCreate(payload, payload.assignTo, admin.Email);
      }
      if (Array.isArray(payload.assignTo) && payload.assignTo.length === 1) {
        payload.assignedTo = payload.assignTo[0];
      }
      var task = TaskService.create(payload, admin.Email);
      return mapTask_(task);
    });
}
function api_taskUpdate(token, payload) {
  return withApi_({ token: token, admin: true, name: 'taskUpdate', write: true },
    function (admin) {
      payload = payload || {};
      return TaskService.update(payload.taskId, payload, admin.Email);
    });
}

function api_taskCancel(token, payload) {
  return withApi_({ token: token, admin: true, name: 'taskCancel', write: true },
    function (admin) {
      payload = payload || {};
      return TaskService.cancel(payload.taskId, admin.Email, payload.reason);
    });
}

/** Reassign a task to another staff member (reactivates a failed task). */
function api_taskReassign(token, payload) {
  return withApi_({ token: token, admin: true, name: 'taskReassign', write: true },
    function (admin) {
      payload = payload || {};
      return TaskService.reassign(payload.taskId, payload.staffId, admin.Email,
        { reactivate: payload.reactivate, dueDate: payload.dueDate,
          followUp: payload.followUp });
    });
}

function api_taskAcknowledge(token, payload) {
  return withApi_({ token: token, name: 'taskAcknowledge', write: true }, function (staff) {
    return TaskService.acknowledge((payload || {}).taskId, staff);
  });
}

function api_taskReportProgress(token, payload) {
  return withApi_({ token: token, name: 'taskReportProgress', write: true }, function (staff) {
    payload = payload || {};
    return TaskService.reportProgress(payload.taskId, staff, payload.progress, payload.note);
  });
}

function api_taskSubmit(token, payload) {
  return withApi_({ token: token, name: 'taskSubmit', write: true }, function (staff) {
    payload = payload || {};
    return TaskService.submitForValidation(payload.taskId, staff, payload);
  });
}

/** Requirement 6 — validating the percentage is what releases the pay. */
function api_taskValidate(token, payload) {
  return withApi_({ token: token, admin: true, name: 'taskValidate', write: true },
    function (admin) {
      payload = payload || {};
      return TaskService.validate(payload.taskId, admin, payload);
    });
}

/**
 * Repair: back-fill validated progress from already-approved daily reports so
 * their earnings show up. Safe to run any time (only ever raises progress).
 */
function api_taskSyncValidated(token) {
  return withApi_({ token: token, admin: true, name: 'taskSyncValidated', write: true },
    function (admin) {
      return TaskService.syncValidatedFromReports(String(admin.Email || admin.StaffID));
    });
}

function api_taskReject(token, payload) {
  return withApi_({ token: token, admin: true, name: 'taskReject', write: true },
    function (admin) {
      payload = payload || {};
      return TaskService.reject(payload.taskId, admin, payload.comment);
    });
}

/** Requirement 4 — reverse an approved task back to pending validation. */
function api_taskReverse(token, payload) {
  return withApi_({ token: token, admin: true, name: 'taskReverse', write: true },
    function (admin) {
      payload = payload || {};
      return TaskService.reverse(payload.taskId, admin, payload.comment);
    });
}

/**
 * Requirement 3 — a staff member escalates their task to a Software Developer.
 * Any signed-in staff member may escalate a task assigned to them; a task
 * manager/admin may escalate any task.
 */
function api_taskEscalate(token, payload) {
  return withApi_({ token: token, name: 'taskEscalate', write: true }, function (staff) {
    payload = payload || {};
    var task = TaskService.byId(payload.taskId);
    if (!task) throw new Error('Task not found.');
    if (String(task.AssignedTo) !== String(staff.StaffID) &&
        !Auth.canAssignTasks(staff)) {
      throw new Error('You can only escalate a task assigned to you.');
    }
    return TaskService.escalate(payload.taskId, staff, payload.developerId, payload.note);
  });
}

/**
 * Requirement 3 — the developer it was escalated to (or management) resolves
 * and validates the task. TaskService.resolveEscalation enforces the check.
 */
function api_taskResolveEscalation(token, payload) {
  return withApi_({ token: token, name: 'taskResolveEscalation', write: true },
    function (staff) {
      payload = payload || {};
      return TaskService.resolveEscalation(payload.taskId, staff, payload);
    });
}

/** Software Developers available as escalation targets. Any staff member may read it. */
function api_developerList(token) {
  return withApi_({ token: token, name: 'developerList' }, function () {
    return StaffService.all().filter(function (s) {
      return Auth.isDeveloper(s.Role) && String(s.Status) !== STAFF_STATUS.INACTIVE;
    }).map(function (s) {
      return {
        staffId: String(s.StaffID),
        name: String(s.Name),
        email: String(s.Email),
        department: String(s.Department || '')
      };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  });
}

/**
 * Tasks escalated to the caller (a Software Developer) and still open —
 * requirement 3. Powers the developer's dedicated "Escalated to me" view so an
 * escalation is impossible to miss, in addition to the dashboard card.
 */
function api_escalatedToMe(token) {
  return withApi_({ token: token, name: 'escalatedToMe' }, function (staff) {
    return TaskService.forDeveloper(staff.StaffID).map(mapTask_);
  });
}

/* ---------------------------------------------------------------------------
 * Daily reports
 * ------------------------------------------------------------------------- */

function api_dailyReportSubmit(token, payload) {
  return withApi_({ token: token, name: 'dailyReportSubmit', write: true }, function (staff) {
    Auth.assertCanAct(staff);
    return DailyReportService.submit(payload || {}, staff);
  });
}

function api_dailyReportList(token, filters) {
  return withApi_({ token: token, name: 'dailyReportList' }, function (staff) {
    filters = filters || {};
    var isAdmin = Auth.isAdminRole(staff.Role);
    var scopeId = isAdmin ? (filters.staffId || '') : String(staff.StaffID);
    return SheetDB.find(SHEETS.DAILY_REPORTS, function (r) {
      if (scopeId && String(r.StaffID) !== scopeId) return false;
      if (filters.taskId && String(r.TaskID) !== String(filters.taskId)) return false;
      if (filters.date && Util.dateKey(r.ReportDate) !== filters.date) return false;
      if (filters.reviewStatus && String(r.ReviewStatus) !== filters.reviewStatus) return false;
      return true;
    }).map(mapDailyReport_).sort(function (a, b) {
      return String(b.reportDate).localeCompare(String(a.reportDate));
    });
  });
}

function api_dailyReportReview(token, payload) {
  return withApi_({ token: token, admin: true, name: 'dailyReportReview', write: true },
    function (admin) {
      payload = payload || {};
      return DailyReportService.review(payload.reportId, admin, payload.decision, payload.comment);
    });
}

/* ---------------------------------------------------------------------------
 * Attendance
 * ------------------------------------------------------------------------- */

function api_signAttendance(token, payload) {
  return withApi_({ token: token, name: 'signAttendance', write: true }, function (staff) {
    payload = payload || {};
    return AttendanceService.signIn(staff, payload.note, payload.meta);
  });
}

function api_signOutAttendance(token) {
  return withApi_({ token: token, name: 'signOutAttendance', write: true }, function (staff) {
    return AttendanceService.signOut(staff);
  });
}

function api_attendanceBoard(token) {
  return withApi_({ token: token, admin: true, name: 'attendanceBoard' }, function () {
    return AttendanceService.todayBoard();
  });
}

function api_attendanceList(token, filters) {
  return withApi_({ token: token, name: 'attendanceList' }, function (staff) {
    filters = filters || {};
    var isAdmin = Auth.isAdminRole(staff.Role);
    var scopeId = isAdmin ? (filters.staffId || '') : String(staff.StaffID);
    var period = Util.resolvePeriod(filters.periodType || 'Monthly', filters.refDate);
    return SheetDB.find(SHEETS.ATTENDANCE, function (a) {
      if (scopeId && String(a.StaffID) !== scopeId) return false;
      return Util.inPeriod(a.Date, period);
    }).map(function (a) {
      return {
        attendanceId: String(a.AttendanceID),
        staffId: String(a.StaffID),
        staffName: String(a.StaffName || StaffService.name(a.StaffID)),
        date: Util.dateKey(a.Date),
        loginTime: Util.fmtTime(a.LoginTime),
        logoutTime: Util.fmtTime(a.LogoutTime),
        status: String(a.Status),
        minutesLate: Util.num(a.MinutesLate, 0),
        notes: String(a.Notes || ''),
        deviceType: String(a.DeviceType || ''),
        latitude: a.Latitude !== '' && a.Latitude != null ? Util.num(a.Latitude, null) : null,
        longitude: a.Longitude !== '' && a.Longitude != null ? Util.num(a.Longitude, null) : null,
        distanceMeters: a.DistanceMeters !== '' && a.DistanceMeters != null ? Util.num(a.DistanceMeters, null) : null,
        locationFlagged: Util.truthy(a.LocationFlagged)
      };
    }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  });
}

function api_attendanceSet(token, payload) {
  return withApi_({ token: token, admin: true, name: 'attendanceSet', write: true },
    function (admin) {
      payload = payload || {};
      return AttendanceService.adminSet(payload.staffId, payload.date,
        payload.status, payload.note, admin);
    });
}

/**
 * Per-staff attendance summary for a period — one row per active staff member
 * with the count of days signed in against the working days elapsed (weekdays
 * only, weekends excluded). Drives the admin Attendance "History" card so it
 * shows "18 / 21" per person instead of a long flat list of every entry.
 */
function api_attendanceSummary(token, filters) {
  return withApi_({ token: token, admin: true, name: 'attendanceSummary' }, function () {
    filters = filters || {};
    var period = Util.resolvePeriod(filters.periodType || 'Monthly', filters.refDate);

    // Working days elapsed so far (weekdays only, never crediting the future) —
    // this is the shared denominator every "present / N" figure is measured against.
    var todayKey = Util.dateKey(Util.today());
    var effectiveEnd = period.endKey <= todayKey ? period.end : Util.today();
    var workingDays = Util.dateKey(effectiveEnd) < period.startKey
      ? 0 : Util.countWorkingDays(period.start, effectiveEnd);

    var rows = [];
    StaffService.all().forEach(function (staff) {
      if (String(staff.Status) === STAFF_STATUS.INACTIVE) return;
      var st = AttendanceService.statsFor(staff.StaffID, period);
      rows.push({
        staffId: String(staff.StaffID),
        staffName: String(staff.Name),
        department: String(staff.Department || ''),
        status: String(staff.Status),
        workingDays: st.workingDays,
        present: st.present,
        onTime: st.onTime,
        late: st.late,
        absent: st.absent,
        leave: st.leave,
        attendanceRate: st.attendanceRate,
        punctualityRate: st.punctualityRate
      });
    });
    rows.sort(function (a, b) { return b.attendanceRate - a.attendanceRate; });
    return {
      periodLabel: period.label,
      periodType: String(filters.periodType || 'Monthly'),
      workingDays: workingDays,
      rows: rows
    };
  });
}

/* ---------------------------------------------------------------------------
 * Reports (requirement 4)
 * ------------------------------------------------------------------------- */

/** Daily | Weekly | Monthly | Quarterly | HalfYearly | Yearly. */
function api_reportBuild(token, payload) {
  return withApi_({ token: token, name: 'reportBuild' }, function (staff) {
    payload = payload || {};
    var isAdmin = Auth.isAdminRole(staff.Role);
    // Staff may only ever build their own report.
    var staffId = isAdmin ? (payload.staffId || '') : String(staff.StaffID);
    if (staffId) {
      return {
        scope: 'staff',
        report: ReportService.buildStaffReport(staffId, payload.periodType, payload.refDate)
      };
    }
    return {
      scope: 'organisation',
      report: ReportService.buildOrganisationReport(payload.periodType, payload.refDate, {})
    };
  });
}

function api_reportExport(token, payload) {
  return withApi_({ token: token, name: 'reportExport' }, function (staff) {
    payload = payload || {};
    var isAdmin = Auth.isAdminRole(staff.Role);
    var staffId = isAdmin ? (payload.staffId || '') : String(staff.StaffID);
    return String(payload.format).toLowerCase() === 'csv'
      ? ReportService.exportCsv(payload.periodType, payload.refDate, staffId, staff.Email)
      : ReportService.exportPdf(payload.periodType, payload.refDate, staffId, staff.Email);
  });
}

function api_reportGenerate(token, payload) {
  return withApi_({ token: token, admin: true, name: 'reportGenerate', write: true },
    function (admin) {
      payload = payload || {};
      var out = ReportService.generateAll(payload.periodType, payload.refDate, admin.Email);
      return { periodLabel: out.periodLabel, persisted: out.persisted };
    });
}

function api_reportList(token, filters) {
  return withApi_({ token: token, name: 'reportList' }, function (staff) {
    filters = filters || {};
    var staffId = Auth.isAdminRole(staff.Role) ? (filters.staffId || '') : String(staff.StaffID);
    return ReportService.listPersisted(filters.periodType, staffId);
  });
}

/* ---------------------------------------------------------------------------
 * Payroll
 * ------------------------------------------------------------------------- */

function api_payrollPreview(token, payload) {
  return withApi_({ token: token, management: true, name: 'payrollPreview' }, function () {
    payload = payload || {};
    var period = Util.resolvePeriod(payload.periodType || 'Monthly', payload.refDate);
    return {
      period: { type: period.type, label: period.label,
                start: period.startKey, end: period.endKey },
      summary: PayrollService.organisationSummary(period.type, period.start),
      rows: StaffService.active().map(function (s) {
        return PayrollService.compute(s.StaffID, period.type, period.start);
      }),
      persisted: PayrollService.listPeriod(period.type, period.start)
    };
  });
}

function api_payrollRun(token, payload) {
  return withApi_({ token: token, management: true, name: 'payrollRun', write: true },
    function (admin) {
      payload = payload || {};
      var out = PayrollService.runPeriod(payload.periodType, payload.refDate, admin.Email);
      return { period: out.period, created: out.created, updated: out.updated,
               locked: out.locked, reallocated: out.reallocated };
    });
}

function api_payrollAdjust(token, payload) {
  return withApi_({ token: token, management: true, name: 'payrollAdjust', write: true },
    function (admin) {
      payload = payload || {};
      return PayrollService.setAdjustment(payload.payrollId, payload.amount, payload.note, admin);
    });
}

function api_payrollApprove(token, payload) {
  return withApi_({ token: token, management: true, name: 'payrollApprove', write: true },
    function (admin) {
      return PayrollService.approve((payload || {}).payrollId, admin);
    });
}

function api_payrollMarkPaid(token, payload) {
  return withApi_({ token: token, management: true, name: 'payrollMarkPaid', write: true },
    function (admin) {
      payload = payload || {};
      return PayrollService.markPaid(payload.payrollId, admin, payload.reference);
    });
}

function api_myEarnings(token, payload) {
  return withApi_({ token: token, name: 'myEarnings' }, function (staff) {
    payload = payload || {};
    var plan = AllocationService.plan(staff.StaffID, payload.refDate);
    delete plan.byTaskId;   // the lines array already carries everything
    return {
      current: PayrollService.compute(staff.StaffID, payload.periodType || 'Monthly', payload.refDate),
      allocation: plan,
      history: PayrollService.historyFor(staff.StaffID)
    };
  });
}

/* ---------------------------------------------------------------------------
 * Task allocation from the guaranteed monthly salary
 * ------------------------------------------------------------------------- */

/** The whole-organisation allocation table for one month. */
function api_allocationBoard(token, payload) {
  return withApi_({ token: token, admin: true, name: 'allocationBoard' }, function () {
    payload = payload || {};
    return AllocationService.summary(payload.refDate);
  });
}

/**
 * Live preview for the task form: what this task will carry and what it does to
 * the other tasks already due that month. Read-only, so it is safe to call on
 * every keystroke-free change of assignee / due date / priority.
 */
function api_allocationPreview(token, payload) {
  return withApi_({ token: token, admin: true, name: 'allocationPreview' }, function () {
    payload = payload || {};
    var ids = payload.staffIds && payload.staffIds.length
      ? payload.staffIds
      : (payload.staffId ? [payload.staffId] : []);
    return ids.map(function (id) {
      try {
        return AllocationService.preview(id, payload.dueDate, payload.priority, payload.taskId);
      } catch (err) {
        return { staffId: String(id), error: String(err && err.message ? err.message : err) };
      }
    });
  });
}

/** Repair pass — re-split every unbanked month for everybody. */
function api_allocationRecalc(token, payload) {
  return withApi_({ token: token, admin: true, name: 'allocationRecalc', write: true },
    function () {
      payload = payload || {};
      if (payload.staffId) return AllocationService.recalcStaff(payload.staffId);
      return AllocationService.recalcAll();
    });
}

/* ---------------------------------------------------------------------------
 * Documents (requirement 5)
 * ------------------------------------------------------------------------- */

/**
 * Upload one file. The browser sends {fileName, mimeType, dataBase64, ...} —
 * see Scripts.html readFileAsBase64().
 */
function api_upload(token, payload) {
  return withApi_({ token: token, name: 'upload', write: true }, function (staff) {
    Auth.assertCanAct(staff);
    return UploadService.upload(payload || {}, staff);
  });
}

function api_uploadList(token, filters) {
  return withApi_({ token: token, name: 'uploadList' }, function (staff) {
    return UploadService.listFor(staff, filters || {});
  });
}

function api_uploadDelete(token, payload) {
  return withApi_({ token: token, name: 'uploadDelete', write: true }, function (staff) {
    return UploadService.remove((payload || {}).uploadId, staff);
  });
}

/* ---------------------------------------------------------------------------
 * Notifications
 * ------------------------------------------------------------------------- */

function api_notifications(token, payload) {
  return withApi_({ token: token, name: 'notifications' }, function (staff) {
    return {
      items: NotificationService.listFor(staff.StaffID, (payload || {}).limit || 25),
      unread: NotificationService.unreadCount(staff.StaffID)
    };
  });
}

function api_notificationRead(token, payload) {
  return withApi_({ token: token, name: 'notificationRead', write: true }, function (staff) {
    payload = payload || {};
    return payload.all
      ? NotificationService.markAllRead(staff.StaffID)
      : NotificationService.markRead(payload.notificationId, staff.StaffID);
  });
}

/* ---------------------------------------------------------------------------
 * Email (admin broadcast + templates) — Requirement 10
 * ------------------------------------------------------------------------- */

function api_emailData(token) {
  return withApi_({ token: token, admin: true, name: 'emailData' }, function (admin) {
    var templates = [], templatesReady = true;
    try {
      templates = EmailTemplateService.list();
    } catch (e) {
      // EmailTemplates sheet not created yet — run setupSystem() once.
      templatesReady = false;
    }
    // Requirement 4 — show the administrator exactly which address the mail
    // leaves as, so "send through the designated admin email" is verifiable.
    var account = '';
    try { account = String(Session.getEffectiveUser().getEmail() || ''); } catch (e) { account = ''; }
    var opts = {};
    try { opts = Notify.senderOptions() || {}; } catch (e) { opts = {}; }
    var configured = String(CFG.get('SenderEmail', '')).trim();
    return {
      audience: EmailService.audience(),
      templates: templates,
      templatesReady: templatesReady,
      sender: {
        configured: configured,
        account: account,
        from: opts.from || account,
        replyTo: opts.replyTo || '',
        name: opts.name || '',
        // true when the configured address cannot be used as From (not a
        // verified alias of the executing account) and is used as Reply-To.
        aliasFallback: !!(configured && !opts.from && configured.toLowerCase() !== account.toLowerCase()),
        adminEmail: String(admin.Email || '')
      }
    };
  });
}

function api_emailSend(token, payload) {
  return withApi_({ token: token, admin: true, name: 'emailSend', write: true },
    function (admin) {
      return EmailService.send(payload || {}, admin);
    });
}

function api_emailTemplateSave(token, payload) {
  return withApi_({ token: token, admin: true, name: 'emailTemplateSave', write: true },
    function (admin) {
      return EmailTemplateService.save(payload || {}, admin);
    });
}

function api_emailTemplateDelete(token, payload) {
  return withApi_({ token: token, admin: true, name: 'emailTemplateDelete', write: true },
    function () {
      return EmailTemplateService.remove((payload || {}).templateId);
    });
}

/* ---------------------------------------------------------------------------
 * Settings & automation
 * ------------------------------------------------------------------------- */

function api_configList(token) {
  return withApi_({ token: token, admin: true, name: 'configList' }, function () {
    return {
      values: CFG.all(),
      rows: SheetDB.readAll(SHEETS.CONFIG).map(function (r) {
        return {
          key: String(r.Key), value: String(r.Value === undefined ? '' : r.Value),
          category: String(r.Category || ''), description: String(r.Description || '')
        };
      }),
      triggers: listInstalledTriggers(),
      timezone: getTz(),
      spreadsheetId: SheetDB.spreadsheet().getId(),
      webAppUrl: Notify.portalUrl()
    };
  });
}

function api_configSave(token, payload) {
  return withApi_({ token: token, admin: true, name: 'configSave', write: true },
    function (admin) {
      payload = payload || {};
      var updates = payload.updates || {};
      var applied = 0;
      Object.keys(updates).forEach(function (key) {
        CFG.set(key, updates[key]);
        applied++;
      });
      CFG.flush();
      Log.info('Config', applied + ' key(s) updated by ' + admin.Email,
        Object.keys(updates).join(', '));
      return { applied: applied, values: CFG.all() };
    });
}

function api_runAutomation(token, payload) {
  return withApi_({ token: token, admin: true, name: 'runAutomation' }, function (admin) {
    payload = payload || {};
    Log.info('Triggers', 'Manual run of ' + payload.name + ' by ' + admin.Email);
    return runTriggerByName(payload.name || 'runDailyAutomationNow');
  });
}

function api_installTriggers(token) {
  return withApi_({ token: token, admin: true, name: 'installTriggers' }, function () {
    return installAllTriggers();
  });
}

function api_logs(token, payload) {
  return withApi_({ token: token, admin: true, name: 'logs' }, function () {
    var limit = (payload || {}).limit || 100;
    return SheetDB.readAll(SHEETS.LOGS).slice(-limit).reverse().map(function (r) {
      return {
        timestamp: Util.fmtDateTime(r.Timestamp),
        level: String(r.Level || ''),
        source: String(r.Source || ''),
        message: String(r.Message || ''),
        detail: String(r.Detail || '')
      };
    });
  });
}
