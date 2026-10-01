/**
 * ============================================================================
 * Payroll.gs — guaranteed salary, paid out on progress.
 * ============================================================================
 * REQUIREMENT 6: "allocation pay should be calculated by percentage of
 * completion progress".
 *
 * Each staff member has a guaranteed monthly salary (Staff.MonthlySalary).
 * AllocationService shares that guarantee across the tasks due in the month —
 * one task carries the whole salary, four tasks carry a quarter each — so the
 * per-task allocation is never typed in by hand:
 *
 *   share(task)   = guarantee × weight(task) / Σ weight(tasks due that month)
 *   payable(task) = share(task) × effectiveProgress(task) / 100
 *
 * effectiveProgress comes from Config.PayProgressSource, which is
 * 'AdminValidated' (confirmed decision): only the percentage an administrator
 * has validated pays out. Work sitting in "Pending — yet to validate" is
 * visible on the dashboard but earns nothing until it is signed off.
 *
 *   net = Σ payable(tasks due in period) − Σ strike penalties in period + adjustments
 *
 * The difference between the guarantee and what is earned is the forfeited
 * amount — the part of the salary the completion percentages did not release.
 *
 * Tasks are attributed to the period their DueDate falls in, so a task that
 * spans a month boundary is paid in the month it was due.
 * ============================================================================
 */

