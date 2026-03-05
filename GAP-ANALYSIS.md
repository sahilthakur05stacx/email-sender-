# Gap Analysis — Existing Code & DB vs SRS v1.0

> Last updated: March 5, 2026
> Compared against: outreach-vibe Supabase schema + email-sender/src/scheduler.ts

---

## 1. SCHEDULER CODE — What's Done vs Missing

### Completed (Partially or Fully)

| SRS Requirement | Status | Notes |
|---|---|---|
| **Cron trigger every hour** | Done | `cron.schedule("0 * * * *", ...)` works |
| **Fetch active campaigns** (FR-01) | Partial | Fetches via Supabase edge function (`get-campaign-queue`), but delegates filtering to the API — no local `status = "active"` check |
| **Daily sender limit** (FR-06, FR-07) | Partial | `daily_limit` checked, but counted from `email_logs.created_at` — no `emails_sent_today` column on senders table |
| **Sending window check** (FR-04) | Done | `isWithinSendingWindow()` works with per-contact `time_from`/`time_to` from contacts table |
| **Template resolution** (FR-15) | Done | `getTemplateForStep()` handles resolved templates + fallback + randomize |
| **Skip if previous run in progress** | Partial | In-memory `isRunning` flag — NOT a distributed lock (fails on restart/multi-instance) |
| **Tracking integration** | Done | `generateTracking()` calls tracking API with open/click/unsubscribe support |
| **n8n webhook dispatch** | Done | Sends email payload to n8n for actual delivery |
| **Recipient status update** | Done | Marks recipients as `in_queue` before sending to prevent duplicates |

### Missing (Not Implemented)

| SRS Requirement | ID | Priority | What's Missing |
|---|---|---|---|
| **Hardcoded credentials** | NFR/Security | DONE | ~~Hardcoded in scheduler.ts~~ — Fixed: now loads from `.env` via dotenv with startup validation |
| **Hourly sender limit** | FR-06, FR-08 | LATER | No `hourly_limit` or `emails_sent_this_hour` — not needed at current volume (~5 emails/hr). Daily limit is sufficient |
| **Remaining capacity formula** | FR-08 | LATER | `MIN(daily_remaining, hourly_remaining)` — deferred with hourly limit. Currently uses `daily_limit` only |
| **Aggregate capacity across senders** | FR-10 | LATER | Current code has 1 sender per campaign (`campaigns.sender_id` FK) — multi-sender support deferred |
| **Sequence priority sorting** | FR-18, FR-19 | DONE | Sorts by `current_step DESC`, `step_entered_at ASC`, `contact_id ASC` — higher-step contacts always prioritized |
| **Round-robin sender assignment** | FR-23 | LATER | No round-robin — single sender per campaign. Deferred until multi-sender is implemented |
| **email_queue table** | Section 4.5 | LATER | Doesn't write to `email_queue` — sends directly to n8n webhook. Deferred — `email_logs` + `campaign_recipients` already track emails at current volume |
| **scheduler_logs table** | Section 4.6 | MUST | No logging to DB — only `console.log` to stdout |
| **Campaign date window** | FR-02 | MUST | No `start_date`/`end_date` validation — `campaigns.end_date` column doesn't even exist |
| **Exclude unsubscribed/bounced/dnc** | FR-12, FR-13 | MUST | Filtering delegated entirely to the edge function — not verified locally in scheduler |
| **Exclude already-emailed-today** | FR-14 | MUST | Not checked in scheduler code (edge function may handle it) |
| **Structured logging (Pino)** | NFR 5.3 | MUST | Uses raw `console.log` with emojis and PII (contact emails in logs) — no structured JSON logging |
| **Distributed lock** | NFR 5.2 | MUST | Only in-memory `isRunning` — doesn't survive restarts or multiple instances |
| **DB transactions / idempotency** | NFR 5.2 | MUST | No transaction wrapping — crash mid-run can create duplicate queue entries |
| **Error alerting (Slack)** | NFR 5.3 | MUST | No Slack webhook or alert mechanism for critical errors |
| **Warmup ramp support** | FR-11 | SHOULD | No `warmup_ramp` logic — `senders.warmup_status` exists as text but is unused by scheduler |
| **Per-contact opt-out preferences** | FR-16 | SHOULD | Not implemented |
| **Per-step reply-to/from-name** | FR-26 | SHOULD | Not implemented |
| **Timezone-aware send windows** | FR-05 | MAY | Handled externally by n8n workflow, not in scheduler |

