# Setup Guide

Stand up the Staff Task, Attendance & Payroll system from an empty Google account. Takes about
15 minutes. You need a Google account with access to Google Sheets, Google Drive and Apps Script
(any consumer or Workspace account works).

> Throughout: the account you do this with becomes the **owner** — the first Admin, the identity
> the web app runs as, and the only account the spreadsheet is shared with. Use the account that
> should own the workspace.

---

## Step 1 — Create the spreadsheet and its bound script

1. Go to <https://sheets.google.com> and create a **blank spreadsheet**. Name it e.g.
   `Staff Management System`. (This one spreadsheet is your whole database.)
2. In the sheet menu choose **Extensions → Apps Script**. A bound Apps Script project opens.
3. Rename the script project (top-left) to `Staff Management System` so it's easy to find later.

Keeping the script **bound** to the sheet matters: `setupSystem()` builds its tabs in the
spreadsheet the script is bound to, and the `onOpen` menu appears in that sheet.

---

## Step 2 — Turn on the manifest and set the timezone/scopes

1. In the Apps Script editor click the **gear (Project Settings)**.
2. Tick **"Show \"appsscript.json\" manifest file in editor."**
3. Go back to the **Editor**. Open `appsscript.json` and replace its contents with the
   `appsscript.json` from this project (`apps-script/appsscript.json`).

That manifest sets `timeZone: Africa/Lagos`, `runtimeVersion: V8`, the web-app execution model,
and the six OAuth scopes the app needs. Change `timeZone` here if you're not in West Africa —
and set the matching `Timezone` Config value later (Step 6).

---

## Step 3 — Add every code file

Add each file from `apps-script/` into the editor with the **exact same name** (Apps Script
adds the `.gs`/`.html` extension for you — match the base name and type).

**Server files** — for each, click **＋ → Script**, name it, paste the file's contents:

```
Config   SheetDB   Util     Auth       Staff     Tasks
Attendance   Strikes   Payroll   Reports   Uploads
Notifications   Triggers   Setup   WebApp
```

**HTML files** — for each, click **＋ → HTML**, name it, paste the file's contents:

```
Index   Styles   Login   Scripts   AdminDashboard   StaffPortal   EmailTemplate
```

You can delete the default `Code.gs` (its logic lives in the files above). When done you should
have **15 `.gs` files + `appsscript.json` + 7 `.html` files**. Click **Save**.

> Names must match exactly — files reference each other by name (`include('Styles')`,
> `HtmlService.createTemplateFromFile('EmailTemplate')`, etc.). A typo here is the most common
> setup failure.

---

## Step 4 — Run `setupSystem()` once

