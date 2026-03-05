# Gap Analysis — Existing Code & DB vs SRS v1.0

> Last updated: March 5, 2026
> Compared against: outreach-vibe Supabase schema + email-sender/src/ (modular structure)

---

## 0. CURRENT SYSTEM FLOW

### How It Works Right Now

```
┌─────────────────────────────────────────────────────────────────┐
│                     SCHEDULER (runs every hour)                  │
│                     src/scheduler/index.ts                       │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                   cron triggers runScheduler()
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 0: Acquire Lock                                           │
│  utils/lock.ts → acquireLock()                                  │
│  If locked → log "skipped", write scheduler_log, exit           │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 0b: Stale Queue Cleanup                                   │
│  db/client.ts → resetStaleRecipients()                          │
│  Resets "in_queue" recipients stuck > 30 min back to "pending"  │
│  Prevents permanently stuck contacts after a crash              │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 1: Fetch Active Campaigns                                 │
│  scheduler/fetchCampaigns.ts → fetchCampaigns()                 │
│  GET /functions/v1/get-campaign-queue?resolve=true&limit=5      │
│  Returns: campaigns[] with pending_recipients[], templates[]    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 2: For Each Campaign                                      │
│  scheduler/runner.ts                                            │
│                                                                  │
│  2a. Sort recipients by priority                                │
│      → current_step DESC (higher step = higher priority)        │
│      → step_entered_at ASC (oldest first at same step)          │
│      → contact_id ASC (tie-breaker)                             │
│                                                                  │
│  2b. Check sender daily limit                                   │
│      → db/client.ts → getSenderTodayCount()                     │
│      → counts email_logs for this sender today                  │
│      → remaining = daily_limit - sent_today                     │
│      → trim recipient list to remaining slots                   │
│                                                                  │
│  2c. Mark recipients as "in_queue"                              │
│      → scheduler/fetchCampaigns.ts → markRecipientsInQueue()    │
│      → prevents duplicate picks on next run                     │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 3: For Each Recipient                                     │
│                                                                  │
│  3a. Check sending window                                       │
│      → utils/helpers.ts → isWithinSendingWindow()               │
│      → contact.time_from / time_to (UTC)                        │
│      → outside window? skip (stays in_queue for next run)       │
│                                                                  │
│  3b. Resolve template for current step                          │
│      → utils/helpers.ts → getTemplateForStep()                  │
│      → tries resolved_templates first, falls back to templates  │
│      → supports randomize_templates                             │
│                                                                  │
│  3c. Apply tracking (if HTML + tracking enabled)                │
│      → utils/helpers.ts → generateTracking()                    │
│      → POST to tracking-api /api/generate                       │
│      → injects open pixel + rewrites links                      │
│      → returns list-unsubscribe headers                         │
│                                                                  │
│  3d. Build email payload object                                 │
│      → to, from, subject, body, bodyHtml, IDs, tracking flags  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 4: Send to n8n                                            │
│  POST all emails as JSON array to N8N_WEBHOOK_URL               │
│  n8n loops through and sends each via SMTP                      │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 5: Write scheduler_log                                    │
│  db/client.ts → writeSchedulerLog()                             │
│  Records: campaigns_processed, emails_sent, skipped, duration   │
│  Status: success | failed | skipped                             │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 6: Release Lock                                           │
│  utils/lock.ts → releaseLock()                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow Between Services

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Supabase   │     │  Scheduler   │     │ Tracking API │     │     n8n      │
│   Database   │     │  (Node.js)   │     │              │     │   (SMTP)     │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │                    │
       │  GET campaign queue│                    │                    │
       │◄───────────────────│                    │                    │
       │  campaigns + recipients                 │                    │
       │───────────────────►│                    │                    │
       │                    │                    │                    │
       │  PUT mark in_queue │                    │                    │
       │◄───────────────────│                    │                    │
       │                    │                    │                    │
       │                    │  POST /api/generate│                    │
       │                    │───────────────────►│                    │
       │                    │  tracked HTML + IDs│                    │
       │                    │◄───────────────────│                    │
       │                    │                    │                    │
       │                    │  POST email array  │                    │
       │                    │────────────────────────────────────────►│
       │                    │                    │                    │
       │  POST scheduler_log│                    │           sends via SMTP
       │◄───────────────────│                    │                    │
       │                    │                    │                    │
```

