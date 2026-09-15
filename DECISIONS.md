# Design Decisions

Why the system is built the way it is. Each decision lists the context, the options considered,
what was chosen, and where it lives in the code/config so you can change it if your policy
differs.

Two of these (pay basis, login model) were confirmed directly with the requester; the rest
resolve ambiguities in the brief in favour of correctness and auditability.

---

## 1. Pay basis — allocation pay follows **admin-validated** progress

**Context.** Requirement 6: "allocation pay should be calculated by percentage of completion
progress." The open question was *whose* percentage — the staff member's self-reported progress,
or a figure an admin has verified.

**Options.**
- *Reported progress* — pay the % staff enter. Fast, but self-graded and gameable.
- *Admin-validated progress* — staff report a %, an admin validates it, only the validated % pays.

**Decision: admin-validated progress.** Staff report progress and submit; an admin validates
(or rejects) before it counts toward pay.

**Why.** Pay is money. A self-reported number with no check invites inflation and disputes;
validation gives a defensible audit trail (who validated, when, at what %). It also gives the
"pending — yet to validate" bucket real meaning (Decision 4).

**Where.**
- Config `PayProgressSource = AdminValidated` (alternative: `ReportedProgress`).
- `Payroll.gs`: `payable = AmountAllocated × effectiveProgress / 100`, where `effectiveProgress`
  comes from `ValidatedProgress`. Unvalidated work is surfaced as *held pending validation*, not
  paid.
- `Tasks` columns `ReportedProgress` vs `ValidatedProgress`; `ValidatedBy`/`ValidatedAt` record
  the audit trail.

---

## 2. Login model — **Hybrid (Google + PIN)**, private sheet, run as owner

**Context.** Staff need to sign in from anywhere, but the spreadsheet holds pay and discipline
data and must not be shared with them.

**Options.**
- *Google only* — clean, but fails for staff without a matching Google identity and leaks less
  reliably through "execute as owner".
- *PIN only* — works for everyone, but no SSO convenience for the owner/Workspace users.
- *Hybrid* — Google SSO when it's available, email + PIN otherwise.

**Decision: Hybrid.** Auto sign-in via Google when the address is recognised; email + salted PIN
for everyone else. The spreadsheet stays **private (owner only)** and the web app **executes as
the owner**.

**Why.** One URL works for the whole team regardless of their Google setup; the owner and
same-domain users get frictionless SSO; nobody needs edit access to the database. Because the app
runs as the owner, visitors only ever receive what an `api_*` endpoint returns after
authenticating them.

**Where.**
- Config `AuthMode = Hybrid` (alternatives `GoogleOnly`, `PinOnly`).
- `Auth.gs`: Google resolution + **salted SHA-256** PIN hashing (`PinHash`/`PinSalt`), opaque
  session tokens in `CacheService` (`SessionTimeoutMinutes`).
- `appsscript.json`: `executeAs: USER_DEPLOYING` (owner) + `access: ANYONE`.
- **Trade-off documented:** with "execute as owner" + "anyone" access, Google often won't reveal a
  visitor's email to the script, so most staff use the PIN path. That's expected — see
  [SETUP.md](SETUP.md) → *Hybrid auth — what to expect*.

---

## 3. Web-app access = **Anyone**, execution = **owner**

**Context.** "Who has access" on the deployment could be *Only myself*, *Anyone with Google
account*, or *Anyone*. The sheet must remain private.

**Decision: Execute as *Me (owner)*, access *Anyone*.**

**Why.** *Execute as owner* is what keeps the database private — every read/write happens under
the owner's identity, so staff never get direct sheet access. *Access: Anyone* is required so a
staff member (who is **not** a sheet collaborator) can even load the login page and post their
PIN. Security is enforced in-app by Decision 2, not by Google's sharing dialog. Restricting
access to "Anyone with a Google account" would block PIN-only staff.

**Where.** `appsscript.json` web-app block; reinforced in [SETUP.md](SETUP.md) Step 7.

---

## 4. Task status naming — **`Assigned`** vs **`PendingValidation`**

**Context.** Requirement 3 wants a dashboard bucket for tasks that are *submitted but not yet
validated* and calls it "pending". The brief also used "Pending" for a *freshly assigned* task.
One word, two meanings.

