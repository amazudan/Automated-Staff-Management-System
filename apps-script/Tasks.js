/**
 * ============================================================================
 * Tasks.gs — task lifecycle, daily reporting, rollover and scoring.
 * ============================================================================
 * LIFECYCLE
 *
 *   Scheduled ──(StartDate arrives, trigger)──▶ Assigned
 *   Assigned  ──(staff clicks Acknowledge)───▶ Acknowledged
 *   Acknowledged ──(staff reports progress)──▶ InProgress
 *   InProgress ──(staff submits)─────────────▶ PendingValidation
 *   PendingValidation ──(admin validates)────▶ Completed
 *                     └─(admin rejects)──────▶ InProgress
 *   any open status ──(DueDate passes)───────▶ Failed  (Daily tasks roll first)
 *
 * DASHBOARD BUCKETS (requirement 3)
 *   Completed  = Completed
 *   Pending    = PendingValidation  ("yet to validate")
 *   InProgress = Assigned + Acknowledged + InProgress
 *
 * DAILY ROLLOVER (requirement 1)
 *   A Daily task still open after its due date is moved to the next working
 *   day, flagged IsPriority, escalated one priority level, and the staff
 *   member is warned by email + in-app notification. Each rollover issues one
 *   strike. On the strike limit (default 3) the staff member is suspended and
 *   the task stops rolling.
 * ============================================================================
 */