### Recipient Status Flow

```
pending ──→ in_queue ──→ sent ──→ completed
               │                      │
               │                      ├──→ replied
               │                      ├──→ bounced
               │                      └──→ unsubscribed
               │
               └──→ (stuck if crash — needs stale queue cleanup)
```

### Wait Days — How Steps Are Spaced Out

Each template step has a `wait_days` setting configured in the UI:

```
Template Step 1: "First Email"       → wait_days: 0  (send immediately)
Template Step 2: "Follow Up"         → wait_days: 3  (wait 3 days after Step 1)
Template Step 3: "Final Follow Up"   → wait_days: 5  (wait 5 days after Step 2)
```

**How it works — Lucy's journey through 3 steps:**

```
Day 1 (March 1):
  Lucy joins campaign → status: "pending", step: 1, next_send_at: NULL

Day 1, 2:00 PM — Scheduler runs:
  next_send_at is NULL → eligible → picked up
  Step 1 template sent via n8n

  After n8n delivers, update-recipient-status is called (status: "sent")
  advanceStep() runs:
    → Looks up Step 2 template → wait_days: 3
    → next_send_at = March 1 + 3 days = March 4
    → Updates: status: "pending", current_step: 2, next_send_at: March 4

Day 2 (March 2) — Scheduler runs:
  Lucy: next_send_at = March 4 → March 4 > now → SKIP (still waiting)

Day 3 (March 3) — Scheduler runs:
  Lucy: next_send_at = March 4 → SKIP (still waiting)

Day 4 (March 4) — Scheduler runs:
  Lucy: next_send_at = March 4 → March 4 <= now → ELIGIBLE
  Step 2 template "Follow Up" sent via n8n
  advanceStep():
    → Step 3 wait_days: 5
    → next_send_at = March 4 + 5 days = March 9
    → Updates: status: "pending", current_step: 3, next_send_at: March 9

Day 9 (March 9) — Scheduler runs:
  Lucy: next_send_at = March 9 → ELIGIBLE
  Step 3 "Final Follow Up" sent
  advanceStep() → current_step (3) >= total_steps (3)
    → status: "completed", completed_at: now → DONE
```

**The query that enforces wait days (get-campaign-queue edge function):**

```
.eq("status", "pending")
.or("next_send_at.is.null,next_send_at.lte." + now())

  next_send_at IS NULL   → new recipient (Step 1), send now
  next_send_at <= now()  → wait period passed, send next step
  next_send_at > now()   → still waiting, SKIP
```

### Reply Protection — How Replied Contacts Are Stopped

When a contact replies, the entire sequence stops immediately. They never receive the next step.

**Example — Oliver replies after receiving Step 1:**

```
Day 1:
  Oliver receives Step 1 email → status: "sent"
  advanceStep() → status: "pending", step: 2, next_send_at: March 4

Day 2:
  Oliver replies to the email
  n8n detects reply → calls update-recipient-status (status: "replied")

  Edge function does:
    → Finds Oliver's campaign_recipients row
    → Sets: status = "replied", replied_at = now
    → Also updates ALL his campaign recipients across campaigns:
        WHERE contact_id = Oliver AND status IN ("active", "sent", "pending")
        → ALL set to "replied"

Day 4 — Scheduler runs:
  Query: .eq("status", "pending")
  Oliver's status is "replied" (not "pending")
  → NOT returned by the query
  → Step 2 is NEVER sent
```

**Same protection for all stop statuses:**

```
Contact replies      → status: "replied"      → never picked up again
Contact unsubscribes → status: "unsubscribed"  → never picked up again
Email bounces        → status: "bounced"       → never picked up again
Sequence finishes    → status: "completed"     → never picked up again

Only status = "pending" recipients are fetched by the scheduler.
```

