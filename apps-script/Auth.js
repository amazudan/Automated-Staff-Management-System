/**
 * ============================================================================
 * Auth.gs — identity, sessions and role gates.
 * ============================================================================
 * AUTH MODE (confirmed decision): "Hybrid".
 *
 *   1. The web app is deployed "Execute as: Me (owner)" so the database
 *      spreadsheet stays private — staff never get access to the raw sheet.
 *   2. On load we try Session.getActiveUser().getEmail(). Inside a Workspace
 *      domain this returns the signed-in address and the user is let straight
 *      in (single sign-on).
 *   3. When Google withholds the address (consumer accounts, external users)
 *      we fall back to an email + 6-digit PIN form. PINs are stored as
 *      salted SHA-256 hashes in Staff.PinHash / Staff.PinSalt — never in
 *      plain text.
 *   4. A successful sign-in (PIN *or* Google) returns an opaque session token
 *      which the browser holds in sessionStorage and replays on every call.
 *      Tokens live in CacheService and expire after Config.SessionTimeoutMinutes.
 *   5. PRECEDENCE: the session token always wins over the browser's Google
 *      identity. The app is deployed "Execute as: Me", so on the owner's own
 *      machine Session.getActiveUser() is always the owner — if SSO were
 *      checked first, every staff member signed in on that machine would be
 *      resolved as the administrator.
 *
 * Switch behaviour with Config.AuthMode = Hybrid | GoogleOnly | PinOnly.
 * ============================================================================
 */

