/**
 * ============================================================================
 * Strikes.gs — warnings, strikes, suspension and manual clearance.
 * ============================================================================
 * RULES (requirements 1 & 2)
 *
 *   Strike 1  → warning email + in-app warning. Task becomes priority.
 *   Strike 2  → warning email, admins copied.
 *   Strike 3  → SUSPENSION. Staff.Status = Suspended, FlaggedStatus = TRUE,
 *               a row is written to the Suspensions tab, and the staff member
 *               is blocked from acting in the portal.
 *
 *   Reset     → Config.StrikeResetPolicy = ManualClearanceOnly (default).
 *               An admin clears the record explicitly. Clearing NEVER deletes
 *               anything: Strikes rows are marked Cleared (with who cleared
 *               them and why), Suspensions rows are marked Lifted, and the
 *               permanent counters Staff.TotalStrikesIssued and
 *               Staff.SuspensionCount are left untouched. The staff file
 *               therefore always shows that a strike/suspension happened.
 *
 *   Penalty   → Config.Strike{1,2,3}PenaltyPercent, applied to the offending
 *               task's AmountAllocated and logged in Strikes.PenaltyAmount.
 *               Defaults are 0% because suspension is the agreed penalty;
 *               set a percentage if you also want a cash deduction.
 * ============================================================================
 */

