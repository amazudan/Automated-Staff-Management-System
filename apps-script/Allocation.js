/**
 * ============================================================================
 * Allocation.gs — guaranteed monthly salary → automatic task allocation.
 * ============================================================================
 * Every staff member has a guaranteed monthly salary (Staff.MonthlySalary).
 * Nobody types an allocation per task any more: the guarantee is shared across
 * the tasks whose DueDate falls in that month, and each task then pays out on
 * its completion percentage.
 *
 *   share(task)   = guarantee × weight(task) / Σ weight(tasks in the month)
 *   payable(task) = share(task) × effectiveProgress(task) / 100
 *
 * So a 30,000 guarantee with one task in the month puts the whole 30,000 on
 * that task and pays 30,000 × completion%. Add a second task and each carries
 * 15,000; add a fourth and each carries 7,500. The month's shares always add
 * back up to the guarantee exactly — the rounding residue is pushed onto the
 * last task.
 *
 * Config:
 *   AutoAllocateFromSalary  TRUE (FALSE = go back to typing amounts by hand)
 *   DefaultMonthlySalary    guarantee for staff with no figure of their own
 *   TaskAllocationMode      Equal | Weighted
 *   TaskAllocationWeights   Low:1,Normal:1,High:1.5,Critical:2
 *
 * Shares are recalculated at every mutation point (task created, edited,
 * reassigned, re-dated, cancelled, rolled over; salary changed), so every read
 * path can simply trust Tasks.AmountAllocated.
 *
 * A month whose Monthly payroll row is already Approved or Paid is frozen:
 * existing shares are left exactly as they were banked, and only a task with no
 * share yet is filled in.
 * ============================================================================
 */

