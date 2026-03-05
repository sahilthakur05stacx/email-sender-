import { env, writeSchedulerLog, getSenderTodayCount, resetStaleRecipients, getContactsEmailedToday } from "../db/client";
import { fetchCampaigns, markRecipientsInQueue } from "./fetchCampaigns";
import { isWithinSendingWindow, getTemplateForStep, generateTracking } from "../utils/helpers";
import { logger } from "../utils/logger";
import { acquireLock, releaseLock } from "../utils/lock";
import { alertFailure } from "../utils/alerts";

export async function runScheduler() {
  if (!acquireLock()) {
    logger.info("Cron skipped — previous run still in progress");
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

  const runStartedAt = new Date();
  let campaignsProcessed = 0;
  let totalSlotsAvailable = 0;
  let totalEmailsSent = 0;
  let totalSkipped = 0;
  const campaignMeta: any[] = [];

  logger.info("Cron job triggered!");

  try {
    // Track contacts already sent to in this run (prevents cross-campaign same-day duplicates)
    const sentThisRun = new Set<string>();

    // Step 0: Reset any recipients stuck as "in_queue" from a previous crashed run
    await resetStaleRecipients();

    // Step 1: Fetch active campaigns
    const { success, queue, error } = await fetchCampaigns();

    if (!success) {
      await writeSchedulerLog({
        run_at: runStartedAt.toISOString(),
        campaigns_processed: 0,
        total_slots_available: 0,
        total_emails_sent: 0,
        total_skipped: 0,
        duration_ms: Date.now() - runStartedAt.getTime(),
        status: "failed",
        error: error || "API returned success=false",
      });
      await alertFailure(error || "fetchCampaigns failed");
      return;
    }

    // Step 2–6: Process each campaign
    for (const campaign of queue) {
      logger.info(`\n=== Campaign: ${campaign.name} ===`);
      const sender = campaign.sender || {};
      const senderName = sender.name ?? "";
      const senderEmail = sender.email ?? "";
      let campaignSent = 0;
      let campaignSkipped = 0;
      logger.info(`Sender: ${senderName} <${senderEmail}>`);
      logger.info(`Templates: ${campaign.templates?.length ?? 0}`);
      logger.info(`Pending: ${campaign.pending_count ?? 0}`);
      logger.info(`Randomize: ${campaign.randomize_templates ? "ON" : "OFF"}`);
      logger.info(`Tracking: ${campaign.tracking_enabled ? "ON" : "OFF"}`);
      logger.info(`Track Opens: ${campaign.track_opens !== false ? "ON" : "OFF"}`);
      logger.info(`Track Clicks: ${campaign.track_clicks !== false ? "ON" : "OFF"}`);

      if (!campaign.pending_recipients?.length) {
        logger.info("  No pending recipients — skipping");
        continue;
      }

      // Sequence priority sorting (FR-18, FR-19)
      campaign.pending_recipients.sort((a: any, b: any) => {
        const stepDiff = (b.current_step || 0) - (a.current_step || 0);
        if (stepDiff !== 0) return stepDiff;

        const aEntered = a.step_entered_at ? new Date(a.step_entered_at).getTime() : 0;
        const bEntered = b.step_entered_at ? new Date(b.step_entered_at).getTime() : 0;
        const enteredDiff = aEntered - bEntered;
        if (enteredDiff !== 0) return enteredDiff;

        return (a.contact_id || "").localeCompare(b.contact_id || "");
      });

      logger.info(`  Sorted ${campaign.pending_recipients.length} recipients by sequence priority`);

      // Daily sender limit check
      const dailyLimit = sender.daily_limit ?? null;
      if (dailyLimit !== null && dailyLimit > 0) {
        const senderId = sender.id;
        const todayCount = await getSenderTodayCount(senderId);
        const remaining = dailyLimit - todayCount;
        logger.info(`  Daily Limit: ${dailyLimit} | Sent Today: ${todayCount} | Remaining: ${remaining}`);
        totalSlotsAvailable += remaining;

        if (remaining <= 0) {
          logger.info(`  Daily limit reached for ${senderEmail} — skipping campaign`);
          campaignMeta.push({ id: campaign.id, name: campaign.name, organization_id: campaign.organization_id, eligible: 0, sent: 0, skipped: 0, reason: "daily_limit_reached" });
          campaignsProcessed++;
          continue;
        }

        if (campaign.pending_recipients.length > remaining) {
          campaign.pending_recipients = campaign.pending_recipients.slice(0, remaining);
          logger.info(`  Trimmed to ${remaining} recipient(s) to stay within daily limit`);
        }
      }

      // Exclude contacts already emailed today (FR-14 — cross-campaign dedup)
      const contactIds = campaign.pending_recipients.map((r: any) => r.contact_id || r.contact?.id);
      const emailedTodaySet = await getContactsEmailedToday(contactIds);
      const alreadyEmailedCount = emailedTodaySet.size + sentThisRun.size;
      campaign.pending_recipients = campaign.pending_recipients.filter((r: any) => {
        const cid = r.contact_id || r.contact?.id;
        if (sentThisRun.has(cid) || emailedTodaySet.has(cid)) {
          logger.info(`  Skipping ${r.contact?.full_name || cid} — already emailed today`);
          campaignSkipped++;
          totalSkipped++;
          return false;
        }
        return true;
      });
      if (alreadyEmailedCount > 0) {
        logger.info(`  Excluded ${alreadyEmailedCount} contact(s) already emailed today`);
      }

      // Mark recipients as in_queue
      const recipientIds = campaign.pending_recipients.map((r: any) => r.id);
      await markRecipientsInQueue(recipientIds);

      const emailsToSend: any[] = [];

      for (const recipient of campaign.pending_recipients) {
        const contact = recipient.contact || {};
        const currentStep = recipient.current_step;

        // Sending window check
        if (!isWithinSendingWindow(contact.time_from, contact.time_to)) {
          logger.info(`\n  Skipping ${contact.full_name} — outside sending window (${contact.time_from} – ${contact.time_to})`);
          campaignSkipped++;
          totalSkipped++;
          continue;
        }

        const templateForStep = getTemplateForStep(recipient, campaign);

        logger.info(`\n  Contact: ${contact.full_name} (${contact.email})`);
        logger.info(`  Company: ${contact.company_name}`);
        logger.info(`  Step: ${currentStep}/${recipient.total_steps}`);

        if (templateForStep) {
          logger.info(`  Template: ${templateForStep.name ?? "Step " + currentStep}`);
          logger.info(`  Subject: ${templateForStep.subject}`);
          logger.info(`  Format: ${templateForStep.format || "text"}`);
          logger.info(`  Email Log ID: ${recipient.email_log_id || "N/A"}`);
          logger.info(`  Tracking ID: ${recipient.tracking_id || "N/A"}`);
          if (recipient.email_log_error) {
            logger.error(`  EMAIL LOG ERROR: ${recipient.email_log_error}`);
          }
          logger.info(`  Contact ID: ${recipient.contact_id || contact.id}`);

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
            logger.info("  Applying tracking via tracking-api...");
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
              logger.info(`  Tracking applied (tracking_id: ${trackingResult.tracking_id})`);
            } else {
              logger.warn("  Tracking failed, using original HTML");
            }
          }

          const contactId = recipient.contact_id || contact.id;
          emailsToSend.push({
            to: contact.email,
            toName: contact.full_name,
            company: contact.company_name,
            from: senderEmail,
            fromName: senderName,
            subject: templateForStep.subject,
            body: templateForStep.body,
            bodyHtml: finalBodyHtml,
            format: templateForStep.format || "text",
            recipientId: recipient.id,
            campaignId: campaign.id,
            contactId,
            emailLogId: recipient.email_log_id || null,
            trackingId: recipient.tracking_id || null,
            organizationId: campaign.organization_id,
            senderAddress: campaign.sender_address || null,
            trackingEnabled: campaign.tracking_enabled || false,
            trackOpens: campaign.track_opens !== false,
            trackClicks: campaign.track_clicks !== false,
            trackingApplied,
            listUnsubscribeHeader,
            listUnsubscribePostHeader,
            step: currentStep,
          });
          sentThisRun.add(contactId);
        }
      }

      const { N8N_WEBHOOK_URL } = env();
      if (emailsToSend.length > 0 && N8N_WEBHOOK_URL) {
        await fetch(N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(emailsToSend),
        });
        campaignSent = emailsToSend.length;
        totalEmailsSent += campaignSent;
        logger.info(`\n  Sent ${emailsToSend.length} email(s) to n8n`);
      } else if (emailsToSend.length > 0 && !N8N_WEBHOOK_URL) {
        logger.warn("  N8N_WEBHOOK_URL not set — skipping webhook");
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

    logger.info(`\n--- Run complete: ${campaignsProcessed} campaigns, ${totalEmailsSent} sent, ${totalSkipped} skipped, ${Date.now() - runStartedAt.getTime()}ms ---`);

  } catch (error: any) {
    logger.error({ err: error }, "Scheduler error");
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
    await alertFailure(error?.message || String(error), { campaigns: campaignMeta });
  } finally {
    releaseLock();
  }
}
