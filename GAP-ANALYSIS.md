# Gap Analysis — Existing Code & DB vs SRS v1.0

> Last updated: March 5, 2026
> Compared against: outreach-vibe Supabase schema + email-sender/src/ (modular structure)

---

## 1. SCHEDULER CODE — Implemented vs Missing

### Implemented

| SRS Requirement | ID | Notes |
|---|---|---|
| **Cron trigger every hour** | — | `cron.schedule("0 * * * *", ...)` in `scheduler/index.ts` |
| **Fetch active campaigns** | FR-01 | `scheduler/fetchCampaigns.ts` fetches via Supabase edge function (`get-campaign-queue`) |
| **Daily sender limit** | FR-06, FR-07 | `daily_limit` checked via `getSenderTodayCount()` counting from `email_logs.created_at` |
| **Sending window check** | FR-04 | `isWithinSendingWindow()` in `utils/helpers.ts` — per-contact `time_from`/`time_to` |
| **Template resolution** | FR-15 | `getTemplateForStep()` in `utils/helpers.ts` — resolved templates + fallback + randomize |
| **Sequence priority sorting** | FR-18, FR-19 | Sorts by `current_step DESC`, `step_entered_at ASC`, `contact_id ASC` in `runner.ts` |
| **Skip if previous run in progress** | — | `utils/lock.ts` with `acquireLock()`/`releaseLock()` (in-memory, Redis-swappable) |
| **Tracking integration** | — | `generateTracking()` in `utils/helpers.ts` — calls tracking API with open/click/unsubscribe |
| **n8n webhook dispatch** | — | Sends email payload array to n8n in `runner.ts` |
| **Recipient status update** | — | Marks recipients as `in_queue` via `markRecipientsInQueue()` before sending |
| **Secrets in .env** | NFR/Security | All credentials loaded from `.env` via dotenv with startup validation |
| **Modular file structure** | NFR | Split into `scheduler/`, `db/`, `utils/` per SRS (see Section 5) |
| **Structured logging (Pino)** | NFR 5.3 | `utils/logger.ts` uses Pino with structured JSON output, `pino-pretty` for dev |
| **scheduler_logs table** | Section 4.6 | Migration exists + `writeSchedulerLog()` in `db/client.ts` writes every run |
| **step_entered_at column** | FR-19 | Migration exists on `campaign_recipients`, backfilled from `enrolled_at` |
| **Error alerting stubs** | NFR 5.3 | `utils/alerts.ts` with `alertFailure()` wired into runner error paths |
| **Distributed lock stubs** | NFR 5.2 | `utils/lock.ts` with `acquireLock()`/`releaseLock()` API — ready for Redis/pg swap |

### Still Missing

| SRS Requirement | ID | Priority | What's Missing |
|---|---|---|---|
| **Campaign date window** | FR-02 | MUST | No `start_date`/`end_date` validation — `campaigns.end_date` column doesn't exist |
| **Exclude unsubscribed/bounced/dnc** | FR-12, FR-13 | MUST | Filtering delegated entirely to the edge function — not verified locally in scheduler |
| **Exclude already-emailed-today** | FR-14 | MUST | Not checked in scheduler code (edge function may handle it) |
| **DB transactions / idempotency** | NFR 5.2 | MUST | No transaction wrapping — crash mid-run can create duplicate queue entries |

### Deferred to Later Phase

| SRS Requirement | ID | Why Deferred |
|---|---|---|
| **Hourly sender limit** | FR-06, FR-08 | Not needed at current volume (~5 emails/hr). Daily limit is sufficient |
| **Remaining capacity formula** | FR-08 | `MIN(daily_remaining, hourly_remaining)` — deferred with hourly limit |
| **Aggregate capacity across senders** | FR-10 | Current code has 1 sender per campaign — multi-sender support deferred |
| **Round-robin sender assignment** | FR-23 | No round-robin — single sender per campaign. Deferred until multi-sender |
| **email_queue table** | Section 4.5 | Sends directly to n8n webhook. `email_logs` + `campaign_recipients` already track emails |
| **Warmup ramp support** | FR-11 | No `warmup_ramp` logic — `senders.warmup_status` exists but unused by scheduler |
| **Per-contact opt-out preferences** | FR-16 | Not implemented |
| **Per-step reply-to/from-name** | FR-26 | Not implemented |
| **Wire Slack alerting** | NFR 5.3 | `utils/alerts.ts` stubs ready — add Slack webhook POST when needed |
| **Distributed lock (Redis/pg)** | NFR 5.2 | `utils/lock.ts` API ready — swap in-memory to Redis/pg for multi-instance |
| **emails_sent_today column** | — | Not needed — scheduler counts from `email_logs` directly via `getSenderTodayCount()` |

---

## 2. DATABASE SCHEMA — Column-by-Column Comparison

### 2.1 CAMPAIGNS (SRS: `campaigns`)

Your table: `campaigns` — exists in outreach-vibe

