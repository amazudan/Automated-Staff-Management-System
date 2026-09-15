# Staff Task, Attendance & Payroll Management System

A complete staff-operations back office built entirely on **Google Apps Script** with
**Google Sheets as the database** and an **HtmlService web app** as the frontend. It runs
assignments, daily reporting, attendance, discipline (strikes/suspension), progress-based
allocation pay, document uploads to Google Drive, and period reporting — all from a single
bound Apps Script project. No external server, no external database.

> **New here?** Read this file for the structure, then follow **[SETUP.md](SETUP.md)** to
> stand it up, and **[DECISIONS.md](DECISIONS.md)** for why each design choice was made.

---

## 1. What it does (mapped to requirements)

| # | Requirement | Where it lives |
|---|-------------|----------------|
| 1 | Daily tasks roll over to the next working day as a **priority** task with a **warning**, repeating until completion or the 3rd strike (suspension). | `Tasks.gs` (`processDailyRollover`), Config `Rollover*` keys |
| 2 | The 3rd-strike penalty is **suspension**; it can be cleared manually, but the record **permanently** shows the staff was struck/suspended. | `Strikes.gs`, `Staff` columns `TotalStrikesIssued`/`SuspensionCount`, `Strikes`/`Suspensions` sheets (rows are cleared, never deleted) |
| 3 | Dashboard shows staff who **completed** tasks, are **pending — yet to validate**, and are **in progress**. | `TASK_BUCKETS` in `Config.gs`, admin/staff dashboards |
| 4 | **Daily, weekly, monthly, quarterly, half-yearly and yearly** reports with full task/allocation/attendance/strike detail. | `Reports.gs`, `PeriodReports` sheet, `PERIOD_TYPES` |
| 5 | Both admin and staff dashboards have an **upload button** that stores files in **Google Drive**. | `Uploads.gs`, `Uploads` sheet, `App.openUpload()` in `Scripts.html` |
| 6 | Allocation pay is calculated by **percentage of completion progress**. | `Payroll.gs` (`payable = AmountAllocated × effectiveProgress/100`) |

Two confirmed decisions shape the behaviour (full rationale in **[DECISIONS.md](DECISIONS.md)**):

- **Pay basis = admin-validated progress.** Staff *report* a progress %, an admin *validates*
  it, and only the validated figure pays. Config key `PayProgressSource = AdminValidated`.
- **Login = Hybrid (Google + PIN).** Google SSO signs in automatically when recognised;
  everyone else uses email + PIN. The spreadsheet stays **private to the owner** and the web
  app executes **as the owner**. Config key `AuthMode = Hybrid`.

---

## 2. Architecture at a glance

```
Browser (one HtmlService page)
   │  google.script.run  ──►  { ok, data, error, authRequired } envelope
   ▼
WebApp.gs   ── api_* endpoints, withApi_/withPublic_ wrappers, session tokens
   │
   ├─ Auth.gs         hybrid login, PIN hashing, session cache, publicProfile
   ├─ Tasks.gs        task lifecycle, rollover, validation, progress
   ├─ Attendance.gs   sign-in / sign-out, late/absent sweeps
   ├─ Strikes.gs      strikes, suspension, manual clearance (permanent record)
   ├─ Payroll.gs      progress-based pay, periods, payslip lines
   ├─ Reports.gs      Daily→Yearly rollups, strength/weakness remarks
   ├─ Uploads.gs      Google Drive storage + Uploads ledger
   ├─ Notifications.gs HtmlService-templated email + in-app notices
   ├─ Staff.gs        staff CRUD, status, clearance
   ├─ Triggers.gs     5+ time-driven automations
   ├─ Setup.gs        one-time installer / repairer + spreadsheet menu
   └─ Config.gs · SheetDB.gs · Util.gs   (schema, generic sheet I/O, helpers)
   ▼
Google Sheet (13 tabs)  ── the database
Google Drive folder     ── uploaded documents
```

Every server call returns a uniform envelope so the client never has to guess:

```js
{ ok: true,  data: <payload> }
{ ok: false, error: "message", authRequired: true|false }
```

