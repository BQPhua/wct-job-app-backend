# Offboarding module: Power Automate setup and go-live checklist

This goes with the offboarding merge of 30 Sep 2026. Offboarding now uses two new Power Automate flows:

| Flow | Trigger | What it does |
|---|---|---|
| **A. WCT Offboarding Email** | When an HTTP request is received | Sends every offboarding email: invite, clearance task, reminder, acknowledgement request, payroll (with 2 PDFs), completed, cancelled |
| **B. WCT Offboarding Daily Reminder** | Recurrence, daily 9:00 am MYT | Calls the backend, which sends the 7-day and 3-day clearance reminders |

The old **"Offboarding notification"** flow (`fd1ede43-…`) is no longer called. Turn it off after go-live.

> Build both flows under the shared HR mailbox or service account, not a personal account. If the owner's account is deactivated, the flow's Outlook connection stops working immediately. This is the same risk as the existing 7 job-application flows.

---

## Flow A: "WCT Offboarding Email"

1. Power Automate → **Create** → **Instant cloud flow** → skip the trigger picker → **Create**.
2. Add the trigger **When a HTTP request is received** (Request connector).
   - **Who can trigger the flow**: *Anyone*. The URL's `sig=` part is the secret.
   - **Request Body JSON Schema**: paste this:

```json
{
  "type": "object",
  "properties": {
    "to": { "type": "string" },
    "cc": { "type": "string" },
    "subject": { "type": "string" },
    "html": { "type": "string" },
    "attachments": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "content_base64": { "type": "string" }
        }
      }
    },
    "event_type": { "type": "string" },
    "case_ref": { "type": "string" },
    "department": { "type": "string" }
  },
  "required": ["to", "subject", "html"]
}
```

3. Add a **Data Operation → Select** action:
   - **From** (expression): `coalesce(triggerBody()?['attachments'], json('[]'))`
   - **Map**: switch to key/value mode and add two rows:
     - `Name` → expression `item()?['name']`
     - `ContentBytes` → expression `item()?['content_base64']`
4. Add **Office 365 Outlook → Send an email (V2)**. Sign it in with the shared HR mailbox.
   - **To**: expression `triggerBody()?['to']`. Several addresses come already joined with `;`.
   - **Subject**: expression `triggerBody()?['subject']`
   - **Body**: click **</>** (code view), then insert expression `triggerBody()?['html']`
   - **Show advanced options**:
     - **CC**: expression `triggerBody()?['cc']`
     - **Attachments**: click **Switch to input entire array** (the small `T` icon) and put the expression `body('Select')`
     - **Importance**: Normal
5. **Save**. Open the trigger again and copy the **HTTP POST URL**. It must contain `sig=`.
6. Put that URL in App Service → **Environment variables** as `POWER_AUTOMATE_URL_OFFBOARDING_EMAIL`.

The backend sends a complete, WCT-branded HTML email, so leave the Body as just that expression and don't add any wording of your own in the flow.

## Flow B: "WCT Offboarding Daily Reminder"

1. Create a **Scheduled cloud flow** that repeats every **1 day**. Under **Show advanced options**, set **Time zone** to *(UTC+08:00) Kuala Lumpur, Singapore* and **At these hours** to `9`.
2. Add an **HTTP** action (Premium; the same licence the HTTP-trigger flows already need):
   - **Method**: `POST`
   - **URI**: `https://wct-job-app-api.azurewebsites.net/api/offboarding/cron/reminders`
   - **Headers**: `x-cron-key` = the same value you set as `OFFBOARDING_CRON_SECRET` on the App Service
3. Save, then click **Test → Manually**. A successful run returns `200` with something like `{"today":"2026-10-01","cases":3,"sent":2,"failed":0,"skipped":1}`.

Running it more than once a day is safe. Each department gets each reminder (7-day and 3-day) only once, and a reminder that Power Automate rejected is retried the next day.

---

## Go-live checklist

Do these in order.

### 1. Database (Azure Cloud Shell or pgAdmin)
- [ ] Take a backup first. In the Azure portal: PostgreSQL server → Backup and restore, or run `pg_dump`.
- [ ] Upload `db/migrations/005_offboarding_module.sql` and run it:
  `psql "host=<PGHOST> dbname=<PGDATABASE> user=<PGUSER> sslmode=require" -f 005_offboarding_module.sql`
- [ ] Check it worked:
  `SELECT count(*) FROM clearance_checklist_templates;` should return **45**.
  `SELECT ref_no, status FROM offboarding_cases;` should list any exit interviews that were migrated.
  `SELECT count(*) FROM applications WHERE status='offboarding';` should return **0**.

The migration runs in one transaction, so if anything fails, nothing changes. It is also safe to run twice.
- [ ] **Push the new backend straight after the migration** (step 3), ideally at a quiet time. The migration renames the old `exit_interviews` table, so the old backend's offboarding screens will error until the new code is live.
- [ ] Afterwards, open **Offboarding** and filter by status *Clearance in progress*. Exit interviews migrated from the old system start in clearance but have had no task emails yet, so select them and click **Remind pending departments**. Check their last days too, because some may already have passed.

### 2. App Service settings (wct-job-app-api → Environment variables)
- [ ] `POWER_AUTOMATE_URL_OFFBOARDING_EMAIL` = Flow A's URL
- [ ] `OFFBOARDING_CRON_SECRET` = a long random string (use the same one in Flow B)
- [ ] `FRONTEND_BASE_URL` = the live frontend address, e.g. `https://wctjobappstorage.z23.web.core.windows.net`, with no trailing slash. Email links are built from this. If it's unset, links point to the old GitHub Pages copy.
- [ ] Remove `POWER_AUTOMATE_URL_EXIT_INTERVIEW`. It is no longer used.

### 3. Push the backend (wct-job-app-backend), then the frontend (job-app)
See the file list delivered with this change. The backend goes first, because the new frontend calls the new API.

### 4. Assign the new roles (admin dashboard → Admin Access)
- [ ] **Payroll PIC**: one or more per business unit
- [ ] **Clearance PIC**: per business unit **and** department (IT, Administration, Finance, Purchasing, Human Resources). There is no Reporting Unit PIC: the employee's immediate superior *is* the Reporting Unit. HR must enter the superior's email when inviting, and that person gets the Reporting Unit checklist and signs in on admin.html with Microsoft, with no grant needed.
- [ ] New people must first be invited with "+ Invite Admin" (an @wct.my email). They then sign in on admin.html with Microsoft.

If a department has no PIC, its clearance emails go to that business unit's HR admins, so nothing gets lost. Cases migrated from the old system may have no superior email: their Reporting Unit email goes to HR, who can add the superior with **Edit details** or sign on behalf.

### 5. Smoke test in production
- [ ] HR: Offboarding → **Invite employee** with your own test mailbox, then check the email arrives.
- [ ] Open the link and sign in with that email. Fill in and submit the Exit Interview.
- [ ] Sign one checklist as a PIC and the rest "on behalf" as HR. Acknowledge as the employee, then mark payroll done. Check the payroll email has 2 PDFs attached.
- [ ] **Cancel** the test case afterwards with the reason "Go-live test".

### 6. Afterwards
- [ ] Turn off the old "Offboarding notification" flow.
- [ ] Move Flow A and Flow B (and the 7 existing flows) to the shared mailbox or service account.
