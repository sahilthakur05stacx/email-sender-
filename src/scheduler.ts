import cron from "node-cron";
import dotenv from "dotenv";

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const API_KEY = process.env.API_KEY!;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL!;
const TRACKING_API_URL = process.env.TRACKING_API_URL!;
const CRON_EXPRESSION = process.env.CRON_EXPRESSION || "0 * * * *";

/** Get template for current step from resolved_templates (or fallback to templates) */
function getTemplateForStep(
  recipient: { current_step: number; resolved_templates?: any[] },
  campaign: { templates: any[]; randomize_templates?: boolean },
): { subject: string; body: string; bodyHtml?: string | null; format?: string; name?: string } | undefined {
  const step = recipient.current_step;
  if (recipient.resolved_templates && recipient.resolved_templates.length > 0) {
    const resolved = recipient.resolved_templates.find(
      (t: any) => t.step_number === step,
    );
    if (resolved?.resolved_subject != null && resolved?.resolved_body != null) {
      return {
        subject: resolved.resolved_subject,
        body: resolved.resolved_body,
        bodyHtml: resolved.resolved_body_html || null,
        format: resolved.format || "text",
        name: resolved.name,
      };
    }
  }
  const stepTemplates = campaign.templates.filter(
    (t: any) => t.step_number === step,
  );
  if (stepTemplates.length === 0) return undefined;
  const template =
    campaign.randomize_templates && stepTemplates.length > 1
      ? stepTemplates[Math.floor(Math.random() * stepTemplates.length)]
      : stepTemplates[0];
  return {
    subject: template.subject,
    body: template.body,
    bodyHtml: template.body_html || null,
    format: template.format || "text",
    name: template.name,
  };
}

async function generateTracking(params: {
  emailLogId: string;
  organizationId: string;
  contactId: string;
  campaignId: string;
  recipientId: string;
  bodyHtml: string;
  senderAddress: string | null;
}): Promise<{
  tracked_body: string;
  tracking_id: string;
  unsubscribe_url: string;
  list_unsubscribe_header: string;
  list_unsubscribe_post_header: string;
} | null> {
  try {
    const res = await fetch(`${TRACKING_API_URL}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        email_log_id: params.emailLogId,
        organization_id: params.organizationId,
        contact_id: params.contactId,
        campaign_id: params.campaignId,
        recipient_id: params.recipientId,
        html_body: params.bodyHtml,
        sender_address: params.senderAddress,
      }),
    });

    if (!res.ok) {
      console.error(`  Tracking API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    console.error(`  Tracking API call failed:`, err);
    return null;
  }
}

/** Write a row to scheduler_logs table */
async function writeSchedulerLog(log: {
  run_at: string;
  campaigns_processed: number;
  total_slots_available: number;
  total_emails_sent: number;
  total_skipped: number;
  duration_ms: number;
  status: "success" | "failed" | "skipped";
  error?: string;
  meta?: any;
}) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/scheduler_logs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(log),
    });
  } catch (err) {
    console.error("Failed to write scheduler log:", err);
  }
}

/** Check if current server time is within the contact's allowed sending window (time_from – time_to) */
function isWithinSendingWindow(timeFrom?: string | null, timeTo?: string | null): boolean {
  // If no window defined, do NOT send
  if (!timeFrom || !timeTo) return false;

  // Parse "HH:MM" strings
  const [fromH, fromM] = timeFrom.split(":").map(Number);
  const [toH, toM] = timeTo.split(":").map(Number);

  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const fromMinutes = fromH * 60 + fromM;
  const toMinutes = toH * 60 + toM;

  return currentMinutes >= fromMinutes && currentMinutes <= toMinutes;
}

