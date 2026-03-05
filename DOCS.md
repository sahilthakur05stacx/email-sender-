# Email Sender — System Documentation

## Table of Contents
1. [How the Scheduler Works](#1-how-the-scheduler-works)
2. [Daily Sender Limit](#2-daily-sender-limit)
3. [Sending Window (time_from / time_to)](#3-sending-window-time_from--time_to)
4. [UTC — What It Is & Why We Use It](#4-utc--what-it-is--why-we-use-it)
5. [n8n Timezone Workflow](#5-n8n-timezone-workflow)
6. [How Campaign Recipients Are Added](#6-how-campaign-recipients-are-added)
7. [Full Flow — End to End](#7-full-flow--end-to-end)
8. [Environment Variables](#8-environment-variables)
9. [Scheduler Logs](#9-scheduler-logs)
10. [How Emails Are Sent to n8n](#10-how-emails-are-sent-to-n8n)
11. [Sequence Priority Sorting](#11-sequence-priority-sorting)

---

## 1. How the Scheduler Works

The scheduler runs **every 1 hour** using a cron job.

```
cron.schedule("0 * * * *", runScheduler)
```

### Every hour it does:

```
Scheduler runs
      ↓
Fetch pending campaigns from Supabase (max 5 campaigns per run)
      ↓
For each campaign:
    Sort recipients by sequence priority
      ↓
    Check sender daily limit → trim from bottom
      ↓
    For each recipient:
        Check sending window (time_from / time_to)
          ↓
        Prepare email with template + tracking
          ↓
        Send to n8n webhook
              ↓
          n8n delivers the actual email
      ↓
Write run summary to scheduler_logs table
```

### Important Rules:
- If a previous run is still in progress → **skip** (no duplicate runs)
- Campaigns per run: **max 5**
- Recipients are marked as `in_queue` before sending to prevent duplicates
- Contacts with **no time_from / time_to** → **skip** (do not send)

---

## 2. Daily Sender Limit

Each sender (e.g. `sahil@stacx24.com`) has a `daily_limit` column in the `senders` table.

### How It Works:

```
Sender daily_limit = 50

Scheduler runs at 2:00 PM:
  Count emails sent today (from email_logs.created_at) = 47
  Remaining = 50 - 47 = 3

  Only send to 3 recipients → trim the list
  Next run: count = 50 → remaining = 0 → skip campaign entirely
```

### Key Points:
- Count is based on `email_logs.created_at` (not `sent_at`)
- This means emails **in queue** (not yet delivered by n8n) are also counted
- Prevents over-sending even if n8n hasn't delivered yet
- Resets at **midnight** every day automatically

### Example Log Output:
```
Daily Limit: 50 | Sent Today: 47 | Remaining: 3
Trimmed to 3 recipient(s) to stay within daily limit

# When limit reached:
⛔ Daily limit reached for sahil@stacx24.com — skipping campaign
```

---

## 3. Sending Window (time_from / time_to)

Each contact has `time_from` and `time_to` fields in the `contacts` table.
These define **when** we are allowed to send them an email.

### Format:
```
time_from: "09:00"   (HH:MM in UTC)
time_to:   "17:00"   (HH:MM in UTC)
```

### How the Check Works:

```
Current UTC time = 10:30

Contact: matt@sidedishmedia.co.uk
time_from = "09:00"
time_to   = "17:00"

10:30 is between 09:00 and 17:00 → ✅ SEND

---

Current UTC time = 07:00
07:00 is before 09:00 → ❌ SKIP (stays pending)

---

Current UTC time = 20:00
20:00 is after 17:00 → ❌ SKIP (stays pending)
```

### What Happens When Skipped:
- Recipient is **NOT marked as failed**
- Stays in `pending` status
- Next cron run (1 hour later) checks again
- Will be sent automatically when the time window opens

### What If No Time Set:
```
time_from = null
time_to   = null
→ No window defined → ❌ SKIP (do not send)
→ n8n timezone workflow must set time_from/time_to first
```

### Code Logic (scheduler.ts):
```ts
const now = new Date();
const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
const fromMinutes = fromH * 60 + fromM;
const toMinutes   = toH   * 60 + toM;

return currentMinutes >= fromMinutes && currentMinutes <= toMinutes;
```

---

## 4. UTC — What It Is & Why We Use It

**UTC (Coordinated Universal Time)** is the world's standard base time.
Every country's timezone is defined relative to UTC.

### Common Offsets:

| Country | Timezone | UTC Offset |
|---|---|---|
| India | IST | UTC +5:30 |
| UK (winter) | GMT | UTC +0 |
| UK (summer) | BST | UTC +1 |
| USA (New York, winter) | EST | UTC -5 |
| UAE (Dubai) | GST | UTC +4 |
| Australia (Sydney) | AEST | UTC +10 |

### Why UTC and Not IST:

```
If we store times in IST:
  → Only works when server is in India
  → If server moves to another country → everything breaks

If we store times in UTC:
  → Works on any server, anywhere in the world ✅
  → One standard for all contacts globally ✅
```

### Real Example:

```
London contact opens at 9 AM London time
London = UTC+0 (winter)
→ 9 AM London = 09:00 UTC ✅

New York contact opens at 9 AM New York time
New York = UTC-5 (winter)
→ 9 AM New York = 14:00 UTC ✅

India contact opens at 9 AM India time
India = UTC+5:30
→ 9 AM India = 03:30 UTC ✅
```

---

## 5. n8n Timezone Workflow

The n8n workflow automatically finds the correct UTC sending window for each contact based on their location.

### Input (from HTTP Request):
```json
{
  "success": true,
  "location": {
    "address": "18 Soho Square, London, W1D 3QL, United Kingdom",
    "company_city": "London",
    "company_country": "United Kingdom",
    "hours": "Closed · Opens 9 AM"
  }
}
```

### Output (saved to contacts table):
```json
{
  "email": "matt@sidedishmedia.co.uk",
  "time_from": "09:00",
  "time_to": "17:00"
}
```

### AI Agent Setup:

**System Message** (instructions — never changes):
```
You are a timezone analyst. You will receive location data from an API
response containing an address, city, and country.

Your task:
1. Read the city and country from the input data
2. Determine the UTC timezone offset for that city
3. Convert business hours to UTC
4. If hours data is provided, parse opening/closing times and convert to UTC
5. If only opening time is available, assume closing is 8 hours after opening
6. Use the provided date to correctly apply DST if applicable

You MUST respond ONLY in this exact JSON format with no extra text:
{
  "city": "<city name>",
  "country": "<country name>",
  "timezone": "<timezone name e.g. Europe/London>",
  "utc_offset": "<e.g. UTC+0, UTC+5:30, UTC-5>",
  "business_hours_local": "9:00 AM - 5:00 PM",
  "business_hours_utc": "<converted to UTC>",
  "time_from": "<HH:MM in UTC 24h>",
  "time_to": "<HH:MM in UTC 24h>"
}

Common timezone mappings:
- London, UK → Europe/London → UTC+0 (winter) / UTC+1 (summer BST)
- New Delhi, India → Asia/Kolkata → UTC+5:30
- New York, USA → America/New_York → UTC-5 (winter) / UTC-4 (summer EDT)
- Dubai, UAE → Asia/Dubai → UTC+4
- Sydney, Australia → Australia/Sydney → UTC+11 (summer) / UTC+10 (winter)
```

**User Message** (dynamic data per contact):
```
Analyze this location and give me the UTC timezone:
City: {{ $json.location.company_city }}
Country: {{ $json.location.company_country }}
Address: {{ $json.location.address }}
Hours: {{ $json.location.hours }}
Today's Date: {{ $now.toFormat('yyyy-MM-dd') }}
```

### DST (Daylight Saving Time) Note:
- UK is UTC+0 in winter, UTC+1 in summer (BST)
- USA East is UTC-5 in winter, UTC-4 in summer (EDT)
- Always pass today's date to the AI so it applies the correct offset

---

## 6. How Campaign Recipients Are Added

There are 3 ways recipients get added to `campaign_recipients`:

### Method 1 — Automatic DB Trigger (Email Campaigns)
When a campaign is created with a `segment_id`, a Postgres trigger fires automatically:
```
INSERT into campaigns (segment_id = X)
    → trigger: create_campaign_recipients()
    → inserts 1 row per active contact in that segment
    → status: "pending", current_step: 1
```

### Method 2 — Manual Sync (WhatsApp Campaigns)
A "Sync Recipients" button on WhatsApp campaign page:
1. Gets all contacts in the campaign's segment
2. Filters to only those with `wa_contacts.opt_in_status = "opted_in"`
3. Upserts them into `campaign_recipients`

### Method 3 — Status Updates Only
The edge function `update-recipient-status` only **updates** existing rows:
```
pending → in_queue → sent → completed
```

---

## 7. Full Flow — End to End

```
[n8n Timezone Workflow]
    Finds contact's city/country
    Converts business hours to UTC
    Saves time_from + time_to to contacts table
              ↓
[Campaign Created]
    Segment assigned → DB trigger adds all contacts as recipients
    status: pending
              ↓
[Scheduler — every 1 hour]
    1. Fetch pending campaigns (max 5)
    2. For each campaign:
         a. Sort recipients by sequence priority
              → step 5 before step 3 before step 1
              → same step? oldest entry first (FIFO)
         b. Check sender daily limit
              → limit reached? skip campaign
              → remaining = 3? trim to top 3 (highest priority kept)
         c. For each recipient:
              → Check current UTC time vs time_from / time_to
              → Outside window? skip (stays pending)
              → Inside window? prepare email
         d. Send eligible emails to n8n webhook
    3. n8n delivers the actual email
    4. email_logs.created_at recorded (used for daily limit count)
    5. Write run summary to scheduler_logs table
              ↓
[Recipient Status Updates]
    pending → in_queue → sent → completed
```

---

## 8. Environment Variables

All credentials are loaded from `.env` file — **nothing is hardcoded** in source code.

### Required Variables:

| Variable | Description | Example |
|---|---|---|
| `SUPABASE_URL` | Supabase project URL | `https://xyz.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Service role key (read-write) | `eyJhbGci...` |
| `API_KEY` | API key for tracking service | `or_ed5e1...` |
| `N8N_WEBHOOK_URL` | n8n webhook URL for email delivery | `https://n8n.example.com/webhook/...` |
| `TRACKING_API_URL` | Tracking API base URL | `https://tracking.example.com` |

### Optional Variables:

| Variable | Description | Default |
|---|---|---|
| `CRON_EXPRESSION` | Cron schedule | `0 * * * *` (every hour) |
| `LOG_LEVEL` | Log verbosity | `info` |
| `TZ` | Process timezone | `UTC` |

### Startup Validation:

The scheduler validates all required env vars on startup. If any are missing, it exits with an error:

```
Missing required environment variables: SUPABASE_URL, API_KEY
```

### Setup:

```bash
cp .env.example .env
# Edit .env with your actual values
npm start
```

---

## 9. Scheduler Logs

Every scheduler run writes **1 row** to the `scheduler_logs` table in Supabase. This provides full auditing of what the scheduler did each hour.

### Table Schema:

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | Auto-generated unique ID |
| `run_at` | timestamptz | When this run started |
| `campaigns_processed` | integer | How many active campaigns were found |
| `total_slots_available` | integer | Total sender capacity (daily_limit - sent_today) |
| `total_emails_sent` | integer | How many emails were sent to n8n this run |
| `total_skipped` | integer | How many recipients were skipped (outside window, no template, etc.) |
| `duration_ms` | integer | How long the run took in milliseconds |
| `status` | text | `success` / `failed` / `skipped` |
| `error` | text | Error message if status = failed or skipped |
| `meta` | jsonb | Per-campaign breakdown |
| `created_at` | timestamptz | Row creation timestamp |

### Status Values:

| Status | When |
|---|---|
| `success` | Run completed, at least 1 campaign processed |
| `skipped` | No active campaigns found OR previous run still in progress |
| `failed` | API error, DB error, or any unhandled exception |

### Example Log Entries:

```
Normal run:
  run_at: 2026-03-05 14:00:00
  campaigns_processed: 3
  total_slots_available: 45
  total_emails_sent: 12
  total_skipped: 5
  duration_ms: 1200
  status: success

No campaigns:
  run_at: 2026-03-05 15:00:00
  campaigns_processed: 0
  total_emails_sent: 0
  duration_ms: 120
  status: skipped

Error:
  run_at: 2026-03-05 16:00:00
  campaigns_processed: 1
  total_emails_sent: 3
  duration_ms: 5000
  status: failed
  error: "fetch failed: ECONNREFUSED"
```

### Meta JSONB — Per-Campaign Breakdown:

The `meta` column stores detailed info per campaign:

```json
{
  "campaigns": [
    {
      "id": "uuid-abc",
      "name": "Cold Outreach Q1",
      "organization_id": "org-123",
      "eligible": 20,
      "sent": 15,
      "skipped": 5
    },
    {
      "id": "uuid-def",
      "name": "Follow Up Sequence",
      "organization_id": "org-123",
      "eligible": 0,
      "sent": 0,
      "skipped": 0,
      "reason": "daily_limit_reached"
    }
  ]
}
```

### When Logs Are Written:

```
Scheduler triggers
    ↓
Previous run in progress? → Write log (status: skipped) → exit
    ↓
API returns error? → Write log (status: failed) → exit
    ↓
Process all campaigns...
    ↓
Write log (status: success) with full breakdown
    ↓
Exception at any point? → Write log (status: failed) with error message
```

### Querying Logs:

```sql
-- Last 10 runs
SELECT run_at, status, campaigns_processed, total_emails_sent, duration_ms
FROM scheduler_logs ORDER BY run_at DESC LIMIT 10;

-- Failed runs today
SELECT * FROM scheduler_logs
WHERE status = 'failed' AND run_at >= CURRENT_DATE;

-- Average emails per run this week
SELECT AVG(total_emails_sent), AVG(duration_ms)
FROM scheduler_logs
WHERE status = 'success' AND run_at >= CURRENT_DATE - INTERVAL '7 days';
```

---

## 10. How Emails Are Sent to n8n

The scheduler does **NOT** send emails directly via SMTP. It builds an array of email objects and sends them to n8n in a single POST request.

### Step 1 — Build Email Array

For each eligible recipient, the scheduler creates an email object:

```json
{
  "to": "john@company.com",
  "toName": "John Smith",
  "from": "sahil@stacx24.com",
  "fromName": "Sahil",
  "subject": "Quick question about Company Inc",
  "body": "Hey John...",
  "bodyHtml": "<html>...with tracking pixels...</html>",
  "format": "html",
  "recipientId": "uuid-123",
  "campaignId": "uuid-456",
  "contactId": "uuid-789",
  "emailLogId": "uuid-log",
  "trackingId": "uuid-track",
  "organizationId": "uuid-org",
  "trackingEnabled": true,
  "trackOpens": true,
  "trackClicks": true,
  "trackingApplied": true,
  "step": 2
}
```

### Step 2 — POST to n8n Webhook

All emails are sent in **one HTTP request**:

```ts
await fetch(N8N_WEBHOOK_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(emailsToSend),  // array of all emails
});
```

### Step 3 — n8n Delivers

```
Scheduler ── POST [email1, email2, email3] ──→ n8n webhook
                                                    ↓
                                              n8n loops through each
                                                    ↓
                                              sends via SMTP one by one
                                                    ↓
                                              email1 → SMTP → john@company.com
                                              email2 → SMTP → sarah@other.com
                                              email3 → SMTP → mike@xyz.com
```

### What Data n8n Receives:

| Field | Purpose |
|---|---|
| `to`, `toName` | Recipient email and display name |
| `from`, `fromName` | Sender email and display name |
| `subject` | Email subject line |
| `body` | Plain text body |
| `bodyHtml` | HTML body (with tracking pixels if enabled) |
| `format` | `text` or `html` |
| `recipientId`, `campaignId`, `contactId` | IDs for status updates after send |
| `emailLogId`, `trackingId` | IDs for open/click tracking |
| `trackingEnabled`, `trackOpens`, `trackClicks` | Whether tracking is active |
| `trackingApplied` | Whether tracking pixels were successfully injected |
| `listUnsubscribeHeader` | List-Unsubscribe header for email compliance |
| `step` | Current sequence step number |

---

## 11. Sequence Priority Sorting

Recipients are sorted **before** processing so that contacts further in the funnel get priority. This ensures higher-step contacts are never skipped when capacity is limited.

### Sort Order:

| Priority | Column | Direction | Why |
|---|---|---|---|
| 1st | `current_step` | DESC (highest first) | Contact on step 5 has been in funnel longer than step 1 — prioritize them |
| 2nd | `step_entered_at` | ASC (oldest first) | If two contacts are on the same step, the one who entered that step first goes first (FIFO fairness) |
| 3rd | `contact_id` | ASC | Deterministic tie-breaker if everything else is equal |

### Example:

```
Before sort (random API order):
  Contact D - step 2 (entered Mar 1)
  Contact A - step 5 (entered Mar 1)
  Contact E - step 1 (entered Feb 15)
  Contact C - step 3 (entered Mar 2)
  Contact B - step 3 (entered Feb 20)

After sort:
  Contact A - step 5 (entered Mar 1)     ← highest step
  Contact B - step 3 (entered Feb 20)    ← same step as C, but entered earlier
  Contact C - step 3 (entered Mar 2)     ← same step as B, but entered later
  Contact D - step 2 (entered Mar 1)
  Contact E - step 1 (entered Feb 15)    ← lowest step
```

### How It Works with Daily Limit:

```
daily_limit = 3, 10 recipients available

1. Sort all 10 by priority (step DESC → entered ASC)
2. Trim to top 3 (daily limit)
3. Contacts A, B, C get emails
4. Contacts D through J wait for next run

Step 5 contact is NEVER skipped for a step 1 contact.
```

### Required Column:

The `step_entered_at` column on `campaign_recipients` tracks when a contact moved to their current step.

- **New contacts**: set to `now()` when they join the campaign
- **Existing contacts**: backfilled from `enrolled_at`
- **Step change**: should be updated to `now()` when `current_step` changes

### Code (scheduler.ts):

```ts
campaign.pending_recipients.sort((a, b) => {
  // Primary: higher step first
  const stepDiff = (b.current_step || 0) - (a.current_step || 0);
  if (stepDiff !== 0) return stepDiff;

  // Secondary: oldest entry at same step first (FIFO)
  const aEntered = a.step_entered_at ? new Date(a.step_entered_at).getTime() : 0;
  const bEntered = b.step_entered_at ? new Date(b.step_entered_at).getTime() : 0;
  const enteredDiff = aEntered - bEntered;
  if (enteredDiff !== 0) return enteredDiff;

  // Tertiary: deterministic tie-breaker
  return (a.contact_id || "").localeCompare(b.contact_id || "");
});
```

---

## File Reference

| File | Purpose |
|---|---|
| `src/scheduler.ts` | Main scheduler — cron job, daily limit, sending window, logging |
| `.env` | Environment variables (secrets — never committed) |
| `.env.example` | Template for required env vars |
| `supabase/functions/get-campaign-queue/index.ts` | Fetches pending recipients with contact data |
| `supabase/functions/update-recipient-status/index.ts` | Updates recipient status after send |
| `contacts` table | Stores `time_from`, `time_to`, `email` per contact |
| `senders` table | Stores `daily_limit` per sender |
| `email_logs` table | Tracks every email sent (used for daily limit count) |
| `campaign_recipients` table | Tracks each contact's progress in a campaign (`current_step`, `step_entered_at`) |
| `scheduler_logs` table | Audit log — one row per scheduler run |