var TaskService = {

  /* --- Queries ---------------------------------------------------------- */

  all: function () { return SheetDB.readAll(SHEETS.TASKS); },

  byId: function (taskId) { return SheetDB.findById(SHEETS.TASKS, 'TaskID', taskId); },

  forStaff: function (staffId) {
    return SheetDB.find(SHEETS.TASKS, function (t) {
      return String(t.AssignedTo) === String(staffId);
    });
  },

  /** Which of the three headline buckets a status belongs to ('' if none). */
  bucketOf: function (status) {
    var s = String(status);
    if (TASK_BUCKETS.COMPLETED.indexOf(s) !== -1) return 'completed';
    if (TASK_BUCKETS.PENDING.indexOf(s) !== -1) return 'pending';
    if (TASK_BUCKETS.IN_PROGRESS.indexOf(s) !== -1) return 'inProgress';
    return '';
  },

  isOpen: function (status) {
    return TASK_OPEN_STATUSES.indexOf(String(status)) !== -1;
  },

  /* --- Money & scoring -------------------------------------------------- */

  /**
   * The completion percentage that pay is based on.
   * Config.PayProgressSource is 'AdminValidated' (confirmed decision), so a
   * staff member's self-reported progress earns nothing until an admin
   * validates it.
   */
  effectiveProgress: function (task) {
    var source = CFG.get('PayProgressSource', 'AdminValidated');
    var validated = Util.pct(task.ValidatedProgress);
    var reported = Util.pct(task.ReportedProgress);

    var progress;
    if (source === 'ReportedProgress') {
      progress = reported;
    } else {
      progress = validated;
      // A task an admin marked Completed without typing a number is 100%.
      if (String(task.Status) === TASK_STATUS.COMPLETED && !task.ValidatedProgress) {
        progress = 100;
      }
    }
    if (String(task.Status) === TASK_STATUS.CANCELLED) return 0;
    return progress < CFG.num('MinProgressForPay', 0) ? 0 : progress;
  },

  /** Requirement 6: pay = AmountAllocated × completion progress %. */
  payableAmount: function (task) {
    return Util.money(Util.num(task.AmountAllocated, 0) * this.effectiveProgress(task) / 100);
  },

  /**
   * Weighted metric score 0–100. Weights come from the Config sheet:
   *   MetricWeightReportTimeliness (default 40) — on-time daily reports
   *   MetricWeightOnTimeCompletion (default 40) — finished by DueDate
   *   MetricWeightAdminRating      (default 20) — admin quality rating
   */
  computeMetricScore: function (task) {
    var w1 = CFG.num('MetricWeightReportTimeliness', 40);
    var w2 = CFG.num('MetricWeightOnTimeCompletion', 40);
    var w3 = CFG.num('MetricWeightAdminRating', 20);
    var total = w1 + w2 + w3;
    if (total <= 0) return 0;

    var reports = DailyReportService.forTask(task.TaskID);
    var onTimeReports = reports.filter(function (r) { return Util.truthy(r.OnTime); }).length;
    var timeliness = reports.length ? (onTimeReports / reports.length) : 0;

    var onTimeCompletion = 0;
    var completedKey = Util.dateKey(task.CompletedAt);
    var dueKey = Util.dateKey(task.DueDate);
    if (completedKey && dueKey) {
      onTimeCompletion = completedKey <= dueKey ? 1 : 0;
    } else {
      // Not finished yet: credit proportionally to validated progress.
      onTimeCompletion = Util.pct(task.ValidatedProgress) / 100;
    }
    // Every rollover costs 15% of the timeliness component.
    var rolloverPenalty = Math.min(1, Util.num(task.RolloverCount, 0) * 0.15);
    timeliness = Math.max(0, timeliness - rolloverPenalty);

    var rating = task.AdminRating === '' || task.AdminRating === null ||
                 task.AdminRating === undefined
      ? CFG.num('DefaultAdminRating', 80)
      : Util.pct(task.AdminRating);

    var score = (w1 * timeliness + w2 * onTimeCompletion + w3 * (rating / 100)) / total * 100;
    return Math.round(Math.max(0, Math.min(100, score)));
  },

  /* --- Creation --------------------------------------------------------- */

  /**
   * Create one task. Tasks with a future StartDate are parked as Scheduled and
   * go live automatically via activateScheduledTasks().
   */
  create: function (input, actor, opts) {
    opts = opts || {};
    var title = String(input.title || '').trim();
    if (!title) throw new Error('Task title is required.');

    var staff = StaffService.byId(input.assignedTo);
    if (!staff) throw new Error('Assign the task to a valid staff member.');
    if (String(staff.Status) === STAFF_STATUS.INACTIVE) {
      throw new Error(staff.Name + ' is inactive and cannot be assigned work.');
    }
    if (String(staff.Status) === STAFF_STATUS.SUSPENDED &&
        CFG.bool('SuspensionBlocksNewTasks', true)) {
      throw new Error(staff.Name + ' is suspended. Clear their strike record before assigning new tasks.');
    }

    var taskType = String(input.taskType || TASK_TYPE.DAILY);
    if ([TASK_TYPE.DAILY, TASK_TYPE.WEEKLY, TASK_TYPE.MONTHLY, TASK_TYPE.PROJECT]
        .indexOf(taskType) === -1) {
      throw new Error('Task type must be Daily, Weekly, Monthly or Project.');
    }

    var start = Util.startOfDay(input.startDate || Util.today());
    var due = input.dueDate ? Util.startOfDay(input.dueDate) : defaultDueDate_(start, taskType);
    if (Util.dateKey(due) < Util.dateKey(start)) {
      throw new Error('Due date cannot fall before the start date.');
    }

    // Requirement: allocations are derived from the assignee's guaranteed
    // monthly salary, shared across the tasks due that month (AllocationService).
    // The typed figure is only honoured when AutoAllocateFromSalary is FALSE.
    var autoAllocate = AllocationService.enabled();
    var amount = autoAllocate ? 0 : Util.num(input.amountAllocated, 0);
    if (amount < 0) throw new Error('Allocated amount cannot be negative.');

    var priority = String(input.priority || 'Normal');
    if (PRIORITY_LADDER.indexOf(priority) === -1) priority = 'Normal';

    var goLiveToday = Util.dateKey(start) <= Util.dateKey(Util.today());
    var record = {
      TaskID: SheetDB.nextId('TSK', SHEETS.TASKS, 'TaskID', 6),
      Title: title,
      Description: String(input.description || '').trim(),
      TaskType: taskType,
      Priority: priority,
      AssignedTo: String(staff.StaffID),
      AssignedToName: String(staff.Name),
      AssignedBy: String(actor || ''),
      StartDate: start,
      DueDate: due,
      OriginalDueDate: due,
      AmountAllocated: amount,
      Status: goLiveToday ? TASK_STATUS.ASSIGNED : TASK_STATUS.SCHEDULED,
      ReportedProgress: 0,
      ValidatedProgress: 0,
      PayableAmount: 0,
      AcknowledgedAt: '', SubmittedAt: '', ValidatedAt: '', ValidatedBy: '',
      CompletedAt: '',
      MetricScore: '', AdminRating: '', AdminComment: '',
      RolloverCount: 0,
      WarningsIssued: 0,
      IsPriority: priority === 'Critical',
      ParentTaskID: String(input.parentTaskId || ''),
      AttachmentUrl: '',
      CreatedAt: new Date(),
      LastUpdated: new Date()
    };

    SheetDB.insert(SHEETS.TASKS, record);
    Log.info('Tasks', 'Created ' + record.TaskID + ' for ' + staff.StaffID + ' by ' + actor);

    // Re-split the month now the new task is in it, then read our own share back
    // so the notification quotes the real figure.
    var allocation = null;
    if (autoAllocate) {
      allocation = AllocationService.recalcStaffMonth(staff.StaffID, record.DueDate);
      var mine = allocation && allocation.byTaskId[record.TaskID];
      if (mine) {
        record.AmountAllocated = mine.share;
        record.PayableAmount = mine.payable;
        amount = mine.share;
      }
    }

    if (!opts.silent && goLiveToday) {
      try { Notify.taskAssigned(staff, record); }
      catch (e) { Log.exception('Tasks.create/notify', e); }
      NotificationService.push(staff.StaffID, 'TaskAssigned', 'info',
        'New task: ' + title, 'Due ' + Util.fmtDate(due) + ' · ' +
        Util.fmtMoney(amount) + ' allocated' +
        (allocation && allocation.taskCount > 1
          ? ' (your ' + Util.fmtMoney(allocation.guaranteed) + ' guarantee shared across ' +
            allocation.taskCount + ' tasks due in ' + allocation.monthLabel + ')'
          : '') + '.');
    }
    return record;
  },

  /** Assign the same task to several people at once. */
  bulkCreate: function (input, staffIds, actor) {
    var out = { created: [], failed: [] };
    (staffIds || []).forEach(function (id) {
      try {
        var copy = {};
        Object.keys(input).forEach(function (k) { copy[k] = input[k]; });
        copy.assignedTo = id;
        out.created.push(TaskService.create(copy, actor).TaskID);
      } catch (e) {
        out.failed.push({ staffId: id, error: e.message });
      }
    });
    return out;
  },

  /** Admin edits an existing task. */
  update: function (taskId, patch, actor) {
    var task = this.byId(taskId);
    if (!task) throw new Error('Task not found.');
    if (String(task.Status) === TASK_STATUS.COMPLETED && patch.reopen !== true) {
      throw new Error('This task is already completed. Reopen it before editing.');
    }

    var changes = { LastUpdated: new Date() };
    if (patch.title !== undefined) {
      if (!String(patch.title).trim()) throw new Error('Task title cannot be blank.');
      changes.Title = String(patch.title).trim();
    }
    if (patch.description !== undefined) changes.Description = String(patch.description);
    if (patch.priority !== undefined && PRIORITY_LADDER.indexOf(String(patch.priority)) !== -1) {
      changes.Priority = String(patch.priority);
    }
    if (patch.taskType !== undefined) changes.TaskType = String(patch.taskType);
    if (patch.amountAllocated !== undefined && !AllocationService.enabled()) {
      var amt = Util.num(patch.amountAllocated, 0);
      if (amt < 0) throw new Error('Allocated amount cannot be negative.');
      changes.AmountAllocated = amt;
      changes.PayableAmount = Util.money(amt * this.effectiveProgress(task) / 100);
    }
    if (patch.startDate) changes.StartDate = Util.startOfDay(patch.startDate);
    if (patch.dueDate) changes.DueDate = Util.startOfDay(patch.dueDate);
    if (patch.assignedTo) {
      var staff = StaffService.byId(patch.assignedTo);
      if (!staff) throw new Error('Reassignment target not found.');
      changes.AssignedTo = String(staff.StaffID);
      changes.AssignedToName = String(staff.Name);
    }
    if (patch.reopen === true) {
      changes.Status = TASK_STATUS.IN_PROGRESS;
      changes.CompletedAt = '';
    }

    SheetDB.updateRowAt(SHEETS.TASKS, task.__row, changes);
    Log.info('Tasks', 'Updated ' + taskId + ' by ' + actor, JSON.stringify(changes));

    // Reassigning, re-dating or re-prioritising changes how the guarantee is
    // split — both the month it left and the month it landed in are re-split.
    AllocationService.recalcMany([
      { staffId: task.AssignedTo, date: task.DueDate },
      { staffId: changes.AssignedTo || task.AssignedTo,
        date: changes.DueDate || task.DueDate }
    ]);
    return true;
  },

  cancel: function (taskId, actor, reason) {
    var task = this.byId(taskId);
    if (!task) throw new Error('Task not found.');
    var changes = {
      Status: TASK_STATUS.CANCELLED,
      PayableAmount: 0,
      AdminComment: String(reason || ''),
      LastUpdated: new Date()
    };
    // Under automatic allocation a cancelled task keeps no share; in manual mode
    // the amount the admin typed is left on the record for the audit trail.
    if (AllocationService.enabled()) changes.AmountAllocated = 0;
    SheetDB.updateRowAt(SHEETS.TASKS, task.__row, changes);
    // The released share goes back to the rest of the month.
    AllocationService.recalcStaffMonth(task.AssignedTo, task.DueDate);
    NotificationService.push(task.AssignedTo, 'TaskCancelled', 'warn',
      'Task cancelled: ' + task.Title, String(reason || 'Cancelled by administrator.'));
    Log.info('Tasks', 'Cancelled ' + taskId + ' by ' + actor);
    return true;
  },

  /**
   * Reassign a task to another staff member. A failed task is reactivated so
   * the new owner can retry it (progress reset, status back to Assigned, and a
   * fresh due date if the old one has passed); an open task simply changes
   * hands. `opts` = { reactivate:Boolean, dueDate:'yyyy-MM-dd' }.
   */
  reassign: function (taskId, newStaffId, actor, opts) {
    opts = opts || {};
    var task = this.byId(taskId);
    if (!task) throw new Error('Task not found.');
    if (String(task.Status) === TASK_STATUS.CANCELLED) {
      throw new Error('A cancelled task cannot be reassigned — recreate it instead.');
    }
    var staff = StaffService.byId(newStaffId);
    if (!staff) throw new Error('Reassignment target not found.');
    if (String(staff.Status) === STAFF_STATUS.INACTIVE) {
      throw new Error(staff.Name + ' is inactive and cannot be assigned work.');
    }
    if (String(staff.Status) === STAFF_STATUS.SUSPENDED &&
        CFG.bool('SuspensionBlocksNewTasks', true)) {
      throw new Error(staff.Name + ' is suspended. Clear their strike record before assigning new tasks.');
    }

    var fromStaff = task.AssignedTo, fromDue = task.DueDate;
    var wasFailed = String(task.Status) === TASK_STATUS.FAILED ||
                    String(task.Status) === TASK_STATUS.COMPLETED;
    // A follow-up (requirement 1) re-opens the same work — usually for the same
    // person — under a "Follow-up:" heading, with no penalty. It always
    // reactivates so the task re-appears on the owner's board.
    var followUp = !!opts.followUp;
    var reactivate = followUp ? true
      : (opts.reactivate === undefined ? wasFailed : !!opts.reactivate);

    var changes = {
      AssignedTo: String(staff.StaffID),
      AssignedToName: String(staff.Name),
      LastUpdated: new Date()
    };
    if (followUp) {
      var baseTitle = String(task.Title || '');
      changes.Title = /^\s*Follow-up:/i.test(baseTitle) ? baseTitle : 'Follow-up: ' + baseTitle;
    }

    if (reactivate) {
      // A failed / finished task handed to someone new starts fresh for them.
      changes.Status = TASK_STATUS.ASSIGNED;
      changes.CompletedAt = '';
      changes.AcknowledgedAt = '';
      changes.ReportedProgress = 0;
      changes.ValidatedProgress = 0;
      changes.PayableAmount = 0;
      changes.IsPriority = true;
      // Don't leave it instantly overdue.
      if (opts.dueDate) {
        changes.DueDate = Util.startOfDay(opts.dueDate);
      } else if (Util.dateKey(task.DueDate) < Util.dateKey(Util.today())) {
        changes.DueDate = defaultDueDate_(Util.today(), String(task.TaskType));
      }
    } else if (opts.dueDate) {
      changes.DueDate = Util.startOfDay(opts.dueDate);
    }

    SheetDB.updateRowAt(SHEETS.TASKS, task.__row, changes);

    // Re-split the guarantee for the month it left and the month it lands in.
    AllocationService.recalcMany([
      { staffId: fromStaff, date: fromDue },
      { staffId: changes.AssignedTo, date: changes.DueDate || fromDue }
    ]);

    var newDue = changes.DueDate || task.DueDate;
    var noticeTitle = followUp ? 'Follow-up task: ' + task.Title
                               : 'Task assigned to you: ' + task.Title;
    NotificationService.push(staff.StaffID, 'TaskAssigned', 'info', noticeTitle,
      'Due ' + Util.fmtDate(newDue) + '.' +
      (followUp ? ' A follow-up on your earlier work — no penalty applies.'
                : (wasFailed ? ' Reactivated from a failed task — please acknowledge and retry.' : '')));
    var merged = {};
    Object.keys(task).forEach(function (k) { merged[k] = task[k]; });
    Object.keys(changes).forEach(function (k) { merged[k] = changes[k]; });
    try { Notify.taskAssigned(staff, merged); }
    catch (e) { Log.exception('Tasks.reassign/notify', e); }

    Log.info('Tasks', 'Reassigned ' + taskId + ' from ' + fromStaff + ' to ' +
      staff.StaffID + ' by ' + actor + (reactivate ? ' (reactivated)' : ''));
    return {
      taskId: String(task.TaskID),
      assignedTo: changes.AssignedTo,
      assignedToName: changes.AssignedToName,
      status: changes.Status || String(task.Status),
      reactivated: reactivate,
      followUp: followUp
    };
  },

  /* --- Staff actions ---------------------------------------------------- */

  /** Requirement 3.2: acknowledge before work counts as in progress. */
  acknowledge: function (taskId, staff) {
    var task = this.byId(taskId);
    if (!task) throw new Error('Task not found.');
    if (String(task.AssignedTo) !== String(staff.StaffID)) {
      throw new Error('That task is not assigned to you.');
    }
    if (String(task.Status) === TASK_STATUS.SCHEDULED) {
      // Its start date may already have arrived without the daily trigger
      // having run yet — in that case go live now instead of refusing.
      if (Util.dateKey(task.StartDate) > Util.dateKey(Util.today())) {
        throw new Error('This task is scheduled to start on ' + Util.fmtDate(task.StartDate) + '.');
      }
      SheetDB.updateRowAt(SHEETS.TASKS, task.__row, {
        Status: TASK_STATUS.ASSIGNED, LastUpdated: new Date()
      });
      task.Status = TASK_STATUS.ASSIGNED;
    }
    if (String(task.Status) !== TASK_STATUS.ASSIGNED) {
      throw new Error('This task has already been acknowledged.');
    }
    SheetDB.updateRowAt(SHEETS.TASKS, task.__row, {
      Status: TASK_STATUS.ACKNOWLEDGED,
      AcknowledgedAt: new Date(),
      LastUpdated: new Date()
    });
    NotificationService.pushAdmins('TaskAcknowledged', 'info',
      staff.Name + ' acknowledged "' + task.Title + '"',
      'Due ' + Util.fmtDate(task.DueDate) + '. Progress updates will appear on the task.');
    Log.info('Tasks', 'Acknowledged ' + taskId + ' by ' + staff.StaffID);
    return { acknowledged: true, status: TASK_STATUS.ACKNOWLEDGED, taskId: String(task.TaskID) };
  },

  /** Staff moves the progress slider. Does not pay out on its own. */
  reportProgress: function (taskId, staff, progress, note) {
    var task = this.byId(taskId);
    if (!task) throw new Error('Task not found.');
    if (String(task.AssignedTo) !== String(staff.StaffID)) {
      throw new Error('That task is not assigned to you.');
    }
    if (String(task.Status) === TASK_STATUS.SCHEDULED &&
        Util.dateKey(task.StartDate) <= Util.dateKey(Util.today())) {
      // Live in all but name — let the update through rather than blocking it.
      task.Status = TASK_STATUS.ASSIGNED;
    }
    if (!this.isOpen(task.Status)) {
      throw new Error('Progress can only be updated while a task is open. Current status: ' + task.Status);
    }
    if (CFG.bool('RequireAcknowledgement', true) &&
        String(task.Status) === TASK_STATUS.ASSIGNED) {
      throw new Error('Acknowledge the task before reporting progress.');
    }

    var pct = Util.pct(progress);
    var trimmed = String(note || '').trim();
    SheetDB.updateRowAt(SHEETS.TASKS, task.__row, {
      ReportedProgress: pct,
      Status: TASK_STATUS.IN_PROGRESS,
      AdminComment: trimmed
        ? (staff.Name + ' reported ' + pct + '%: ' + trimmed)
        : task.AdminComment,
      LastUpdated: new Date()
    });

    // Requirement: the percentage is visible to the admin as well as the staff
    // member, so the reported figure lands in the admin's reminder feed too.
    NotificationService.pushAdmins('TaskProgress', 'info',
      staff.Name + ' reported ' + pct + '% on "' + task.Title + '"',
      (trimmed ? trimmed + ' · ' : '') + 'Due ' + Util.fmtDate(task.DueDate) +
      '. Validate the task to release ' + Util.fmtMoney(task.AmountAllocated) + ' pro rata.');

    return {
      taskId: String(task.TaskID),
      reportedProgress: pct,
      status: TASK_STATUS.IN_PROGRESS
    };
  },

  /**
   * Staff hands the task in. It lands in the "Pending — yet to validate"
   * bucket; no money is earned until an admin validates.
   */
  submitForValidation: function (taskId, staff, note) {
    var task = this.byId(taskId);
    if (!task) throw new Error('Task not found.');
    if (String(task.AssignedTo) !== String(staff.StaffID)) {
      throw new Error('That task is not assigned to you.');
    }
    if (!this.isOpen(task.Status)) {
      throw new Error('Only an open task can be submitted. Current status: ' + task.Status);
    }
    if (CFG.bool('RequireDailyReportToSubmit', true) &&
        DailyReportService.forTask(taskId).length === 0) {
      throw new Error('Submit at least one daily report for this task before handing it in.');
    }

    SheetDB.updateRowAt(SHEETS.TASKS, task.__row, {
      Status: TASK_STATUS.PENDING_VALIDATION,
      SubmittedAt: new Date(),
      // Handing a task in is a claim of 100% unless the staff member says less.
      ReportedProgress: Util.pct(
        note && note.claimedProgress !== undefined
          ? note.claimedProgress
          : Math.max(Util.pct(task.ReportedProgress), 100)),
      AdminComment: typeof note === 'string' && note ? note : task.AdminComment,
      LastUpdated: new Date()
    });

    StaffService.adminEmails().forEach(function (email) {
      try { Notify.taskAwaitingValidation(email, staff, task); }
      catch (e) { Log.exception('Tasks.submit/notify', e); }
    });
    Log.info('Tasks', 'Submitted for validation ' + taskId + ' by ' + staff.StaffID);
    return true;
  },

  /* --- Admin validation ------------------------------------------------- */

  /**
   * Requirement 6 + confirmed pay decision: the admin's validated percentage
   * is what pays. markComplete=false records partial validated progress and
   * pushes the task back to InProgress so the staff member keeps going.
   */
  validate: function (taskId, admin, payload) {
    payload = payload || {};
    var task = this.byId(taskId);
    if (!task) throw new Error('Task not found.');
    if (String(task.Status) === TASK_STATUS.CANCELLED) {
      throw new Error('A cancelled task cannot be validated.');
    }

    var validated = Util.pct(
      payload.validatedProgress === undefined || payload.validatedProgress === ''
        ? task.ReportedProgress
        : payload.validatedProgress);
    var markComplete = payload.markComplete === undefined
      ? validated >= 100
      : !!payload.markComplete;

    var changes = {
      ValidatedProgress: validated,
      ValidatedAt: new Date(),
      ValidatedBy: String(admin.Email || admin.StaffID),
      AdminRating: payload.rating === undefined || payload.rating === ''
        ? task.AdminRating : Util.pct(payload.rating),
      AdminComment: payload.comment === undefined ? task.AdminComment : String(payload.comment),
      LastUpdated: new Date()
    };

    if (markComplete) {
      changes.Status = TASK_STATUS.COMPLETED;
      changes.CompletedAt = new Date();
      if (!validated) changes.ValidatedProgress = 100;
    } else {
      changes.Status = TASK_STATUS.IN_PROGRESS;
      changes.CompletedAt = '';
      changes.IsPriority = true;   // partially accepted work stays prioritised
    }

    // Recompute money and score against the merged record.
    var merged = {};
    Object.keys(task).forEach(function (k) { merged[k] = task[k]; });
    Object.keys(changes).forEach(function (k) { merged[k] = changes[k]; });
    changes.PayableAmount = this.payableAmount(merged);
    changes.MetricScore = this.computeMetricScore(merged);

    SheetDB.updateRowAt(SHEETS.TASKS, task.__row, changes);

    var staff = StaffService.byId(task.AssignedTo);
    if (staff) {
      NotificationService.push(staff.StaffID,
        markComplete ? 'TaskCompleted' : 'TaskPartiallyValidated',
        markComplete ? 'success' : 'warn',
        markComplete ? 'Task approved: ' + task.Title
                     : 'Partially approved: ' + task.Title,
        'Validated progress ' + changes.ValidatedProgress + '% · earning ' +
        Util.fmtMoney(changes.PayableAmount) +
        (markComplete ? '' : '. Keep going to earn the balance.'));
      try { Notify.taskValidated(staff, merged, changes, markComplete); }
      catch (e) { Log.exception('Tasks.validate/notify', e); }
    }

    Log.info('Tasks', 'Validated ' + taskId + ' at ' + changes.ValidatedProgress +
      '% by ' + admin.Email, 'payable=' + changes.PayableAmount);
    return {
      status: changes.Status,
      validatedProgress: changes.ValidatedProgress,
      payableAmount: changes.PayableAmount,
      metricScore: changes.MetricScore
    };
  },

  /**
   * Send a submission back without accepting any progress. Per requirement 4 a
   * rejected task returns to the "Assigned" state — the staff member must
   * acknowledge and rework it — so acknowledgement is cleared too.
   */
  reject: function (taskId, admin, comment) {
    var task = this.byId(taskId);
    if (!task) throw new Error('Task not found.');
    SheetDB.updateRowAt(SHEETS.TASKS, task.__row, {
      Status: TASK_STATUS.ASSIGNED,
      AcknowledgedAt: '',
      ValidatedProgress: 0,
      PayableAmount: 0,
      IsPriority: true,
      AdminComment: String(comment || 'Returned for rework.'),
      ValidatedAt: new Date(),
      ValidatedBy: String(admin.Email || admin.StaffID),
      LastUpdated: new Date()
    });
    // Zeroing validated progress releases this task's share back to the month.
    AllocationService.recalcStaffMonth(task.AssignedTo, task.DueDate);
    NotificationService.push(task.AssignedTo, 'TaskRejected', 'danger',
      'Rework needed: ' + task.Title,
      String(comment || 'Returned for rework.') + ' Acknowledge it again to restart.');
    var staff = StaffService.byId(task.AssignedTo);
    if (staff) {
      try { Notify.taskRejected(staff, task, comment); }
      catch (e) { Log.exception('Tasks.reject/notify', e); }
    }
    Log.info('Tasks', 'Rejected ' + taskId + ' by ' + admin.Email);
    return true;
  },

  /* --- Reverse, escalate & resolve (requirements 3 & 4) ----------------- */

  /**
   * Reverse an approved (Completed) task back to the "pending validation"
   * state so it can be validated again — requirement 4. Progress and pay are
   * reset to zero until it is re-validated.
   */
  reverse: function (taskId, admin, comment) {
    var task = this.byId(taskId);
    if (!task) throw new Error('Task not found.');
    if (String(task.Status) !== TASK_STATUS.COMPLETED) {
      throw new Error('Only an approved (completed) task can be reversed.');
    }
    SheetDB.updateRowAt(SHEETS.TASKS, task.__row, {
      Status: TASK_STATUS.PENDING_VALIDATION,
      ValidatedProgress: 0,
      PayableAmount: 0,
      CompletedAt: '',
      ValidatedAt: '',
      ValidatedBy: '',
      AdminComment: String(comment || 'Approval reversed — awaiting re-validation.'),
      LastUpdated: new Date()
    });
    // Releasing the validated progress hands this task's share back to the month.
    AllocationService.recalcStaffMonth(task.AssignedTo, task.DueDate);
    NotificationService.push(task.AssignedTo, 'TaskReversed', 'warn',
      'Approval reversed: ' + task.Title,
      String(comment || 'Your completed task is awaiting re-validation.'));
    Log.info('Tasks', 'Reversed ' + taskId + ' by ' + admin.Email);
    return { status: TASK_STATUS.PENDING_VALIDATION, taskId: String(task.TaskID) };
  },

  /**
   * Escalate a task to a Software Developer — requirement 3. The task stays
   * assigned to the original staff member (pay attribution is unchanged) but is
   * flagged as escalated; the developer is emailed immediately, then works AND
   * validates it. The original assignee sees "Resolved" once it is done.
   */
  escalate: function (taskId, actor, developerId, note) {
    var task = this.byId(taskId);
    if (!task) throw new Error('Task not found.');
    if (String(task.Status) === TASK_STATUS.CANCELLED) {
      throw new Error('A cancelled task cannot be escalated.');
    }
    if (String(task.EscalationStatus) === 'Open') {
      throw new Error('This task is already escalated to ' +
        (task.EscalatedToName || 'a developer') + '.');
    }
    var dev = StaffService.byId(developerId);
    if (!dev) throw new Error('Choose a developer to escalate to.');
    if (!Auth.isDeveloper(dev.Role)) {
      throw new Error(dev.Name + ' is not a Software Developer.');
    }
    if (String(dev.Status) === STAFF_STATUS.INACTIVE) {
      throw new Error(dev.Name + ' is inactive.');
    }
    if (String(dev.StaffID) === String(task.AssignedTo)) {
      throw new Error('A task cannot be escalated to its own assignee.');
    }

    SheetDB.updateRowAt(SHEETS.TASKS, task.__row, {
      EscalatedTo: String(dev.StaffID),
      EscalatedToName: String(dev.Name),
      EscalatedBy: String(actor.Email || actor.StaffID || actor),
      EscalatedAt: new Date(),
      EscalationStatus: 'Open',
      IsPriority: true,
      LastUpdated: new Date()
    });

    var fromStaff = StaffService.byId(task.AssignedTo);
    var fromName = fromStaff ? fromStaff.Name : task.AssignedToName;
    NotificationService.push(dev.StaffID, 'TaskEscalated', 'danger',
      'Escalated to you: ' + task.Title,
      'From ' + fromName + '. Work on it now, then validate to resolve it.' +
      (note ? ' Note: ' + note : ''));
    try { Notify.taskEscalated(dev, task, fromStaff, note); }
    catch (e) { Log.exception('Tasks.escalate/notify', e); }
    if (fromStaff) {
      NotificationService.push(fromStaff.StaffID, 'TaskEscalated', 'info',
        'Escalated for you: ' + task.Title,
        'Handed to ' + dev.Name + ' to resolve. You will be notified when it is done.');
    }

    Log.info('Tasks', 'Escalated ' + taskId + ' to developer ' + dev.StaffID +
      ' by ' + (actor.Email || actor));
    return {
      taskId: String(task.TaskID),
      escalatedTo: String(dev.StaffID),
      escalatedToName: String(dev.Name),
      escalationStatus: 'Open'
    };
  },

  /** Tasks currently escalated to — and still open for — a given developer. */
  forDeveloper: function (developerId) {
    return SheetDB.find(SHEETS.TASKS, function (t) {
      return String(t.EscalatedTo) === String(developerId) &&
             String(t.EscalationStatus) === 'Open';
    });
  },

  /**
   * The developer it was escalated to (or management) resolves the task —
   * requirement 3. It becomes Completed with EscalationStatus='Resolved'; the
   * original assignee sees "Resolved" and keeps the pay attribution.
   */
  resolveEscalation: function (taskId, actor, payload) {
    payload = payload || {};
    var task = this.byId(taskId);
    if (!task) throw new Error('Task not found.');
    if (String(task.EscalationStatus) !== 'Open') {
      throw new Error('This task has no open escalation.');
    }
    var isAssignedDev = String(task.EscalatedTo) === String(actor.StaffID);
    if (!isAssignedDev && !Auth.isManagement(actor.Role)) {
      throw new Error('Only the developer it was escalated to, or management, can resolve it.');
    }

    var validated = Util.pct(
      payload.validatedProgress === undefined || payload.validatedProgress === ''
        ? 100 : payload.validatedProgress);

    var changes = {
      Status: TASK_STATUS.COMPLETED,
      CompletedAt: new Date(),
      ValidatedProgress: validated,
      ValidatedAt: new Date(),
      ValidatedBy: String(actor.Email || actor.StaffID),
      EscalationStatus: 'Resolved',
      ResolvedAt: new Date(),
      AdminComment: payload.comment === undefined ? task.AdminComment : String(payload.comment),
      IsPriority: false,
      LastUpdated: new Date()
    };
    var merged = {};
    Object.keys(task).forEach(function (k) { merged[k] = task[k]; });
    Object.keys(changes).forEach(function (k) { merged[k] = changes[k]; });
    changes.PayableAmount = this.payableAmount(merged);
    changes.MetricScore = this.computeMetricScore(merged);

    SheetDB.updateRowAt(SHEETS.TASKS, task.__row, changes);
    // Validated progress now counts — re-split the month so pay reflects it.
    AllocationService.recalcStaffMonth(task.AssignedTo, task.DueDate);

    var staff = StaffService.byId(task.AssignedTo);
    if (staff) {
      NotificationService.push(staff.StaffID, 'TaskResolved', 'success',
        'Resolved: ' + task.Title,
        'Your escalated task has been resolved by ' + (actor.Name || 'a developer') + '.');
      try { Notify.escalationResolved(staff, task, actor); }
      catch (e) { Log.exception('Tasks.resolveEscalation/notify', e); }
    }
    Log.info('Tasks', 'Resolved escalation ' + taskId + ' by ' + (actor.Email || actor.StaffID));
    return {
      status: TASK_STATUS.COMPLETED,
      escalationStatus: 'Resolved',
      taskId: String(task.TaskID),
      payableAmount: changes.PayableAmount
    };
  },

  /* --- Automation ------------------------------------------------------- */

  /** Trigger: flip Scheduled -> Assigned when StartDate arrives. */
  activateScheduled: function () {
    var todayKey = Util.dateKey(Util.today());
    var activated = 0;

    SheetDB.find(SHEETS.TASKS, function (t) {
      return String(t.Status) === TASK_STATUS.SCHEDULED &&
             Util.dateKey(t.StartDate) <= todayKey;
    }).forEach(function (task) {
      SheetDB.updateRowAt(SHEETS.TASKS, task.__row, {
        Status: TASK_STATUS.ASSIGNED, LastUpdated: new Date()
      });
      var staff = StaffService.byId(task.AssignedTo);
      if (staff) {
        try { Notify.taskAssigned(staff, task); }
        catch (e) { Log.exception('Tasks.activateScheduled/notify', e); }
        NotificationService.push(staff.StaffID, 'TaskAssigned', 'info',
          'Task now live: ' + task.Title,
          'Due ' + Util.fmtDate(task.DueDate) + '. Acknowledge it to begin.');
      }
      activated++;
    });

    Log.info('Triggers', 'activateScheduledTasks activated ' + activated + ' task(s)');
    return { activated: activated };
  },

  /**
   * Self-healing companion to the 6 a.m. trigger. Called at the top of the
   * read-only dashboard/task APIs so a task whose StartDate has arrived is
   * already live the moment somebody opens the app — a task scheduled yesterday
   * for today must never still be sitting in "Upcoming".
   *
   * Cheap when there is nothing to do: it only takes the write lock after it has
   * actually found a due row. Never throws into the caller.
   */
  activateDueNow: function () {
    try {
      var todayKey = Util.dateKey(Util.today());
      var due = SheetDB.find(SHEETS.TASKS, function (t) {
        return String(t.Status) === TASK_STATUS.SCHEDULED &&
               Util.dateKey(t.StartDate) !== '' &&
               Util.dateKey(t.StartDate) <= todayKey;
      });
      if (!due.length) return { activated: 0 };
      return SheetDB.withLock(function () {
        return TaskService.activateScheduled();
      }, 20000);
    } catch (err) {
      Log.exception('Tasks.activateDueNow', err);
      return { activated: 0, error: String(err && err.message ? err.message : err) };
    }
  },

  /**
   * Requirement 1 — trigger: roll incomplete Daily tasks into the next
   * working day as priority work, warn the staff member, and strike them.
   */
  processRollover: function () {
    if (!CFG.bool('RolloverEnabled', true)) return { rolled: 0, failed: 0, skipped: 'disabled' };

    var todayKey = Util.dateKey(Util.today());
    var maxRollovers = CFG.num('MaxRolloverDays', 3);
    var result = { rolled: 0, failed: 0, awaitingValidation: 0 };

    var candidates = SheetDB.find(SHEETS.TASKS, function (t) {
      return String(t.TaskType) === TASK_TYPE.DAILY &&
             Util.dateKey(t.DueDate) < todayKey &&
             (TaskService.isOpen(t.Status) ||
              String(t.Status) === TASK_STATUS.PENDING_VALIDATION);
    });

    candidates.forEach(function (task) {
      var staff = StaffService.byId(task.AssignedTo);
      if (!staff || String(staff.Status) === STAFF_STATUS.INACTIVE) return;

      // Work already handed in is the admin's bottleneck, not the staff's.
      if (String(task.Status) === TASK_STATUS.PENDING_VALIDATION) {
        result.awaitingValidation++;
        StaffService.adminEmails().forEach(function (email) {
          try { Notify.validationOverdue(email, staff, task); }
          catch (e) { Log.exception('Tasks.rollover/validationOverdue', e); }
        });
        return;
      }

      var rolloverNo = Util.num(task.RolloverCount, 0) + 1;
      var isFinal = rolloverNo >= maxRollovers;

      var strikeResult = null;
      if (CFG.bool('RolloverStrikePerDay', true)) {
        strikeResult = StrikeService.issue({
          staff: staff,
          taskId: task.TaskID,
          category: STRIKE_CATEGORY.TASK_ROLLOVER,
          reason: 'Daily task "' + task.Title + '" not completed by ' +
                  Util.fmtDate(task.DueDate) + ' (rollover ' + rolloverNo + ')',
          taskAmount: Util.num(task.AmountAllocated, 0)
        });
      }

      var changes = {
        RolloverCount: rolloverNo,
        WarningsIssued: Util.num(task.WarningsIssued, 0) + 1,
        IsPriority: true,
        LastUpdated: new Date()
      };
      if (CFG.bool('RolloverEscalatePriority', true)) {
        changes.Priority = Util.escalatePriority(task.Priority);
      }

      if (isFinal && CFG.bool('FailTaskOnFinalStrike', true)) {
        changes.Status = TASK_STATUS.FAILED;
        changes.PayableAmount = TaskService.payableAmount(task);
        changes.MetricScore = TaskService.computeMetricScore(task);
        result.failed++;
      } else {
        // Push to the next working day, never into the past.
        var nextDue = Util.nextWorkingDay(task.DueDate);
        for (var guard = 0; Util.dateKey(nextDue) < todayKey && guard < 60; guard++) {
          nextDue = Util.nextWorkingDay(nextDue);
        }
        changes.DueDate = nextDue;
        result.rolled++;
      }

      SheetDB.updateRowAt(SHEETS.TASKS, task.__row, changes);

      // A rollover can push the due date into the next month, which moves the
      // task's share of the guarantee with it.
      if (changes.DueDate) {
        AllocationService.recalcMany([
          { staffId: task.AssignedTo, date: task.DueDate },
          { staffId: task.AssignedTo, date: changes.DueDate }
        ]);
      }

      var suspended = strikeResult && strikeResult.suspended;
      NotificationService.push(staff.StaffID, 'TaskRolledOver',
        suspended ? 'danger' : 'warn',
        (suspended ? 'SUSPENDED — ' : 'WARNING ' + rolloverNo + '/' + maxRollovers + ' — ') +
        task.Title + ' rolled over',
        suspended
          ? 'This was strike ' + rolloverNo + ' of ' + maxRollovers +
            '. Your account is suspended pending administrator clearance.'
          : 'Now a PRIORITY task due ' + Util.fmtDate(changes.DueDate || task.DueDate) +
            '. ' + (maxRollovers - rolloverNo) + ' warning(s) left before suspension.');

      try {
        Notify.taskRolledOver(staff, task, {
          rolloverNo: rolloverNo,
          maxRollovers: maxRollovers,
          newDueDate: changes.DueDate || task.DueDate,
          failed: changes.Status === TASK_STATUS.FAILED,
          suspended: suspended
        });
      } catch (e) { Log.exception('Tasks.rollover/notify', e); }
    });

    Log.info('Triggers', 'processRollover ' + JSON.stringify(result));
    return result;
  },

  /** Trigger: non-daily tasks that blew their due date become Failed. */
  failOverdue: function () {
    if (!CFG.bool('FailOverdueNonDailyTasks', true)) return { failed: 0 };
    var todayKey = Util.dateKey(Util.today());
    var failed = 0;

    SheetDB.find(SHEETS.TASKS, function (t) {
      return String(t.TaskType) !== TASK_TYPE.DAILY &&
             TaskService.isOpen(t.Status) &&
             Util.dateKey(t.DueDate) < todayKey;
    }).forEach(function (task) {
      var staff = StaffService.byId(task.AssignedTo);
      SheetDB.updateRowAt(SHEETS.TASKS, task.__row, {
        Status: TASK_STATUS.FAILED,
        PayableAmount: TaskService.payableAmount(task),
        MetricScore: TaskService.computeMetricScore(task),
        LastUpdated: new Date()
      });
      failed++;

      if (staff && CFG.bool('StrikeOnFailedTask', true)) {
        StrikeService.issue({
          staff: staff,
          taskId: task.TaskID,
          category: STRIKE_CATEGORY.TASK_FAILED,
          reason: task.TaskType + ' task "' + task.Title + '" not completed by ' +
                  Util.fmtDate(task.DueDate),
          taskAmount: Util.num(task.AmountAllocated, 0)
        });
      }
      if (staff) {
        NotificationService.push(staff.StaffID, 'TaskFailed', 'danger',
          'Task failed: ' + task.Title,
          'The due date passed on ' + Util.fmtDate(task.DueDate) +
          '. Partial validated progress still counts towards pay.');
      }
    });

    Log.info('Triggers', 'failOverdue failed ' + failed + ' task(s)');
    return { failed: failed };
  },

  /**
   * One-time repair: raise every task's ValidatedProgress to at least the
   * highest progress carried by an *approved* daily report, then recompute pay
   * and re-split the affected months. This heals historical rows where a report
   * was approved before approval propagated progress to the task — the
   * "validated report but 0 earned / 0% validated" cases — and is safe to run
   * repeatedly (it only ever raises, never lowers).
   */
  syncValidatedFromReports: function (actor) {
    var self = this;
    var result = { scanned: 0, updated: 0 };
    var recalc = [];
    SheetDB.find(SHEETS.TASKS, function (t) {
      return String(t.Status) !== TASK_STATUS.CANCELLED;
    }).forEach(function (task) {
      result.scanned++;
      var approved = DailyReportService.forTask(task.TaskID).filter(function (r) {
        return String(r.ReviewStatus) === 'Approved';
      });
      if (!approved.length) return;
      var maxPct = approved.reduce(function (m, r) {
        var p = Util.pct(r.ProgressPercent); return p > m ? p : m;
      }, 0);
      if (maxPct <= Util.pct(task.ValidatedProgress)) return;

      var changes = {
        ValidatedProgress: maxPct,
        ValidatedAt: new Date(),
        ValidatedBy: String(actor || 'system (report sync)'),
        LastUpdated: new Date()
      };
      if (maxPct >= 100 && String(task.Status) !== TASK_STATUS.COMPLETED) {
        changes.Status = TASK_STATUS.COMPLETED;
        changes.CompletedAt = new Date();
      }
      var merged = {};
      Object.keys(task).forEach(function (k) { merged[k] = task[k]; });
      Object.keys(changes).forEach(function (k) { merged[k] = changes[k]; });
      changes.PayableAmount = self.payableAmount(merged);
      changes.MetricScore = self.computeMetricScore(merged);
      SheetDB.updateRowAt(SHEETS.TASKS, task.__row, changes);
      recalc.push({ staffId: task.AssignedTo, date: task.DueDate });
      result.updated++;
    });
    AllocationService.recalcMany(recalc);
    Log.info('Tasks', 'syncValidatedFromReports ' + JSON.stringify(result) + ' by ' + actor);
    return result;
  },

  /* --- Aggregates ------------------------------------------------------- */

  /**
   * Requirement 3.3: task statistics for one staff member over a period.
   * Tasks are attributed to the period their DueDate falls in.
   */
  statsFor: function (staffId, period) {
    var tasks = this.forStaff(staffId).filter(function (t) {
      return Util.inPeriod(t.DueDate, period) &&
             String(t.Status) !== TASK_STATUS.CANCELLED;
    });

    var s = {
      assigned: tasks.length, completed: 0, pendingValidation: 0, inProgress: 0,
      failed: 0, scheduled: 0, rolledOver: 0,
      grossAllocated: 0, earned: 0, progressSum: 0, scoreSum: 0, scored: 0,
      tasks: tasks
    };

    tasks.forEach(function (t) {
      var status = String(t.Status);
      if (status === TASK_STATUS.COMPLETED) s.completed++;
      else if (status === TASK_STATUS.PENDING_VALIDATION) s.pendingValidation++;
      else if (status === TASK_STATUS.FAILED) s.failed++;
      else if (status === TASK_STATUS.SCHEDULED) s.scheduled++;
      else s.inProgress++;

      if (Util.num(t.RolloverCount, 0) > 0) s.rolledOver++;
      s.grossAllocated += Util.num(t.AmountAllocated, 0);
      s.earned += TaskService.payableAmount(t);
      s.progressSum += TaskService.effectiveProgress(t);
      var score = t.MetricScore === '' || t.MetricScore === null || t.MetricScore === undefined
        ? null : Util.num(t.MetricScore, 0);
      if (score !== null) { s.scoreSum += score; s.scored++; }
    });

    s.completionRate = Util.rate(s.completed, s.assigned);
    s.avgProgress = s.assigned ? Math.round(s.progressSum / s.assigned) : 0;
    s.avgMetricScore = s.scored ? Math.round(s.scoreSum / s.scored) : 0;
    s.grossAllocated = Util.money(s.grossAllocated);
    s.earned = Util.money(s.earned);
    return s;
  },

  /** Requirement 3: the three-bucket board used by both dashboards. */
  board: function (staffId) {
    var tasks = staffId ? this.forStaff(staffId) : this.all();
    var out = {
      total: 0, completed: 0, pending: 0, inProgress: 0,
      scheduled: 0, failed: 0, overdue: 0, priority: 0
    };
    var todayKey = Util.dateKey(Util.today());

    tasks.forEach(function (t) {
      var status = String(t.Status);
      if (status === TASK_STATUS.CANCELLED) return;
      out.total++;
      if (status === TASK_STATUS.SCHEDULED) { out.scheduled++; return; }
      if (status === TASK_STATUS.FAILED) { out.failed++; return; }
      var bucket = TaskService.bucketOf(status);
      if (bucket) out[bucket]++;
      if (TaskService.isOpen(status) && Util.dateKey(t.DueDate) < todayKey) out.overdue++;
      if (Util.truthy(t.IsPriority) && TaskService.isOpen(status)) out.priority++;
    });
    return out;
  }
};

