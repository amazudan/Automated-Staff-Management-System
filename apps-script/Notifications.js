/**
 * ============================================================================
 * Notifications.gs — outbound email (Notify) and in-app alerts
 * (NotificationService, which feeds the "Reminders" card on both dashboards).
 * ============================================================================
 * Every email body is rendered through the EmailTemplate.html HtmlService
 * template, so there is one place to restyle all outbound mail.
 * ============================================================================
 */

var Notify = (function () {

  function enabled() { return CFG.bool('EmailNotificationsEnabled', true); }

  function portalUrl() {
    var url = CFG.get('WebAppUrl', '');
    if (url) return url;
    try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
  }

  /* --- The designated sender ---------------------------------------------- */

  /** The Google account the script actually runs as (''when unavailable). */
  function executingEmail() {
    try { return String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase(); }
    catch (e) { return ''; }
  }

  /**
   * Mail options carrying the designated sender.
   *
   * Google will not let a script forge an arbitrary From address: it must be
   * the executing account or one of its verified Gmail aliases. So:
   *   • Config.SenderEmail == the executing account → nothing to do, that is
   *     already the From address.
   *   • Otherwise we optimistically ask for it as From. If Gmail rejects it
   *     (not a verified alias) deliver() remembers that and falls back to
   *     Reply-To for every later send.
   */
  function senderOptions() {
    var out = { name: CFG.get('SenderName', '') || CFG.get('CompanyName', 'Staff Management System') };
    var addr = String(CFG.get('SenderEmail', '')).trim();
    if (!Util.isEmail(addr)) return out;
    if (addr.toLowerCase() === executingEmail()) return out;   // already the From address
    if (aliasRejected(addr)) out.replyTo = addr;
    else { out.from = addr; out.replyTo = addr; }
    return out;
  }

  var ALIAS_FLAG = 'MAIL_ALIAS_BAD_';

  function aliasRejected(addr) {
    try { return CacheService.getScriptCache().get(ALIAS_FLAG + addr.toLowerCase()) === '1'; }
    catch (e) { return false; }
  }

  function rememberAliasRejected(addr) {
    try { CacheService.getScriptCache().put(ALIAS_FLAG + addr.toLowerCase(), '1', 21600); }
    catch (e) {}
  }

  /**
   * Actually hand a message to Gmail, with the designated-sender retry.
   * Throws on a genuine delivery failure so callers can report it.
   * @param {Object} o {to, subject, htmlBody}
   */
  function deliver(o) {
    var opts = senderOptions();
    opts.to = o.to;
    opts.subject = o.subject;
    opts.htmlBody = o.htmlBody;
    try {
      MailApp.sendEmail(opts);
    } catch (err) {
      if (!opts.from) throw err;
      // The configured address is not a verified alias of this account.
      Log.warn('Notify', 'Sender "' + opts.from + '" refused by Gmail — falling back to Reply-To',
        String(err && err.message ? err.message : err));
      rememberAliasRejected(opts.from);
      delete opts.from;
      MailApp.sendEmail(opts);
    }
    return true;
  }

  /* --- Rendering ---------------------------------------------------------- */

  /** Bare-bones body used if the HTML template ever fails to compile. */
  function fallbackHtml(d) {
    var rows = (d.rows || []).map(function (r) {
      return '<tr><td style="padding:4px 12px 4px 0;color:#64748B">' +
        Util.escapeHtml(String(r[0])) + '</td><td style="padding:4px 0"><b>' +
        Util.escapeHtml(String(r[1])) + '</b></td></tr>';
    }).join('');
    return '<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:14px">' +
      '<h2 style="color:#0B2447">' + Util.escapeHtml(d.company) + '</h2>' +
      (d.title ? '<h3>' + Util.escapeHtml(d.title) + '</h3>' : '') +
      (d.intro ? '<p>' + Util.escapeHtml(d.intro) + '</p>' : '') +
      (rows ? '<table>' + rows + '</table>' : '') +
      (d.body || '') +
      (d.cta ? '<p><a href="' + Util.escapeHtml(d.cta.url) + '">' +
               Util.escapeHtml(d.cta.label) + '</a></p>' : '') +
      (d.footnote ? '<p style="color:#64748B;font-size:12px">' +
                    Util.escapeHtml(d.footnote) + '</p>' : '') +
      '</div>';
  }

  /**
   * Render the shared template.
   * @param {Object} o {title, intro, rows:[[label,value]], body, cta:{label,url},
   *                    accent:'navy'|'red'|'amber'|'green', footnote}
   */
  function render(o) {
    var data = {
      company: CFG.get('CompanyName', 'Staff Management'),
      logoUrl: String(CFG.get('CompanyLogoUrl', '')).trim(),
      title: o.title || '',
      intro: o.intro || '',
      rows: o.rows || [],
      body: o.body || '',
      cta: o.cta || null,
      accent: o.accent || 'navy',
      footnote: o.footnote || '',
      year: Utilities.formatDate(new Date(), getTz(), 'yyyy')
    };
    // A template compile error must never take a send down with it.
    try {
      var tpl = HtmlService.createTemplateFromFile('EmailTemplate');
      tpl.data = data;
      return tpl.evaluate().getContent();
    } catch (err) {
      Log.exception('Notify.render — using plain fallback body', err);
      return fallbackHtml(data);
    }
  }

  /** Send one HTML email, swallowing quota/permission errors into the log. */
  function send(to, subject, html) {
    if (!enabled()) {
      Log.info('Notify', 'Email suppressed (EmailNotificationsEnabled=FALSE): ' + subject);
      return false;
    }
    var recipients = (Array.isArray(to) ? to : [to])
      .filter(function (e) { return Util.isEmail(e); });
    if (!recipients.length) return false;
    try {
      return deliver({
        to: recipients.join(','),
        subject: '[' + CFG.get('CompanyName', 'Staff MS') + '] ' + subject,
        htmlBody: html
      });
    } catch (err) {
      Log.exception('Notify.send(' + subject + ')', err);
      return false;
    }
  }

  function cta(label) {
    var url = portalUrl();
    return url ? { label: label, url: url } : null;
  }

  return {
    render: render,
    send: send,
    deliver: deliver,
    senderOptions: senderOptions,
    portalUrl: portalUrl,

    welcome: function (staff, pin) {
      return send(staff.Email, 'Your staff portal access', render({
        title: 'Welcome, ' + staff.Name,
        intro: 'Your account on the staff task, attendance and payroll portal is ready.',
        rows: [
          ['Staff ID', staff.StaffID],
          ['Email', staff.Email],
          ['Role', staff.Role],
          ['Login PIN', pin]
        ],
        body: '<p>Sign in with your Google account. If your address is not detected ' +
              'automatically, use your email and the PIN above. <strong>Change your PIN ' +
              'from Settings after your first login.</strong></p>' +
              '<p>Each working day you must: sign attendance before <strong>' +
              CFG.get('AttendanceDeadline', '09:00') + '</strong>, and file a daily report ' +
              'on every active task before <strong>' + CFG.get('DailyReportDeadline', '18:00') +
              '</strong>. Missing either issues a strike; ' + CFG.num('StrikeLimit', 3) +
              ' strikes suspends the account.</p>',
        cta: cta('Open the staff portal')
      }));
    },

    pinReset: function (staff, pin) {
      return send(staff.Email, 'Your PIN has been reset', render({
        title: 'New login PIN',
        intro: 'An administrator reset the PIN on your account.',
        rows: [['Staff ID', staff.StaffID], ['New PIN', pin]],
        body: '<p>Please change it from Settings once you are signed in.</p>',
        accent: 'amber',
        cta: cta('Sign in')
      }));
    },

    taskAssigned: function (staff, task) {
      if (!CFG.bool('NotifyStaffOnAssignment', true)) return false;
      return send(staff.Email, 'New task assigned: ' + task.Title, render({
        title: 'New task: ' + task.Title,
        intro: 'Hello ' + staff.Name + ', a task has been allocated to you.',
        rows: [
          ['Task ID', task.TaskID],
          ['Type', task.TaskType],
          ['Priority', task.Priority],
          ['Starts', Util.fmtDate(task.StartDate)],
          ['Due', Util.fmtDate(task.DueDate)],
          ['Allocated amount', Util.fmtMoney(task.AmountAllocated)]
        ],
        body: (task.Description ? '<p>' + Util.escapeHtml(task.Description) + '</p>' : '') +
              '<p><strong>Acknowledge this task in the portal</strong> before you begin — ' +
              'it stays unstarted until you do. Then file a daily report each working ' +
              'day before ' + CFG.get('DailyReportDeadline', '18:00') + '.</p>' +
              '<p>Pay is calculated as <em>allocated amount × validated completion ' +
              'percentage</em>, so partial delivery still earns partial pay once an ' +
              'administrator validates it.</p>',
        cta: cta('Acknowledge task')
      }));
    },

    /** Requirement 1: the rollover warning. */
    taskRolledOver: function (staff, task, info) {
      var subject = info.suspended
        ? 'ACCOUNT SUSPENDED — ' + task.Title
        : 'WARNING ' + info.rolloverNo + '/' + info.maxRollovers + ' — task rolled over: ' + task.Title;

      var body;
      if (info.suspended) {
        body = '<p>This was strike <strong>' + info.rolloverNo + ' of ' + info.maxRollovers +
          '</strong>. Your account has been <strong>suspended</strong> and you cannot ' +
          'acknowledge tasks, file reports or sign attendance until an administrator ' +
          'clears your record.</p>' +
          '<p>The strike history and the suspension stay on your permanent staff file ' +
          'even after clearance.</p>';
      } else {
        body = '<p>Your task was not completed by its due date, so it has been ' +
          '<strong>rolled over to ' + Util.fmtDate(info.newDueDate) + '</strong> and ' +
          'flagged as <strong>PRIORITY</strong>.</p>' +
          '<p>You have <strong>' + (info.maxRollovers - info.rolloverNo) +
          ' warning(s) left</strong>. On strike ' + info.maxRollovers +
          ' your account is suspended.</p>';
      }
      if (info.failed) {
        body += '<p>The task has been marked <strong>Failed</strong> and will no longer ' +
                'roll forward. Any validated progress still counts towards your pay.</p>';
      }

      return send(staff.Email, subject, render({
        title: info.suspended ? 'Account suspended' : 'Task rolled over — warning ' +
               info.rolloverNo + ' of ' + info.maxRollovers,
        intro: 'Hello ' + staff.Name + ', action is required on "' + task.Title + '".',
        rows: [
          ['Task', task.Title + ' (' + task.TaskID + ')'],
          ['Original due date', Util.fmtDate(task.OriginalDueDate || task.DueDate)],
          ['New due date', info.failed ? '— (task failed)' : Util.fmtDate(info.newDueDate)],
          ['Rollover', info.rolloverNo + ' of ' + info.maxRollovers],
          ['Reported progress', Util.pct(task.ReportedProgress) + '%']
        ],
        body: body,
        accent: info.suspended ? 'red' : 'amber',
        cta: cta('Open my tasks')
      }));
    },

    taskAwaitingValidation: function (adminEmail, staff, task) {
      return send(adminEmail, 'Validation needed: ' + task.Title, render({
        title: 'Task submitted for validation',
        intro: staff.Name + ' has handed in "' + task.Title + '".',
        rows: [
          ['Staff', staff.Name + ' (' + staff.StaffID + ')'],
          ['Task', task.Title + ' (' + task.TaskID + ')'],
          ['Due', Util.fmtDate(task.DueDate)],
          ['Reported progress', Util.pct(task.ReportedProgress) + '%'],
          ['Allocated amount', Util.fmtMoney(task.AmountAllocated)]
        ],
        body: '<p>No pay accrues until you validate a completion percentage. ' +
              'Open the admin dashboard, review the daily reports and any attached ' +
              'documents, then set the validated percentage.</p>',
        accent: 'amber',
        cta: cta('Validate now')
      }));
    },

    validationOverdue: function (adminEmail, staff, task) {
      return send(adminEmail, 'Overdue validation: ' + task.Title, render({
        title: 'A submitted task is still unvalidated',
        intro: staff.Name + ' submitted "' + task.Title + '" and its due date has passed.',
        rows: [
          ['Staff', staff.Name],
          ['Task', task.Title + ' (' + task.TaskID + ')'],
          ['Submitted', Util.fmtDateTime(task.SubmittedAt)],
          ['Due', Util.fmtDate(task.DueDate)]
        ],
        body: '<p>The task was <strong>not</strong> rolled over and no strike was issued, ' +
              'because the delay is on the validation side. Please review it.</p>',
        accent: 'amber',
        cta: cta('Review submission')
      }));
    },

    taskValidated: function (staff, task, changes, markComplete) {
      return send(staff.Email,
        (markComplete ? 'Task approved: ' : 'Partially approved: ') + task.Title,
        render({
          title: markComplete ? 'Task approved' : 'Partial progress approved',
          intro: 'Hello ' + staff.Name + ', "' + task.Title + '" has been validated.',
          rows: [
            ['Validated progress', changes.ValidatedProgress + '%'],
            ['Allocated amount', Util.fmtMoney(task.AmountAllocated)],
            ['Earned on this task', Util.fmtMoney(changes.PayableAmount)],
            ['Quality score', changes.MetricScore + '/100'],
            ['Status', changes.Status]
          ],
          body: markComplete
            ? '<p>Thank you — this task is now complete and counted towards your ' +
              'earnings for the period.</p>'
            : '<p>Part of the work was accepted. The task is back in your queue as a ' +
              'priority item; finish it to earn the remaining ' +
              Util.fmtMoney(Util.num(task.AmountAllocated, 0) - Util.num(changes.PayableAmount, 0)) +
              '.</p>',
          accent: markComplete ? 'green' : 'amber',
          cta: cta('Open my tasks')
        }));
    },

    taskRejected: function (staff, task, comment) {
      return send(staff.Email, 'Rework needed: ' + task.Title, render({
        title: 'Submission returned',
        intro: 'Hello ' + staff.Name + ', "' + task.Title + '" needs more work.',
        rows: [['Task', task.Title + ' (' + task.TaskID + ')'],
               ['Due', Util.fmtDate(task.DueDate)]],
        body: '<p><strong>Reviewer comment:</strong> ' +
              Util.escapeHtml(comment || 'Returned for rework.') + '</p>' +
              '<p>The task is back in progress and flagged as priority. Keep filing ' +
              'daily reports while you address the feedback.</p>',
        accent: 'amber',
        cta: cta('Open my tasks')
      }));
    },

    strikeIssued: function (staff, info) {
      var last = info.suspended;
      return send(staff.Email,
        last ? 'ACCOUNT SUSPENDED — strike ' + info.strikeNumber + ' of ' + info.limit
             : 'Warning: strike ' + info.strikeNumber + ' of ' + info.limit,
        render({
          title: last ? 'Account suspended' : 'Strike ' + info.strikeNumber + ' of ' + info.limit,
          intro: 'Hello ' + staff.Name + ', a strike has been recorded on your account.',
          rows: [
            ['Strike', info.strikeNumber + ' of ' + info.limit],
            ['Reference', info.strikeId],
            ['Category', info.category],
            ['Reason', info.reason],
            ['Penalty applied', info.penaltyAmount > 0 ? Util.fmtMoney(info.penaltyAmount) : 'None']
          ],
          body: last
            ? '<p>You have reached the strike limit, so your account is now ' +
              '<strong>suspended</strong>. You can still sign in and view your record, ' +
              'but you cannot acknowledge tasks, file reports or sign attendance until ' +
              'an administrator clears you.</p>' +
              '<p>Clearance resets the active counter only — the strikes and this ' +
              'suspension remain permanently on your staff record.</p>'
            : '<p>You have <strong>' + (info.limit - info.strikeNumber) +
              ' warning(s) remaining</strong>. A third strike suspends the account.</p>',
          accent: last ? 'red' : 'amber',
          cta: cta('Open my portal')
        }));
    },

    strikeAdminAlert: function (staff, info) {
      return send(StaffService.adminEmails(),
        (info.suspended ? 'SUSPENSION: ' : 'Strike ' + info.strikeNumber + ': ') + staff.Name,
        render({
          title: info.suspended ? 'Staff suspended' : 'Strike issued',
          intro: staff.Name + ' (' + staff.StaffID + ') is now on strike ' +
                 info.strikeNumber + ' of ' + info.limit + '.',
          rows: [
            ['Staff', staff.Name + ' — ' + staff.Email],
            ['Strike', info.strikeNumber + ' of ' + info.limit],
            ['Reference', info.strikeId],
            ['Reason', info.reason]
          ],
          body: info.suspended
            ? '<p>The account has been suspended automatically and is blocked from new ' +
              'task assignment. Use <strong>Strikes &amp; Discipline → Clear record</strong> ' +
              'in the admin dashboard once the matter is resolved. A clearance note is ' +
              'mandatory and is stored permanently.</p>'
            : '<p>One more strike will trigger automatic suspension.</p>',
          accent: info.suspended ? 'red' : 'amber',
          cta: cta('Open admin dashboard')
        }));
    },

    strikesCleared: function (staff, strikeCount, suspensionCount, admin, note) {
      return send([staff.Email].concat(StaffService.adminEmails()),
        'Strike record cleared: ' + staff.Name, render({
          title: 'Strike record cleared',
          intro: strikeCount + ' active strike(s) cleared for ' + staff.Name + '.',
          rows: [
            ['Staff', staff.Name + ' (' + staff.StaffID + ')'],
            ['Strikes cleared', String(strikeCount)],
            ['Suspensions lifted', String(suspensionCount)],
            ['Cleared by', String(admin.Email)],
            ['Clearance note', String(note)]
          ],
          body: '<p>The account is active again and can be assigned new work.</p>' +
                '<p><strong>For the record:</strong> cleared strikes and lifted ' +
                'suspensions are never deleted. They remain visible in the Strikes and ' +
                'Suspensions history and in every period report.</p>',
          accent: 'green',
          cta: cta('Open portal')
        }));
    },

    manualSuspension: function (staff, reason, admin) {
      return send([staff.Email].concat(StaffService.adminEmails()),
        'Account suspended: ' + staff.Name, render({
          title: 'Account suspended',
          intro: staff.Name + ' has been suspended by ' + admin.Email + '.',
          rows: [['Staff', staff.Name + ' (' + staff.StaffID + ')'], ['Reason', String(reason)]],
          body: '<p>The account cannot act in the portal or receive new tasks until it ' +
                'is cleared. The suspension is recorded permanently.</p>',
          accent: 'red',
          cta: cta('Open portal')
        }));
    },

    attendanceReminder: function (staff) {
      return send(staff.Email, 'Reminder: sign your attendance', render({
        title: 'You have not signed in yet',
        intro: 'Hello ' + staff.Name + ', the attendance deadline is ' +
               CFG.get('AttendanceDeadline', '09:00') + ' today.',
        body: '<p>Open the portal and tap <strong>Sign Attendance</strong>. Signing after ' +
              'the deadline records a late arrival; no sign-in at all is recorded as ' +
              'absent by the end-of-day sweep.</p>',
        accent: 'amber',
        cta: cta('Sign attendance')
      }));
    },

    payslip: function (staff, payrollRow) {
      return send(staff.Email, 'Payment released — ' + payrollRow.PeriodLabel, render({
        title: 'Payment released',
        intro: 'Hello ' + staff.Name + ', your pay for ' + payrollRow.PeriodLabel +
               ' has been released.',
        rows: [
          ['Period', payrollRow.PeriodType + ' — ' + payrollRow.PeriodLabel],
          ['Tasks considered', String(payrollRow.TasksConsidered)],
          ['Gross allocated', Util.fmtMoney(payrollRow.GrossAllocated)],
          ['Earned on progress', Util.fmtMoney(payrollRow.ProgressEarned)],
          ['Penalties', Util.fmtMoney(payrollRow.Penalties)],
          ['Adjustments', Util.fmtMoney(payrollRow.Adjustments)],
          ['Net paid', Util.fmtMoney(payrollRow.NetPay)],
          ['Reference', String(payrollRow.Reference || '—')]
        ],
        body: '<p>Allocation pay is <em>amount allocated × validated completion ' +
              'percentage</em>. A full task-by-task breakdown is in your portal under ' +
              'Earnings.</p>',
        accent: 'green',
        cta: cta('View earnings')
      }));
    },

    /** Period report email — html comes from ReportService.toHtml(). */
    periodReport: function (recipients, subject, reportHtml, pdfUrl) {
      return send(recipients, subject, render({
        title: subject,
        intro: 'The report is reproduced below.' +
               (pdfUrl ? ' A PDF copy has been saved to Drive.' : ''),
        body: reportHtml,
        cta: pdfUrl ? { label: 'Open the PDF in Drive', url: pdfUrl } : cta('Open dashboard'),
        footnote: 'Generated automatically by the Staff Management System.'
      }));
    },

    documentUploaded: function (adminEmail, staff, record, task) {
      return send(adminEmail, 'Document uploaded: ' + record.FileName, render({
        title: 'New document uploaded',
        intro: staff.Name + ' uploaded a file' + (task ? ' for "' + task.Title + '"' : '') + '.',
        rows: [
          ['Staff', staff.Name + ' (' + staff.StaffID + ')'],
          ['File', record.FileName],
          ['Category', record.Category],
          ['Size', Math.round(Util.num(record.SizeBytes, 0) / 1024) + ' KB'],
          ['Task', task ? task.Title + ' (' + task.TaskID + ')' : '—']
        ],
        body: '<p><a href="' + record.DriveUrl + '">Open the file in Google Drive</a></p>',
        cta: cta('Open admin dashboard')
      }));
    }
  };
})();