`withApi_` requires a valid session token (authenticated endpoints); `withPublic_` does not
(`api_bootstrap`, `api_login`). All writes are wrapped in `LockService` so a manual action and
a scheduled trigger can never corrupt the same row.

---

## 3. Server files (`.gs`)

All files live in `apps-script/`. They are plain V8 Apps Script; file order does not matter
because Apps Script loads every `.gs` into one global scope.

| File | Responsibility |
|------|----------------|
| **Config.gs** | Single source of truth: `SHEETS` (tab names), `SCHEMA` (every header row), controlled vocabularies (`TASK_STATUS`, `TASK_BUCKETS`, `ATTENDANCE_STATUS`, `PERIOD_TYPES`, …), `DEFAULT_CONFIG` (every tunable with a default + description), and the `CFG` accessor (`get/num/bool/list/all/set`). No magic strings or numbers live anywhere else. |
| **SheetDB.gs** | Generic, header-name-based sheet access (`readAll`, `find`, `insert`, `update`, `remove`). Columns are addressed by **name**, never by index, so re-ordering columns can't break the app. |
| **Util.gs** | Cross-cutting helpers: id generation, date/period maths, timezone-aware formatting, `Log` (writes to the hidden `Logs` sheet), money rounding, safe parsing. |
| **Auth.gs** | Hybrid authentication: Google SSO resolution, salted **SHA-256** PIN hashing/verification, opaque session tokens in `CacheService`, `publicProfile` (the safe user object sent to the browser). |
| **Staff.gs** | Staff records: create/update, status changes, PIN reset, manual strike clearance. Enforces the "permanent record" rule. |
| **Tasks.gs** | The task engine: create/assign, acknowledge, report progress, submit, **validate/reject**, daily reports, and `processDailyRollover` (roll incomplete daily tasks forward, escalate priority, issue warnings/strikes). |
| **Attendance.gs** | Sign-in / sign-out, on-time/late calculation against `AttendanceDeadline` + grace, and the absentee sweep. |
| **Strikes.gs** | Strike issuance (idempotent per staff+category+task+date), suspension at `StrikeLimit`, and clearance that resets *active* strikes while retaining lifetime counters. |
| **Payroll.gs** | Progress-based pay: `compute`, `listPeriod`, `historyFor`. Only **validated** progress pays; produces per-task payslip lines and organisation summaries. |
| **Reports.gs** | Period reports for Daily/Weekly/Monthly/Quarterly/HalfYearly/Yearly with rule-based **strengths/weaknesses/remark** text; writes rollups to `PeriodReports`. |
| **Uploads.gs** | Google Drive storage: auto-creates the root folder, enforces size/extension limits, records every file in the `Uploads` ledger, handles visibility/sharing. |
| **Notifications.gs** | Outbound email rendered through `EmailTemplate.html` (`Notify.render`) plus in-app notices in the `Notifications` sheet. Master switch `EmailNotificationsEnabled`. |
| **Triggers.gs** | The automation plan (`triggerPlan_`) and `installAllTriggers` / `removeAllTriggers` / `listInstalledTriggers`. Hours come from Config, never hard-coded. |
| **Setup.gs** | `setupSystem()` — the idempotent installer/repairer that builds every tab from `SCHEMA`, seeds `DEFAULT_CONFIG`, registers the script owner as the first Admin (with a generated PIN), hides `Logs`, and seeds holidays. Also `seedDemoData()` and the `onOpen()` **Staff MS** menu. |
| **WebApp.gs** | `doGet` (serves the single page), `include()` (HTML partials), the `withApi_`/`withPublic_` wrappers, and all `api_*` endpoints the browser calls. |

**`appsscript.json`** — the manifest: `timeZone: Africa/Lagos`, `runtimeVersion: V8`,
web-app `executeAs: USER_DEPLOYING` (run as the owner) + `access: ANYONE` (so staff can reach
the PIN form), and the six OAuth scopes (Sheets, Drive, ScriptApp, Send Mail, userinfo.email,
container UI).

---

