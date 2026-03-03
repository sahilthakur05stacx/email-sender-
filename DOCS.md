# Email Sender — System Documentation

## Table of Contents
1. [How the Scheduler Works](#1-how-the-scheduler-works)
2. [Daily Sender Limit](#2-daily-sender-limit)
3. [Sending Window (time_from / time_to)](#3-sending-window-time_from--time_to)
4. [UTC — What It Is & Why We Use It](#4-utc--what-it-is--why-we-use-it)
5. [n8n Timezone Workflow](#5-n8n-timezone-workflow)
6. [How Campaign Recipients Are Added](#6-how-campaign-recipients-are-added)
7. [Full Flow — End to End](#7-full-flow--end-to-end)

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
    Check sender daily limit
      ↓
    For each recipient:
        Check sending window (time_from / time_to)
          ↓
        Prepare email with template + tracking
          ↓
        Send to n8n webhook
              ↓
          n8n delivers the actual email
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
- Next cron run (1 minute later) checks again
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
[Scheduler — every 1 minute]
    1. Fetch pending campaigns (max 5)
    2. For each campaign:
         a. Check sender daily limit
              → limit reached? skip campaign
              → remaining = 3? only take 3 recipients
         b. For each recipient:
              → Check current UTC time vs time_from / time_to
              → Outside window? skip (stays pending)
              → Inside window? prepare email
         c. Send eligible emails to n8n webhook
    3. n8n delivers the actual email
    4. email_logs.created_at recorded (used for daily limit count)
              ↓
[Recipient Status Updates]
    pending → in_queue → sent → completed
```

---

## File Reference

| File | Purpose |
|---|---|
| `src/scheduler.ts` | Main scheduler — cron job, daily limit, sending window |
| `supabase/functions/get-campaign-queue/index.ts` | Fetches pending recipients with contact data |
| `supabase/functions/update-recipient-status/index.ts` | Updates recipient status after send |
| `contacts` table | Stores `time_from`, `time_to`, `email` per contact |
| `senders` table | Stores `daily_limit` per sender |
| `email_logs` table | Tracks every email sent (used for daily limit count) |
| `campaign_recipients` table | Tracks each contact's progress in a campaign |