| SRS Column | SRS Type | Your Column | Your Type | Status |
|---|---|---|---|---|
| `id` | uuid PK | `id` | uuid PK | Done |
| `name` | text | `name` | text | Done |
| `status` | text (active/paused/completed/draft) | `status` | text (draft/scheduled/active/paused/completed/archived) | Done (you have extra statuses — fine) |
| `start_date` | timestamptz | `scheduled_at` | timestamptz | Done (different name, similar purpose) |
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
| `hourly_limit` | integer | — | — | LATER — not needed at current volume |
| `emails_sent_today` | integer | — | — | LATER — counted from `email_logs` instead |
| `emails_sent_this_hour` | integer | — | — | LATER — deferred with hourly limit |
| `last_reset_date` | date | — | — | LATER — not needed with `email_logs` count approach |
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

### 2.5 EMAIL_QUEUE (SRS: `email_queue`) — LATER

Your table: **DOES NOT EXIST** — deferred

> Currently emails go directly from scheduler -> n8n webhook. No queue table in between. Deferred — `email_logs` + `campaign_recipients` already track emails at current volume.

### 2.6 SCHEDULER_LOGS (SRS: `scheduler_logs`) — DONE

Your table: `scheduler_logs` — migration created

| SRS Column | SRS Type | Status |
|---|---|---|
| `id` | uuid PK | Done |
| `run_at` | timestamptz | Done |
| `campaigns_processed` | integer | Done |
| `total_slots_available` | integer | Done |
| `total_emails_sent` | integer | Done (SRS calls it `total_emails_queued`) |
| `total_skipped` | integer | Done (extra — not in SRS) |
| `duration_ms` | integer | Done |
| `status` | text | Done (extra — not in SRS) |
| `error` | text | Done |
| `meta` | jsonb | Done |
| `created_at` | timestamptz | Done |

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

## 5. FILE STRUCTURE — DONE

> Restructured from single `scheduler.ts` into modular files.

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
    lock.ts             ← Distributed run lock (in-memory, Redis-swappable)
    alerts.ts           ← Alert stubs (alertFailure, alertDailyDigest)
```

### Key Design Decisions:
- **Lazy env vars**: `db/client.ts` exports `env()` function (not top-level constants) so `dotenv.config()` runs first
- **Lock module**: `acquireLock()`/`releaseLock()` API ready for Redis swap — no changes needed in runner
- **Logger**: Pino structured JSON — `npm start` for raw JSON, `npm run dev` for pretty colored output
- **fetchCampaigns.ts**: Extracted campaign fetch + `markRecipientsInQueue()` from runner for single-responsibility

---

## 6. MIGRATION NEEDED — Remaining

### Tables Still Missing

```sql
-- email_queue (dispatch list) — LATER PHASE
-- Not needed at current volume. Sends directly to n8n webhook.
```

### Columns Still Missing

```sql
-- campaigns: add end_date for campaign window check
ALTER TABLE campaigns ADD COLUMN end_date TIMESTAMPTZ;
```

### Migrations Already Applied

```sql
-- scheduler_logs table — DONE
-- step_entered_at on campaign_recipients — DONE (backfilled from enrolled_at)
-- time_from/time_to on contacts — DONE
```

---

## 7. SUMMARY SCORE

| Category | Done | Total | % |
|---|---|---|---|
| MUST requirements (scheduler logic) | ~13 | ~22 | ~59% |
| SHOULD requirements | ~0 | ~5 | 0% |
| MAY requirements | ~1 | ~1 | ~100% |
| Non-functional requirements | ~5 | ~8 | ~62% |
| DB tables (exist) | 4/6 | 6 | 67% |
| DB columns (on existing tables) | ~17 | ~22 | ~77% |
| **Overall** | **~40** | **~64** | **~62%** |

---

## 8. TOP PRIORITIES — What's Left

### Completed

1. ~~Move hardcoded secrets to `.env`~~
2. ~~Restructure into modular files~~ (`scheduler/`, `db/`, `utils/`)
3. ~~Create `scheduler_logs` table~~ (migration + code)
4. ~~Add `step_entered_at` column~~ (migration + backfill)
5. ~~Implement sequence priority sorting~~ (step DESC, entered ASC, contact_id ASC)
6. ~~Replace console logger with Pino~~ (structured JSON, `pino-pretty` for dev)

### Next Up

7. **Add `end_date` to campaigns** — migration + scheduler check for campaign window
8. **DB transactions / idempotency** — wrap critical sections to prevent duplicate queue entries on crash

### Deferred — Later Phase

- **Distributed lock (Redis/pg)** — swap in-memory lock when deploying multi-instance
- **Slack alerting** — add Slack webhook POST to `utils/alerts.ts` stubs
- **email_queue table** — dispatch queue between scheduler and n8n
- **Hourly sender limit** — `hourly_limit`, `emails_sent_this_hour` on senders
- **Multi-sender support** — `campaign_senders` table + round-robin assignment
- **Warmup ramp** — warmup override logic for sender limits
- **Per-contact opt-out preferences** — respect per-contact day/time preferences
- **Per-step reply-to/from-name** — template-level overrides