var StrikeService = {

  all: function () { return SheetDB.readAll(SHEETS.STRIKES); },

  forStaff: function (staffId) {
    return SheetDB.find(SHEETS.STRIKES, function (s) {
      return String(s.StaffID) === String(staffId);
    });
  },

  /** Strikes that currently count towards suspension. */
  activeFor: function (staffId) {
    return this.forStaff(staffId).filter(function (s) {
      return String(s.Status) === 'Active';
    });
  },

  suspensionsFor: function (staffId) {
    return SheetDB.find(SHEETS.SUSPENSIONS, function (s) {
      return String(s.StaffID) === String(staffId);
    });
  },

  /** Penalty percentage configured for a given strike number. */
  penaltyPercentFor: function (strikeNumber) {
    var n = Math.max(1, Math.min(3, Math.round(strikeNumber)));
    return CFG.num('Strike' + n + 'PenaltyPercent', 0);
  },

  /**
   * Issue one strike.
   * @param {Object} o {staff, taskId, category, reason, taskAmount}
   * @return {Object|null} {strikeId, strikeNumber, suspended, penaltyAmount}
   *                       or null when the strike was suppressed as duplicate.
   */
  issue: function (o) {
    var staff = o.staff;
    if (!staff) throw new Error('issue() needs a staff row.');
    var todayKey = Util.dateKey(Util.today());

    // Idempotency: the daily triggers can be re-run safely.
    var duplicate = SheetDB.findOne(SHEETS.STRIKES, function (s) {
      return String(s.StaffID) === String(staff.StaffID) &&
             String(s.Category) === String(o.category) &&
             String(s.TaskID) === String(o.taskId || '') &&
             Util.dateKey(s.Date) === todayKey;
    });
    if (duplicate) {
      Log.info('Strikes', 'Duplicate strike suppressed for ' + staff.StaffID +
        ' (' + o.category + ' / ' + (o.taskId || 'n/a') + ')');
      return null;
    }

    var limit = CFG.num('StrikeLimit', 3);
    var strikeNumber = this.activeFor(staff.StaffID).length + 1;
    var penaltyPercent = this.penaltyPercentFor(strikeNumber);
    var penaltyAmount = Util.money(Util.num(o.taskAmount, 0) * penaltyPercent / 100);

    var strikeId = SheetDB.nextId('STR', SHEETS.STRIKES, 'StrikeID', 5);
    SheetDB.insert(SHEETS.STRIKES, {
      StrikeID: strikeId,
      StaffID: String(staff.StaffID),
      StaffName: String(staff.Name),
      Date: Util.today(),
      TaskID: String(o.taskId || ''),
      Category: String(o.category),
      Reason: String(o.reason || ''),
      StrikeNumber: strikeNumber,
      PenaltyApplied: penaltyAmount > 0,
      PenaltyAmount: penaltyAmount,
      Status: 'Active',
      IssuedAt: new Date(),
      ClearedAt: '', ClearedBy: '', ClearanceNote: ''
    });

    var reachedLimit = strikeNumber >= limit;
    SheetDB.updateRowAt(SHEETS.STAFF, staff.__row, {
      StrikeCount: strikeNumber,
      TotalStrikesIssued: Util.num(staff.TotalStrikesIssued, 0) + 1,
      FlaggedStatus: reachedLimit ? true : Util.truthy(staff.FlaggedStatus)
    });

    var suspensionId = '';
    if (reachedLimit && String(staff.Status) !== STAFF_STATUS.SUSPENDED) {
      // Re-read so applySuspension sees the updated counters.
      SheetDB.invalidate(SHEETS.STAFF);
      var fresh = StaffService.byId(staff.StaffID) || staff;
      suspensionId = StaffService.applySuspension(
        fresh,
        'Reached ' + limit + ' active strikes. Latest: ' + o.reason,
        strikeId);
    }

    // Notifications ---------------------------------------------------------
    NotificationService.push(staff.StaffID, 'Strike',
      reachedLimit ? 'danger' : 'warn',
      reachedLimit
        ? 'ACCOUNT SUSPENDED — strike ' + strikeNumber + ' of ' + limit
        : 'Warning: strike ' + strikeNumber + ' of ' + limit,
      String(o.reason || '') +
      (penaltyAmount > 0 ? ' Penalty applied: ' + Util.fmtMoney(penaltyAmount) + '.' : '') +
      (reachedLimit
        ? ' Your account is suspended until an administrator clears your record.'
        : ' ' + (limit - strikeNumber) + ' warning(s) remaining.'));

    try {
      if (CFG.bool('NotifyStaffOnStrike', true)) {
        Notify.strikeIssued(staff, {
          strikeId: strikeId, strikeNumber: strikeNumber, limit: limit,
          reason: o.reason, category: o.category,
          penaltyAmount: penaltyAmount, suspended: reachedLimit
        });
      }
      if (strikeNumber >= 2 && CFG.bool('NotifyAdminOnStrike2', true)) {
        Notify.strikeAdminAlert(staff, {
          strikeId: strikeId, strikeNumber: strikeNumber, limit: limit,
          reason: o.reason, suspended: reachedLimit
        });
      }
    } catch (e) {
      Log.exception('Strikes.issue/notify', e);
    }

    Log.warn('Strikes', 'Strike ' + strikeNumber + '/' + limit + ' issued to ' +
      staff.StaffID + ' — ' + o.category, o.reason);

    return {
      strikeId: strikeId,
      strikeNumber: strikeNumber,
      suspended: reachedLimit,
      suspensionId: suspensionId,
      penaltyAmount: penaltyAmount
    };
  },

  /** Admin-issued manual strike (e.g. conduct, missed meeting). */
  issueManual: function (staffId, reason, admin, taskId) {
    var staff = StaffService.byId(staffId);
    if (!staff) throw new Error('Staff member not found.');
    if (!String(reason || '').trim()) throw new Error('A reason is required for a manual strike.');
    var task = taskId ? TaskService.byId(taskId) : null;
    var result = this.issue({
      staff: staff,
      taskId: taskId || '',
      category: STRIKE_CATEGORY.MANUAL,
      reason: String(reason).trim() + ' (issued by ' + admin.Email + ')',
      taskAmount: task ? Util.num(task.AmountAllocated, 0) : 0
    });
    if (!result) throw new Error('A manual strike for this staff member was already recorded today.');
    return result;
  },

  /**
   * Requirement 2: manual clearance. Resets the *active* counter so the staff
   * member can work again, while preserving the historical record.
   */
  clearRecord: function (staffId, admin, note) {
    var staff = StaffService.byId(staffId);
    if (!staff) throw new Error('Staff member not found.');
    var clearanceNote = String(note || '').trim();
    if (!clearanceNote) throw new Error('A clearance note is required — it becomes part of the permanent record.');

    var active = this.activeFor(staffId);
    active.forEach(function (s) {
      SheetDB.updateRowAt(SHEETS.STRIKES, s.__row, {
        Status: 'Cleared',
        ClearedAt: new Date(),
        ClearedBy: String(admin.Email || admin.StaffID),
        ClearanceNote: clearanceNote
      });
    });

    var liftedSuspensions = StaffService.liftSuspension(
      staffId, String(admin.Email || admin.StaffID), clearanceNote);

    SheetDB.updateRowAt(SHEETS.STAFF, staff.__row, {
      StrikeCount: 0,
      FlaggedStatus: false,
      Status: String(staff.Status) === STAFF_STATUS.SUSPENDED
        ? STAFF_STATUS.ACTIVE : String(staff.Status),
      SuspendedAt: '',
      ClearedAt: new Date(),
      ClearedBy: String(admin.Email || admin.StaffID),
      ClearanceNote: clearanceNote
    });

    NotificationService.push(staffId, 'StrikesCleared', 'success',
      'Your strike record has been cleared',
      clearanceNote + ' Note: the strikes and any suspension remain on your ' +
      'permanent file for reporting purposes.');

    try { Notify.strikesCleared(staff, active.length, liftedSuspensions, admin, clearanceNote); }
    catch (e) { Log.exception('Strikes.clearRecord/notify', e); }

    Log.info('Strikes', 'Cleared ' + active.length + ' strike(s) and ' +
      liftedSuspensions + ' suspension(s) for ' + staffId + ' by ' + admin.Email,
      clearanceNote);

    return {
      strikesCleared: active.length,
      suspensionsLifted: liftedSuspensions,
      permanentRecord: {
        totalStrikesEverIssued: Util.num(staff.TotalStrikesIssued, 0),
        totalSuspensions: Util.num(staff.SuspensionCount, 0)
      }
    };
  },

  /** Manual suspension without waiting for a third strike. */
  suspendManually: function (staffId, reason, admin) {
    var staff = StaffService.byId(staffId);
    if (!staff) throw new Error('Staff member not found.');
    if (String(staff.Status) === STAFF_STATUS.SUSPENDED) {
      throw new Error(staff.Name + ' is already suspended.');
    }
    if (!String(reason || '').trim()) throw new Error('A reason is required.');
    var suspensionId = StaffService.applySuspension(
      staff, String(reason).trim() + ' (manual, by ' + admin.Email + ')', '');
    NotificationService.push(staffId, 'Suspended', 'danger',
      'Your account has been suspended', String(reason).trim());
    try { Notify.manualSuspension(staff, reason, admin); }
    catch (e) { Log.exception('Strikes.suspendManually/notify', e); }
    return { suspensionId: suspensionId };
  },

  /**
   * Optional monthly auto-reset. Only runs when
   * Config.StrikeResetPolicy = 'Monthly'; the default ManualClearanceOnly
   * makes this a no-op.
   */
  monthlyReset: function () {
    if (CFG.get('StrikeResetPolicy', 'ManualClearanceOnly') !== 'Monthly') {
      return { policy: 'ManualClearanceOnly', cleared: 0 };
    }
    var period = Util.resolvePeriod('Monthly', Util.today());
    var cleared = 0, reinstated = 0;

    SheetDB.find(SHEETS.STRIKES, function (s) {
      return String(s.Status) === 'Active' && Util.dateKey(s.Date) < period.startKey;
    }).forEach(function (s) {
      SheetDB.updateRowAt(SHEETS.STRIKES, s.__row, {
        Status: 'Cleared',
        ClearedAt: new Date(),
        ClearedBy: 'system (monthly reset)',
        ClearanceNote: 'Automatic monthly strike reset per Config.StrikeResetPolicy.'
      });
      cleared++;
    });

    SheetDB.invalidate(SHEETS.STRIKES);
    StaffService.all().forEach(function (staff) {
      var active = StrikeService.activeFor(staff.StaffID).length;
      var patch = { StrikeCount: active };
      if (active < CFG.num('StrikeLimit', 3) &&
          String(staff.Status) === STAFF_STATUS.SUSPENDED) {
        patch.Status = STAFF_STATUS.ACTIVE;
        patch.FlaggedStatus = false;
        patch.SuspendedAt = '';
        StaffService.liftSuspension(staff.StaffID, 'system (monthly reset)',
          'Automatic monthly strike reset.');
        reinstated++;
      }
      SheetDB.updateRowAt(SHEETS.STAFF, staff.__row, patch);
    });

    Log.info('Strikes', 'monthlyReset cleared ' + cleared + ' strike(s), reinstated ' + reinstated);
    return { policy: 'Monthly', cleared: cleared, reinstated: reinstated };
  },

  /** Strike/suspension figures for one staff member over a period. */
  statsFor: function (staffId, period) {
    var strikes = this.forStaff(staffId);
    var inPeriod = strikes.filter(function (s) { return Util.inPeriod(s.Date, period); });
    var suspensions = this.suspensionsFor(staffId)
      .filter(function (s) { return Util.inPeriod(s.StartDate, period); });

    return {
      issued: inPeriod.length,
      active: strikes.filter(function (s) { return String(s.Status) === 'Active'; }).length,
      penaltyTotal: Util.money(inPeriod.reduce(function (sum, s) {
        return sum + Util.num(s.PenaltyAmount, 0);
      }, 0)),
      suspensions: suspensions.length,
      byCategory: inPeriod.reduce(function (acc, s) {
        var k = String(s.Category || 'Other');
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
      rows: inPeriod
    };
  }
};
