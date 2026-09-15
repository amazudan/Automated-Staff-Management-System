/**
 * ============================================================================
 * Reports.gs — daily, weekly, monthly, quarterly, half-yearly and yearly
 * reporting (requirement 4).
 * ============================================================================
 * Every report is assembled from the same builder, so a Daily report and a
 * Yearly report contain exactly the same fields — only the window changes.
 *
 * A report covers, per staff member:
 *   • task allocation and outcome (assigned / completed / pending validation /
 *     in progress / failed / rolled over) with completion rate
 *   • daily reporting discipline (expected vs submitted vs on-time)
 *   • attendance (working days, on-time, late, absent, leave, rate)
 *   • strikes and suspensions, including penalties
 *   • money: gross allocated, progress-earned, penalties, net payable
 *   • average metric score
 *   • rule-based strengths / weaknesses / overall remark
 *
 * Persisted rows land in the PeriodReports tab (this supersedes the single
 * MonthlyReports tab in the original spec: monthly rows are simply
 * PeriodType='Monthly').
 * ============================================================================
 */

var ReportService = {

  /** Build a full report object for one staff member. Nothing is written. */
  buildStaffReport: function (staffId, periodType, refDate) {
    var staff = StaffService.byId(staffId);
    if (!staff) throw new Error('Staff member not found: ' + staffId);
    var period = Util.resolvePeriod(periodType || 'Monthly', refDate);

    var taskStats = TaskService.statsFor(staffId, period);
    var attendance = AttendanceService.statsFor(staffId, period);
    var reporting = DailyReportService.statsFor(staffId, period);
    var strikes = StrikeService.statsFor(staffId, period);
    var pay = PayrollService.compute(staffId, period.type, period.start);
    var appraisal = this.appraise({
      taskStats: taskStats, attendance: attendance,
      reporting: reporting, strikes: strikes
    });

    return {
      staffId: String(staff.StaffID),
      staffName: String(staff.Name),
      email: String(staff.Email),
      role: String(staff.Role),
      department: String(staff.Department || ''),
      position: String(staff.Position || ''),
      accountStatus: String(staff.Status),
      flagged: Util.truthy(staff.FlaggedStatus),
      lifetimeStrikes: Util.num(staff.TotalStrikesIssued, 0),
      lifetimeSuspensions: Util.num(staff.SuspensionCount, 0),

      periodType: period.type,
      periodLabel: period.label,
      periodStart: period.startKey,
      periodEnd: period.endKey,

      tasks: {
        assigned: taskStats.assigned,
        completed: taskStats.completed,
        pendingValidation: taskStats.pendingValidation,
        inProgress: taskStats.inProgress,
        failed: taskStats.failed,
        scheduled: taskStats.scheduled,
        rolledOver: taskStats.rolledOver,
        completionRate: taskStats.completionRate,
        avgProgress: taskStats.avgProgress,
        avgMetricScore: taskStats.avgMetricScore,
        detail: taskStats.tasks.map(function (t) {
          return {
            taskId: String(t.TaskID),
            title: String(t.Title),
            taskType: String(t.TaskType),
            priority: String(t.Priority),
            status: String(t.Status),
            startDate: Util.dateKey(t.StartDate),
            dueDate: Util.dateKey(t.DueDate),
            originalDueDate: Util.dateKey(t.OriginalDueDate),
            amountAllocated: Util.money(t.AmountAllocated),
            reportedProgress: Util.pct(t.ReportedProgress),
            validatedProgress: Util.pct(t.ValidatedProgress),
            payable: TaskService.payableAmount(t),
            metricScore: t.MetricScore === '' ? null : Util.num(t.MetricScore, 0),
            rolloverCount: Util.num(t.RolloverCount, 0),
            warnings: Util.num(t.WarningsIssued, 0),
            validatedBy: String(t.ValidatedBy || ''),
            completedAt: Util.dateKey(t.CompletedAt)
          };
        })
      },

      attendance: {
        workingDays: attendance.workingDays,
        present: attendance.present,
        onTime: attendance.onTime,
        late: attendance.late,
        absent: attendance.absent,
        leave: attendance.leave,
        lateMinutes: attendance.lateMinutes,
        attendanceRate: attendance.attendanceRate,
        punctualityRate: attendance.punctualityRate
      },

      dailyReporting: {
        expected: reporting.expected,
        submitted: reporting.submitted,
        onTime: reporting.onTime,
        late: reporting.late,
        onTimeRate: reporting.onTimeRate,
        submissionRate: reporting.submissionRate
      },

      discipline: {
        strikesIssued: strikes.issued,
        activeStrikes: strikes.active,
        suspensions: strikes.suspensions,
        penaltyTotal: strikes.penaltyTotal,
        byCategory: strikes.byCategory,
        detail: strikes.rows.map(function (s) {
          return {
            strikeId: String(s.StrikeID),
            date: Util.dateKey(s.Date),
            category: String(s.Category),
            reason: String(s.Reason),
            strikeNumber: Util.num(s.StrikeNumber, 0),
            penaltyAmount: Util.money(s.PenaltyAmount),
            status: String(s.Status),
            clearedBy: String(s.ClearedBy || ''),
            clearanceNote: String(s.ClearanceNote || '')
          };
        })
      },

      pay: {
        monthlySalary: pay.monthlySalary,
        guaranteed: pay.guaranteed,
        grossAllocated: pay.grossAllocated,
        progressEarned: pay.progressEarned,
        forfeited: pay.forfeited,
        penalties: pay.penalties,
        adjustments: pay.adjustments,
        netPayable: pay.netPay,
        payoutRate: pay.payoutRate,
        heldPendingValidation: pay.unpaidBecauseUnvalidated,
        payBasis: CFG.get('PayProgressSource', 'AdminValidated'),
        allocationBasis: pay.autoAllocated
          ? 'Guaranteed monthly salary shared across tasks due in the period (' +
            pay.allocationMode + ')'
          : 'Amount entered per task',
        status: pay.status
      },

      appraisal: appraisal
    };
  },

  /**
   * Rule-based strengths / weaknesses / remark. Deliberately explicit so the
   * wording can be tuned without touching the maths.
   */
  appraise: function (input) {
    var t = input.taskStats, a = input.attendance,
        r = input.reporting, s = input.strikes;
    var strengths = [], weaknesses = [];

    if (t.assigned === 0) {
      return {
        strengths: 'No tasks allocated in this period.',
        weaknesses: '',
        remark: 'No activity to appraise.',
        grade: 'N/A',
        score: 0
      };
    }

    // Strengths ------------------------------------------------------------
    if (t.completionRate >= 90) strengths.push('Outstanding task delivery (' + t.completionRate + '% completion)');
    else if (t.completionRate >= 75) strengths.push('Reliable task delivery (' + t.completionRate + '% completion)');
    if (a.attendanceRate >= 95) strengths.push('Excellent attendance (' + a.attendanceRate + '%)');
    if (a.onTime > 0 && a.late === 0) strengths.push('Perfect punctuality — no late sign-ins');
    if (r.onTimeRate >= 90 && r.submitted > 0) strengths.push('Daily reports consistently filed on time (' + r.onTimeRate + '%)');
    if (s.issued === 0) strengths.push('Clean disciplinary record for the period');
    if (t.avgMetricScore >= 85) strengths.push('High quality scores (avg ' + t.avgMetricScore + '/100)');
    if (t.rolledOver === 0 && t.assigned > 1) strengths.push('No task rollovers');

    // Weaknesses -----------------------------------------------------------
    if (t.completionRate < 60) weaknesses.push('Low completion rate (' + t.completionRate + '%)');
    if (t.failed > 0) weaknesses.push(t.failed + ' task(s) failed');
    if (t.pendingValidation > 0) weaknesses.push(t.pendingValidation + ' task(s) still awaiting validation');
    if (t.rolledOver > 0) weaknesses.push(t.rolledOver + ' task(s) rolled over past their due date');
    if (a.absent > 0) weaknesses.push(a.absent + ' day(s) absent');
    if (a.late > 2) weaknesses.push(a.late + ' late sign-in(s), ' + a.lateMinutes + ' minutes total');
    if (r.expected > 0 && r.submissionRate < 80) weaknesses.push('Daily reporting gaps (' + r.submissionRate + '% of expected reports filed)');
    if (r.late > 0) weaknesses.push(r.late + ' daily report(s) filed after the deadline');
    if (s.issued > 0) weaknesses.push(s.issued + ' strike(s) issued');
    if (s.suspensions > 0) weaknesses.push(s.suspensions + ' suspension(s) in this period');

    // Composite score ------------------------------------------------------
    var score = Math.round(
      0.40 * t.completionRate +
      0.20 * a.attendanceRate +
      0.15 * (r.expected > 0 ? r.submissionRate : 100) +
      0.15 * (t.avgMetricScore || 0) +
      0.10 * Math.max(0, 100 - s.issued * 25)
    );
    score = Math.max(0, Math.min(100, score));

    var grade = score >= 85 ? 'A — Excellent'
              : score >= 70 ? 'B — Good'
              : score >= 55 ? 'C — Needs improvement'
              : score >= 40 ? 'D — Poor'
              : 'E — Critical';

    var remark;
    if (s.suspensions > 0) {
      remark = 'Suspended during this period after reaching the strike limit. Performance review required before new allocations.';
    } else if (score >= 85) {
      remark = 'Strong all-round performance. Consistent delivery, attendance and reporting.';
    } else if (score >= 70) {
      remark = 'Solid performer. Tighten up the weak points listed to move into the top band.';
    } else if (score >= 55) {
      remark = 'Meeting only part of expectations. Close supervision recommended next period.';
    } else {
      remark = 'Performance below acceptable threshold. Formal improvement plan recommended.';
    }

    return {
      strengths: strengths.length ? strengths.join('; ') + '.' : 'No standout strengths this period.',
      weaknesses: weaknesses.length ? weaknesses.join('; ') + '.' : 'No material weaknesses recorded.',
      remark: remark,
      grade: grade,
      score: score
    };
  },

  /** Write (or refresh) a report row in the PeriodReports tab. */
  persist: function (report, actor) {
    var existing = SheetDB.findOne(SHEETS.PERIOD_REPORTS, function (r) {
      return String(r.StaffID) === report.staffId &&
             String(r.PeriodType) === report.periodType &&
             String(r.PeriodLabel) === report.periodLabel;
    });

    var payload = {
      StaffID: report.staffId,
      StaffName: report.staffName,
      PeriodType: report.periodType,
      PeriodLabel: report.periodLabel,
      PeriodStart: Util.startOfDay(report.periodStart),
      PeriodEnd: Util.startOfDay(report.periodEnd),
      WorkingDays: report.attendance.workingDays,
      DaysPresent: report.attendance.present,
      DaysLate: report.attendance.late,
      DaysAbsent: report.attendance.absent,
      AttendanceRate: report.attendance.attendanceRate,
      TasksAssigned: report.tasks.assigned,
      TasksCompleted: report.tasks.completed,
      TasksPendingValidation: report.tasks.pendingValidation,
      TasksInProgress: report.tasks.inProgress,
      TasksFailed: report.tasks.failed,
      TasksRolledOver: report.tasks.rolledOver,
      CompletionRate: report.tasks.completionRate,
      AvgValidatedProgress: report.tasks.avgProgress,
      AvgMetricScore: report.tasks.avgMetricScore,
      DailyReportsExpected: report.dailyReporting.expected,
      DailyReportsSubmitted: report.dailyReporting.submitted,
      OnTimeReports: report.dailyReporting.onTime,
      StrikesIssued: report.discipline.strikesIssued,
      ActiveStrikes: report.discipline.activeStrikes,
      Suspensions: report.discipline.suspensions,
      GrossAllocated: report.pay.grossAllocated,
      EarnedAmount: report.pay.progressEarned,
      PenaltyTotal: report.pay.penalties,
      NetPayable: report.pay.netPayable,
      Strengths: report.appraisal.strengths,
      Weaknesses: report.appraisal.weaknesses,
      Remark: report.appraisal.grade + ' — ' + report.appraisal.remark,
      GeneratedAt: new Date(),
      GeneratedBy: String(actor || 'system')
    };

    if (existing) {
      SheetDB.updateRowAt(SHEETS.PERIOD_REPORTS, existing.__row, payload);
      return existing.ReportID;
    }
    payload.ReportID = SheetDB.nextId('PRD', SHEETS.PERIOD_REPORTS, 'ReportID', 6);
    SheetDB.insert(SHEETS.PERIOD_REPORTS, payload);
    return payload.ReportID;
  },

  /**
   * Organisation-wide report: one entry per active staff member plus totals.
   * This is what the admin Reports screen renders and exports.
   */
  buildOrganisationReport: function (periodType, refDate, opts) {
    opts = opts || {};
    var period = Util.resolvePeriod(periodType || 'Monthly', refDate);
    var staffRows = opts.staffId
      ? [StaffService.byId(opts.staffId)].filter(Boolean)
      : StaffService.active();

    var entries = staffRows.map(function (s) {
      return ReportService.buildStaffReport(s.StaffID, period.type, period.start);
    });

    var totals = {
      staffCount: entries.length,
      tasksAssigned: 0, tasksCompleted: 0, tasksPendingValidation: 0,
      tasksInProgress: 0, tasksFailed: 0, tasksRolledOver: 0,
      strikesIssued: 0, suspensions: 0,
      grossAllocated: 0, progressEarned: 0, penalties: 0, netPayable: 0,
      workingDays: 0, daysPresent: 0, daysLate: 0, daysAbsent: 0,
      reportsExpected: 0, reportsSubmitted: 0
    };

    entries.forEach(function (e) {
      totals.tasksAssigned += e.tasks.assigned;
      totals.tasksCompleted += e.tasks.completed;
      totals.tasksPendingValidation += e.tasks.pendingValidation;
      totals.tasksInProgress += e.tasks.inProgress;
      totals.tasksFailed += e.tasks.failed;
      totals.tasksRolledOver += e.tasks.rolledOver;
      totals.strikesIssued += e.discipline.strikesIssued;
      totals.suspensions += e.discipline.suspensions;
      totals.grossAllocated += e.pay.grossAllocated;
      totals.progressEarned += e.pay.progressEarned;
      totals.penalties += e.pay.penalties;
      totals.netPayable += e.pay.netPayable;
      totals.workingDays += e.attendance.workingDays;
      totals.daysPresent += e.attendance.present;
      totals.daysLate += e.attendance.late;
      totals.daysAbsent += e.attendance.absent;
      totals.reportsExpected += e.dailyReporting.expected;
      totals.reportsSubmitted += e.dailyReporting.submitted;
    });

    ['grossAllocated', 'progressEarned', 'penalties', 'netPayable']
      .forEach(function (k) { totals[k] = Util.money(totals[k]); });
    totals.completionRate = Util.rate(totals.tasksCompleted, totals.tasksAssigned);
    totals.attendanceRate = Util.rate(totals.daysPresent, totals.workingDays);
    totals.reportingRate = Util.rate(totals.reportsSubmitted, totals.reportsExpected);
    totals.payoutRate = Util.rate(totals.progressEarned, totals.grossAllocated);

    return {
      periodType: period.type,
      periodLabel: period.label,
      periodStart: period.startKey,
      periodEnd: period.endKey,
      generatedAt: Util.fmtDateTime(new Date()),
      company: CFG.get('CompanyName', ''),
      currency: CFG.get('Currency', ''),
      totals: totals,
      staff: entries
    };
  },

  /** Build + persist a report for every active staff member. */
  generateAll: function (periodType, refDate, actor) {
    var report = this.buildOrganisationReport(periodType, refDate);
    var ids = [];
    report.staff.forEach(function (entry) {
      ids.push(ReportService.persist(entry, actor));
    });
    Log.info('Reports', 'generateAll ' + report.periodType + ' ' +
      report.periodLabel + ' — ' + ids.length + ' row(s)');
    return { periodLabel: report.periodLabel, persisted: ids.length, report: report };
  },

  /** Saved report rows, newest first. */
  listPersisted: function (periodType, staffId) {
    return SheetDB.find(SHEETS.PERIOD_REPORTS, function (r) {
      if (periodType && String(r.PeriodType) !== periodType) return false;
      if (staffId && String(r.StaffID) !== String(staffId)) return false;
      return true;
    }).map(function (r) {
      return {
        reportId: String(r.ReportID),
        staffId: String(r.StaffID),
        staffName: String(r.StaffName),
        periodType: String(r.PeriodType),
        periodLabel: String(r.PeriodLabel),
        completionRate: Util.num(r.CompletionRate, 0),
        attendanceRate: Util.num(r.AttendanceRate, 0),
        strikesIssued: Util.num(r.StrikesIssued, 0),
        suspensions: Util.num(r.Suspensions, 0),
        netPayable: Util.money(r.NetPayable),
        remark: String(r.Remark || ''),
        generatedAt: Util.fmtDateTime(r.GeneratedAt)
      };
    }).sort(function (a, b) {
      return String(b.generatedAt).localeCompare(String(a.generatedAt));
    });
  },

  /* --- Export ----------------------------------------------------------- */

  /** Report as a CSV string (one row per staff member). */
  toCsv: function (report) {
    var head = [
      'StaffID', 'Name', 'Department', 'AccountStatus', 'Period', 'PeriodStart',
      'PeriodEnd', 'TasksAssigned', 'TasksCompleted', 'PendingValidation',
      'InProgress', 'Failed', 'RolledOver', 'CompletionRate%', 'AvgProgress%',
      'AvgMetricScore', 'WorkingDays', 'Present', 'OnTime', 'Late', 'Absent',
      'AttendanceRate%', 'ReportsExpected', 'ReportsSubmitted', 'OnTimeReports',
      'StrikesIssued', 'ActiveStrikes', 'Suspensions', 'LifetimeStrikes',
      'LifetimeSuspensions', 'GrossAllocated', 'ProgressEarned', 'Penalties',
      'NetPayable', 'Grade', 'Strengths', 'Weaknesses', 'Remark'
    ];

    function cell(v) {
      var s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    var lines = [head.join(',')];
    report.staff.forEach(function (e) {
      lines.push([
        e.staffId, e.staffName, e.department, e.accountStatus, e.periodLabel,
        e.periodStart, e.periodEnd, e.tasks.assigned, e.tasks.completed,
        e.tasks.pendingValidation, e.tasks.inProgress, e.tasks.failed,
        e.tasks.rolledOver, e.tasks.completionRate, e.tasks.avgProgress,
        e.tasks.avgMetricScore, e.attendance.workingDays, e.attendance.present,
        e.attendance.onTime, e.attendance.late, e.attendance.absent,
        e.attendance.attendanceRate, e.dailyReporting.expected,
        e.dailyReporting.submitted, e.dailyReporting.onTime,
        e.discipline.strikesIssued, e.discipline.activeStrikes,
        e.discipline.suspensions, e.lifetimeStrikes, e.lifetimeSuspensions,
        e.pay.grossAllocated, e.pay.progressEarned, e.pay.penalties,
        e.pay.netPayable, e.appraisal.grade, e.appraisal.strengths,
        e.appraisal.weaknesses, e.appraisal.remark
      ].map(cell).join(','));
    });
    return lines.join('\n');
  },

  /** Printable HTML used for both the PDF export and the emailed summary. */
  toHtml: function (report) {
    var cur = CFG.get('Currency', '');
    var rows = report.staff.map(function (e) {
      var flagBadge = e.flagged
        ? '<span style="background:#FEE2E2;color:#991B1B;padding:2px 6px;border-radius:6px;font-size:10px;">FLAGGED</span>'
        : '';
      return '<tr>' +
        '<td><strong>' + Util.escapeHtml(e.staffName) + '</strong><br>' +
          '<span style="color:#6B7280;font-size:11px;">' + Util.escapeHtml(e.staffId) +
          ' · ' + Util.escapeHtml(e.department || '—') + ' ' + flagBadge + '</span></td>' +
        '<td style="text-align:center;">' + e.tasks.assigned + '</td>' +
        '<td style="text-align:center;color:#15803D;font-weight:600;">' + e.tasks.completed + '</td>' +
        '<td style="text-align:center;color:#B45309;">' + e.tasks.pendingValidation + '</td>' +
        '<td style="text-align:center;">' + e.tasks.inProgress + '</td>' +
        '<td style="text-align:center;color:#B91C1C;">' + e.tasks.failed + '</td>' +
        '<td style="text-align:center;">' + e.tasks.completionRate + '%</td>' +
        '<td style="text-align:center;">' + e.attendance.attendanceRate + '%</td>' +
        '<td style="text-align:center;">' + e.discipline.strikesIssued +
          (e.discipline.suspensions ? ' / ' + e.discipline.suspensions + ' susp.' : '') + '</td>' +
        '<td style="text-align:right;">' + cur + e.pay.grossAllocated.toLocaleString() + '</td>' +
        '<td style="text-align:right;font-weight:600;">' + cur + e.pay.netPayable.toLocaleString() + '</td>' +
        '<td style="font-size:11px;">' + Util.escapeHtml(e.appraisal.grade) + '</td>' +
        '</tr>';
    }).join('');

    var t = report.totals;
    return '' +
      '<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;">' +
      '<div style="background:linear-gradient(135deg,#14532D,#1E7A4C);color:#fff;padding:22px 26px;border-radius:14px;">' +
        '<div style="font-size:12px;letter-spacing:.14em;opacity:.85;">' +
          Util.escapeHtml(report.company).toUpperCase() + ' · STAFF PERFORMANCE REPORT</div>' +
        '<div style="font-size:26px;font-weight:700;margin-top:6px;">' +
          Util.escapeHtml(report.periodType) + ' report — ' + Util.escapeHtml(report.periodLabel) + '</div>' +
        '<div style="font-size:12px;opacity:.9;margin-top:4px;">' +
          report.periodStart + ' to ' + report.periodEnd +
          ' · generated ' + Util.escapeHtml(report.generatedAt) + '</div>' +
      '</div>' +

      '<table style="width:100%;margin-top:18px;border-collapse:separate;border-spacing:10px 0;">' +
      '<tr>' +
        kpi_('Staff covered', t.staffCount) +
        kpi_('Tasks assigned', t.tasksAssigned) +
        kpi_('Completed', t.tasksCompleted + ' (' + t.completionRate + '%)') +
        kpi_('Pending validation', t.tasksPendingValidation) +
      '</tr><tr><td colspan="4" style="height:10px;"></td></tr><tr>' +
        kpi_('Attendance rate', t.attendanceRate + '%') +
        kpi_('Strikes / suspensions', t.strikesIssued + ' / ' + t.suspensions) +
        kpi_('Gross allocated', cur + t.grossAllocated.toLocaleString()) +
        kpi_('Net payable', cur + t.netPayable.toLocaleString()) +
      '</tr></table>' +

      '<h3 style="margin:26px 0 8px;font-size:15px;">Per-staff breakdown</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
      '<thead><tr style="background:#F3F4F6;text-align:left;">' +
        '<th style="padding:8px;">Staff</th><th>Alloc.</th><th>Done</th>' +
        '<th>Pending</th><th>Active</th><th>Failed</th><th>Compl.</th>' +
        '<th>Attend.</th><th>Strikes</th><th style="text-align:right;">Allocated</th>' +
        '<th style="text-align:right;">Net pay</th><th>Grade</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +

      '<p style="margin-top:18px;font-size:11px;color:#6B7280;">' +
        'Pay basis: ' + Util.escapeHtml(CFG.get('PayProgressSource', 'AdminValidated')) +
        ' progress × amount allocated. Strike limit ' + CFG.num('StrikeLimit', 3) +
        ', reset policy ' + Util.escapeHtml(CFG.get('StrikeResetPolicy', '')) + '. ' +
        'Cleared strikes and lifted suspensions remain on the permanent staff record.' +
      '</p></div>';
  },

  /**
   * Render the report to a PDF in Drive and return its link.
   * Reports live in <root>/Reports/<PeriodType>/.
   */
  exportPdf: function (periodType, refDate, staffId, actor) {
    var report = this.buildOrganisationReport(periodType, refDate, { staffId: staffId });
    var html = '<html><head><meta charset="utf-8"></head><body style="margin:24px;">' +
               this.toHtml(report) + '</body></html>';
    var name = [
      CFG.get('CompanyName', 'Report').replace(/[^\w\-]+/g, '_'),
      report.periodType,
      report.periodLabel.replace(/[^\w\-]+/g, '_'),
      staffId ? String(staffId) : 'ALL'
    ].join('_') + '.pdf';

    var blob = Utilities.newBlob(html, 'text/html', name).getAs('application/pdf').setName(name);
    var folder = DriveService.reportFolder(report.periodType);
    var file = folder.createFile(blob);
    DriveService.applySharing(file, { audience: 'admins' });

    Log.info('Reports', 'exportPdf ' + name + ' by ' + actor, file.getUrl());
    return {
      fileName: name,
      url: file.getUrl(),
      fileId: file.getId(),
      periodLabel: report.periodLabel
    };
  },

  /** Save the CSV to Drive and return its link. */
  exportCsv: function (periodType, refDate, staffId, actor) {
    var report = this.buildOrganisationReport(periodType, refDate, { staffId: staffId });
    var name = [
      CFG.get('CompanyName', 'Report').replace(/[^\w\-]+/g, '_'),
      report.periodType, report.periodLabel.replace(/[^\w\-]+/g, '_')
    ].join('_') + '.csv';
    var blob = Utilities.newBlob(this.toCsv(report), 'text/csv', name);
    var file = DriveService.reportFolder(report.periodType).createFile(blob);
    DriveService.applySharing(file, { audience: 'admins' });
    Log.info('Reports', 'exportCsv ' + name + ' by ' + actor, file.getUrl());
    return { fileName: name, url: file.getUrl(), fileId: file.getId() };
  }
};

/** Small KPI cell used by ReportService.toHtml. */
function kpi_(label, value) {
  return '<td style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;' +
    'padding:12px 14px;width:25%;">' +
    '<div style="font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:.08em;">' +
      Util.escapeHtml(label) + '</div>' +
    '<div style="font-size:20px;font-weight:700;margin-top:4px;">' +
      Util.escapeHtml(value) + '</div></td>';
}