**Decision.** Split them explicitly:
- **`Assigned`** = live, not yet acknowledged (the brief's "pending" assignment).
- **`PendingValidation`** = staff submitted, admin hasn't validated.

The dashboard's three headline buckets (`TASK_BUCKETS`) are then unambiguous:

| Bucket | Statuses |
|--------|----------|
| Completed | `Completed` |
| Pending — yet to validate | `PendingValidation` |
| In progress | `Assigned`, `Acknowledged`, `InProgress` |

**Why.** Requirement 3 and the pay model (Decision 1) both hinge on "pending = awaiting
validation." Overloading one label would make the dashboard and payroll ambiguous.

**Where.** `TASK_STATUS`, `TASK_BUCKETS`, `TASK_OPEN_STATUSES` in `Config.gs` (with an explicit
code comment); consumed by both dashboards and `Reports.gs`.

---

## 5. Daily-task rollover — priority + warning, until completion or the 3rd strike

**Context.** Requirement 1: an incomplete daily task rolls to the next day as a **priority** task
with a **warning**, repeating "until completion or 3rd strike which flags a suspension."

**Decision.** Nightly, `processDailyRollover` moves each incomplete **Daily** task to the next
working day, **escalates its priority** one rung (Normal→High→Critical), issues a **warning**,
and records a **strike**. On the strike that reaches `StrikeLimit` (default 3) the staff member is
**suspended** and the task is marked **Failed**.

**Why.** This turns the requirement into deterministic, idempotent automation with a hard stop, so
a neglected task can't roll forever and the penalty escalates exactly as described.

**Where.**
- `Tasks.gs: processDailyRollover` (22:00 trigger).
- Config: `RolloverEnabled`, `RolloverStrikePerDay`, `RolloverEscalatePriority`, `MaxRolloverDays`,
  `FailTaskOnFinalStrike`.
- `Tasks` columns `RolloverCount`, `WarningsIssued`, `IsPriority`, `OriginalDueDate`,
  `ParentTaskID`.

---

## 6. Discipline record is **permanent** — clearance resets, never erases

**Context.** Requirement 2: a 3rd strike causes **suspension**; it "can be reset after manual
clearance, but it must be in record the staff has been struck or suspended."

**Decision.** Manual clearance sets *active* strikes back to zero so the person can work again,
but:
- **Lifetime counters never decrease** — `Staff.TotalStrikesIssued` and `Staff.SuspensionCount`
  only ever go up.
- **Ledger rows are cleared, not deleted** — each `Strikes`/`Suspensions` row keeps its history
  and gains `ClearedAt`/`ClearedBy`/`ClearanceNote` (or `LiftedAt`/`LiftedBy`). Nothing is removed.
- Clearance in the admin UI **requires a note** and states plainly that the lifetime record is
  retained.

**Why.** "Reset so they can continue" and "the record must show it happened" are both mandatory
and would conflict if clearance deleted rows. Separating *active* state from *lifetime* history
satisfies both and keeps an audit trail.

**Where.** `Strikes.gs`, `Staff.gs`; Config `StrikeResetPolicy = ManualClearanceOnly`,
`StrikeLimit = 3`; `Staff` columns `StrikeCount` (active) vs `TotalStrikesIssued`/
`SuspensionCount` (lifetime); `Strikes`/`Suspensions` clearance columns.

---

## 7. Period reports — Daily, Weekly, Monthly, Quarterly, Half-Yearly, Yearly

**Context.** Requirement 4: full reports across six horizons with task, allocation, attendance and
strike detail.

**Decision.** A single reporting engine computes all six period types into one `PeriodReports`
schema, at both **organisation** and **per-staff** granularity, with rule-based **strengths /
weaknesses / remark** text derived from the metrics.

**Why.** One schema and one engine keep every horizon consistent (a quarter is just an aggregation
window), avoid divergent report code, and make the weighted metric score comparable across
periods.

**Where.** `Reports.gs`; `PERIOD_TYPES` in `Config.gs`; `PeriodReports` sheet; weekly/monthly
triggers generate them automatically, and the admin **Reports** screen renders any period on
demand. Metric weights: `MetricWeightReportTimeliness` 40 / `MetricWeightOnTimeCompletion` 40 /
`MetricWeightAdminRating` 20 (must total 100).

---

## 8. Document uploads — **Google Drive** for both dashboards

**Context.** Requirement 5: both admin and staff dashboards need an upload button using Google
Drive as storage.

**Decision.** A shared upload dialog (`App.openUpload`) on both dashboards sends files through
`api_upload` to `Uploads.gs`, which stores them in a Drive folder (auto-created on first use) and
records every file in the `Uploads` ledger with its Drive id/URL, owner, category and visibility.

**Why.** Drive is the natural, quota-friendly blob store for an Apps Script app; the `Uploads`
ledger keeps documents queryable and permission-aware without scanning Drive.

**Where.** `Uploads.gs`; `Uploads` sheet; Config `DriveRootFolderName`, `DriveRootFolderId`,
`DriveSharingMode`, `MaxUploadMB`, `AllowedUploadExtensions`; client `App.openUpload()` /
`readFileAsBase64()` in `Scripts.html`.

---

## 9. Configuration over magic values

**Context.** The brief forbids magic strings/numbers outside Config.

**Decision.** Every tunable — deadlines, trigger hours, strike limit, pay source, scoring weights,
upload limits, auth mode, currency — is a row in the **Config** sheet with a default and a
description; sheet/column names and vocabularies live once in `Config.gs`. Code reads them via
`CFG.get/num/bool/list`.

**Why.** Admins can retune policy from a sheet (or the Settings screen) without touching code, and
there's a single place to audit how the system behaves.

**Where.** `Config.gs` (`SHEETS`, `SCHEMA`, vocabularies, `DEFAULT_CONFIG`, `CFG`); the admin
**Settings** screen edits Config rows live.

---

## 10. Reliability — locks, idempotency, and a hidden log

**Context.** Manual actions and scheduled triggers can run at the same time; a single failure
shouldn't take down a trigger or corrupt a row.

**Decision.** All writes are wrapped in `LockService`; every trigger entry point is idempotent
(e.g. duplicate strikes for the same staff+category+task+date are suppressed) and wrapped in
`try/catch`; failures are written to a hidden **Logs** sheet rather than lost.

**Why.** Sheets have no transactions; locks + idempotency are how you get safe concurrency, and a
persistent log is how you debug an automation that ran at 02:00.

**Where.** `Util.gs` (`Log`), `Triggers.gs`, and the `withApi_`/write paths across the services;
`Logs` sheet (hidden by `setupSystem`).