**Flow diagram:**

```
Step 1 sent → wait 3 days → Step 2 sent → wait 5 days → Step 3 sent → COMPLETED
                  │
                  │ (contact replies on Day 2)
                  ▼
         status: "replied"
         Step 2 NEVER sent
         Sequence STOPPED
```

**Where the protection happens (3 layers):**

```
Layer 1 — update-recipient-status (Supabase edge function):
  Sets status from "pending" → "replied"
  Updates ALL campaign_recipients for this contact

Layer 2 — get-campaign-queue (Supabase edge function):
  Only returns .eq("status", "pending")
  "replied" contacts are never returned to scheduler

Layer 3 — Scheduler (runner.ts):
  Only processes what it receives from the edge function
  Never sees replied/bounced/unsubscribed contacts
```

---

## 1. SCHEDULER CODE — Implemented vs Missing

### Implemented (18 items)

| SRS Requirement | ID | File | Notes |
|---|---|---|---|
| **Cron trigger every hour** | — | `scheduler/index.ts` | `cron.schedule("0 * * * *", ...)` |
| **Fetch active campaigns** | FR-01 | `scheduler/fetchCampaigns.ts` | Fetches via Supabase edge function (`get-campaign-queue`) |
| **Daily sender limit** | FR-06, FR-07 | `db/client.ts` | `getSenderTodayCount()` counts from `email_logs.created_at` |
| **Sending window check** | FR-04 | `utils/helpers.ts` | `isWithinSendingWindow()` — per-contact `time_from`/`time_to` in UTC |
| **Template resolution** | FR-15 | `utils/helpers.ts` | `getTemplateForStep()` — resolved templates + fallback + randomize |
| **Sequence priority sorting** | FR-18, FR-19 | `scheduler/runner.ts` | `current_step DESC`, `step_entered_at ASC`, `contact_id ASC` |
| **Skip if previous run in progress** | — | `utils/lock.ts` | `acquireLock()`/`releaseLock()` (in-memory, Redis-swappable) |
| **Tracking integration** | — | `utils/helpers.ts` | `generateTracking()` — calls tracking API for open/click/unsubscribe |
| **n8n webhook dispatch** | — | `scheduler/runner.ts` | POST email array to n8n webhook |
| **Recipient status update** | — | `scheduler/fetchCampaigns.ts` | `markRecipientsInQueue()` — prevents duplicate picks |
| **Secrets in .env** | NFR/Security | `scheduler/index.ts` | dotenv + startup validation of required vars |
| **Modular file structure** | SRS Section 7 | all | `scheduler/`, `db/`, `utils/` per SRS |
| **Structured logging (Pino)** | NFR 5.3 | `utils/logger.ts` | Pino JSON output, `pino-pretty` for dev |
| **scheduler_logs table** | SRS Section 4.6 | `db/client.ts` | Migration + `writeSchedulerLog()` every run |
| **step_entered_at column** | FR-19 | migration | Added to `campaign_recipients`, backfilled from `enrolled_at` |
| **Error alerting stubs** | NFR 5.3 | `utils/alerts.ts` | `alertFailure()` wired into runner error paths |
| **Distributed lock stubs** | NFR 5.2 | `utils/lock.ts` | API ready for Redis/pg swap |
| **Stale queue cleanup** | NFR 5.2 | `db/client.ts` | `resetStaleRecipients()` — resets `in_queue` > 30 min back to `pending` at start of each run |
| **Exclude already-emailed-today** | FR-14 | `db/client.ts` + `scheduler/runner.ts` | `getContactsEmailedToday()` batch query + in-memory `sentThisRun` Set — prevents cross-campaign same-day duplicates |

### Still Missing (2 items — all low priority, handled by edge function)