/** Sensible default due date when the admin leaves it blank. */
function defaultDueDate_(start, taskType) {
  switch (taskType) {
    case TASK_TYPE.DAILY:   return Util.startOfDay(start);
    case TASK_TYPE.WEEKLY:  return Util.addDays(start, 6);
    case TASK_TYPE.MONTHLY: return Util.addDays(Util.addMonths(start, 1), -1);
    default:                return Util.addDays(start, 13);
  }
}

/**
 * ============================================================================
 * DailyReportService — the daily update a staff member files per active task.
 * ============================================================================
 */
var DailyReportService = {

  all: function () { return SheetDB.readAll(SHEETS.DAILY_REPORTS); },

  forTask: function (taskId) {
    return SheetDB.find(SHEETS.DAILY_REPORTS, function (r) {
      return String(r.TaskID) === String(taskId);
    });
  },

  forStaff: function (staffId) {
    return SheetDB.find(SHEETS.DAILY_REPORTS, function (r) {
      return String(r.StaffID) === String(staffId);
    });
  },

  /** Did this task already get a report on this date? */
  existsFor: function (taskId, dateKey) {
    return !!SheetDB.findOne(SHEETS.DAILY_REPORTS, function (r) {
      return String(r.TaskID) === String(taskId) &&
             Util.dateKey(r.ReportDate) === dateKey;
    });
  },

  /** Submit (or replace) today's report for a task. */
  submit: function (input, staff) {
    var task = TaskService.byId(input.taskId);
    if (!task) throw new Error('Task not found.');
    if (String(task.AssignedTo) !== String(staff.StaffID)) {
      throw new Error('That task is not assigned to you.');
    }
    if (!TaskService.isOpen(task.Status)) {
      throw new Error('Daily reports can only be filed against an open task. Current status: ' + task.Status);
    }
    var text = String(input.reportText || '').trim();
    if (text.length < 5) throw new Error('Please describe what you did today (at least 5 characters).');

    var reportDate = Util.startOfDay(input.reportDate || Util.today());
    var dateKey = Util.dateKey(reportDate);
    if (dateKey > Util.dateKey(Util.today())) {
      throw new Error('You cannot file a report for a future date.');
    }

    var deadline = Util.parseHhMm(CFG.get('DailyReportDeadline', '18:00'), 18 * 60);
    var now = new Date();
    var onTime = dateKey < Util.dateKey(Util.today())
      ? false                                     // back-dated report is late by definition
      : Util.minutesOfDay(now) <= deadline;

    var existing = SheetDB.findOne(SHEETS.DAILY_REPORTS, function (r) {
      return String(r.TaskID) === String(input.taskId) &&
             Util.dateKey(r.ReportDate) === dateKey;
    });

    var payload = {
      TaskID: String(task.TaskID),
      StaffID: String(staff.StaffID),
      ReportDate: reportDate,
      ReportText: text,
      ProgressPercent: Util.pct(input.progressPercent),
      HoursSpent: Util.num(input.hoursSpent, 0),
      Blockers: String(input.blockers || '').trim(),
      AttachmentUrl: String(input.attachmentUrl || ''),
      SubmittedAt: now,
      OnTime: onTime,
      ReviewStatus: 'Pending',
      ReviewedBy: '', ReviewedAt: '', ReviewComment: ''
    };

    if (existing) {
      SheetDB.updateRowAt(SHEETS.DAILY_REPORTS, existing.__row, payload);
      payload.ReportID = existing.ReportID;
    } else {
      payload.ReportID = SheetDB.nextId('RPT', SHEETS.DAILY_REPORTS, 'ReportID', 6);
      SheetDB.insert(SHEETS.DAILY_REPORTS, payload);
    }

    // A report is also a progress signal.
    if (input.progressPercent !== undefined && input.progressPercent !== '') {
      TaskService.reportProgress(task.TaskID, staff, input.progressPercent);
    } else if (String(task.Status) === TASK_STATUS.ACKNOWLEDGED) {
      SheetDB.updateRowAt(SHEETS.TASKS, task.__row, {
        Status: TASK_STATUS.IN_PROGRESS, LastUpdated: new Date()
      });
    }

    Log.info('DailyReports', (existing ? 'Updated ' : 'Created ') + payload.ReportID +
      ' for ' + task.TaskID, 'onTime=' + onTime);
    return { reportId: payload.ReportID, onTime: onTime, replaced: !!existing };
  },

  /** Admin approves or rejects a daily report. */
  review: function (reportId, admin, decision, comment) {
    var report = SheetDB.findById(SHEETS.DAILY_REPORTS, 'ReportID', reportId);
    if (!report) throw new Error('Daily report not found.');
    if (['Approved', 'Rejected'].indexOf(decision) === -1) {
      throw new Error('Decision must be Approved or Rejected.');
    }
    SheetDB.updateRowAt(SHEETS.DAILY_REPORTS, report.__row, {
      ReviewStatus: decision,
      ReviewedBy: String(admin.Email || admin.StaffID),
      ReviewedAt: new Date(),
      ReviewComment: String(comment || '')
    });

    // Approving a report validates the progress it carried. Push that onto the
    // task so pay is calculated on the admin-validated percentage — otherwise a
    // report could sit Approved at 90% while the task stayed at 0% validated and
    // therefore earned nothing (the "validated report but 0 earned" bug).
    var validatedNote = null;
    if (decision === 'Approved') {
      var task = TaskService.byId(report.TaskID);
      if (task && String(task.Status) !== TASK_STATUS.CANCELLED) {
        var reported = Util.pct(report.ProgressPercent);
        var current = Util.pct(task.ValidatedProgress);
        if (reported > current) {
          var changes = {
            ValidatedProgress: reported,
            ValidatedAt: new Date(),
            ValidatedBy: String(admin.Email || admin.StaffID),
            LastUpdated: new Date()
          };
          // Reaching 100% via an approved report completes the task.
          if (reported >= 100 && String(task.Status) !== TASK_STATUS.COMPLETED) {
            changes.Status = TASK_STATUS.COMPLETED;
            changes.CompletedAt = new Date();
          }
          // Recompute money and score against the merged record.
          var merged = {};
          Object.keys(task).forEach(function (k) { merged[k] = task[k]; });
          Object.keys(changes).forEach(function (k) { merged[k] = changes[k]; });
          changes.PayableAmount = TaskService.payableAmount(merged);
          changes.MetricScore = TaskService.computeMetricScore(merged);
          SheetDB.updateRowAt(SHEETS.TASKS, task.__row, changes);
          // Re-split the month so the validated progress flows into pay.
          AllocationService.recalcStaffMonth(task.AssignedTo, task.DueDate);
          validatedNote = reported;
          Log.info('DailyReports', 'Approval validated ' + task.TaskID +
            ' at ' + reported + '% by ' + admin.Email);
        }
      }
    }

    NotificationService.push(report.StaffID, 'DailyReportReviewed',
      decision === 'Approved' ? 'success' : 'warn',
      'Daily report ' + decision.toLowerCase(),
      (validatedNote !== null
        ? 'Validated at ' + validatedNote + '% — earnings updated. '
        : '') +
      String(comment || 'Report for ' + Util.fmtDate(report.ReportDate) + '.'));
    return true;
  },

  /**
   * Requirement 3.7 — trigger: find active tasks with no report filed today
   * and issue a strike. Runs after Config.DailyReportDeadline.
   */
  checkMissed: function () {
    var today = Util.today();
    var todayKey = Util.dateKey(today);
    var result = { checked: 0, strikes: 0, skippedNonWorkingDay: false };

    if (!Util.isWorkingDay(today)) {
      result.skippedNonWorkingDay = true;
      Log.info('Triggers', 'checkDailyReports skipped — not a working day');
      return result;
    }

    var activeTasks = SheetDB.find(SHEETS.TASKS, function (t) {
      var status = String(t.Status);
      if (status !== TASK_STATUS.ACKNOWLEDGED && status !== TASK_STATUS.IN_PROGRESS) return false;
      var startKey = Util.dateKey(t.StartDate);
      var dueKey = Util.dateKey(t.DueDate);
      return startKey <= todayKey && todayKey <= dueKey;
    });

    activeTasks.forEach(function (task) {
      result.checked++;
      if (DailyReportService.existsFor(task.TaskID, todayKey)) return;

      var staff = StaffService.byId(task.AssignedTo);
      if (!staff || String(staff.Status) === STAFF_STATUS.INACTIVE) return;

      var outcome = StrikeService.issue({
        staff: staff,
        taskId: task.TaskID,
        category: STRIKE_CATEGORY.MISSED_DAILY_REPORT,
        reason: 'No daily report filed for "' + task.Title + '" on ' +
                Util.fmtDate(today) + ' · task deadline ' +
                Util.fmtDate(task.DueDate),
        taskAmount: Util.num(task.AmountAllocated, 0)
      });
      if (outcome) result.strikes++;

      SheetDB.updateRowAt(SHEETS.TASKS, task.__row, {
        WarningsIssued: Util.num(task.WarningsIssued, 0) + 1,
        IsPriority: true,
        LastUpdated: new Date()
      });
    });

    Log.info('Triggers', 'checkDailyReports ' + JSON.stringify(result));
    return result;
  },

  /** Expected vs submitted report counts for a staff member over a period. */
  statsFor: function (staffId, period) {
    var reports = this.forStaff(staffId).filter(function (r) {
      return Util.inPeriod(r.ReportDate, period);
    });
    var onTime = reports.filter(function (r) { return Util.truthy(r.OnTime); }).length;

    // Expected = one report per working day that each task was live.
    var expected = 0;
    TaskService.forStaff(staffId).forEach(function (t) {
      if (String(t.Status) === TASK_STATUS.SCHEDULED ||
          String(t.Status) === TASK_STATUS.CANCELLED) return;
      var from = Util.dateKey(t.StartDate) > period.startKey ? t.StartDate : period.start;
      var to = Util.dateKey(t.DueDate) < period.endKey ? t.DueDate : period.end;
      if (Util.dateKey(from) > Util.dateKey(to)) return;
      expected += Util.countWorkingDays(from, to);
    });

    return {
      expected: expected,
      submitted: reports.length,
      onTime: onTime,
      late: reports.length - onTime,
      onTimeRate: Util.rate(onTime, reports.length),
      submissionRate: Util.rate(reports.length, expected)
    };
  }
};
