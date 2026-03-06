import { env, writeSchedulerLog, getSenderTodayCount, resetStaleRecipients, getContactsEmailedToday } from "../db/client";
import { fetchCampaigns, markRecipientsInQueue, resetRecipientsToPending } from "./fetchCampaigns";
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

  // Skip weekends (Saturday = 6, Sunday = 0)
  const dayOfWeek = runStartedAt.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    logger.info(`Cron skipped — weekend (${dayOfWeek === 0 ? "Sunday" : "Saturday"} UTC)`);
    await writeSchedulerLog({
      run_at: runStartedAt.toISOString(),
      campaigns_processed: 0,
      total_slots_available: 0,
      total_emails_sent: 0,
      total_skipped: 0,
      duration_ms: 0,
      status: "skipped",
      error: "Weekend — no emails sent",
    });
    releaseLock();
    return;
  }

  let campaignsProcessed = 0;
  let totalSlotsAvailable = 0;
  let totalEmailsSent = 0;
  let totalSkipped = 0;
  const campaignMeta: any[] = [];

  const maxEmailsPerRun = parseInt(process.env.MAX_EMAILS_PER_RUN || "0") || 0;

  logger.info("========================================");
  logger.info("  Scheduler Run Started");
  logger.info(`  Time: ${runStartedAt.toISOString()}`);
  if (maxEmailsPerRun > 0) logger.info(`  Max Emails: ${maxEmailsPerRun} (test mode)`);
  logger.info("========================================");

  try {
    // Track contacts already sent to in this run (prevents cross-campaign same-day duplicates)
    const sentThisRun = new Set<string>();

    // Step 0: Reset any recipients stuck as "in_queue" from a previous crashed run
    logger.info("[Step 0] Cleaning up stale in_queue recipients...");
    const resetCount = await resetStaleRecipients();
    logger.info(`[Step 0] Done — ${resetCount} recipient(s) reset`);

    // Step 1: Fetch active campaigns
    logger.info("[Step 1] Fetching active campaigns...");
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
    logger.info(`[Step 1] Found ${queue.length} campaign(s) to process`);

    for (let i = 0; i < queue.length; i++) {
      const campaign = queue[i];
      logger.info(`\n[Step 2] ======= Campaign ${i + 1}/${queue.length}: ${campaign.name} =======`);
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

      logger.info(`[Step 2a] Sorted ${campaign.pending_recipients.length} recipients by sequence priority`);

      // Daily sender limit check
      logger.info("[Step 2b] Checking sender daily limit...");
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

      // Max emails per run limit (for testing)
      if (maxEmailsPerRun > 0) {
        const runRemaining = maxEmailsPerRun - totalEmailsSent;
        if (runRemaining <= 0) {
          logger.info(`  Max emails per run (${maxEmailsPerRun}) reached — skipping remaining campaigns`);
          break;
        }
        if (campaign.pending_recipients.length > runRemaining) {
          campaign.pending_recipients = campaign.pending_recipients.slice(0, runRemaining);
          logger.info(`  Trimmed to ${runRemaining} recipient(s) — max emails per run limit`);
        }
      }

      // Exclude contacts already emailed today (FR-14 — cross-campaign dedup)
      // NOTE: Edge function already marked all fetched recipients as "in_queue".
      // We must reset skipped ones back to "pending" after filtering.
      logger.info("[Step 2c] Checking for contacts already emailed today...");
      const contactIds = campaign.pending_recipients.map((r: any) => r.contact_id || r.contact?.id);
      const emailedTodaySet = await getContactsEmailedToday(contactIds);
      const skippedByDedup: string[] = [];
      campaign.pending_recipients = campaign.pending_recipients.filter((r: any) => {
        const cid = r.contact_id || r.contact?.id;
        if (sentThisRun.has(cid) || emailedTodaySet.has(cid)) {
          logger.info(`  Skipping ${r.contact?.full_name || cid} — already emailed today`);
          skippedByDedup.push(r.id);
          campaignSkipped++;
          totalSkipped++;
          return false;
        }
        return true;
      });
      if (skippedByDedup.length > 0) {
        logger.info(`  Excluded ${skippedByDedup.length} contact(s) already emailed today`);
        await resetRecipientsToPending(skippedByDedup);
        logger.info(`  Reset ${skippedByDedup.length} skipped recipient(s) back to pending`);
      }

      const emailsToSend: any[] = [];
      const skippedByWindow: string[] = [];

      logger.info(`[Step 3] Processing ${campaign.pending_recipients.length} recipient(s)...`);
      for (const recipient of campaign.pending_recipients) {
        const contact = recipient.contact || {};
        const currentStep = recipient.current_step;

        // Sending window check
        if (!isWithinSendingWindow(contact.time_from, contact.time_to)) {
          logger.info(`\n  Skipping ${contact.full_name} — outside sending window (${contact.time_from} – ${contact.time_to})`);
          skippedByWindow.push(recipient.id);
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

      // Reset recipients skipped by sending window back to pending
      if (skippedByWindow.length > 0) {
        await resetRecipientsToPending(skippedByWindow);
        logger.info(`  Reset ${skippedByWindow.length} window-skipped recipient(s) back to pending`);
      }

      logger.info(`[Step 4] Sending ${emailsToSend.length} email(s) to n8n...`);
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

    // Step 5: Write success log
    logger.info("[Step 5] Writing scheduler log to database...");
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

    logger.info("[Step 6] Releasing lock...");
    logger.info("========================================");
    logger.info("  Run Complete!");
    logger.info(`  Campaigns : ${campaignsProcessed}`);
    logger.info(`  Sent      : ${totalEmailsSent}`);
    logger.info(`  Skipped   : ${totalSkipped}`);
    logger.info(`  Duration  : ${Date.now() - runStartedAt.getTime()}ms`);
    logger.info("========================================");

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