| SRS Requirement | ID | What's Missing | Impact |
|---|---|---|---|
| **Campaign date window** | FR-02 | No `end_date` column on campaigns, no date check in scheduler | Low — campaigns are manually paused/completed |
| **Exclude unsubscribed/bounced/dnc** | FR-12, FR-13 | Filtering delegated to edge function, not verified locally | Low — edge function handles it |

### Deferred to Later Phase (11 items)

| SRS Requirement | ID | Why Deferred |
|---|---|---|
| **Hourly sender limit** | FR-06, FR-08 | ~5 emails/hr, daily limit is enough |
| **Remaining capacity formula** | FR-08 | Deferred with hourly limit |
| **Aggregate capacity across senders** | FR-10 | Single sender per campaign currently |
| **Round-robin sender assignment** | FR-23 | Deferred until multi-sender |
| **email_queue table** | Section 4.5 | n8n direct send works, `email_logs` tracks everything |
| **Warmup ramp support** | FR-11 | `warmup_status` exists but unused |
| **Per-contact opt-out preferences** | FR-16 | Not needed yet |
| **Per-step reply-to/from-name** | FR-26 | Not needed yet |
| **Slack alerting** | NFR 5.3 | Stubs ready, wire when needed |
| **Distributed lock (Redis/pg)** | NFR 5.2 | Swap when deploying multi-instance |
| **emails_sent_today column** | — | Counted from `email_logs` instead |

---

## 2. DATABASE SCHEMA — Column-by-Column Comparison

### 2.1 CAMPAIGNS (SRS: `campaigns`)

Your table: `campaigns` — exists in outreach-vibe

| SRS Column | SRS Type | Your Column | Your Type | Status |
|---|---|---|---|---|
| `id` | uuid PK | `id` | uuid PK | Done |
| `name` | text | `name` | text | Done |
| `status` | text (active/paused/completed/draft) | `status` | text (draft/scheduled/active/paused/completed/archived) | Done |
| `start_date` | timestamptz | `scheduled_at` | timestamptz | Done (different name) |
| `end_date` | timestamptz | — | — | LATER |
| `send_time_window` | jsonb | `settings` | jsonb (contains sendWindow, sendDays, timezone) | Done |
| `created_at` | timestamptz | `created_at` | timestamptz | Done |

### 2.2 CAMPAIGN_SENDERS (SRS: `campaign_senders`) — LATER

**DOES NOT EXIST** — deferred. Currently using `campaigns.sender_id` (1 sender per campaign).

### 2.3 EMAIL_SENDERS (SRS: `email_senders`)

Your table: `senders` — exists in outreach-vibe

| SRS Column | SRS Type | Your Column | Your Type | Status |
|---|---|---|---|---|
| `id` | uuid PK | `id` | uuid PK | Done |
| `email` | text | `email` | text | Done |
| `display_name` | text | `name` | text | Done |
| `daily_limit` | integer | `daily_limit` | integer (default 50) | Done |
| `hourly_limit` | integer | — | — | LATER |
| `emails_sent_today` | integer | — | — | LATER (counted from email_logs) |
| `emails_sent_this_hour` | integer | — | — | LATER |
| `last_reset_date` | date | — | — | LATER |
| `last_reset_hour` | integer | — | — | LATER |
| `is_active` | boolean | `is_active` | boolean | Done |
| `warmup_ramp` | boolean | `warmup_status` | text | Partial |

### 2.4 CAMPAIGN_CONTACTS (SRS: `campaign_contacts`)

Your table: `campaign_recipients` — exists in outreach-vibe

| SRS Column | SRS Type | Your Column | Your Type | Status |
|---|---|---|---|---|
| `id` | uuid PK | `id` | uuid PK | Done |
| `campaign_id` | uuid FK | `campaign_id` | uuid FK | Done |
| `contact_id` | uuid FK | `contact_id` | uuid FK | Done |
| `sequence_step` | integer | `current_step` | integer (default 1) | Done |
| `step_entered_at` | timestamptz | `step_entered_at` | timestamptz | Done |
| `status` | text | `status` | text | Partial (missing `complained`, `dnc`) |
| `last_emailed_at` | timestamptz | `last_sent_at` | timestamptz | Done |

