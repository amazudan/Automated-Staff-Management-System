/**
 * ============================================================================
 * Attendance.gs — daily sign-in, lateness, absence sweep and reminders.
 * ============================================================================
 * OnTime  : signed in at or before Config.AttendanceDeadline + AttendanceGraceMinutes
 * Late    : signed in after that
 * Absent  : no sign-in by the nightly sweep on a working day
 * Leave   : approved absence, recorded by an admin
 * Holiday : recorded by an admin for a company-wide non-working day
 *
 * A staff member who signs in on a day outside Config.WorkWeekDays is recorded
 * OnTime (punctuality is meaningless off-roster) with a note saying so, and the
 * row is left out of the attendance-rate maths so it can neither help nor hurt
 * the percentage. Sign-ins are NEVER auto-classified Holiday — that label is an
 * administrator's decision, not a side effect of working a weekend.
 * ============================================================================
 */

var AttendanceService = {

  all: function () { return SheetDB.readAll(SHEETS.ATTENDANCE); },

  forStaff: function (staffId) {
    return SheetDB.find(SHEETS.ATTENDANCE, function (a) {
      return String(a.StaffID) === String(staffId);
    });
  },

  /** One staff member's record for a specific day, or null. */
  recordFor: function (staffId, dateKey) {
    return SheetDB.findOne(SHEETS.ATTENDANCE, function (a) {
      return String(a.StaffID) === String(staffId) &&
             Util.dateKey(a.Date) === dateKey;
    });
  },

  /** Deadline in minutes-since-midnight, including the configured grace. */
  deadlineMinutes: function () {
    return Util.parseHhMm(CFG.get('AttendanceDeadline', '09:00'), 9 * 60) +
           CFG.num('AttendanceGraceMinutes', 0);
  },

  /** Has this staff member already signed in today? */
  hasSignedInToday: function (staffId) {
    var rec = this.recordFor(staffId, Util.dateKey(Util.today()));
    return !!(rec && String(rec.Status) !== ATTENDANCE_STATUS.ABSENT);
  },

  /**
   * Requirement 3.9 — the Sign Attendance button. Idempotent per day; the
   * caller wraps this in SheetDB.withLock().
   */
    signIn: function (staff, note, meta) {
    Auth.assertCanAct(staff);

    var today = Util.today();
    var todayKey = Util.dateKey(today);
    var existing = this.recordFor(staff.StaffID, todayKey);

    if (existing && String(existing.Status) !== ATTENDANCE_STATUS.ABSENT) {
      throw new Error('You already signed in today at ' +
        Util.fmtTime(existing.LoginTime) + '.');
    }

    var now = new Date();
    var minutes = Util.minutesOfDay(now);
    var deadline = this.deadlineMinutes();
    var workingDay = Util.isWorkingDay(today);

    var status, minutesLate = 0;
    if (!workingDay) {
      status = ATTENDANCE_STATUS.ON_TIME;
    } else if (minutes <= deadline) {
      status = ATTENDANCE_STATUS.ON_TIME;
    } else {
      status = ATTENDANCE_STATUS.LATE;
      minutesLate = minutes - deadline;
    }

    var notes = String(note || '').trim();
    if (!workingDay) {
      notes = (notes ? notes + ' · ' : '') +
        'Signed in on a non-working day — excluded from the attendance rate.';
    }

    // ---- device + geofence handling ----
    meta = meta || {};
    var deviceType = String(meta.deviceType || 'Unknown').slice(0, 100);
    var lat = (meta.latitude !== undefined && meta.latitude !== null && meta.latitude !== '')
      ? Number(meta.latitude) : null;
    var lng = (meta.longitude !== undefined && meta.longitude !== null && meta.longitude !== '')
      ? Number(meta.longitude) : null;

       var officeLat = CFG.num('OfficeLatitude', null);
    var officeLng = CFG.num('OfficeLongitude', null);
    var radius = CFG.num('GeofenceRadiusMeters', 300);
    var isDesktop = /^Desktop/i.test(deviceType);

    var distance = null, flagged = false;
    if (lat != null && lng != null && officeLat != null && officeLng != null) {
      distance = Math.round(Util.haversineMeters(lat, lng, officeLat, officeLng));
      flagged = distance > radius;
    } else if ((lat == null || lng == null) && !isDesktop) {
      // Desktops routinely can't provide GPS — only flag missing location on
      // mobile devices, where it usually means the person declined permission.
      flagged = true;
      notes = (notes ? notes + ' · ' : '') + 'No location data received from device.';
    } else if ((lat == null || lng == null) && isDesktop) {
      notes = (notes ? notes + ' · ' : '') + 'Desktop sign-in — location not available.';
    }

    if (flagged && distance != null) {
      notes = (notes ? notes + ' · ' : '') +
        'Location flagged: ' + distance + 'm from office (limit ' + radius + 'm).';
    }
    // ---- end new block ----

    var payload = {
      StaffID: String(staff.StaffID),
      StaffName: String(staff.Name),
      Date: today,
      LoginTime: now,
      LogoutTime: '',
      Status: status,
      MinutesLate: minutesLate,
      Notes: notes,
      RecordedAt: now,
      DeviceType: deviceType,
      Latitude: lat,
      Longitude: lng,
      DistanceMeters: distance,
      LocationFlagged: flagged
    };

    if (existing) {
      SheetDB.updateRowAt(SHEETS.ATTENDANCE, existing.__row, payload);
      payload.AttendanceID = existing.AttendanceID;
    } else {
      payload.AttendanceID = SheetDB.nextId('ATT', SHEETS.ATTENDANCE, 'AttendanceID', 6);
      SheetDB.insert(SHEETS.ATTENDANCE, payload);
    }

    SheetDB.updateRowAt(SHEETS.STAFF, staff.__row, { LastLogin: now });

    if (status === ATTENDANCE_STATUS.LATE) {
      NotificationService.push(staff.StaffID, 'AttendanceLate', 'warn',
        'Signed in late (' + Util.fmtTime(now) + ')',
        'You were ' + minutesLate + ' minute(s) past the ' +
        CFG.get('AttendanceDeadline', '09:00') + ' deadline.');
    }

    if (flagged) {
      NotificationService.push(staff.StaffID, 'AttendanceLocationFlag', 'warn',
        'Sign-in location flagged',
        distance != null
          ? 'You signed in ' + distance + 'm from the office (outside the ' + radius + 'm limit).'
          : 'Your device did not share a location for this sign-in.');
    }

    Log.info('Attendance', staff.StaffID + ' signed in ' + status +
      ' at ' + Util.fmtTime(now) + ' [' + deviceType + ', flagged=' + flagged + ']');

    return {
      attendanceId: payload.AttendanceID,
      status: status,
      loginTime: Util.fmtTime(now),
      minutesLate: minutesLate,
      workingDay: workingDay,
      staffId: String(staff.StaffID),
      staffName: String(staff.Name),
      deviceType: deviceType,
      distanceMeters: distance,
      locationFlagged: flagged
    };
  },
  /** Optional close-of-day sign-out, used to compute hours on site. */
  signOut: function (staff) {
    var rec = this.recordFor(staff.StaffID, Util.dateKey(Util.today()));
    if (!rec) throw new Error('You have not signed in today.');
    if (rec.LogoutTime) throw new Error('You already signed out at ' + Util.fmtTime(rec.LogoutTime) + '.');
    var now = new Date();
    SheetDB.updateRowAt(SHEETS.ATTENDANCE, rec.__row, { LogoutTime: now });
    return { logoutTime: Util.fmtTime(now) };
  },

  /** Admin override — approved leave or a holiday only. */
  adminSet: function (staffId, dateKey, status, note, admin) {
    // Requirement 4: OnTime / Late / Absent are decided automatically from the
    // sign-in time and the nightly sweep — never chosen by hand. Admins may only
    // record an approved Leave or a Holiday.
    var allowed = [ATTENDANCE_STATUS.LEAVE, ATTENDANCE_STATUS.HOLIDAY];
    if (allowed.indexOf(status) === -1) {
      throw new Error('Attendance status is set automatically from the sign-in time. ' +
        'Admins may only record Leave or Holiday.');
    }
    var staff = StaffService.byId(staffId);
    if (!staff) throw new Error('Staff member not found.');
    var date = Util.startOfDay(dateKey);
    var existing = this.recordFor(staffId, Util.dateKey(date));
    var patch = {
      Status: status,
      Notes: String(note || '') + ' (set by ' + admin.Email + ')',
      MinutesLate: status === ATTENDANCE_STATUS.LATE ? Util.num(existing && existing.MinutesLate, 0) : 0
    };
    if (existing) {
      SheetDB.updateRowAt(SHEETS.ATTENDANCE, existing.__row, patch);
    } else {
      SheetDB.insert(SHEETS.ATTENDANCE, {
        AttendanceID: SheetDB.nextId('ATT', SHEETS.ATTENDANCE, 'AttendanceID', 6),
        StaffID: String(staffId), StaffName: String(staff.Name),
        Date: date, LoginTime: '', LogoutTime: '',
        Status: status, MinutesLate: patch.MinutesLate,
        Notes: patch.Notes, RecordedAt: new Date()
      });
    }
    Log.info('Attendance', 'Admin set ' + staffId + ' on ' + Util.dateKey(date) +
      ' to ' + status + ' by ' + admin.Email);
    return true;
  },

  /** Trigger: end-of-day sweep marking non-signers Absent. */
  sweepAbsences: function () {
    var today = Util.today();
    var todayKey = Util.dateKey(today);
    var result = { date: todayKey, absent: 0, strikes: 0, skipped: false };

    if (!Util.isWorkingDay(today)) {
      result.skipped = true;
      Log.info('Triggers', 'sweepAttendance skipped — non-working day');
      return result;
    }

    var rows = [];
    StaffService.all().forEach(function (staff) {
      if (String(staff.Status) === STAFF_STATUS.INACTIVE) return;
      if (Auth.isAttendanceExempt(staff.Role)) return;   // management is not swept
      if (AttendanceService.recordFor(staff.StaffID, todayKey)) return;

      rows.push({
        AttendanceID: SheetDB.nextId('ATT', SHEETS.ATTENDANCE, 'AttendanceID', 6),
        StaffID: String(staff.StaffID),
        StaffName: String(staff.Name),
        Date: today,
        LoginTime: '', LogoutTime: '',
        Status: ATTENDANCE_STATUS.ABSENT,
        MinutesLate: 0,
        Notes: 'No sign-in recorded by end of day (automatic sweep).',
        RecordedAt: new Date()
      });
      result.absent++;

      NotificationService.push(staff.StaffID, 'AttendanceAbsent', 'danger',
        'Marked absent for ' + Util.fmtDate(today),
        'No attendance sign-in was recorded. Contact your administrator if this is wrong.');

      if (CFG.bool('StrikeOnAbsence', false)) {
        var outcome = StrikeService.issue({
          staff: staff,
          taskId: '',
          category: STRIKE_CATEGORY.MISSED_ATTENDANCE,
          reason: 'No attendance sign-in on ' + Util.fmtDate(today),
          taskAmount: 0
        });
        if (outcome) result.strikes++;
      }
    });

    if (rows.length) SheetDB.insertMany(SHEETS.ATTENDANCE, rows);
    Log.info('Triggers', 'sweepAttendance ' + JSON.stringify(result));
    return result;
  },

  /** Trigger: nudge anybody who has not signed in yet today. */
  remindUnsigned: function () {
    var today = Util.today();
    if (!Util.isWorkingDay(today)) return { reminded: 0, skipped: true };
    var todayKey = Util.dateKey(today);
    var reminded = 0;

    StaffService.all().forEach(function (staff) {
      if (String(staff.Status) !== STAFF_STATUS.ACTIVE) return;
      if (Auth.isAttendanceExempt(staff.Role)) return;
      if (AttendanceService.recordFor(staff.StaffID, todayKey)) return;
      try {
        Notify.attendanceReminder(staff);
        reminded++;
      } catch (e) { Log.exception('Attendance.remindUnsigned', e); }
    });

    Log.info('Triggers', 'sendAttendanceReminder reminded ' + reminded + ' staff');
    return { reminded: reminded };
  },

  /** Attendance figures for one staff member over a period. */
  statsFor: function (staffId, period) {
    var records = this.forStaff(staffId).filter(function (a) {
      return Util.inPeriod(a.Date, period);
    });

    var onTime = 0, late = 0, absent = 0, leave = 0, lateMinutes = 0, offRoster = 0;
    records.forEach(function (a) {
      // A sign-in on a day outside the work week is goodwill, not attendance:
      // count it separately so it neither inflates nor dents the percentage.
      if (!Util.isWorkingDay(a.Date)) {
        if (String(a.Status) === ATTENDANCE_STATUS.ON_TIME ||
            String(a.Status) === ATTENDANCE_STATUS.LATE) offRoster++;
        return;
      }
      switch (String(a.Status)) {
        case ATTENDANCE_STATUS.ON_TIME: onTime++; break;
        case ATTENDANCE_STATUS.LATE:
          late++; lateMinutes += Util.num(a.MinutesLate, 0); break;
        case ATTENDANCE_STATUS.ABSENT: absent++; break;
        case ATTENDANCE_STATUS.LEAVE:  leave++; break;
        default: break;   // Holiday rows are ignored
      }
    });

    // Working days elapsed so far (never credit the future).
    var todayKey = Util.dateKey(Util.today());
    var effectiveEnd = period.endKey <= todayKey ? period.end : Util.today();
    var workingDays = Util.dateKey(effectiveEnd) < period.startKey
      ? 0 : Util.countWorkingDays(period.start, effectiveEnd);
    var expected = Math.max(0, workingDays - leave);

    return {
      workingDays: workingDays,
      present: onTime + late,
      onTime: onTime,
      late: late,
      absent: absent,
      leave: leave,
      offRoster: offRoster,
      lateMinutes: lateMinutes,
      attendanceRate: Util.rate(onTime + late, expected),
      punctualityRate: Util.rate(onTime, onTime + late),
      records: records
    };
  },

  /** Today's roll-call, used by the admin dashboard. */
    todayBoard: function () {
    var todayKey = Util.dateKey(Util.today());
    var out = { date: todayKey, onTime: 0, late: 0, absent: 0, notSigned: 0, rows: [] };

    StaffService.all().forEach(function (staff) {
      if (String(staff.Status) === STAFF_STATUS.INACTIVE) return;
      var rec = AttendanceService.recordFor(staff.StaffID, todayKey);
      var status = rec ? String(rec.Status) : 'NotSigned';
      if (status === ATTENDANCE_STATUS.ON_TIME) out.onTime++;
      else if (status === ATTENDANCE_STATUS.LATE) out.late++;
      else if (status === ATTENDANCE_STATUS.ABSENT) out.absent++;
      else out.notSigned++;

            out.rows.push({
        staffId: String(staff.StaffID),
        name: String(staff.Name),
        department: String(staff.Department || ''),
        status: status,
        loginTime: rec ? Util.fmtTime(rec.LoginTime) : '',
        minutesLate: rec ? Util.num(rec.MinutesLate, 0) : 0,
        photoUrl: String(staff.PhotoUrl || ''),
        deviceType: rec ? String(rec.DeviceType || '') : '',
        distanceMeters: rec && rec.DistanceMeters !== '' && rec.DistanceMeters != null ? Util.num(rec.DistanceMeters, null) : null,
        locationFlagged: rec ? Util.truthy(rec.LocationFlagged) : false
      });
    });
    return out;
  }
};