## 4. Frontend files (`.html`)

The whole UI is one page assembled by `Index.html`. Understanding **how HtmlService loads these
files** is essential to editing them safely:

- `Index.html` is a **top-level template** (`createTemplateFromFile(...).evaluate()`), so its
  scriptlets run. It `include()`s the UI partials **in order**: **Styles → Login →
  AdminDashboard → StaffPortal → Scripts**.
- `include()` **injects raw text without evaluating scriptlets.** So `Login.html`,
  `AdminDashboard.html`, `StaffPortal.html`, `Scripts.html` and `Styles.html` are **not**
  templates — they are raw `<script>`/`<style>` blocks. They must contain **no** `<? ?>`
  scriptlets and **no** literal `</script>`.
- Because Scripts.html is included **last**, `window.UI` and `window.App` (defined there) do
  **not** exist while the AdminDashboard/StaffPortal IIFEs first run. Those modules therefore
  reference `UI.*`/`App.*` **only inside functions called after login**, and every local
  helper is a hoisted `function` declaration — never `const esc = UI.esc` at module top level.
- **`EmailTemplate.html` is the exception**: it is rendered on its own with
  `createTemplateFromFile(...).evaluate()`, so its scriptlets **do** run.

| File | Role |
|------|------|
| **Index.html** | The page shell + include order. The only file served by `doGet`. |
| **Styles.html** | All CSS (the green "Donezo-style" dashboard theme) for admin and staff. |
| **Login.html** | `window.LoginUI` — the pre-auth screen: Google "continue as…", email + PIN form, and the "setup needed / not on the team" states. |
| **Scripts.html** | `window.App` + `window.UI` — the client core: bootstrap, the `google.script.run` envelope wrapper, routing, toasts, the upload dialog (`App.openUpload`), period helpers, badges, logout. Dispatches to the right dashboard via `App.activeUI()`. |
| **AdminDashboard.html** | `window.AdminUI` — admin views: dashboard (KPIs, three task buckets, analytics), tasks, validation, staff, attendance, discipline, payroll, reports (org + per-staff), documents, settings (Config editor, triggers, automation, logs). |
| **StaffPortal.html** | `window.StaffUI` — staff views: dashboard, my tasks, daily report, attendance (sign in/out), earnings, documents, my reports, profile (change PIN, logout). |
| **EmailTemplate.html** | The single, email-client-safe (table-based, inline-styled) template behind every outbound email. Consumes `{company, title, intro, rows, body, cta, accent, footnote, year}`. |

---

## 5. The database — 13 Google Sheet tabs

`Setup.gs` builds each tab from `SCHEMA` in `Config.gs`. Columns are accessed by **name**, so
you can safely add trailing columns; `setupSystem()` appends any missing header without touching
data.