var AllocationService = {

  /* --- Config ----------------------------------------------------------- */

  /** Is automatic allocation switched on? */
  enabled: function () { return CFG.bool('AutoAllocateFromSalary', true); },

  /** 'Equal' (default) or 'Weighted'. */
  mode: function () {
    return String(CFG.get('TaskAllocationMode', 'Equal')).trim() === 'Weighted'
      ? 'Weighted' : 'Equal';
  },

  /** Parse 'Low:1,Normal:1,High:1.5,Critical:2' into a map. */
  weights: function () {
    var map = {};
    String(CFG.get('TaskAllocationWeights', '')).split(',').forEach(function (pair) {
      var bits = String(pair).split(':');
      if (bits.length !== 2) return;
      var name = bits[0].trim();
      var w = Util.num(bits[1], 0);
      if (name && w > 0) map[name] = w;
    });
    return map;
  },

  /** The weight one task carries when the guarantee is split. */
  weightOf: function (task) {
    if (this.mode() !== 'Weighted') return 1;
    var w = Util.num(this.weights()[String(task.Priority)], 0);
    return w > 0 ? w : 1;
  },

  /* --- Salary ----------------------------------------------------------- */

  /** Guaranteed monthly salary for a staff row (falls back to the config default). */
  salaryOf: function (staff) {
    if (!staff) return 0;
    var raw = staff.MonthlySalary;
    if (raw === '' || raw === null || raw === undefined) {
      return Util.money(CFG.num('DefaultMonthlySalary', 0));
    }
    return Util.money(Util.num(raw, 0));
  },

  salaryFor: function (staffId) {
    return this.salaryOf(StaffService.byId(staffId));
  },

  /**
   * What the guarantee is worth over an arbitrary reporting period. A month is
   * exactly one salary; longer periods add up; a part-month (Daily/Weekly) is
   * pro-rated by days so the figure never overstates the promise.
   */
  guaranteedForPeriod: function (staff, period) {
    var salary = this.salaryOf(staff);
    if (!salary || !period) return 0;
    var total = 0;
    var cursor = new Date(period.start.getFullYear(), period.start.getMonth(), 1);
    var guard = 0;
    while (cursor <= period.end && guard++ < 400) {
      var monthStart = cursor;
      var monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
      var days = monthEnd.getDate();
      var from = period.start > monthStart ? period.start : monthStart;
      var to = period.end < monthEnd ? period.end : monthEnd;
      var covered = Math.round((Util.startOfDay(to) - Util.startOfDay(from)) / 86400000) + 1;
      if (covered > 0) total += salary * (covered / days);
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
    return Util.money(total);
  },

  /* --- Months ----------------------------------------------------------- */

  /** The calendar month a task is paid in — the month of its DueDate. */
  monthOf: function (dateish) {
    var period = Util.resolvePeriod('Monthly', dateish ? Util.startOfDay(dateish) : Util.today());
    period.key = Utilities.formatDate(period.start, getTz(), 'yyyy-MM');
    return period;
  },

  /** Does this task consume a share of the month? Cancelled work does not. */
  counts: function (task) {
    return String(task.Status) !== TASK_STATUS.CANCELLED;
  },

  /**
   * Is the month's pay already banked? Approved/Paid payroll rows are frozen so
   * a late edit cannot rewrite what somebody has been told they earned.
   */
  isMonthLocked: function (staffId, month) {
    var row = SheetDB.findOne(SHEETS.PAYROLL, function (p) {
      return String(p.StaffID) === String(staffId) &&
             String(p.PeriodType) === 'Monthly' &&
             String(p.PeriodLabel) === month.label;
    });
    return !!(row && String(row.Status) !== 'Draft');
  },

  /* --- The plan --------------------------------------------------------- */

  /**
   * Work out what every task in one staff-month should carry. Pure: writes
   * nothing. `extra` optionally models a task that does not exist yet
   * ({priority: 'High'}) so the task form can preview the split live.
   */
  plan: function (staffId, monthRef, extra) {
    var staff = StaffService.byId(staffId);
    if (!staff) throw new Error('Staff member not found.');
    var self = this;
    var month = this.monthOf(monthRef);
    var guaranteed = this.salaryOf(staff);

    var rows = TaskService.forStaff(staffId).filter(function (t) {
      return self.counts(t) && Util.inPeriod(t.DueDate, month);
    }).sort(function (a, b) {
      var ka = Util.dateKey(a.DueDate), kb = Util.dateKey(b.DueDate);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return String(a.TaskID).localeCompare(String(b.TaskID));
    });

    // A hypothetical task is weighted like a real one but never written.
    var units = rows.map(function (t) { return { task: t, weight: self.weightOf(t) }; });
    if (extra) {
      units.push({ task: null, weight: self.weightOf({ Priority: extra.priority || 'Normal' }) });
    }

    var totalWeight = units.reduce(function (sum, u) { return sum + u.weight; }, 0);
    var shares = units.map(function (u) {
      return totalWeight > 0 ? Util.money(guaranteed * u.weight / totalWeight) : 0;
    });
    // Hand the rounding residue to the last share so the month adds up exactly.
    if (shares.length && totalWeight > 0) {
      var sum = shares.reduce(function (a, b) { return a + b; }, 0);
      var last = shares.length - 1;
      shares[last] = Util.money(shares[last] + (guaranteed - sum));
    }

    var lines = [], allocated = 0, earned = 0, newShare = 0;
    units.forEach(function (u, i) {
      if (!u.task) { newShare = shares[i]; return; }
      var t = u.task;
      var share = shares[i];
      var effective = TaskService.effectiveProgress(t);
      var payable = Util.money(share * effective / 100);
      var storedBlank = t.AmountAllocated === '' || t.AmountAllocated === null ||
                        t.AmountAllocated === undefined;
      allocated += share;
      earned += payable;
      lines.push({
        taskId: String(t.TaskID),
        title: String(t.Title),
        taskType: String(t.TaskType),
        status: String(t.Status),
        priority: String(t.Priority),
        dueDate: Util.dateKey(t.DueDate),
        weight: u.weight,
        share: share,
        stored: Util.money(Util.num(t.AmountAllocated, 0)),
        storedBlank: storedBlank,
        storedPayable: Util.money(Util.num(t.PayableAmount, 0)),
        reportedProgress: Util.pct(t.ReportedProgress),
        validatedProgress: Util.pct(t.ValidatedProgress),
        effectiveProgress: effective,
        payable: payable,
        rowIndex: t.__row
      });
    });

    var byTaskId = {};
    lines.forEach(function (l) { byTaskId[l.taskId] = l; });

    return {
      staffId: String(staff.StaffID),
      staffName: String(staff.Name),
      monthKey: month.key,
      monthLabel: month.label,
      guaranteed: guaranteed,
      mode: this.mode(),
      taskCount: lines.length,
      totalWeight: totalWeight,
      allocated: Util.money(allocated),
      earned: Util.money(earned),
      forfeited: Util.money(allocated - earned),
      sharePerTask: lines.length ? shares[0] : 0,
      newTaskShare: newShare,
      locked: this.isMonthLocked(staffId, month),
      lines: lines,
      byTaskId: byTaskId
    };
  },

  /* --- Writing ---------------------------------------------------------- */

  /**
   * Persist a plan onto the Tasks sheet. Only rows whose numbers actually
   * changed are written. In a frozen month nothing is rewritten except a task
   * that has no share at all yet.
   */
  applyPlan: function (plan) {
    var written = 0;
    plan.lines.forEach(function (line) {
      if (plan.locked && !line.storedBlank) return;
      var patch = {};
      if (line.stored !== line.share) patch.AmountAllocated = line.share;
      if (line.storedPayable !== line.payable) patch.PayableAmount = line.payable;
      if (!Object.keys(patch).length) return;
      patch.LastUpdated = new Date();
      SheetDB.updateRowAt(SHEETS.TASKS, line.rowIndex, patch);
      line.stored = line.share;
      line.storedBlank = false;
      line.storedPayable = line.payable;
      written++;
    });
    plan.written = written;
    return plan;
  },

  /**
   * Recalculate one staff-month and write the result. Returns the plan (with
   * .written), or null when automatic allocation is switched off or the staff
   * member has gone. Never throws into a caller — allocation must not be able
   * to fail a task save.
   */
  recalcStaffMonth: function (staffId, monthRef) {
    if (!this.enabled()) return null;
    if (!staffId) return null;
    try {
      return this.applyPlan(this.plan(staffId, monthRef));
    } catch (err) {
      Log.exception('Allocation.recalcStaffMonth ' + staffId, err);
      return null;
    }
  },

  /** Recalculate the month a task sits in. */
  recalcForTask: function (task) {
    if (!task) return null;
    return this.recalcStaffMonth(task.AssignedTo, task.DueDate);
  },

  /**
   * Recalculate several staff-months, ignoring duplicates. Pass
   * [{staffId: 'STF-001', date: dueDate}, ...].
   */
  recalcMany: function (targets) {
    var self = this;
    var seen = {}, plans = [];
    (targets || []).forEach(function (t) {
      if (!t || !t.staffId) return;
      var key = String(t.staffId) + '|' + self.monthOf(t.date).key;
      if (seen[key]) return;
      seen[key] = true;
      var plan = self.recalcStaffMonth(t.staffId, t.date);
      if (plan) plans.push(plan);
    });
    return plans;
  },

  /** Every month one staff member has tasks in (plus the current month). */
  monthsFor: function (staffId) {
    var self = this;
    var seen = {}, out = [];
    var add = function (dateish) {
      var m = self.monthOf(dateish);
      if (seen[m.key]) return;
      seen[m.key] = true;
      out.push(m);
    };
    add(Util.today());
    TaskService.forStaff(staffId).forEach(function (t) {
      if (self.counts(t) && Util.dateKey(t.DueDate)) add(t.DueDate);
    });
    return out;
  },

  /** Recalculate every month for one staff member (used when a salary changes). */
  recalcStaff: function (staffId) {
    if (!this.enabled()) return { staffId: staffId, months: 0, written: 0 };
    var self = this;
    var result = { staffId: String(staffId), months: 0, written: 0, locked: 0 };
    this.monthsFor(staffId).forEach(function (month) {
      var plan = self.recalcStaffMonth(staffId, month.start);
      if (!plan) return;
      result.months++;
      result.written += plan.written || 0;
      if (plan.locked) result.locked++;
    });
    return result;
  },

  /** Repair pass across everybody — the admin "Recalculate allocations" button. */
  recalcAll: function () {
    if (!this.enabled()) {
      return { staff: 0, months: 0, written: 0, skipped: 'AutoAllocateFromSalary is FALSE' };
    }
    var out = { staff: 0, months: 0, written: 0, locked: 0 };
    StaffService.all().forEach(function (staff) {
      var r = AllocationService.recalcStaff(staff.StaffID);
      out.staff++;
      out.months += r.months;
      out.written += r.written;
      out.locked += r.locked || 0;
    });
    Log.info('Allocation', 'recalcAll ' + JSON.stringify(out));
    return out;
  },

  /* --- Read-only views -------------------------------------------------- */

  /**
   * What one task carries, in the context of its month — used by both task
   * detail screens ("7,500 of a 30,000 guarantee · 1 of 4 tasks in September").
   */
  forTask: function (task) {
    if (!task || !task.AssignedTo) return null;
    try {
      var plan = this.plan(task.AssignedTo, task.DueDate);
      var line = plan.byTaskId[String(task.TaskID)] || null;
      return {
        enabled: this.enabled(),
        monthLabel: plan.monthLabel,
        guaranteed: plan.guaranteed,
        taskCount: plan.taskCount,
        mode: plan.mode,
        locked: plan.locked,
        share: line ? line.share : Util.money(Util.num(task.AmountAllocated, 0)),
        payable: line ? line.payable : TaskService.payableAmount(task),
        position: line ? plan.lines.indexOf(line) + 1 : 0
      };
    } catch (err) {
      Log.exception('Allocation.forTask', err);
      return null;
    }
  },

  /**
   * Preview for the task form: what this task would be worth, and what it does
   * to the other tasks in the month. `taskId` is set when editing, so the task
   * is already in the plan and no hypothetical is added.
   */
  preview: function (staffId, dueDate, priority, taskId) {
    var wanted = String(taskId || '');
    var existing = wanted ? this.plan(staffId, dueDate) : null;
    var inPlan = existing && existing.byTaskId[wanted];
    var plan = inPlan ? existing : this.plan(staffId, dueDate, { priority: priority });

    return {
      enabled: this.enabled(),
      staffId: plan.staffId,
      staffName: plan.staffName,
      monthLabel: plan.monthLabel,
      guaranteed: plan.guaranteed,
      mode: plan.mode,
      locked: plan.locked,
      // Tasks that will share the month once this one is saved.
      taskCount: inPlan ? plan.taskCount : plan.taskCount + 1,
      existingCount: inPlan ? plan.taskCount - 1 : plan.taskCount,
      thisShare: inPlan ? plan.byTaskId[wanted].share : plan.newTaskShare,
      others: plan.lines.filter(function (l) { return l.taskId !== wanted; })
        .map(function (l) {
          return { taskId: l.taskId, title: l.title, share: l.share,
                   stored: l.stored, dueDate: l.dueDate, status: l.status };
        })
    };
  },

  /**
   * Whole-organisation allocation table for the admin Allocation screen.
   * One row per staff member for the chosen month, each with its task lines.
   */
  summary: function (monthRef) {
    var self = this;
    var month = this.monthOf(monthRef);
    var totals = { guaranteed: 0, allocated: 0, earned: 0, forfeited: 0, tasks: 0, staff: 0 };
    var rows = [];

    StaffService.all().forEach(function (staff) {
      if (String(staff.Status) === STAFF_STATUS.INACTIVE) return;
      var plan;
      try { plan = self.plan(staff.StaffID, month.start); }
      catch (e) { return; }

      rows.push({
        staffId: plan.staffId,
        staffName: plan.staffName,
        department: String(staff.Department || ''),
        status: String(staff.Status),
        guaranteed: plan.guaranteed,
        taskCount: plan.taskCount,
        sharePerTask: plan.sharePerTask,
        allocated: plan.allocated,
        earned: plan.earned,
        forfeited: plan.forfeited,
        payoutRate: Util.rate(plan.earned, plan.allocated),
        locked: plan.locked,
        drift: plan.lines.some(function (l) { return l.stored !== l.share; }),
        lines: plan.lines.map(function (l) {
          return {
            taskId: l.taskId, title: l.title, status: l.status, priority: l.priority,
            dueDate: l.dueDate, weight: l.weight, share: l.share, stored: l.stored,
            reportedProgress: l.reportedProgress, validatedProgress: l.validatedProgress,
            effectiveProgress: l.effectiveProgress, payable: l.payable
          };
        })
      });

      totals.staff++;
      totals.tasks += plan.taskCount;
      totals.guaranteed += plan.guaranteed;
      totals.allocated += plan.allocated;
      totals.earned += plan.earned;
      totals.forfeited += plan.forfeited;
    });

    ['guaranteed', 'allocated', 'earned', 'forfeited'].forEach(function (k) {
      totals[k] = Util.money(totals[k]);
    });
    totals.payoutRate = Util.rate(totals.earned, totals.allocated);
    totals.monthLabel = month.label;
    totals.monthKey = month.key;
    totals.mode = this.mode();
    totals.enabled = this.enabled();

    rows.sort(function (a, b) { return b.guaranteed - a.guaranteed; });
    return { month: { key: month.key, label: month.label,
                      start: month.startKey, end: month.endKey },
             totals: totals, rows: rows };
  }
};