1. In the editor's function dropdown select **`setupSystem`** and click **Run**.
2. Google shows an **authorization** prompt (first run only). Choose your owner account →
   **Advanced → Go to \<project\> (unsafe)** → **Allow**. (It's "unsafe" only because the script
   is unverified — it's your own code.) Grant the requested scopes.
3. The run creates all 13 tabs, seeds every Config default, hides the `Logs` tab, seeds two
   sample holidays, and **registers you (the owner) as the first Admin with a generated PIN.**

**Capture your Admin PIN now.** Open **View → Execution log** (or **Executions**) and read the
`setupSystem` return summary / log line — it contains the generated PIN for your Admin account.
You can also change it later from the app (Profile → Change PIN) or reset it from the sheet.

`setupSystem()` is **idempotent** — safe to run again any time. It repairs missing tabs/headers
and adds new Config keys without deleting your data.

---

## Step 5 — (Optional) seed demo data

To explore with sample content, run **`seedDemoData()`** once. It adds four demo staff and a
handful of tasks. Skip this for a real deployment (or delete the demo rows afterward).

---

## Step 6 — Configure the workspace

Open the **Config** tab in the spreadsheet (or do this later from **Admin → Settings**) and set:

| Key | Set to |
|-----|--------|
| `CompanyName` | Your organisation's name (shown in UI + emails) |
| `Currency` / `CurrencyCode` | e.g. `₦` / `NGN`, or `$` / `USD` |
| `Timezone` | Match `appsscript.json` (e.g. `Africa/Lagos`) |
| `AdminEmails` | Comma-separated admin alert recipients (blank = every `Role=Admin` staff row) |
| `AuthMode` | Leave `Hybrid` (Google + PIN) unless you want `GoogleOnly` or `PinOnly` |
| `PayProgressSource` | Leave `AdminValidated` (only validated progress pays) |

The scoring weights (`MetricWeightReportTimeliness` 40, `MetricWeightOnTimeCompletion` 40,
`MetricWeightAdminRating` 20) already total 100; adjust only if you keep them summing to 100.
`WebAppUrl` is filled in **Step 8**.

---

## Step 7 — Deploy the web app

1. In the editor click **Deploy → New deployment**.
2. **Select type → Web app.**
3. Set:
   - **Description**: e.g. `Staff MS v1`
   - **Execute as**: **Me (\<owner\>)**  ← keeps the spreadsheet private; the app runs with the
     owner's access.
   - **Who has access**: **Anyone**  ← so staff can reach the login/PIN form. (The app does its
     own authentication; the sheet is never shared with them.)
4. Click **Deploy**, authorize if prompted, and **copy the Web app URL**.

> **Why "Anyone" is safe here:** access is gated *inside* the app by Hybrid auth (Google SSO or
> email + PIN). Because the app **executes as the owner**, visitors never touch your Google Sheet
> directly — they only ever see what an `api_*` endpoint chooses to return after authenticating
> them. See **[DECISIONS.md](DECISIONS.md)**.

---

## Step 8 — Tell the app its own URL

Paste the Web app URL into Config so email buttons link back correctly:

- Open the **Config** tab, find **`WebAppUrl`**, and paste the deployment URL as its value
  (or set it from **Admin → Settings**).

---

## Step 9 — Install the automation triggers

Reload the spreadsheet tab. A **Staff MS** menu appears (from `onOpen`). Then either:

- **Staff MS → Install automation triggers**, or
- In the Apps Script editor, run **`installAllTriggers`** once.

This schedules all seven automations (task activation, attendance reminder/sweep, daily-report
check, rollover, weekly & monthly reports). Authorize the trigger scope if prompted. Use
**Staff MS → Remove automation triggers** to clear them, and the admin **Settings** screen to see
what's installed.

The **Staff MS** menu also offers: *Run setup / repair*, *Run daily automation now*, *Generate
monthly reports now*, and *Seed demo data* — handy for testing without waiting for a trigger.

---

## Step 10 — First sign-in

1. Open the **Web app URL**.
2. Sign in as the owner — either **"Continue as \<you\>"** (Google SSO) or with your **email +
   the generated Admin PIN** from Step 4.
3. You land on the **Admin** dashboard. From **Staff**, add your team (each new staff member gets
   a generated PIN; with `EmailNotificationsEnabled=TRUE` and a real email, it's emailed to them).
4. Staff open the **same URL** and sign in with their email + PIN (or Google SSO if their Google
   address matches their staff email).

---

## Hybrid auth — what to expect

- **Google SSO auto-detect is reliable for the owner** (and often same-Workspace-domain users).
  Because the app executes as the owner with "Anyone" access, Google may **not** reveal a
  visitor's email to the script — so most staff will use the **email + PIN** path. This is by
  design and fully supported; the login screen shows the PIN form whenever SSO isn't available.
- Staff never need edit access to the spreadsheet. Keep it **private (owner only)**.

---

## Updating the app later

When you change code, redeploy so users get it:

- **Deploy → Manage deployments →** pencil-edit your web app **→ Version: New version → Deploy.**
  The URL stays the same. (A brand-new deployment would mint a new URL — then update `WebAppUrl`.)

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Login screen says "run the `setupSystem` function once" | You opened the web app before Step 4. Run `setupSystem()`, then reload. |
| "Not on the team yet" after Google sign-in | Your Google address isn't a Staff row. Add it (exact email) from Admin → Staff, or sign in with email + PIN. |
| Can't find your Admin PIN | Re-open the `setupSystem` **execution log**, or reset it: edit the Staff row's PIN from the app (Admin → Staff → Reset PIN). |
| Emails aren't sending | Check `EmailNotificationsEnabled=TRUE`, valid recipient emails, and that you granted the send-mail scope. Consumer Gmail has a daily send quota. |
| Triggers didn't run | Confirm **Install automation triggers** was run; check **Executions** for errors; verify the trigger hours in Config and the project `Timezone`. |
| A screen is blank / JS error | Re-check that every `.html` file name matches exactly and none contains stray scriptlets (only `Index` and `EmailTemplate` use `<? ?>`). |
| Menu "Staff MS" missing | Reload the spreadsheet tab; `onOpen` runs on open. If still missing, run `onOpen` once from the editor. |

Once you can sign in as Admin, add a staff member, assign a task, and see it on both dashboards,
the system is live. See **[README.md](README.md)** for how the pieces fit together.
