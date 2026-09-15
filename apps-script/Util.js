/**
 * ============================================================================
 * Util.gs — date/period maths, formatting, ids and small shared helpers.
 * ============================================================================
 * Every date-only value in the sheets is stored as a real Date pinned to
 * midnight in the configured timezone. Util.dateKey() is the canonical way to
 * compare two dates: it renders both to 'yyyy-MM-dd' strings, which sort and
 * compare correctly and are immune to timezone drift.
 * ============================================================================
 */

var Util = {

  /* --- Dates ------------------------------------------------------------ */

  /** Coerce anything sheet-ish (Date | string | number) into a Date, or null. */
  toDate: function (v) {
    if (v === null || v === undefined || v === '') return null;
    if (Object.prototype.toString.call(v) === '[object Date]') {
      return isNaN(v.getTime()) ? null : v;
    }
    if (typeof v === 'number') return new Date(v);
    var s = String(v).trim();
    if (!s) return null;
    // yyyy-MM-dd is parsed as UTC by the JS engine — rebuild it locally so it
    // does not slide backwards a day in positive-offset timezones.
    var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  },

  /** 'yyyy-MM-dd' in the configured timezone. Safe comparison key. */
  dateKey: function (v) {
    var d = this.toDate(v);
    return d ? Utilities.formatDate(d, getTz(), 'yyyy-MM-dd') : '';
  },

  /** Strip the time component, in the configured timezone. */
  startOfDay: function (v) {
    var d = this.toDate(v) || new Date();
    var parts = Utilities.formatDate(d, getTz(), 'yyyy-MM-dd').split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  },

  /** Today at midnight. */
  today: function () { return this.startOfDay(new Date()); },

  /** Now, as a Date. */
  now: function () { return new Date(); },

  addDays: function (v, n) {
    var d = this.startOfDay(v);
    d.setDate(d.getDate() + n);
    return d;
  },

  addMonths: function (v, n) {
    var d = this.startOfDay(v);
    var day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    // Clamp for short months (31 Jan + 1 month -> 28/29 Feb).
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d;
  },

  /** Whole days from a to b (b - a). */
  daysBetween: function (a, b) {
    var ms = this.startOfDay(b).getTime() - this.startOfDay(a).getTime();
    return Math.round(ms / 86400000);
  },

  /** Display date: '29 Aug 2026'. */
  fmtDate: function (v) {
    var d = this.toDate(v);
    return d ? Utilities.formatDate(d, getTz(), 'dd MMM yyyy') : '';
  },

  /** Display timestamp: '29 Aug 2026, 14:05'. */
  fmtDateTime: function (v) {
    var d = this.toDate(v);
    return d ? Utilities.formatDate(d, getTz(), 'dd MMM yyyy, HH:mm') : '';
  },

  /** 'HH:mm' in the configured timezone. */
  fmtTime: function (v) {
    var d = this.toDate(v);
    return d ? Utilities.formatDate(d, getTz(), 'HH:mm') : '';
  },

  /** Minutes since midnight for a Date. */
  minutesOfDay: function (v) {
    var d = this.toDate(v) || new Date();
    var hhmm = Utilities.formatDate(d, getTz(), 'HH:mm').split(':');
    return Number(hhmm[0]) * 60 + Number(hhmm[1]);
  },

  /** Minutes since midnight for an 'HH:mm' config string. */
  parseHhMm: function (s, fallbackMinutes) {
    var m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return fallbackMinutes === undefined ? 0 : fallbackMinutes;
    return Number(m[1]) * 60 + Number(m[2]);
  },

  /** True when the date falls on a configured working day and is not a holiday. */
  isWorkingDay: function (v) {
    var d = this.startOfDay(v);
    var working = CFG.list('WorkWeekDays').map(Number);
    if (working.length && working.indexOf(d.getDay()) === -1) return false;
    return !this.isHoliday(d);
  },

  /** Holiday lookup (supports Recurring=TRUE rows that ignore the year). */
  isHoliday: function (v) {
    var key = this.dateKey(v);
    if (!key) return false;
    var mmdd = key.substring(5);
    var rows;
    try { rows = SheetDB.readAll(SHEETS.HOLIDAYS); } catch (e) { return false; }
    for (var i = 0; i < rows.length; i++) {
      var hk = this.dateKey(rows[i].Date);
      if (!hk) continue;
      if (hk === key) return true;
      if (Util.truthy(rows[i].Recurring) && hk.substring(5) === mmdd) return true;
    }
    return false;
  },

  /** Next working day strictly after the given date. */
  nextWorkingDay: function (v) {
    var d = this.addDays(v, 1);
    for (var guard = 0; guard < 14 && !this.isWorkingDay(d); guard++) {
      d = this.addDays(d, 1);
    }
    return d;
  },

  /** Count working days in an inclusive range. */
  countWorkingDays: function (start, end) {
    var s = this.startOfDay(start), e = this.startOfDay(end), n = 0;
    for (var guard = 0; s.getTime() <= e.getTime() && guard < 800; guard++) {
      if (this.isWorkingDay(s)) n++;
      s = this.addDays(s, 1);
    }
    return n;
  },

  /** Every date key in an inclusive range. */
  dateKeysBetween: function (start, end) {
    var s = this.startOfDay(start), e = this.startOfDay(end), out = [];
    for (var guard = 0; s.getTime() <= e.getTime() && guard < 800; guard++) {
      out.push(this.dateKey(s));
      s = this.addDays(s, 1);
    }
    return out;
  },

  /* --- Reporting periods ------------------------------------------------ */

  /**
   * Resolve a period type + reference date into {start, end, label, type}.
   * Weeks run Monday..Sunday. Quarters are calendar quarters.
   */
  resolvePeriod: function (periodType, refDate) {
    var ref = this.startOfDay(refDate || new Date());
    var y = ref.getFullYear(), m = ref.getMonth(), type = periodType || 'Monthly';
    var start, end, label;

    switch (type) {
      case 'Daily':
        start = ref; end = ref;
        label = Utilities.formatDate(ref, getTz(), 'dd MMM yyyy');
        break;

      case 'Weekly':
        var dow = ref.getDay();                 // 0=Sun
        var backToMonday = (dow === 0) ? 6 : dow - 1;
        start = this.addDays(ref, -backToMonday);
        end = this.addDays(start, 6);
        label = 'Week of ' + Utilities.formatDate(start, getTz(), 'dd MMM yyyy');
        break;

      case 'Monthly':
        start = new Date(y, m, 1);
        end = new Date(y, m + 1, 0);
        label = Utilities.formatDate(start, getTz(), 'MMMM yyyy');
        break;

      case 'Quarterly':
        var q = Math.floor(m / 3);
        start = new Date(y, q * 3, 1);
        end = new Date(y, q * 3 + 3, 0);
        label = 'Q' + (q + 1) + ' ' + y;
        break;

      case 'HalfYearly':
        var h = m < 6 ? 0 : 1;
        start = new Date(y, h * 6, 1);
        end = new Date(y, h * 6 + 6, 0);
        label = (h === 0 ? 'H1 ' : 'H2 ') + y;
        break;

      case 'Yearly':
        start = new Date(y, 0, 1);
        end = new Date(y, 11, 31);
        label = String(y);
        break;

      default:
        throw new Error('Unknown period type: ' + type);
    }
    return { type: type, start: start, end: end, label: label,
             startKey: this.dateKey(start), endKey: this.dateKey(end) };
  },

  /** True when a date value sits inside a resolved period (inclusive). */
  inPeriod: function (value, period) {
    var k = this.dateKey(value);
    return !!k && k >= period.startKey && k <= period.endKey;
  },

  /* --- Values ----------------------------------------------------------- */

  /** Sheet-safe boolean read. Accepts TRUE, true, 'Y', 1, 'yes'. */
  truthy: function (v) {
    if (v === true) return true;
    if (v === false || v === null || v === undefined) return false;
    var s = String(v).trim().toLowerCase();
    return s === 'true' || s === 'y' || s === 'yes' || s === '1';
  },

  num: function (v, fallback) {
    var n = parseFloat(v);
    return isNaN(n) ? (fallback === undefined ? 0 : fallback) : n;
  },

  /** Clamp to 0..100 and round to a whole percent. */
  pct: function (v) {
    return Math.max(0, Math.min(100, Math.round(this.num(v, 0))));
  },

  /** Safe division returning a rounded percentage. */
  rate: function (numerator, denominator) {
    var d = this.num(denominator, 0);
    if (d <= 0) return 0;
    return Math.round((this.num(numerator, 0) / d) * 1000) / 10;
  },

  /** Round money to the configured precision. */
  money: function (v) {
    var dp = CFG.num('PayRoundTo', 2);
    var f = Math.pow(10, dp);
    return Math.round(this.num(v, 0) * f) / f;
  },

  /** Currency string for emails and reports. */
  fmtMoney: function (v) {
    var dp = CFG.num('PayRoundTo', 2);
    return CFG.get('Currency', '') +
      this.num(v, 0).toFixed(dp).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },

  isEmail: function (s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());
  },

  /** Escape for embedding into HTML email bodies. */
  escapeHtml: function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  /** One level up the priority ladder. */
  escalatePriority: function (current) {
    var i = PRIORITY_LADDER.indexOf(String(current || 'Normal'));
    if (i === -1) i = 1;
    return PRIORITY_LADDER[Math.min(i + 1, PRIORITY_LADDER.length - 1)];
  },

  /** Deterministic hash used for PINs. */
  hash: function (value, salt) {
    var raw = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, String(salt) + '::' + String(value),
      Utilities.Charset.UTF_8);
    return raw.map(function (b) {
      return ('0' + (b & 0xFF).toString(16)).slice(-2);
    }).join('');
  },

  randomToken: function (len) {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var out = '';
    for (var i = 0; i < (len || 24); i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  },

  randomPin: function () {
    return String(Math.floor(100000 + Math.random() * 900000));
  },

  /** Serialise Dates to ISO so google.script.run can return them to the client. */
  serialise: function (value) {
    if (value === null || value === undefined) return value;
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return isNaN(value.getTime()) ? '' : value.toISOString();
    }
    if (Array.isArray(value)) return value.map(Util.serialise);
    if (typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) { out[k] = Util.serialise(value[k]); });
      return out;
    }
    return value;
  }
};
