import cron from "node-cron";

const SUPABASE_URL = "https://ujzxlsqlopgazqktukpq.supabase.co";
const API_KEY =
  "or_ed5e1ee1676a5de84aed3de020915a0a64a223d7a7f672bed7bd255de2538aec";
const SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqenhsc3Fsb3BnYXpxa3R1a3BxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2ODU1MTEwNywiZXhwIjoyMDg0MTI3MTA3fQ.GWZ5h3hBclPXCF5TPBNqRPsEEG2hArzkbsW9kgkNJzQ";
const N8N_WEBHOOK_URL =
  "http://localhost:5678/webhook/11ce44bf-f24d-4086-8a51-ed833a8cc281";
const TRACKING_API_URL = "http://localhost:3000";

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

async function runScheduler() {
  console.log(`[${new Date().toISOString()}] Cron job triggered!`);

  if (!API_KEY || !SUPABASE_KEY) {
    console.error(
      "Missing API_KEY or SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY",
    );
    return;
  }

  // Use resolve=true so we get resolved_subject and resolved_body per recipient
  const response = await fetch(
    `${SUPABASE_URL}/functions/v1/get-campaign-queue?action=queue&limit=2&resolve=true`,
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
    return;
  }

  const queue = data.queue || [];
  console.log(`Found ${queue.length} active campaign(s)`);

  for (const campaign of queue) {
    console.log(`\n=== Campaign: ${campaign.name} ===`);
    const sender = campaign.sender || {};
    const senderName = sender.name ?? "";
    const senderEmail = sender.email ?? "";
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

    const repliedRes = await fetch(
      `${SUPABASE_URL}/functions/v1/get-campaign-queue?action=recipients&campaign_id=${campaign.id}&status=replied`,
      {
        headers: {
          "x-api-key": API_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );
    const repliedData = await repliedRes.json();

    if (repliedData.count > 0) {
      console.log(
        `  Paused - Campaign has ${repliedData.count} replied recipient(s)`,
      );
      return;
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
      console.log(`\n  Sent ${emailsToSend.length} email(s) to n8n`);
    } else if (emailsToSend.length > 0 && !N8N_WEBHOOK_URL) {
      console.warn("  N8N_WEBHOOK_URL not set — skipping webhook");
    }
  }
}

// Run every minute (same as before)
cron.schedule("* * * * *", runScheduler);
console.log("Scheduler started (using resolved templates from API)...");