---

## 2. DATABASE SCHEMA — Column-by-Column Comparison

### 2.1 CAMPAIGNS (SRS: `campaigns`)

Your table: `campaigns` — exists in outreach-vibe

| SRS Column | SRS Type | Your Column | Your Type | Status |
|---|---|---|---|---|
| `id` | uuid PK | `id` | uuid PK | Done |
| `name` | text | `name` | text | Done |
| `status` | text (active/paused/completed/draft) | `status` | text (draft/scheduled/active/paused/completed/archived) | Done (you have extra statuses — fine) |
| `start_date` | timestamptz | `scheduled_at` | timestamptz | Partial — different name, similar purpose |
| `end_date` | timestamptz | — | — | **MISSING** |
| `send_time_window` | jsonb | `settings` | jsonb (contains sendWindow, sendDays, timezone) | Done (embedded in settings jsonb) |
| `created_at` | timestamptz | `created_at` | timestamptz | Done |

**Extra columns you have (not in SRS):** `organization_id`, `sender_id`, `sequence_id`, `segment_id`, `description`, `behaviors`, `sender` (jsonb), `stats`, `tracking_enabled`, `track_opens`, `track_clicks`, `started_at`, `completed_at`, `updated_at`

### 2.2 CAMPAIGN_SENDERS (SRS: `campaign_senders`) — LATER

Your table: **DOES NOT EXIST** — deferred to later phase

| SRS Column | SRS Type | Status |
|---|---|---|
| `id` | uuid PK | LATER |
| `campaign_id` | uuid FK | LATER — currently `campaigns.sender_id` (single FK, 1 sender per campaign) |
| `sender_id` | uuid FK | LATER |
| `is_active` | boolean | LATER |

> Multi-sender support (FR-10, FR-23) will be implemented in a future phase. Current system uses single sender per campaign via `campaigns.sender_id`.

### 2.3 EMAIL_SENDERS (SRS: `email_senders`)

Your table: `senders` — exists in outreach-vibe

| SRS Column | SRS Type | Your Column | Your Type | Status |
|---|---|---|---|---|
| `id` | uuid PK | `id` | uuid PK | Done |
| `email` | text | `email` | text | Done |
| `display_name` | text | `name` | text | Done (name differs) |
| `daily_limit` | integer | `daily_limit` | integer (default 50) | Done |
| `hourly_limit` | integer | — | — | LATER — not needed at current volume (~5 emails/hr) |
| `emails_sent_today` | integer | — | — | **MISSING** (currently counted from email_logs) |
| `emails_sent_this_hour` | integer | — | — | LATER — deferred with hourly limit |
| `last_reset_date` | date | — | — | **MISSING** |
| `last_reset_hour` | integer | — | — | LATER — deferred with hourly limit |
| `is_active` | boolean | `is_active` | boolean | Done |
| `warmup_ramp` | boolean | `warmup_status` | text (default 'not_started') | Partial — text vs boolean |

**Extra columns you have:** `organization_id`, `provider`, `health_score`, `physical_address`, `updated_at`

**Related table:** `sender_stats` exists with `emails_sent`, `open_rate`, `reply_rate` — but no hourly/daily counters

### 2.4 CAMPAIGN_CONTACTS (SRS: `campaign_contacts`)

Your table: `campaign_recipients` — exists in outreach-vibe

| SRS Column | SRS Type | Your Column | Your Type | Status |
|---|---|---|---|---|
| `id` | uuid PK | `id` | uuid PK | Done |
| `campaign_id` | uuid FK | `campaign_id` | uuid FK | Done |
| `contact_id` | uuid FK | `contact_id` | uuid FK | Done |
| `sequence_step` | integer | `current_step` | integer (default 1) | Done (name differs) |
| `step_entered_at` | timestamptz | `step_entered_at` | timestamptz | Done (added, backfilled from enrolled_at) |
| `status` | text (active/unsubscribed/bounced/complained/dnc/completed) | `status` | text (pending/active/paused/completed/replied/bounced/unsubscribed/skipped) | Partial — missing `complained` and `dnc` |
| `last_emailed_at` | timestamptz | `last_sent_at` | timestamptz | Done (name differs) |

**Extra columns you have:** `organization_id`, `total_steps`, `paused_reason`, `next_send_at`, `sent_at`, `opened_at`, `clicked_at`, `replied_at`, `engagement` (jsonb), `error_message`, `enrolled_at`, `completed_at`, `updated_at`