/**
 * ============================================================================
 * NotificationService — in-app alerts shown in the Reminders card.
 * ============================================================================
 */
var NotificationService = {

  /** Create one notification. audience 'staff' targets a single staff member. */
  push: function (staffId, type, severity, title, message, link) {
    try {
      SheetDB.insert(SHEETS.NOTIFICATIONS, {
        NotificationID: SheetDB.nextId('NTF', SHEETS.NOTIFICATIONS, 'NotificationID', 6),
        StaffID: String(staffId || ''),
        Audience: staffId ? 'Staff' : 'Admin',
        Type: String(type || 'Info'),
        Severity: String(severity || 'info'),
        Title: String(title || ''),
        Message: String(message || ''),
        Link: String(link || ''),
        Read: false,
        CreatedAt: new Date()
      });
      return true;
    } catch (e) {
      Log.exception('NotificationService.push', e);
      return false;
    }
  },

  /** Broadcast to every admin. */
  pushAdmins: function (type, severity, title, message) {
    var count = 0;
    SheetDB.find(SHEETS.STAFF, function (s) {
      return Auth.isAdminRole(s.Role) && String(s.Status) === STAFF_STATUS.ACTIVE;
    }).forEach(function (s) {
      if (NotificationService.push(s.StaffID, type, severity, title, message)) count++;
    });
    return count;
  },

  listFor: function (staffId, limit) {
    return SheetDB.find(SHEETS.NOTIFICATIONS, function (n) {
      return String(n.StaffID) === String(staffId);
    }).sort(function (a, b) {
      return Util.toDate(b.CreatedAt) - Util.toDate(a.CreatedAt);
    }).slice(0, limit || 25).map(function (n) {
      return {
        id: String(n.NotificationID),
        type: String(n.Type),
        severity: String(n.Severity),
        title: String(n.Title),
        message: String(n.Message),
        link: String(n.Link || ''),
        read: Util.truthy(n.Read),
        createdAt: Util.fmtDateTime(n.CreatedAt),
        ago: agoLabel_(n.CreatedAt)
      };
    });
  },

  unreadCount: function (staffId) {
    return SheetDB.find(SHEETS.NOTIFICATIONS, function (n) {
      return String(n.StaffID) === String(staffId) && !Util.truthy(n.Read);
    }).length;
  },

  markRead: function (notificationId, staffId) {
    var row = SheetDB.findById(SHEETS.NOTIFICATIONS, 'NotificationID', notificationId);
    if (!row || String(row.StaffID) !== String(staffId)) return false;
    SheetDB.updateRowAt(SHEETS.NOTIFICATIONS, row.__row, { Read: true });
    return true;
  },

  markAllRead: function (staffId) {
    var n = 0;
    SheetDB.find(SHEETS.NOTIFICATIONS, function (r) {
      return String(r.StaffID) === String(staffId) && !Util.truthy(r.Read);
    }).forEach(function (r) {
      SheetDB.updateRowAt(SHEETS.NOTIFICATIONS, r.__row, { Read: true });
      n++;
    });
    return n;
  }
};

/** '3h ago' style relative label. */
function agoLabel_(value) {
  var d = Util.toDate(value);
  if (!d) return '';
  var mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  if (days < 7) return days + 'd ago';
  return Util.fmtDate(d);
}
