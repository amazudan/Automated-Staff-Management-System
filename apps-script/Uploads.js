/**
 * ============================================================================
 * Uploads.gs — Google Drive document storage (requirement 5).
 * ============================================================================
 * Both dashboards expose an Upload button. Files are streamed from the browser
 * as base64, decoded here and written into Drive under a single root folder:
 *
 *   <DriveRootFolderName>/
 *     ├── Staff/<StaffID> - <Name>/            staff submissions
 *     │     └── Tasks/<TaskID> - <Title>/      task deliverables
 *     ├── Admin-Shared/                        policies, forms, payslips
 *     └── Reports/<PeriodType>/                generated PDF/CSV reports
 *
 * The script runs as the deployment owner, so every file lives in the owner's
 * Drive and the database spreadsheet never has to be shared with staff.
 *
 * SHARING (Config.DriveSharingMode)
 *   Explicit  (default) — the file is shared only with the uploader, the
 *                         admins, and whoever the Visibility says.
 *   LinkAnyone          — anyone with the link may view. Convenient, but treat
 *                         it as public: do not use it for payslips or IDs.
 *
 * VISIBILITY (per upload)
 *   Private     only the uploader and the admins.
 *   Individual  the uploader, the admins and the hand-picked staff listed in
 *               AudienceStaffIDs — how an admin sends a document (a payslip, a
 *               contract, a warning letter) to one person instead of everyone.
 *   Staff / All every active staff member.
 * ============================================================================
 */