/** Get how many emails this sender has already sent today (across all their campaigns) */
async function getSenderTodayCount(senderId: string): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();

  try {
    // Step 1: Get all campaign IDs that belong to this sender
    const campaignsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/campaigns?select=id&sender_id=eq.${senderId}`,
      {
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`,
          apikey: SUPABASE_KEY,
        },
      },
    );
    if (!campaignsRes.ok) return 0;
    const campaigns = await campaignsRes.json();
    if (!campaigns.length) return 0;

    const campaignIds = campaigns.map((c: any) => c.id).join(",");

    // Step 2: Count email_logs sent today for those campaigns
    const logsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/email_logs?select=id&campaign_id=in.(${campaignIds})&created_at=gte.${todayISO}`,
      {
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`,
          apikey: SUPABASE_KEY,
          Prefer: "count=exact",
        },
      },
    );

    const contentRange = logsRes.headers.get("content-range");
    if (contentRange) {
      const total = contentRange.split("/")[1];
      return parseInt(total) || 0;
    }
    return 0;
  } catch (err) {
    console.error(`  Failed to get sender daily count:`, err);
    return 0;
  }
}

let isRunning = false;

async function runScheduler() {
  if (isRunning) {
    console.log(`[${new Date().toISOString()}] Cron skipped — previous run still in progress`);
    await writeSchedulerLog({
      run_at: new Date().toISOString(),
      campaigns_processed: 0,
      total_slots_available: 0,
      total_emails_sent: 0,
      total_skipped: 0,
      duration_ms: 0,
      status: "skipped",
      error: "Previous run still in progress",
    });
    return;
  }

  isRunning = true;
  const runStartedAt = new Date();
  let campaignsProcessed = 0;
  let totalSlotsAvailable = 0;
  let totalEmailsSent = 0;
  let totalSkipped = 0;
  const campaignMeta: any[] = [];

  console.log(`[${runStartedAt.toISOString()}] Cron job triggered!`);

  try {
  // Use resolve=true so we get resolved_subject and resolved_body per recipient
  const response = await fetch(
    `${SUPABASE_URL}/functions/v1/get-campaign-queue?action=queue&limit=5&resolve=true`,
    {
      headers: {
        "x-api-key": API_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
    },
  );

  const data = await response.json();
  console.log(`API status: ${response.status}`);

  if (!data.success) {
    console.error("API error:", data.error || data);
    await writeSchedulerLog({
      run_at: runStartedAt.toISOString(),
      campaigns_processed: 0,
      total_slots_available: 0,
      total_emails_sent: 0,
      total_skipped: 0,
      duration_ms: Date.now() - runStartedAt.getTime(),
      status: "failed",
      error: data.error || "API returned success=false",
    });
    return;
  }

  const queue = data.queue || [];
  console.log(`Found ${queue.length} active campaign(s)`);

  for (const campaign of queue) {
    console.log(`\n=== Campaign: ${campaign.name} ===`);
    const sender = campaign.sender || {};
    const senderName = sender.name ?? "";
    const senderEmail = sender.email ?? "";
    let campaignSent = 0;
    let campaignSkipped = 0;
    console.log(`Sender: ${senderName} <${senderEmail}>`);
    console.log(`Templates: ${campaign.templates?.length ?? 0}`);
    console.log(`Pending: ${campaign.pending_count ?? 0}`);
    console.log(`Randomize: ${campaign.randomize_templates ? "ON" : "OFF"}`);
    console.log(`Tracking: ${campaign.tracking_enabled ? "ON" : "OFF"}`);
    console.log(`Track Opens: ${campaign.track_opens !== false ? "ON" : "OFF"}`);
    console.log(`Track Clicks: ${campaign.track_clicks !== false ? "ON" : "OFF"}`);

    if (!campaign.pending_recipients?.length) {
      console.log(`  No pending recipients — skipping`);
      continue;
    }

    // Sequence priority sorting (FR-18, FR-19)
    // Primary: current_step DESC (higher step = further in funnel = higher priority)
    // Secondary: step_entered_at ASC (oldest first at same step = FIFO fairness)
    // Tertiary: contact_id ASC (deterministic tie-breaker)
    campaign.pending_recipients.sort((a: any, b: any) => {
      const stepDiff = (b.current_step || 0) - (a.current_step || 0);
      if (stepDiff !== 0) return stepDiff;

      const aEntered = a.step_entered_at ? new Date(a.step_entered_at).getTime() : 0;
      const bEntered = b.step_entered_at ? new Date(b.step_entered_at).getTime() : 0;
      const enteredDiff = aEntered - bEntered;
      if (enteredDiff !== 0) return enteredDiff;

      return (a.contact_id || "").localeCompare(b.contact_id || "");
    });

    console.log(`  Sorted ${campaign.pending_recipients.length} recipients by sequence priority`);

    // Daily sender limit check
    const dailyLimit = sender.daily_limit ?? null;
    if (dailyLimit !== null && dailyLimit > 0) {
      const senderId = sender.id;
      const todayCount = await getSenderTodayCount(senderId);
      const remaining = dailyLimit - todayCount;
      console.log(`  Daily Limit: ${dailyLimit} | Sent Today: ${todayCount} | Remaining: ${remaining}`);
      totalSlotsAvailable += remaining;

      if (remaining <= 0) {
        console.log(`  ⛔ Daily limit reached for ${senderEmail} — skipping campaign`);
        campaignMeta.push({ id: campaign.id, name: campaign.name, organization_id: campaign.organization_id, eligible: 0, sent: 0, skipped: 0, reason: "daily_limit_reached" });
        campaignsProcessed++;
        continue;
      }

      if (campaign.pending_recipients.length > remaining) {
        campaign.pending_recipients = campaign.pending_recipients.slice(0, remaining);
        console.log(`  Trimmed to ${remaining} recipient(s) to stay within daily limit`);
      }
    }

    const recipientIds = campaign.pending_recipients.map((r: any) => r.id);

    await fetch(`${SUPABASE_URL}/functions/v1/get-campaign-queue`, {
      method: "PUT",
      headers: {
        "x-api-key": API_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_ids: recipientIds, status: "in_queue" }),
    });

    console.log(`Marked ${recipientIds.length} as in_queue`);

    const emailsToSend: any[] = [];

    for (const recipient of campaign.pending_recipients) {
      const contact = recipient.contact || {};
      const currentStep = recipient.current_step;

      // Sending window check
      if (!isWithinSendingWindow(contact.time_from, contact.time_to)) {
        console.log(`\n  ⏰ Skipping ${contact.full_name} — outside sending window (${contact.time_from} – ${contact.time_to})`);
        campaignSkipped++;
        totalSkipped++;
        continue;
      }

      const templateForStep = getTemplateForStep(recipient, campaign);

      console.log(`\n  Contact: ${contact.full_name} (${contact.email})`);
      console.log(`  Company: ${contact.company_name}`);
      console.log(`  Step: ${currentStep}/${recipient.total_steps}`);

      if (templateForStep) {
        console.log(
          `  Template: ${templateForStep.name ?? "Step " + currentStep}`,
        );
        console.log(`  Subject: ${templateForStep.subject}`);
        console.log(`  Format: ${templateForStep.format || "text"}`);
        console.log(`  Email Log ID: ${recipient.email_log_id || "N/A"}`);
        console.log(`  Tracking ID: ${recipient.tracking_id || "N/A"}`);
        if (recipient.email_log_error) {
          console.error(`  ⚠️ EMAIL LOG ERROR: ${recipient.email_log_error}`);
        }
        console.log(`  Contact ID: ${recipient.contact_id || contact.id}`);

        let finalBodyHtml = templateForStep.bodyHtml || null;
        let trackingApplied = false;
        let listUnsubscribeHeader: string | null = null;
        let listUnsubscribePostHeader: string | null = null;

        if (
          campaign.tracking_enabled &&
          templateForStep.format === "html" &&
          recipient.email_log_id &&
          finalBodyHtml
        ) {
          console.log(`  Applying tracking via tracking-api...`);
          const trackingResult = await generateTracking({
            emailLogId: recipient.email_log_id,
            organizationId: campaign.organization_id,
            contactId: recipient.contact_id || contact.id,
            campaignId: campaign.id,
            recipientId: recipient.id,
            bodyHtml: finalBodyHtml,
            senderAddress: campaign.sender_address || null,
          });

          if (trackingResult) {
            finalBodyHtml = trackingResult.tracked_body;
            listUnsubscribeHeader = trackingResult.list_unsubscribe_header;
            listUnsubscribePostHeader = trackingResult.list_unsubscribe_post_header;
            trackingApplied = true;
            console.log(`  Tracking applied (tracking_id: ${trackingResult.tracking_id})`);
          } else {
            console.warn(`  Tracking failed, using original HTML`);
          }
        }

        emailsToSend.push({
          // Basic email fields
          to: contact.email,
          toName: contact.full_name,
          company: contact.company_name,
          from: senderEmail,
          fromName: senderName,
          subject: templateForStep.subject,
          body: templateForStep.body,

          // HTML email support
          bodyHtml: finalBodyHtml,
          format: templateForStep.format || "text",

          // IDs for tracking
          recipientId: recipient.id,
          campaignId: campaign.id,
          contactId: recipient.contact_id || contact.id,
          emailLogId: recipient.email_log_id || null,
          trackingId: recipient.tracking_id || null,
          organizationId: campaign.organization_id,

          // Compliance
          senderAddress: campaign.sender_address || null,

          // Tracking
          trackingEnabled: campaign.tracking_enabled || false,
          trackOpens: campaign.track_opens !== false,
          trackClicks: campaign.track_clicks !== false,
          trackingApplied,
          listUnsubscribeHeader,
          listUnsubscribePostHeader,

          // Step info
          step: currentStep,
        });
      }
    }

    if (emailsToSend.length > 0 && N8N_WEBHOOK_URL) {
      await fetch(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(emailsToSend),
      });
      campaignSent = emailsToSend.length;
      totalEmailsSent += campaignSent;
      console.log(`\n  Sent ${emailsToSend.length} email(s) to n8n`);
    } else if (emailsToSend.length > 0 && !N8N_WEBHOOK_URL) {
      console.warn("  N8N_WEBHOOK_URL not set — skipping webhook");
    }

    campaignsProcessed++;
    campaignMeta.push({
      id: campaign.id,
      name: campaign.name,
      organization_id: campaign.organization_id,
      eligible: campaign.pending_recipients?.length || 0,
      sent: campaignSent,
      skipped: campaignSkipped,
    });
  }
  // Write success log
  await writeSchedulerLog({
    run_at: runStartedAt.toISOString(),
    campaigns_processed: campaignsProcessed,
    total_slots_available: totalSlotsAvailable,
    total_emails_sent: totalEmailsSent,
    total_skipped: totalSkipped,
    duration_ms: Date.now() - runStartedAt.getTime(),
    status: campaignsProcessed === 0 ? "skipped" : "success",
    meta: { campaigns: campaignMeta },
  });

  console.log(`\n--- Run complete: ${campaignsProcessed} campaigns, ${totalEmailsSent} sent, ${totalSkipped} skipped, ${Date.now() - runStartedAt.getTime()}ms ---`);

  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] Scheduler error:`, error);
    await writeSchedulerLog({
      run_at: runStartedAt.toISOString(),
      campaigns_processed: campaignsProcessed,
      total_slots_available: totalSlotsAvailable,
      total_emails_sent: totalEmailsSent,
      total_skipped: totalSkipped,
      duration_ms: Date.now() - runStartedAt.getTime(),
      status: "failed",
      error: error?.message || String(error),
      meta: { campaigns: campaignMeta },
    });
  } finally {
    isRunning = false;
  }
}

// Validate required env vars before starting
const requiredEnvVars = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "API_KEY", "N8N_WEBHOOK_URL", "TRACKING_API_URL"];
const missing = requiredEnvVars.filter((v) => !process.env[v]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

// Run on configured schedule (default: every hour)
cron.schedule(CRON_EXPRESSION, runScheduler);
console.log(`Scheduler started on cron "${CRON_EXPRESSION}"`);
