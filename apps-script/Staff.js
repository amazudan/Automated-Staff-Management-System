/**
 * ============================================================================
 * Staff.gs — staff records, roles and disciplinary state on the Staff row.
 * ============================================================================
 */

var StaffService = {

  /** All staff rows. */
  all: function () { return SheetDB.readAll(SHEETS.STAFF); },

  /** Active staff only (excludes Inactive; Suspended staff are still listed). */
  active: function () {
    return SheetDB.find(SHEETS.STAFF, function (s) {
      return String(s.Status) !== STAFF_STATUS.INACTIVE;
    });
  },

  /** Staff eligible to receive new work. */
  assignable: function () {
    var blockSuspended = CFG.bool('SuspensionBlocksNewTasks', true);
    return SheetDB.find(SHEETS.STAFF, function (s) {
      if (String(s.Status) === STAFF_STATUS.INACTIVE) return false;
      if (blockSuspended && String(s.Status) === STAFF_STATUS.SUSPENDED) return false;
      return true;
    });
  },

  byId: function (staffId) {
    return SheetDB.findById(SHEETS.STAFF, 'StaffID', staffId);
  },

  byEmail: function (email) { return Auth.staffByEmail(email); },

  name: function (staffId) {
    var s = this.byId(staffId);
    return s ? String(s.Name) : String(staffId || '');
  },

  /** Recipients for administrative alerts. */
  adminEmails: function () {
    var configured = CFG.list('AdminEmails');
    if (configured.length) return configured;
    return SheetDB.find(SHEETS.STAFF, function (s) {
      return Auth.isAdminRole(s.Role) && String(s.Status) === STAFF_STATUS.ACTIVE;
    }).map(function (s) { return String(s.Email); })
      .filter(function (e) { return Util.isEmail(e); });
  },

  /**
   * Create a staff member.
   * @param {Object} input {name, email, role, department, position, phone, pin}
   * @param {string} actor  email/id of the creating admin
   * @param {Object=} opts  {silent:true} to skip the welcome email
   */
  create: function (input, actor, opts) {
    opts = opts || {};
    var name = String(input.name || '').trim();
    var email = String(input.email || '').trim().toLowerCase();
    var role = String(input.role || ROLES.STAFF).trim();

    if (!name) throw new Error('Staff name is required.');
    if (!Util.isEmail(email)) throw new Error('"' + input.email + '" is not a valid email address.');
    if ([ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF].indexOf(role) === -1) {
      throw new Error('Role must be Admin, Manager or Staff.');
    }
    if (Auth.staffByEmail(email)) {
      throw new Error('A staff record already exists for ' + email + '.');
    }

    var salary = input.monthlySalary === undefined || input.monthlySalary === ''
      ? Util.money(CFG.num('DefaultMonthlySalary', 0))
      : Util.money(input.monthlySalary);
    if (salary < 0) throw new Error('The guaranteed monthly salary cannot be negative.');

    var record = {
      StaffID: SheetDB.nextId('STF', SHEETS.STAFF, 'StaffID', 4),
      Name: name,
      Email: email,
      Phone: String(input.phone || '').trim(),
      Role: role,
      Department: String(input.department || '').trim(),
      Position: String(input.position || '').trim(),
      DateAdded: Util.today(),
      Status: STAFF_STATUS.ACTIVE,
      StrikeCount: 0,
      FlaggedStatus: false,
      SuspendedAt: '',
      SuspensionCount: 0,
      TotalStrikesIssued: 0,
      ClearedAt: '', ClearedBy: '', ClearanceNote: '',
      PinHash: '', PinSalt: '',
      LastLogin: '',
      PhotoUrl: String(input.photoUrl || '').trim(),
      Notes: String(input.notes || '').trim(),
      // Guaranteed monthly salary. Task allocations are derived from it, so it
      // is the only money figure anybody has to type in.
      MonthlySalary: salary
    };

    var pin = Auth.stampNewPin(record, input.pin);
    SheetDB.insert(SHEETS.STAFF, record);
    Log.info('Staff', 'Created ' + record.StaffID + ' (' + email + ') by ' + actor);

    if (!opts.silent) {
      try { Notify.welcome(record, pin); }
      catch (e) { Log.exception('Staff.create/notify', e); }
    }
    return { staffId: record.StaffID, pin: pin };
  },

  /** Update editable fields. Email uniqueness is re-checked on change. */
  update: function (staffId, patch, actor) {
    var staff = this.byId(staffId);
    if (!staff) throw new Error('Staff member not found.');

    var changes = {};
    if (patch.name !== undefined) {
      if (!String(patch.name).trim()) throw new Error('Staff name cannot be blank.');
      changes.Name = String(patch.name).trim();
    }
    if (patch.email !== undefined) {
      var email = String(patch.email).trim().toLowerCase();
      if (!Util.isEmail(email)) throw new Error('"' + patch.email + '" is not a valid email address.');
      var clash = Auth.staffByEmail(email);
      if (clash && String(clash.StaffID) !== String(staffId)) {
        throw new Error('That email address is already used by ' + clash.Name + '.');
      }
      changes.Email = email;
    }
    if (patch.role !== undefined) {
      if ([ROLES.ADMIN, ROLES.MANAGER, ROLES.STAFF].indexOf(String(patch.role)) === -1) {
        throw new Error('Role must be Admin, Manager or Staff.');
      }
      changes.Role = String(patch.role);
    }
    ['phone:Phone', 'department:Department', 'position:Position',
     'photoUrl:PhotoUrl', 'notes:Notes'].forEach(function (pair) {
      var parts = pair.split(':');
      if (patch[parts[0]] !== undefined) changes[parts[1]] = String(patch[parts[0]]).trim();
    });
    if (patch.monthlySalary !== undefined && patch.monthlySalary !== '') {
      var salary = Util.money(patch.monthlySalary);
      if (salary < 0) throw new Error('The guaranteed monthly salary cannot be negative.');
      changes.MonthlySalary = salary;
    }

    if (!Object.keys(changes).length) return false;
    SheetDB.updateRowAt(SHEETS.STAFF, staff.__row, changes);

    // Keep the denormalised name on tasks in step.
    if (changes.Name) {
      SheetDB.find(SHEETS.TASKS, function (t) {
        return String(t.AssignedTo) === String(staffId);
      }).forEach(function (t) {
        SheetDB.updateRowAt(SHEETS.TASKS, t.__row, { AssignedToName: changes.Name });
      });
    }

    // A new guarantee re-splits every month that is not already banked.
    if (changes.MonthlySalary !== undefined &&
        Util.money(staff.MonthlySalary) !== changes.MonthlySalary) {
      AllocationService.recalcStaff(staffId);
    }

    Log.info('Staff', 'Updated ' + staffId + ' by ' + actor, JSON.stringify(changes));
    return true;
  },

  /** Soft delete — the row and all history stay on file. */
  setStatus: function (staffId, status, actor, note) {
    var staff = this.byId(staffId);
    if (!staff) throw new Error('Staff member not found.');
    if ([STAFF_STATUS.ACTIVE, STAFF_STATUS.INACTIVE, STAFF_STATUS.SUSPENDED]
        .indexOf(status) === -1) {
      throw new Error('Unknown staff status: ' + status);
    }
    var patch = { Status: status };
    if (note) patch.Notes = String(note);
    SheetDB.updateRowAt(SHEETS.STAFF, staff.__row, patch);
    Log.info('Staff', 'Status of ' + staffId + ' set to ' + status + ' by ' + actor);
    return true;
  },

  /**
   * Mark a staff member suspended. Called by StrikeService when the strike
   * limit is reached, or manually by an admin.
   */
  applySuspension: function (staff, reason, triggerStrikeId) {
    var suspensionId = SheetDB.nextId('SUS', SHEETS.SUSPENSIONS, 'SuspensionID', 4);
    SheetDB.insert(SHEETS.SUSPENSIONS, {
      SuspensionID: suspensionId,
      StaffID: String(staff.StaffID),
      StaffName: String(staff.Name),
      StartDate: Util.today(),
      Reason: String(reason || ''),
      TriggerStrikeID: String(triggerStrikeId || ''),
      Status: 'Active',
      LiftedAt: '', LiftedBy: '', ClearanceNote: '',
      RecordedAt: new Date()
    });

    SheetDB.updateRowAt(SHEETS.STAFF, staff.__row, {
      Status: STAFF_STATUS.SUSPENDED,
      FlaggedStatus: true,
      SuspendedAt: new Date(),
      SuspensionCount: Util.num(staff.SuspensionCount, 0) + 1
    });

    Log.warn('Staff', 'SUSPENDED ' + staff.StaffID + ' — ' + reason, suspensionId);
    return suspensionId;
  },

  /**
   * Lift an active suspension. The Suspensions row is NOT deleted — it is
   * marked Lifted with who cleared it and why, so the permanent record shows
   * the staff member was suspended.
   */
  liftSuspension: function (staffId, actor, note) {
    var lifted = 0;
    SheetDB.find(SHEETS.SUSPENSIONS, function (s) {
      return String(s.StaffID) === String(staffId) && String(s.Status) === 'Active';
    }).forEach(function (s) {
      SheetDB.updateRowAt(SHEETS.SUSPENSIONS, s.__row, {
        Status: 'Lifted',
        LiftedAt: new Date(),
        LiftedBy: String(actor || ''),
        ClearanceNote: String(note || '')
      });
      lifted++;
    });
    return lifted;
  },

  /** Convenience counters used by the dashboards. */
  stats: function () {
    var rows = this.all();
    return {
      total: rows.length,
      active: rows.filter(function (s) { return String(s.Status) === STAFF_STATUS.ACTIVE; }).length,
      suspended: rows.filter(function (s) { return String(s.Status) === STAFF_STATUS.SUSPENDED; }).length,
      inactive: rows.filter(function (s) { return String(s.Status) === STAFF_STATUS.INACTIVE; }).length,
      flagged: rows.filter(function (s) { return Util.truthy(s.FlaggedStatus); }).length
    };
  }
};
