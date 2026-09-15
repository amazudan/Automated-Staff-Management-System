/**
 * ============================================================================
 * Email.gs — admin broadcast email (EmailService) and reusable templates
 * (EmailTemplateService, backed by the EmailTemplates sheet).
 * ============================================================================
 * Requirement 10: from the admin dashboard's Email tab an administrator can
 * compose a message and send it to a chosen audience — everyone, a department,
 * a role, or hand-picked individuals — and save the message as a template for
 * next time.
 *
 * Unlike the automated Notify.* mail (which the EmailNotificationsEnabled
 * master switch can silence), a broadcast here is a deliberate human action, so
 * it is sent directly via MailApp and is NOT gated by that switch. The branded
 * HTML shell is still shared with every other email through Notify.render().
 * ============================================================================
 */

var EmailService = (function () {

  /** Active staff rows that have a usable email address. */
  function activeWithEmail() {
    return StaffService.active().filter(function (s) {
      return Util.isEmail(String(s.Email));
    });
  }

  /** Case-insensitive de-dupe that keeps the first spelling seen. */
  function distinct(values) {
    var seen = {}, out = [];
    values.forEach(function (v) {
      var key = String(v || '').trim();
      if (key && !seen[key.toLowerCase()]) { seen[key.toLowerCase()] = true; out.push(key); }
    });
    return out;
  }

  /** Data the Email tab needs to build its audience pickers. */
  function audience() {
    var staff = activeWithEmail();
    return {
      total: staff.length,
      departments: distinct(staff.map(function (s) { return String(s.Department || ''); }))
        .sort(function (a, b) { return a.localeCompare(b); }),
      roles: distinct(staff.map(function (s) { return String(s.Role || ''); }))
        .sort(function (a, b) { return a.localeCompare(b); }),
      staff: staff.map(function (s) {
        return {
          staffId: String(s.StaffID),
          name: String(s.Name),
          email: String(s.Email),
          department: String(s.Department || ''),
          role: String(s.Role || '')
        };
      }).sort(function (a, b) { return a.name.localeCompare(b.name); })
    };
  }

  /**
   * Resolve a {scope, value} pair to the staff rows it targets.
   *   all        → every active staff member with an email
   *   department → value = department name
   *   role       → value = role name
   *   individual → value = array of StaffIDs
   */
  function resolve(scope, value) {
    var staff = activeWithEmail();
    switch (String(scope || 'all')) {
      case 'all':
        return staff;
      case 'department':
        var dept = String(value || '').trim().toLowerCase();
        return staff.filter(function (s) {
          return String(s.Department || '').trim().toLowerCase() === dept;
        });
      case 'role':
        var role = String(value || '').trim().toLowerCase();
        return staff.filter(function (s) {
          return String(s.Role || '').trim().toLowerCase() === role;
        });
      case 'individual':
        var ids = {};
        (Array.isArray(value) ? value : [value]).forEach(function (id) { ids[String(id)] = true; });
        return staff.filter(function (s) { return ids[String(s.StaffID)]; });
      default:
        throw new Error('Unknown recipient scope: ' + scope);
    }
  }

  function scopeLabel(scope, value) {
    switch (String(scope)) {
      case 'all': return 'all staff';
      case 'department': return 'department "' + value + '"';
      case 'role': return 'the "' + value + '" role';
      case 'individual':
        var n = Array.isArray(value) ? value.length : 1;
        return n + ' selected staff';
      default: return String(scope);
    }
  }

  /** Turn a plain-text textarea body into escaped HTML paragraphs. */
  function bodyToHtml(text) {
    return String(text).split(/\n{2,}/).map(function (para) {
      return '<p>' + Util.escapeHtml(para).replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  /**
   * Compose and send one broadcast.
   * @param {Object} payload {scope, value, subject, body, saveTemplate, templateName}
   * @param {Object} admin   the authenticated admin staff row
   */
  function send(payload, admin) {
    payload = payload || {};
    var subject = String(payload.subject || '').trim();
    var body = String(payload.body || '').trim();
    if (!subject) throw new Error('Enter a subject.');
    if (!body) throw new Error('Write a message before sending.');

    var recipients = resolve(payload.scope, payload.value);
    if (!recipients.length) {
      throw new Error('No active staff with an email address match that audience.');
    }

    var company = CFG.get('CompanyName', 'Staff Management');
    // Subject is sent exactly as typed — no "[Company]" prefix. The company name
    // still appears in the email footnote below.
    var fullSubject = subject;
    var bodyHtml = bodyToHtml(body);
    var portal = Notify.portalUrl();

    // Requirement: send through the designated address in Config.SenderEmail.
    // Notify.senderOptions() resolves it (From when Gmail allows it, Reply-To
    // otherwise) and falls back to the admin's own address when it is blank.
    var sender = Notify.senderOptions();
    var senderShown = sender.from || sender.replyTo || '';
    if (!senderShown && Util.isEmail(String(admin.Email))) {
      senderShown = String(admin.Email);
    }

    var sent = 0, failed = 0, failures = [], lastError = '';
    recipients.forEach(function (s) {
      // Rendering happens INSIDE the guard: a template problem must degrade one
      // message, never abort the whole broadcast.
      try {
        var firstName = String(s.Name || '').split(' ')[0] || 'there';
        var html = Notify.render({
          title: subject,
          intro: 'Hello ' + firstName + ',',
          body: bodyHtml,
          accent: 'navy',
          cta: portal ? { label: 'Open the staff portal', url: portal } : null,
          footnote: 'Sent by ' + String(admin.Name || admin.Email) + ' · ' + company
        });
        var opts = { to: String(s.Email), subject: fullSubject, htmlBody: html };
        if (!sender.from && !sender.replyTo && Util.isEmail(String(admin.Email))) {
          // No designated sender configured — let replies reach the sender.
          opts.replyTo = String(admin.Email);
        }
        Notify.deliver(opts);
        sent++;
      } catch (err) {
        failed++;
        lastError = String(err && err.message ? err.message : err);
        // Keep the reason with the address — the UI lists these back to the
        // administrator so a partial failure is never silent.
        failures.push({ email: String(s.Email), name: String(s.Name || ''), error: lastError });
        Log.exception('EmailService.send(' + s.Email + ')', err);
      }
    });

    // Every single message failed — that is an error, not a partial success.
    if (sent === 0 && failed > 0) {
      throw new Error('Nothing could be sent (' + failed + ' recipient(s)). ' + lastError);
    }

    // Optionally remember this message as a reusable template. A failure here
    // (e.g. the EmailTemplates sheet not created yet) must not undo a send that
    // has already gone out, so it is caught and surfaced softly.
    var savedTemplate = null, templateError = null;
    if (payload.saveTemplate && String(payload.templateName || '').trim()) {
      try {
        savedTemplate = EmailTemplateService.save(
          { name: payload.templateName, subject: subject, body: body }, admin);
      } catch (tplErr) {
        templateError = String(tplErr && tplErr.message ? tplErr.message : tplErr);
        Log.exception('EmailService.send/saveTemplate', tplErr);
      }
    }

    Log.info('Email', admin.Email + ' emailed ' + scopeLabel(payload.scope, payload.value) +
      ' — ' + sent + ' sent, ' + failed + ' failed', subject);

    return {
      sent: sent,
      failed: failed,
      failures: failures,
      recipients: recipients.length,
      sender: senderShown,
      audienceLabel: scopeLabel(payload.scope, payload.value),
      savedTemplate: savedTemplate,
      templateError: templateError
    };
  }

  return {
    audience: audience,
    resolve: resolve,
    send: send
  };
})();


/**
 * EmailTemplateService — CRUD over the EmailTemplates sheet. Templates are
 * shared by every administrator and persist across sessions.
 */
var EmailTemplateService = {

  list: function () {
    return SheetDB.readAll(SHEETS.EMAIL_TEMPLATES).map(function (t) {
      return {
        templateId: String(t.TemplateID),
        name: String(t.Name),
        subject: String(t.Subject || ''),
        body: String(t.Body || ''),
        createdBy: String(t.CreatedBy || ''),
        createdAt: Util.fmtDateTime(t.CreatedAt),
        updatedAt: Util.fmtDateTime(t.UpdatedAt)
      };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  },

  /**
   * Create a template, or update the existing one with the same id/name.
   * @param {Object} input {templateId?, name, subject, body}
   */
  save: function (input, admin) {
    input = input || {};
    var name = String(input.name || '').trim();
    var subject = String(input.subject || '').trim();
    var body = String(input.body || '').trim();
    if (!name) throw new Error('Give the template a name.');
    if (!subject && !body) throw new Error('A template needs a subject or a message.');

    var existing = null;
    if (input.templateId) {
      existing = SheetDB.findById(SHEETS.EMAIL_TEMPLATES, 'TemplateID', input.templateId);
    }
    if (!existing) {
      existing = SheetDB.findOne(SHEETS.EMAIL_TEMPLATES, function (t) {
        return String(t.Name).trim().toLowerCase() === name.toLowerCase();
      });
    }

    if (existing) {
      SheetDB.updateRowAt(SHEETS.EMAIL_TEMPLATES, existing.__row, {
        Name: name, Subject: subject, Body: body, UpdatedAt: new Date()
      });
      return { templateId: String(existing.TemplateID), name: name, updated: true };
    }

    var record = {
      TemplateID: SheetDB.nextId('TPL', SHEETS.EMAIL_TEMPLATES, 'TemplateID', 4),
      Name: name, Subject: subject, Body: body,
      CreatedBy: String(admin.Email || ''),
      CreatedAt: new Date(), UpdatedAt: new Date()
    };
    SheetDB.insert(SHEETS.EMAIL_TEMPLATES, record);
    return { templateId: record.TemplateID, name: name, updated: false };
  },

  remove: function (templateId) {
    var row = SheetDB.findById(SHEETS.EMAIL_TEMPLATES, 'TemplateID', templateId);
    if (!row) throw new Error('Template not found.');
    SheetDB.deleteRowAt(SHEETS.EMAIL_TEMPLATES, row.__row);
    return true;
  }
};