### 2.5 EMAIL_QUEUE (SRS: `email_queue`)

Your table: **DOES NOT EXIST**

| SRS Column | SRS Type | Status |
|---|---|---|
| `id` | uuid PK | **MISSING** |
| `campaign_id` | uuid FK | **MISSING** |
| `sender_id` | uuid FK | **MISSING** |
| `contact_id` | uuid FK | **MISSING** |
| `template_id` | uuid FK | **MISSING** |
| `sequence_step` | integer | **MISSING** |
| `status` | text (pending/sent/failed/skipped) | **MISSING** |
| `scheduled_at` | timestamptz | **MISSING** |
| `sent_at` | timestamptz | **MISSING** |
| `error_message` | text | **MISSING** |
| `created_at` | timestamptz | **MISSING** |

> Currently emails go directly from scheduler -> n8n webhook. No queue table in between.

### 2.6 SCHEDULER_LOGS (SRS: `scheduler_logs`)

Your table: **DOES NOT EXIST**

| SRS Column | SRS Type | Status |
|---|---|---|
| `id` | uuid PK | **MISSING** |
| `run_at` | timestamptz | **MISSING** |
| `campaigns_processed` | integer | **MISSING** |
| `total_slots_available` | integer | **MISSING** |
| `total_emails_queued` | integer | **MISSING** |
| `duration_ms` | integer | **MISSING** |
| `error` | text | **MISSING** |
| `meta` | jsonb | **MISSING** |

> No run auditing at all — only console.log output.

---

## 3. COLUMN NAME DIFFERENCES (SRS vs Yours)

| SRS Name | Your Name | Table | Notes |
|---|---|---|---|
| `sequence_step` | `current_step` | campaign_recipients | Same purpose, different name |
| `last_emailed_at` | `last_sent_at` | campaign_recipients | Same purpose, different name |
| `display_name` | `name` | senders | Same purpose, different name |
| `start_date` | `scheduled_at` | campaigns | Similar purpose |
| `warmup_ramp` (boolean) | `warmup_status` (text) | senders | Different type — text allows more states |
| `campaign_contacts` | `campaign_recipients` | — | Different table name, same purpose |
| `email_senders` | `senders` | — | Different table name, same purpose |

---

## 4. TABLES THAT EXIST BUT ARE NOT IN SRS

These are tables you already have that the SRS doesn't mention but are relevant:

| Your Table | Purpose | Used by Scheduler? |
|---|---|---|
| `email_logs` | Tracks every email sent (status, tracking, open/click counts) | Yes — used for daily limit counting |
| `email_events` | Individual event tracking (sent, opened, clicked, bounced, etc.) | No |
| `contacts` | Full contact data (email, name, company, time_from, time_to) | Yes — contact details + sending window |
| `templates` | Email templates with step_number, subject, body, body_html | Yes — template resolution |
| `template_sequences` | Groups templates into sequences | Yes — via campaign.sequence_id |
| `unsubscribes` | Unsubscribe records per org/email | No (should be checked) |
| `tracked_links` | Click tracking per email | No |
| `link_clicks` | Individual click events | No |
| `unsubscribe_tokens` | One-click unsubscribe tokens | No |
| `segments` / `segment_contacts` | Contact segmentation | No (used at campaign creation) |
| `sender_stats` | Aggregate sender performance | No |

---

## 5. FILE STRUCTURE — Current vs Required

```
CURRENT:                          SRS REQUIRED:
src/                              src/
  scheduler.ts  (everything)        scheduler/
                                      index.ts        <- Entry point, cron setup
                                      runner.ts       <- Main orchestrator (steps 1-6)
                                      fetchCampaigns.ts
                                    db/
                                      client.ts       <- Supabase/pg connection
                                    utils/
                                      logger.ts       <- Pino structured logger
                                      lock.ts         <- Distributed run lock
                                      alerts.ts       <- Slack/email alerting
```

---

## 6. MIGRATION NEEDED — Missing Tables & Columns

### New Tables to Create