var PayrollService = {

  /**
   * Work out one staff member's pay for a period without writing anything.
   * @return {Object} full breakdown including per-task lines.
   */
  compute: function (staffId, periodType, refDate) {
    var staff = StaffService.byId(staffId);
    if (!staff) throw new Error('Staff member not found.');
    var period = Util.resolvePeriod(periodType || 'Monthly', refDate);

    var lines = [];
    var gross = 0, earned = 0;

    TaskService.forStaff(staffId).forEach(function (t) {
      if (String(t.Status) === TASK_STATUS.CANCELLED) return;
      if (String(t.Status) === TASK_STATUS.SCHEDULED) return;
      if (!Util.inPeriod(t.DueDate, period)) return;

      var progress = TaskService.effectiveProgress(t);
      var payable = TaskService.payableAmount(t);
      gross += Util.num(t.AmountAllocated, 0);
      earned += payable;

      lines.push({
        taskId: String(t.TaskID),
        title: String(t.Title),
        taskType: String(t.TaskType),
        status: String(t.Status),
        dueDate: Util.dateKey(t.DueDate),
        amountAllocated: Util.money(t.AmountAllocated),
        reportedProgress: Util.pct(t.ReportedProgress),
        validatedProgress: Util.pct(t.ValidatedProgress),
        effectiveProgress: progress,
        payable: payable,
        metricScore: t.MetricScore === '' ? null : Util.num(t.MetricScore, 0),
        rolloverCount: Util.num(t.RolloverCount, 0)
      });
    });

    var strikeStats = StrikeService.statsFor(staffId, period);
    var penalties = strikeStats.penaltyTotal;
    var adjustments = 0;

    // Lateness deduction — a flat amount per late sign-in this period
    // (Config.LateDeductionPerDay, default ₦500). Counted from attendance.
    var attStats = AttendanceService.statsFor(staffId, period);
    var lateDays = Util.num(attStats.late, 0);
    var lateDeduction = Util.money(lateDays * CFG.num('LateDeductionPerDay', 500));

    // Carry forward any manual adjustment already recorded for this period.
    var existing = this.findRecord(staffId, period);
    if (existing) adjustments = Util.num(existing.Adjustments, 0);

    var net = Util.money(earned - penalties - lateDeduction + adjustments);
    // The guarantee this period represents, and how much of it the completion
    // percentages did not earn.
    var guaranteed = AllocationService.guaranteedForPeriod(staff, period);

    return {
      staffId: String(staff.StaffID),
      staffName: String(staff.Name),
      email: String(staff.Email),
      periodType: period.type,
      periodLabel: period.label,
      periodStart: period.startKey,
      periodEnd: period.endKey,
      tasksConsidered: lines.length,
      monthlySalary: AllocationService.salaryOf(staff),
      guaranteed: guaranteed,
      allocationMode: AllocationService.mode(),
      autoAllocated: AllocationService.enabled(),
      grossAllocated: Util.money(gross),
      unallocatedGuarantee: Util.money(Math.max(0, guaranteed - gross)),
      progressEarned: Util.money(earned),
      forfeited: Util.money(Math.max(0, gross - earned)),
      penalties: penalties,
      lateDays: lateDays,
      lateDeduction: lateDeduction,
      adjustments: Util.money(adjustments),
      netPay: net < 0 ? 0 : net,

      unpaidBecauseUnvalidated: Util.money(lines.reduce(function (sum, l) {
        return sum + (l.status === TASK_STATUS.PENDING_VALIDATION
          ? l.amountAllocated - l.payable : 0);
      }, 0)),
      payoutRate: Util.rate(earned, gross),
      strikes: strikeStats.issued,
      lines: lines,
      status: existing ? String(existing.Status) : 'Draft',
      payrollId: existing ? String(existing.PayrollID) : ''
    };
  },

  /** Existing Payroll row for a staff member + period, or null. */
  findRecord: function (staffId, period) {
    return SheetDB.findOne(SHEETS.PAYROLL, function (p) {
      return String(p.StaffID) === String(staffId) &&
             String(p.PeriodType) === period.type &&
             String(p.PeriodLabel) === period.label;
    });
  },

  /**
   * Compute and persist payroll for every active staff member.
   * Re-running overwrites Draft rows and leaves Approved/Paid rows alone.
   */
  runPeriod: function (periodType, refDate, actor) {
    var period = Util.resolvePeriod(periodType || 'Monthly', refDate);
    var result = { period: period.label, created: 0, updated: 0, locked: 0,
                   reallocated: 0, rows: [] };

    StaffService.active().forEach(function (staff) {
      // Re-split the guarantee before pricing the period so a task added or
      // edited since the last run is already carrying the right share.
      var plan = AllocationService.recalcStaffMonth(staff.StaffID, period.start);
      if (plan) result.reallocated += plan.written || 0;

      var detail = PayrollService.compute(staff.StaffID, period.type, period.start);
      var existing = PayrollService.findRecord(staff.StaffID, period);

      if (existing && String(existing.Status) !== 'Draft') {
        result.locked++;
        result.rows.push(detail);
        return;
      }

      var payload = {
        StaffID: String(staff.StaffID),
        StaffName: String(staff.Name),
        PeriodType: period.type,
        PeriodLabel: period.label,
        PeriodStart: period.start,
        PeriodEnd: period.end,
        TasksConsidered: detail.tasksConsidered,
        GuaranteedSalary: detail.guaranteed,
        GrossAllocated: detail.grossAllocated,
        ProgressEarned: detail.progressEarned,
        Forfeited: detail.forfeited,
        Penalties: detail.penalties,
        LateDeduction: detail.lateDeduction,
        Adjustments: detail.adjustments,
        NetPay: detail.netPay,
        Status: 'Draft',
        ApprovedBy: '', ApprovedAt: '', PaidAt: '',
        Reference: '',
        Notes: 'Guarantee ' + Util.fmtMoney(detail.guaranteed) + ' shared across ' +
               detail.tasksConsidered + ' task(s). Pay basis: ' +
               CFG.get('PayProgressSource', 'AdminValidated') +
               ' progress. Generated by ' + actor + '.',
        CreatedAt: new Date()
      };

      if (existing) {
        SheetDB.updateRowAt(SHEETS.PAYROLL, existing.__row, payload);
        result.updated++;
      } else {
        payload.PayrollID = SheetDB.nextId('PAY', SHEETS.PAYROLL, 'PayrollID', 6);
        SheetDB.insert(SHEETS.PAYROLL, payload);
        result.created++;
      }
      result.rows.push(detail);
    });

    Log.info('Payroll', 'runPeriod ' + period.label + ' ' +
      JSON.stringify({ created: result.created, updated: result.updated, locked: result.locked }));
    return result;
  },

  /** Record a manual adjustment (bonus or deduction) on a draft payroll row. */
  setAdjustment: function (payrollId, amount, note, admin) {
    var row = SheetDB.findById(SHEETS.PAYROLL, 'PayrollID', payrollId);
    if (!row) throw new Error('Payroll record not found.');
    if (String(row.Status) === 'Paid') throw new Error('A paid payroll record cannot be adjusted.');
    var adj = Util.money(amount);
    var net = Util.money(Util.num(row.ProgressEarned, 0) - Util.num(row.Penalties, 0) -
                         Util.num(row.LateDeduction, 0) + adj);
    SheetDB.updateRowAt(SHEETS.PAYROLL, row.__row, {
      Adjustments: adj,
      NetPay: net < 0 ? 0 : net,
      Notes: String(row.Notes || '') + ' | Adjustment ' + Util.fmtMoney(adj) +
             ' by ' + admin.Email + ': ' + String(note || '')
    });
    return { netPay: net < 0 ? 0 : net };
  },

  approve: function (payrollId, admin) {
    var row = SheetDB.findById(SHEETS.PAYROLL, 'PayrollID', payrollId);
    if (!row) throw new Error('Payroll record not found.');
    if (String(row.Status) !== 'Draft') throw new Error('Only a draft record can be approved.');
    SheetDB.updateRowAt(SHEETS.PAYROLL, row.__row, {
      Status: 'Approved',
      ApprovedBy: String(admin.Email),
      ApprovedAt: new Date()
    });
    NotificationService.push(row.StaffID, 'PayrollApproved', 'success',
      'Pay approved for ' + row.PeriodLabel,
      'Net payable ' + Util.fmtMoney(row.NetPay) + '.');
    Log.info('Payroll', 'Approved ' + payrollId + ' by ' + admin.Email);
    return true;
  },

  markPaid: function (payrollId, admin, reference) {
    var row = SheetDB.findById(SHEETS.PAYROLL, 'PayrollID', payrollId);
    if (!row) throw new Error('Payroll record not found.');
    if (String(row.Status) === 'Paid') throw new Error('This record is already marked paid.');
    if (String(row.Status) !== 'Approved') throw new Error('Approve the record before marking it paid.');
    SheetDB.updateRowAt(SHEETS.PAYROLL, row.__row, {
      Status: 'Paid',
      PaidAt: new Date(),
      Reference: String(reference || '')
    });
    var staff = StaffService.byId(row.StaffID);
    NotificationService.push(row.StaffID, 'PayrollPaid', 'success',
      'Payment released for ' + row.PeriodLabel,
      Util.fmtMoney(row.NetPay) + ' · ref ' + String(reference || 'n/a'));
    if (staff) {
      try { Notify.payslip(staff, row); }
      catch (e) { Log.exception('Payroll.markPaid/notify', e); }
    }
    Log.info('Payroll', 'Marked paid ' + payrollId + ' by ' + admin.Email);
    return true;
  },

  /** Payroll rows for a period, for the admin screen. */
  listPeriod: function (periodType, refDate) {
    var period = Util.resolvePeriod(periodType || 'Monthly', refDate);
    return SheetDB.find(SHEETS.PAYROLL, function (p) {
      return String(p.PeriodType) === period.type &&
             String(p.PeriodLabel) === period.label;
    }).map(function (p) {
      return {
        payrollId: String(p.PayrollID),
        staffId: String(p.StaffID),
        staffName: String(p.StaffName),
        periodLabel: String(p.PeriodLabel),
        tasksConsidered: Util.num(p.TasksConsidered, 0),
        guaranteed: Util.money(p.GuaranteedSalary),
        grossAllocated: Util.money(p.GrossAllocated),
        progressEarned: Util.money(p.ProgressEarned),
        forfeited: Util.money(p.Forfeited),
        penalties: Util.money(p.Penalties),
        lateDeduction: Util.money(p.LateDeduction),
        adjustments: Util.money(p.Adjustments),
        netPay: Util.money(p.NetPay),
        status: String(p.Status),
        approvedBy: String(p.ApprovedBy || ''),
        paidAt: Util.dateKey(p.PaidAt),
        reference: String(p.Reference || '')
      };
    });
  },

  /** A staff member's own payroll history. */
  historyFor: function (staffId) {
    return SheetDB.find(SHEETS.PAYROLL, function (p) {
      return String(p.StaffID) === String(staffId);
    }).map(function (p) {
      return {
        payrollId: String(p.PayrollID),
        periodType: String(p.PeriodType),
        periodLabel: String(p.PeriodLabel),
        guaranteed: Util.money(p.GuaranteedSalary),
        grossAllocated: Util.money(p.GrossAllocated),
        progressEarned: Util.money(p.ProgressEarned),
        forfeited: Util.money(p.Forfeited),
        penalties: Util.money(p.Penalties),
        lateDeduction: Util.money(p.LateDeduction),
        netPay: Util.money(p.NetPay),
        status: String(p.Status),
        paidAt: Util.dateKey(p.PaidAt)
      };
    }).sort(function (a, b) {
      return String(b.periodLabel).localeCompare(String(a.periodLabel));
    });
  },

  /** Organisation-wide totals for the admin dashboard tile. */
  organisationSummary: function (periodType, refDate) {
    var period = Util.resolvePeriod(periodType || 'Monthly', refDate);
    var totals = {
      periodLabel: period.label, guaranteed: 0, gross: 0, earned: 0, penalties: 0,
      lateDeductions: 0, net: 0, pendingValidationValue: 0, forfeited: 0, staffCount: 0
    };

    StaffService.active().forEach(function (staff) {
      var d = PayrollService.compute(staff.StaffID, period.type, period.start);
      totals.guaranteed += d.guaranteed;
      totals.gross += d.grossAllocated;
      totals.earned += d.progressEarned;
      totals.penalties += d.penalties;
      totals.lateDeductions += d.lateDeduction;
      totals.net += d.netPay;
      totals.pendingValidationValue += d.unpaidBecauseUnvalidated;
      totals.forfeited += d.forfeited;
      totals.staffCount++;
    });

    ['guaranteed', 'gross', 'earned', 'penalties', 'lateDeductions', 'net', 'pendingValidationValue', 'forfeited']
      .forEach(function (k) { totals[k] = Util.money(totals[k]); });
    totals.payoutRate = Util.rate(totals.earned, totals.gross);
    // How much of the promised salary bill the completion percentages released.
    totals.guaranteeRate = Util.rate(totals.earned, totals.guaranteed);
    totals.allocationMode = AllocationService.mode();
    totals.autoAllocated = AllocationService.enabled();
    return totals;
  }
};