### 2.5 EMAIL_QUEUE (SRS: `email_queue`) — LATER

**DOES NOT EXIST** — sends directly to n8n. Not needed at current volume.

### 2.6 SCHEDULER_LOGS (SRS: `scheduler_logs`) — DONE

Migration created + code writes every run. All SRS columns implemented.

---

## 3. COLUMN NAME DIFFERENCES (SRS vs Yours)

| SRS Name | Your Name | Table |
|---|---|---|
| `sequence_step` | `current_step` | campaign_recipients |
| `last_emailed_at` | `last_sent_at` | campaign_recipients |
| `display_name` | `name` | senders |
| `start_date` | `scheduled_at` | campaigns |
| `warmup_ramp` (boolean) | `warmup_status` (text) | senders |
| `campaign_contacts` | `campaign_recipients` | — |
| `email_senders` | `senders` | — |

---

## 4. FILE STRUCTURE — DONE

```
src/
  scheduler/
    index.ts            ← Entry point: dotenv, env validation, cron setup
    runner.ts           ← Main runScheduler() orchestrator (steps 1–6)
    fetchCampaigns.ts   ← Fetch active campaigns + mark recipients in_queue
  db/
    client.ts           ← Supabase config, env(), supabaseFetch(), writeSchedulerLog(), getSenderTodayCount()
  utils/
    logger.ts           ← Pino structured JSON logger
    helpers.ts          ← isWithinSendingWindow(), getTemplateForStep(), generateTracking()
    lock.ts             ← Distributed run lock (in-memory, Redis-swappable)
    alerts.ts           ← Alert stubs (alertFailure, alertDailyDigest)
.env                    ← Secrets (never committed)
.env.example            ← Template for env vars
package.json            ← npm start / npm run dev
```

### Import Graph

```
scheduler/index.ts
  └── scheduler/runner.ts
        ├── scheduler/fetchCampaigns.ts → db/client.ts → utils/logger.ts
        ├── db/client.ts
        ├── utils/helpers.ts → db/client.ts, utils/logger.ts
        ├── utils/logger.ts
        ├── utils/lock.ts
        └── utils/alerts.ts → utils/logger.ts
```

### NPM Scripts

| Script | Command | Use |
|---|---|---|
| `npm start` | `ts-node src/scheduler/index.ts` | Production — raw JSON logs |
| `npm run dev` | `ts-node src/scheduler/index.ts \| pino-pretty` | Dev — pretty colored logs |

---

## 5. MIGRATIONS — Applied vs Remaining

### Applied

| Migration | What |
|---|---|
| `20260218064229_add_time_from_time_to_to_contacts.sql` | `time_from`/`time_to` on contacts |
| `20260305070925_add_scheduler_logs_table.sql` | `scheduler_logs` table + indexes |
| `20260305073837_add_step_entered_at_to_campaign_recipients.sql` | `step_entered_at` + backfill + priority index |

### Remaining (all deferred)

```sql
-- LATER: campaigns end_date
ALTER TABLE campaigns ADD COLUMN end_date TIMESTAMPTZ;

-- LATER: email_queue table (not needed at current volume)
-- LATER: hourly limit columns on senders
```

---

## 6. SUMMARY SCORE

| Category | Done | Total | % |
|---|---|---|---|
| MUST requirements (scheduler logic) | ~14 | ~22 | ~64% |
| SHOULD requirements | ~0 | ~5 | 0% |
| MAY requirements | ~1 | ~1 | ~100% |
| Non-functional requirements | ~6 | ~8 | ~75% |
| DB tables (exist) | 4/6 | 6 | 67% |
| DB columns (on existing tables) | ~17 | ~22 | ~77% |
| **Overall** | **~42** | **~64** | **~66%** |

> Note: Many "missing" items are LATER/SHOULD priority. All critical MUST items for current volume are done.

---

## 7. WHAT'S LEFT — Priority Order

### Completed