```sql
-- 1. campaign_senders (multi-sender support) — LATER PHASE
-- CREATE TABLE campaign_senders (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
--   sender_id UUID NOT NULL REFERENCES senders(id) ON DELETE CASCADE,
--   is_active BOOLEAN DEFAULT true,
--   created_at TIMESTAMPTZ DEFAULT now(),
--   UNIQUE(campaign_id, sender_id)
-- );

-- 2. email_queue (dispatch list)
CREATE TABLE email_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES senders(id),
  contact_id UUID NOT NULL REFERENCES contacts(id),
  template_id UUID REFERENCES templates(id) ON DELETE SET NULL,
  sequence_step INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(campaign_id, contact_id, sequence_step, scheduled_at::date)
);

-- 3. scheduler_logs (run auditing)
CREATE TABLE scheduler_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  campaigns_processed INTEGER DEFAULT 0,
  total_slots_available INTEGER DEFAULT 0,
  total_emails_queued INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  error TEXT,
  meta JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Columns to Add to Existing Tables

```sql
-- senders: add daily tracking columns
ALTER TABLE senders ADD COLUMN emails_sent_today INTEGER DEFAULT 0;
ALTER TABLE senders ADD COLUMN last_reset_date DATE DEFAULT CURRENT_DATE;

-- LATER (hourly limit — not needed at current volume ~5 emails/hr):
-- ALTER TABLE senders ADD COLUMN hourly_limit INTEGER DEFAULT 20;
-- ALTER TABLE senders ADD COLUMN emails_sent_this_hour INTEGER DEFAULT 0;
-- ALTER TABLE senders ADD COLUMN last_reset_hour INTEGER DEFAULT 0;

-- campaign_recipients: add step_entered_at for priority sorting
ALTER TABLE campaign_recipients ADD COLUMN step_entered_at TIMESTAMPTZ DEFAULT now();

-- campaigns: add end_date for campaign window check
ALTER TABLE campaigns ADD COLUMN end_date TIMESTAMPTZ;
```

### Indexes to Add

```sql
CREATE INDEX idx_campaigns_status ON campaigns(status);
CREATE INDEX idx_campaign_recipients_campaign_status ON campaign_recipients(campaign_id, status);
CREATE INDEX idx_senders_is_active ON senders(is_active);
CREATE INDEX idx_email_queue_status ON email_queue(status);
-- LATER: CREATE INDEX idx_campaign_senders_campaign ON campaign_senders(campaign_id);
```

---

## 7. SUMMARY SCORE

| Category | Done | Total | % |
|---|---|---|---|
| MUST requirements (scheduler logic) | ~5 | ~22 | ~23% |
| SHOULD requirements | ~0 | ~5 | 0% |
| MAY requirements | ~1 | ~1 | ~100% |
| Non-functional requirements | ~1 | ~8 | ~12% |
| DB tables (exist) | 3/6 | 6 | 50% |
| DB columns (on existing tables) | ~15 | ~22 | ~68% |
| **Overall** | **~25** | **~64** | **~39%** |

---

## 8. TOP PRIORITIES — Fix Order

1. ~~**CRITICAL: Move hardcoded secrets to `.env`**~~ — DONE
2. **Create `scheduler_logs` table** — log every run to DB for auditing
3. **Add missing columns** — `emails_sent_today`, `last_reset_date`, `step_entered_at`, `end_date`
4. **Implement sequence priority sorting** — sort by `current_step DESC`, `step_entered_at ASC`, `contact_id ASC`
5. **Add `scheduler_logs`** — log every run to DB
7. **Replace `console.log` with Pino** — structured JSON logging, no PII
8. **Add distributed lock** — replace in-memory `isRunning` with DB advisory lock
9. **Add Slack alerting** — notify on critical errors

### Deferred to Later Phase
- **email_queue table** (Section 4.5) — dispatch queue between scheduler and n8n. Deferred — `email_logs` + `campaign_recipients` already track emails at current volume
- **Hourly sender limit** (FR-06, FR-08) — `hourly_limit`, `emails_sent_this_hour`, `last_reset_hour` on senders. Not needed at current volume (~5 emails/hr), daily limit is sufficient
- **Remaining capacity formula** (FR-08) — `MIN(daily_remaining, hourly_remaining)` — deferred with hourly limit
- **Multi-sender support** (FR-10) — `campaign_senders` table, aggregate capacity across senders
- **Round-robin sender assignment** (FR-23) — weighted round-robin distribution across multiple senders
- **Warmup ramp support** (FR-11) — warmup override logic for sender limits
- **Per-contact opt-out preferences** (FR-16) — respect per-contact day/time preferences
- **Per-step reply-to/from-name** (FR-26) — template-level overrides