var Auth = (function () {
  var TOKEN_PREFIX = 'SESS_';

  function cache() { return CacheService.getScriptCache(); }

  /** Email Google is willing to tell us about, or ''. */
  function googleEmail() {
    try {
      var e = Session.getActiveUser().getEmail();
      return Util.isEmail(e) ? String(e).trim().toLowerCase() : '';
    } catch (err) {
      return '';
    }
  }

  function staffByEmail(email) {
    var wanted = String(email || '').trim().toLowerCase();
    if (!wanted) return null;
    return SheetDB.findOne(SHEETS.STAFF, function (s) {
      return String(s.Email).trim().toLowerCase() === wanted;
    });
  }

  function isAdminRole(role) {
    var r = String(role || '').trim();
    return r === ROLES.ADMIN || r === ROLES.MANAGER;
  }

  /** Trim a Staff row down to what the browser is allowed to see. */
  function publicProfile(staff) {
    if (!staff) return null;
    return {
      staffId: String(staff.StaffID),
      name: String(staff.Name),
      email: String(staff.Email),
      phone: String(staff.Phone || ''),
      role: String(staff.Role),
      isAdmin: isAdminRole(staff.Role),
      department: String(staff.Department || ''),
      position: String(staff.Position || ''),
      status: String(staff.Status),
      strikeCount: Util.num(staff.StrikeCount, 0),
      flagged: Util.truthy(staff.FlaggedStatus),
      suspended: String(staff.Status) === STAFF_STATUS.SUSPENDED,
      suspensionCount: Util.num(staff.SuspensionCount, 0),
      totalStrikesIssued: Util.num(staff.TotalStrikesIssued, 0),
      photoUrl: String(staff.PhotoUrl || ''),
      dateAdded: Util.dateKey(staff.DateAdded),
      // Their own guaranteed monthly salary — the basis of every task allocation.
      monthlySalary: AllocationService.salaryOf(staff)
    };
  }

  /** Session lifetime in seconds (CacheService caps at 6 hours). */
  function sessionTtl() {
    return Math.min(CFG.num('SessionTimeoutMinutes', 480) * 60, 21600);
  }

  /** Issue a session token for a Staff row. */
  function mintSession(staff) {
    var token = Util.randomToken(32);
    cache().put(TOKEN_PREFIX + token, String(staff.StaffID), sessionTtl());
    return token;
  }

  /**
   * Resolve a session token to its Staff row, refreshing the sliding expiry.
   * This is the AUTHORITATIVE identity: whoever holds the token is the caller,
   * regardless of which Google account happens to own the browser. Without this
   * ordering the owner's SSO address wins every call and every staff member is
   * mistaken for the administrator.
   */
  function staffByToken(token) {
    if (!token) return null;
    var staffId = cache().get(TOKEN_PREFIX + token);
    if (!staffId) return null;
    cache().put(TOKEN_PREFIX + token, staffId, sessionTtl());   // sliding expiry
    return SheetDB.findById(SHEETS.STAFF, 'StaffID', staffId);
  }

  return {
    googleEmail: googleEmail,
    staffByEmail: staffByEmail,
    staffByToken: staffByToken,
    isAdminRole: isAdminRole,
    publicProfile: publicProfile,

    /**
     * Work out who is calling.
     * Order matters: the session token wins, and Google SSO is only a fallback
     * for calls made before any token exists. A token that was supplied but has
     * expired never falls through to SSO — on the owner's own machine that would
     * quietly promote a lapsed staff session to the administrator.
     * @param {string} token session token from the browser (may be blank)
     * @return {Object|null} the Staff row
     */
    currentStaff: function (token) {
      var mode = CFG.get('AuthMode', 'Hybrid');
      var presented = String(token || '').trim();

      // 1. Session token — the identity the browser explicitly signed in as.
      if (presented) return staffByToken(presented);

      // 2. Google SSO fallback, only when no session was presented at all.
      if (mode !== 'PinOnly') {
        var email = googleEmail();
        if (email) {
          var byGoogle = staffByEmail(email);
          if (byGoogle) return byGoogle;
        }
      }
      return null;
    },

    /**
     * Sign in the Google account that owns the browser, if it matches a Staff
     * row, and hand back a session token so every later call is attributed to
     * that person and not to whoever the browser's Google account is.
     */
    loginWithGoogle: function () {
      if (CFG.get('AuthMode', 'Hybrid') === 'PinOnly') {
        throw new Error('This deployment uses email + PIN sign-in only.');
      }
      var email = googleEmail();
      if (!email) {
        throw new Error('Google did not share an address for this browser. Use your email and PIN.');
      }
      var staff = staffByEmail(email);
      if (!staff) throw new Error('The Google account ' + email + ' is not on staff yet.');
      if (String(staff.Status) === STAFF_STATUS.INACTIVE) {
        throw new Error('Your account is inactive. Contact your administrator.');
      }
      var token = mintSession(staff);
      SheetDB.updateRowAt(SHEETS.STAFF, staff.__row, { LastLogin: new Date() });
      Log.info('Auth', 'Google sign-in', String(staff.Email));
      return { token: token, profile: publicProfile(staff) };
    },

    /** Throw unless the caller is a known, non-deactivated staff member. */
    requireStaff: function (token) {
      var staff = this.currentStaff(token);
      if (!staff) throw new Error('AUTH_REQUIRED');
      if (String(staff.Status) === STAFF_STATUS.INACTIVE) {
        throw new Error('Your account is inactive. Contact your administrator.');
      }
      return staff;
    },

    /** Throw unless the caller is an Admin or Manager. */
    requireAdmin: function (token) {
      var staff = this.requireStaff(token);
      if (!isAdminRole(staff.Role)) throw new Error('FORBIDDEN: administrator access required.');
      return staff;
    },

    /**
     * Gate used by every staff action (acknowledge, report, sign attendance).
     * A suspended member keeps read access but cannot act until an admin
     * clears their strikes.
     */
    assertCanAct: function (staff) {
      if (String(staff.Status) === STAFF_STATUS.SUSPENDED &&
          CFG.bool('SuspensionBlocksPortal', true)) {
        throw new Error(
          'Your account is suspended after ' + CFG.num('StrikeLimit', 3) +
          ' strikes. An administrator must clear your record before you can ' +
          'continue. Your task history and strike record remain on file.');
      }
      return true;
    },

    /** Email + PIN login. Returns { token, profile }. */
    login: function (email, pin) {
      if (CFG.get('AuthMode', 'Hybrid') === 'GoogleOnly') {
        throw new Error('This deployment uses Google sign-in only.');
      }
      var staff = staffByEmail(email);
      if (!staff) throw new Error('No staff record found for that email address.');
      if (String(staff.Status) === STAFF_STATUS.INACTIVE) {
        throw new Error('Your account is inactive. Contact your administrator.');
      }
      if (!staff.PinHash || !staff.PinSalt) {
        throw new Error('No PIN has been set for this account. Ask your administrator to reset it.');
      }
      if (Util.hash(String(pin || '').trim(), staff.PinSalt) !== String(staff.PinHash)) {
        Log.warn('Auth', 'Failed PIN login', String(email));
        throw new Error('Incorrect PIN.');
      }

      var token = mintSession(staff);
      SheetDB.updateRowAt(SHEETS.STAFF, staff.__row, { LastLogin: new Date() });
      Log.info('Auth', 'PIN login', String(staff.Email));
      return { token: token, profile: publicProfile(staff) };
    },

    logout: function (token) {
      if (token) cache().remove(TOKEN_PREFIX + token);
      return true;
    },

    /** Staff changes their own PIN. */
    changePin: function (token, oldPin, newPin) {
      var staff = this.requireStaff(token);
      var current = String(oldPin || '').trim();
      var clean = String(newPin || '').trim();

      if (staff.PinHash && staff.PinSalt) {
        if (!current) throw new Error('Enter your current PIN.');
        if (Util.hash(current, staff.PinSalt) !== String(staff.PinHash)) {
          throw new Error('Current PIN is incorrect.');
        }
      }
      if (!/^\d{4,8}$/.test(clean)) throw new Error('The new PIN must be 4 to 8 digits.');
      if (current && current === clean) {
        throw new Error('The new PIN must be different from your current one.');
      }

      var salt = Util.randomToken(16);
      SheetDB.updateRowAt(SHEETS.STAFF, staff.__row, {
        PinHash: Util.hash(clean, salt), PinSalt: salt
      });
      Log.info('Auth', 'PIN changed', String(staff.Email));
      return { changed: true, staffId: String(staff.StaffID), email: String(staff.Email) };
    },

    /** Admin resets somebody else's PIN and emails it to them. */
    resetPin: function (token, staffId) {
      var admin = this.requireAdmin(token);
      var staff = SheetDB.findById(SHEETS.STAFF, 'StaffID', staffId);
      if (!staff) throw new Error('Staff member not found.');
      var pin = Util.randomPin();
      var salt = Util.randomToken(16);
      SheetDB.updateRowAt(SHEETS.STAFF, staff.__row, {
        PinHash: Util.hash(pin, salt), PinSalt: salt
      });
      Notify.pinReset(staff, pin);
      Log.info('Auth', 'PIN reset by ' + admin.Email, String(staff.Email));
      return { pin: pin };
    },

    /** Write a fresh PIN onto a Staff row object (used when creating staff). */
    stampNewPin: function (record, explicitPin) {
      var pin = explicitPin || CFG.get('DefaultPin', '') || Util.randomPin();
      var salt = Util.randomToken(16);
      record.PinHash = Util.hash(pin, salt);
      record.PinSalt = salt;
      return pin;
    }
  };
})();