1. ~~Move hardcoded secrets to `.env`~~
2. ~~Restructure into modular files~~ (`scheduler/`, `db/`, `utils/`)
3. ~~Create `scheduler_logs` table~~ (migration + code)
4. ~~Add `step_entered_at` column~~ (migration + backfill)
5. ~~Implement sequence priority sorting~~ (step DESC, entered ASC, contact_id ASC)
6. ~~Replace console logger with Pino~~ (structured JSON, `pino-pretty` for dev)
7. ~~Stale queue cleanup~~ — `resetStaleRecipients()` resets stuck `in_queue` > 30 min back to `pending`

### Deferred — Later Phase (when volume grows)

- **Add `end_date` to campaigns** — campaign window check
- **Distributed lock (Redis/pg)** — for multi-instance deploy
- **Slack alerting** — wire webhook to `utils/alerts.ts`
- **email_queue table** — dispatch queue between scheduler and n8n
- **Hourly sender limit** — `hourly_limit`, `emails_sent_this_hour`
- **Multi-sender support** — `campaign_senders` table + round-robin
- **Warmup ramp** — warmup override for sender limits
- **Per-contact opt-out preferences** — day/time preferences
- **Per-step reply-to/from-name** — template-level overrides

---

## 8. TEST RESULTS — March 5, 2026

### Test 1: Basic Email Sending — PASSED

**Setup:** Campaign "test" with 2 contacts (Kumar Saini, Simeon Prokopov), 4 step sequence, tracking OFF, `MAX_EMAILS_PER_RUN=2`.

**Result:**
```
Campaigns : 1
Sent      : 2
Skipped   : 0
Duration  : 4816ms
```

Both emails successfully sent to n8n webhook. Edge function correctly:
- Fetched 2 pending recipients
- Marked them as `in_queue`
- Created `email_logs` with status "queued"
- Resolved templates (Step 1: "Initial Outreach / Greeting")
- Returned `pending_count: 2` with full contact + template data

Scheduler correctly:
- Passed sending window check (contacts have `time_from: 09:00`, `time_to: 18:00`)
- Passed daily limit check (sender `sahil@stacx24.com`, limit: 50)
- Passed dedup check (no emails sent today)
- Built email payloads and POSTed to n8n

### Tests Still Needed

| Test | What to Verify | How to Test |
|---|---|---|
| **Reply stops sequence** | If contact replies after Step 1, Step 2 should NOT be sent | 1. Send Step 1 (done). 2. Call `update-recipient-status` with `status: "replied"`. 3. Wait for `wait_days` to pass. 4. Run scheduler — recipient should NOT appear |
| **Wait days spacing** | Step 2 should only send after `wait_days` from Step 1 | 1. After Step 1 is sent, check `next_send_at` is set correctly. 2. Run scheduler before `next_send_at` — should skip. 3. Run scheduler after `next_send_at` — should send Step 2 |
| **Daily limit enforcement** | Sender should stop after hitting daily limit | 1. Set sender `daily_limit: 1`. 2. Run scheduler with 2 recipients — only 1 should send |
| **Cross-campaign dedup** | Same contact in 2 campaigns should only get 1 email per day | 1. Add same contact to 2 active campaigns. 2. Run scheduler — first campaign sends, second campaign skips that contact |
| **Sending window skip** | Contacts outside time window should be skipped and reset to pending | 1. Set contact `time_from: 01:00`, `time_to: 02:00` (outside current time). 2. Run scheduler — should skip and reset to pending |
| **Bounce stops sequence** | Bounced contact should not receive further emails | 1. Set recipient status to "bounced". 2. Run scheduler — should not appear |
| **Stale queue cleanup** | Recipients stuck as `in_queue` > 30 min should be reset | 1. Manually set recipient to `in_queue` with old `updated_at`. 2. Run scheduler — Step 0 should reset them |
| **Max emails per run** | `MAX_EMAILS_PER_RUN` should cap total emails | 1. Set `MAX_EMAILS_PER_RUN=1` with 2 pending. 2. Run scheduler — only 1 should send |