| Sheet | Purpose | Key columns |
|-------|---------|-------------|
| **Staff** | The people. Identity, role, status, discipline counters, PIN credentials. | `StaffID, Name, Email, Role, Status, StrikeCount, FlaggedStatus, SuspendedAt, SuspensionCount, TotalStrikesIssued, ClearedAt/By/Note, PinHash, PinSalt, LastLogin, PhotoUrl` |
| **Tasks** | Every task and its full lifecycle, allocation and pay. | `TaskID, Title, TaskType, Priority, AssignedTo, AmountAllocated, Status, ReportedProgress, ValidatedProgress, PayableAmount, MetricScore, AdminRating, RolloverCount, WarningsIssued, IsPriority, ParentTaskID, OriginalDueDate, DueDate` |
| **DailyTaskReports** | Daily progress reports staff file against tasks. | `ReportID, TaskID, StaffID, ReportDate, ReportText, ProgressPercent, HoursSpent, Blockers, OnTime, ReviewStatus, ReviewedBy` |
| **Attendance** | One row per staff per day. | `AttendanceID, StaffID, Date, LoginTime, LogoutTime, Status (OnTime/Late/Absent/Leave/Holiday), MinutesLate` |
| **Strikes** | The discipline ledger. Rows are **cleared, never deleted**. | `StrikeID, StaffID, Date, TaskID, Category, Reason, StrikeNumber, PenaltyApplied, Status, ClearedAt/By/Note` |
| **Suspensions** | A permanent record of every suspension event. | `SuspensionID, StaffID, StartDate, Reason, TriggerStrikeID, Status, LiftedAt/By, ClearanceNote` |
| **PeriodReports** | Generated Daily→Yearly rollups per staff. | `PeriodType, PeriodLabel, WorkingDays, DaysPresent/Late/Absent, TasksAssigned/Completed/…, CompletionRate, AvgMetricScore, StrikesIssued, GrossAllocated, NetPayable, Strengths, Weaknesses, Remark` |
| **Payroll** | Draft/approved/paid pay runs per staff per period. | `PayrollID, StaffID, PeriodType, PeriodLabel, GrossAllocated, ProgressEarned, Penalties, Adjustments, NetPay, Status, ApprovedBy, PaidAt` |
| **Uploads** | The Google Drive document ledger. | `UploadID, StaffID, UploaderEmail/Role, TaskID, FileName, MimeType, SizeBytes, DriveFileID, DriveUrl, Category, Visibility, Status` |
| **Notifications** | In-app notices (bell/badge). | `NotificationID, StaffID, Audience, Type, Severity, Title, Message, Link, Read` |
| **Holidays** | Non-working days used by attendance/period maths. | `Date, Name, Recurring` |
| **Config** | Every tunable setting, grouped by `Category`. Edited in-sheet or from admin Settings. | `Key, Value, Category, Description` |
| **Logs** | Hidden. Every `try/catch` writes here. | `Timestamp, Level, Source, Message, Details, User` |

### Task lifecycle & the three buckets

```
Scheduled ─(activate)─► Assigned ─(ack)─► Acknowledged ─► InProgress
                                                            │ (submit)
                                                            ▼
                                                   PendingValidation
                                                     │(validate)  │(reject)
                                                     ▼            ▼
                                                  Completed     InProgress
   any overdue path ─► Failed        admin ─► Cancelled
```

The dashboard rolls these up into three headline buckets (`TASK_BUCKETS` in `Config.gs`):

- **Completed** → `Completed`
- **Pending — yet to validate** → `PendingValidation`
- **In progress** → `Assigned`, `Acknowledged`, `InProgress`

> **Naming note:** the master prompt called a freshly assigned task "Pending". The dashboard
> needs "Pending" to mean *submitted, awaiting validation*, so the code uses **`Assigned`** for
> "live, not yet acknowledged" and **`PendingValidation`** for "submitted, awaiting admin". See
> the comment in `Config.gs` and **[DECISIONS.md](DECISIONS.md)**.

---

## 6. Automation (time-driven triggers)

Installed by `installAllTriggers()` (or **Staff MS → Install automation triggers**). Hours are
Config keys, evaluated in the configured timezone:

| Time | Function | What it does |
|------|----------|--------------|
| 06:00 | `activateScheduledTasks` | Scheduled → Assigned when the start date arrives |
| 08:00 | `sendAttendanceReminder` | Nudge staff who haven't signed in |
| 19:00 | `checkDailyReports` | Strike staff who filed no daily report |
| 21:00 | `sweepAttendance` | Mark non-signers Absent |
| 22:00 | `processDailyRollover` | Roll incomplete daily tasks forward, escalate priority, warn/strike |
| 02:00 Mon | `generateWeeklyReports` | Weekly report for the week just ended |
| 02:00 1st | `generateMonthlyReports` | Monthly reports, period rollups and draft payroll |

Each entry point is wrapped in `try/catch`, is idempotent (duplicate strikes for the same
staff+category+task+date are suppressed), and is guarded by `LockService`.

---

## 7. Where to go next

- **[SETUP.md](SETUP.md)** — stand the system up from scratch (add files, run `setupSystem()`,
  deploy the web app, install triggers).
- **[DECISIONS.md](DECISIONS.md)** — the reasoning behind pay basis, auth, the permanent
  discipline record, status naming, and web-app access.