var DriveService = {

  /** Root folder, created on first use and remembered in Config. */
  root: function () {
    var id = CFG.get('DriveRootFolderId', '');
    if (id) {
      try { return DriveApp.getFolderById(id); }
      catch (e) { Log.warn('Drive', 'DriveRootFolderId invalid, recreating', String(e)); }
    }
    var name = CFG.get('DriveRootFolderName', 'StaffMS-Uploads');
    var it = DriveApp.getFoldersByName(name);
    var folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
    CFG.set('DriveRootFolderId', folder.getId());
    return folder;
  },

  /** Get or create a direct child folder. */
  child: function (parent, name) {
    var safe = String(name).replace(/[\\/:*?"<>|]/g, '-').substring(0, 120);
    var it = parent.getFoldersByName(safe);
    return it.hasNext() ? it.next() : parent.createFolder(safe);
  },

  /** Nested get-or-create, e.g. path(root, ['Staff','STF-0001']). */
  path: function (parent, segments) {
    var current = parent;
    segments.forEach(function (s) { current = DriveService.child(current, s); });
    return current;
  },

  staffFolder: function (staff) {
    return this.path(this.root(), [
      'Staff', String(staff.StaffID) + ' - ' + String(staff.Name)
    ]);
  },

  taskFolder: function (staff, task) {
    return this.path(this.staffFolder(staff), [
      'Tasks', String(task.TaskID) + ' - ' + String(task.Title).substring(0, 60)
    ]);
  },

  adminFolder: function () {
    return this.child(this.root(), 'Admin-Shared');
  },

  reportFolder: function (periodType) {
    return this.path(this.root(), ['Reports', String(periodType || 'Ad-hoc')]);
  },

  /**
   * Apply the configured sharing policy to a file.
   * @param {File} file
   * @param {Object} o {uploaderEmail,
   *                    audience: 'private'|'admins'|'individual'|'staff'|'all',
   *                    emails: [] extra addresses for 'individual'}
   */
  applySharing: function (file, o) {
    o = o || {};
    var mode = CFG.get('DriveSharingMode', 'Explicit');

    if (mode === 'LinkAnyone') {
      try {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (e) { Log.warn('Drive', 'setSharing failed', String(e)); }
      return;
    }

    var viewers = [];
    if (o.uploaderEmail) viewers.push(o.uploaderEmail);
    StaffService.adminEmails().forEach(function (e) { viewers.push(e); });

    if (o.audience === 'staff' || o.audience === 'all') {
      StaffService.active().forEach(function (s) {
        if (Util.isEmail(s.Email)) viewers.push(String(s.Email));
      });
    }

    // Named recipients: the hand-picked audience of an Individual document, or
    // the owner of the task a file was attached to.
    (o.emails || []).forEach(function (e) { viewers.push(String(e)); });

    var seen = {};
    viewers.forEach(function (email) {
      var key = String(email).toLowerCase();
      if (!Util.isEmail(email) || seen[key]) return;
      seen[key] = true;
      try { file.addViewer(email); }
      catch (e) { Log.warn('Drive', 'addViewer failed for ' + email, String(e)); }
    });
  }
};

/**
 * ============================================================================
 * UploadService — the Uploads tab plus the Drive write.
 * ============================================================================
 */
var UploadService = {

  // 'General' covers the company-wide paperwork an administrator sends out from
  // the Documents tab (memos, forms, notices) as opposed to task deliverables.
  CATEGORIES: ['TaskDeliverable', 'DailyReport', 'General', 'Policy', 'Payslip', 'Evidence', 'Other'],

  VISIBILITIES: ['Private', 'Individual', 'Staff', 'All'],

  /**
   * Normalise an incoming or stored audience into a clean array of StaffIDs.
   * Accepts an array from the browser or the comma-separated string kept in the
   * AudienceStaffIDs column.
   */
  audienceIds: function (value) {
    var raw = Array.isArray(value)
      ? value
      : String(value === null || value === undefined ? '' : value).split(/[,;]+/);
    var seen = {}, out = [];
    raw.forEach(function (v) {
      var id = String(v || '').trim();
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push(id);
    });
    return out;
  },

  /**
   * Store one file.
   * @param {Object} payload {fileName, mimeType, dataBase64, category, taskId,
   *                          description, visibility, audienceStaffIds}
   * @param {Object} staff   the uploading Staff row
   */
  upload: function (payload, staff) {
    var fileName = String(payload.fileName || '').trim();
    if (!fileName) throw new Error('No file name supplied.');
    var b64 = String(payload.dataBase64 || '');
    if (!b64) throw new Error('The file is empty or could not be read.');

    // --- validation -------------------------------------------------------
    var maxBytes = CFG.num('MaxUploadMB', 25) * 1024 * 1024;
    var approxBytes = Math.floor(b64.length * 3 / 4);
    if (approxBytes > maxBytes) {
      throw new Error('"' + fileName + '" is ' + (approxBytes / 1048576).toFixed(1) +
        ' MB. The limit is ' + CFG.num('MaxUploadMB', 25) + ' MB.');
    }
    var allowed = CFG.list('AllowedUploadExtensions');
    if (allowed.length) {
      var ext = (fileName.split('.').pop() || '').toLowerCase();
      if (allowed.map(function (a) { return a.toLowerCase(); }).indexOf(ext) === -1) {
        throw new Error('".' + ext + '" files are not allowed. Permitted types: ' + allowed.join(', ') + '.');
      }
    }

    var category = this.CATEGORIES.indexOf(String(payload.category)) !== -1
      ? String(payload.category)
      : (Auth.isAdminRole(staff.Role) ? 'Policy' : 'TaskDeliverable');

    var isAdmin = Auth.isAdminRole(staff.Role);
    var requested = String(payload.visibility || (isAdmin ? 'Staff' : 'Private'));
    var visibility = UploadService.VISIBILITIES.indexOf(requested) !== -1
      ? requested
      : (isAdmin ? 'Staff' : 'Private');

    // Requirement 6 — a general document can be addressed to hand-picked staff
    // instead of the whole workforce.
    var audience = [], audienceStaff = [];
    if (visibility === 'Individual') {
      audience = UploadService.audienceIds(payload.audienceStaffIds || payload.audience);
      audienceStaff = audience.map(function (id) {
        var target = StaffService.byId(id);
        if (!target) throw new Error('Staff member ' + id + ' was not found.');
        return target;
      });
      if (!audienceStaff.length) {
        throw new Error('Choose at least one staff member to send this document to.');
      }
    }

    // --- destination ------------------------------------------------------
    var task = payload.taskId ? TaskService.byId(payload.taskId) : null;
    if (payload.taskId && !task) throw new Error('The task this file belongs to was not found.');
    if (task && !isAdmin && String(task.AssignedTo) !== String(staff.StaffID)) {
      throw new Error('You can only attach files to your own tasks.');
    }

    var taskOwner = task ? (StaffService.byId(task.AssignedTo) || staff) : null;

    var folder;
    if (task) {
      folder = DriveService.taskFolder(taskOwner, task);
    } else if (visibility === 'Individual' && audienceStaff.length === 1) {
      // One named recipient — file it in their own Drive folder so it is easy
      // to find outside the app too.
      folder = DriveService.staffFolder(audienceStaff[0]);
    } else if (isAdmin && visibility !== 'Private') {
      folder = DriveService.adminFolder();
    } else {
      folder = DriveService.staffFolder(staff);
    }

    // --- write ------------------------------------------------------------
    var bytes = Utilities.base64Decode(b64);
    var blob = Utilities.newBlob(bytes, payload.mimeType || 'application/octet-stream', fileName);
    var stamped = Utilities.formatDate(new Date(), getTz(), 'yyyyMMdd-HHmmss') + ' ' + fileName;
    var file = folder.createFile(blob.setName(stamped));

    // Named viewers: the chosen audience, plus the owner of the task when an
    // admin attaches a brief or a sample to somebody else's task.
    var namedEmails = audienceStaff.map(function (s) { return String(s.Email); });
    if (taskOwner && Util.isEmail(taskOwner.Email)) namedEmails.push(String(taskOwner.Email));

    DriveService.applySharing(file, {
      uploaderEmail: String(staff.Email),
      audience: visibility === 'All' ? 'all'
              : (visibility === 'Staff' ? 'staff'
              : (visibility === 'Individual' ? 'individual' : 'private')),
      emails: namedEmails
    });

    var record = {
      UploadID: SheetDB.nextId('UPL', SHEETS.UPLOADS, 'UploadID', 6),
      StaffID: String(staff.StaffID),
      UploaderEmail: String(staff.Email),
      UploaderRole: String(staff.Role),
      TaskID: task ? String(task.TaskID) : '',
      FileName: stamped,
      MimeType: file.getMimeType(),
      SizeBytes: file.getSize(),
      DriveFileID: file.getId(),
      DriveUrl: file.getUrl(),
      Category: category,
      Visibility: visibility,
      AudienceStaffIDs: audience.join(','),
      Description: String(payload.description || '').trim(),
      UploadedAt: new Date(),
      Status: 'Active'
    };
    SheetDB.insert(SHEETS.UPLOADS, record);

    // Keep the latest attachment handy on the task row.
    if (task) {
      SheetDB.updateRowAt(SHEETS.TASKS, task.__row, {
        AttachmentUrl: file.getUrl(), LastUpdated: new Date()
      });
      if (!isAdmin) {
        StaffService.adminEmails().forEach(function (email) {
          try { Notify.documentUploaded(email, staff, record, task); }
          catch (e) { Log.exception('Uploads.upload/notify', e); }
        });
      } else if (taskOwner && String(taskOwner.StaffID) !== String(staff.StaffID)) {
        NotificationService.push(taskOwner.StaffID, 'DocumentShared', 'info',
          'File added to "' + String(task.Title) + '"',
          stamped + ' was attached by ' + String(staff.Name) + '. Open the task to view it.',
          '');
      }
    }

    // An admin sharing to staff should be visible in their portal immediately.
    if (isAdmin && !task && (visibility === 'Staff' || visibility === 'All')) {
      StaffService.active().forEach(function (s) {
        if (String(s.StaffID) === String(staff.StaffID)) return;
        NotificationService.push(s.StaffID, 'DocumentShared', 'info',
          'New document: ' + fileName,
          String(payload.description || 'Shared by ' + staff.Name) + ' — open it from Documents.');
      });
    }

    // Individual: tell only the people it was addressed to.
    if (visibility === 'Individual') {
      audienceStaff.forEach(function (s) {
        if (String(s.StaffID) === String(staff.StaffID)) return;
        NotificationService.push(s.StaffID, 'DocumentShared', 'info',
          'A document was sent to you: ' + fileName,
          String(payload.description || 'Sent by ' + staff.Name) + ' — open it from Documents.');
      });
    }

    Log.info('Uploads', 'Stored ' + record.UploadID + ' (' + stamped + ') by ' +
      staff.StaffID + ' [' + visibility +
      (audience.length ? ' → ' + audience.join(', ') : '') + ']', file.getUrl());

    return {
      uploadId: record.UploadID,
      fileName: stamped,
      url: file.getUrl(),
      sizeBytes: record.SizeBytes,
      category: category,
      visibility: visibility,
      audienceStaffIds: audience,
      taskId: task ? String(task.TaskID) : ''
    };
  },

  /**
   * Documents the caller may see. Admins see everything. A staff member sees
   * their own uploads, anything attached to a task assigned to them, anything
   * shared with all staff, and anything addressed to them individually — and
   * nothing else.
   */
  listFor: function (staff, filters) {
    filters = filters || {};
    var isAdmin = Auth.isAdminRole(staff.Role);
    var myId = String(staff.StaffID);

    // Tasks assigned to this staff member, so admin attachments on their work
    // reach them without being shared with everybody.
    var myTaskIds = {};
    if (!isAdmin) {
      try {
        SheetDB.find(SHEETS.TASKS, function (t) {
          return String(t.AssignedTo) === myId;
        }).forEach(function (t) { myTaskIds[String(t.TaskID)] = true; });
      } catch (e) { Log.exception('Uploads.listFor/tasks', e); }
    }

    return SheetDB.find(SHEETS.UPLOADS, function (u) {
      if (String(u.Status) !== 'Active') return false;
      if (filters.taskId && String(u.TaskID) !== String(filters.taskId)) return false;
      if (filters.category && String(u.Category) !== String(filters.category)) return false;
      if (filters.staffId && String(u.StaffID) !== String(filters.staffId)) return false;
      if (isAdmin) return true;
      if (String(u.StaffID) === myId) return true;
      if (u.TaskID && myTaskIds[String(u.TaskID)]) return true;
      var visibility = String(u.Visibility);
      if (visibility === 'Staff' || visibility === 'All') return true;
      if (visibility === 'Individual') {
        return UploadService.audienceIds(u.AudienceStaffIDs).indexOf(myId) !== -1;
      }
      return false;
    }).map(function (u) {
      var audience = UploadService.audienceIds(u.AudienceStaffIDs);
      return {
        uploadId: String(u.UploadID),
        staffId: String(u.StaffID),
        uploaderEmail: String(u.UploaderEmail),
        uploaderRole: String(u.UploaderRole),
        staffName: StaffService.name(u.StaffID),
        taskId: String(u.TaskID || ''),
        fileName: String(u.FileName),
        mimeType: String(u.MimeType),
        sizeKb: Math.round(Util.num(u.SizeBytes, 0) / 1024),
        url: String(u.DriveUrl),
        category: String(u.Category),
        visibility: String(u.Visibility),
        audienceStaffIds: audience,
        audienceNames: audience.map(function (id) { return StaffService.name(id); }),
        description: String(u.Description || ''),
        uploadedAt: Util.fmtDateTime(u.UploadedAt),
        uploadedAtKey: Util.dateKey(u.UploadedAt)
      };
    }).sort(function (a, b) {
      return String(b.uploadedAt).localeCompare(String(a.uploadedAt));
    });
  },

  /**
   * Remove a document. The Uploads row is marked Deleted (audit trail kept)
   * and the Drive file is moved to the trash.
   */
  remove: function (uploadId, staff) {
    var row = SheetDB.findById(SHEETS.UPLOADS, 'UploadID', uploadId);
    if (!row) throw new Error('Document not found.');
    var isAdmin = Auth.isAdminRole(staff.Role);
    if (!isAdmin && String(row.StaffID) !== String(staff.StaffID)) {
      throw new Error('You can only remove your own uploads.');
    }
    try {
      DriveApp.getFileById(String(row.DriveFileID)).setTrashed(true);
    } catch (e) {
      Log.warn('Uploads', 'Drive file already gone for ' + uploadId, String(e));
    }
    SheetDB.updateRowAt(SHEETS.UPLOADS, row.__row, {
      Status: 'Deleted',
      Description: String(row.Description || '') + ' [deleted by ' + staff.Email +
                   ' on ' + Util.fmtDateTime(new Date()) + ']'
    });
    Log.info('Uploads', 'Deleted ' + uploadId + ' by ' + staff.StaffID);
    return true;
  },

  /** Storage figures for the dashboard. */
  stats: function () {
    var rows = SheetDB.find(SHEETS.UPLOADS, function (u) {
      return String(u.Status) === 'Active';
    });
    var bytes = rows.reduce(function (s, u) { return s + Util.num(u.SizeBytes, 0); }, 0);
    var thisMonth = Util.resolvePeriod('Monthly', Util.today());
    return {
      files: rows.length,
      totalMb: Math.round(bytes / 1048576 * 10) / 10,
      thisMonth: rows.filter(function (u) {
        return Util.inPeriod(u.UploadedAt, thisMonth);
      }).length,
      rootFolderId: CFG.get('DriveRootFolderId', '')
    };
  }
};
