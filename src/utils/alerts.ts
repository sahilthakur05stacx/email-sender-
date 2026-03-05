/**
 * Slack / email alerting for scheduler events.
 * TODO: Implement Slack webhook + email notifications.
 */

import { logger } from "./logger";

export async function alertFailure(error: string, meta?: any): Promise<void> {
  // TODO: POST to Slack webhook
  // TODO: Send alert email
  logger.error("ALERT — Scheduler failure:", error, meta);
}

export async function alertDailyDigest(summary: {
  campaigns_processed: number;
  total_emails_sent: number;
  total_skipped: number;
}): Promise<void> {
  // TODO: POST daily digest to Slack
  logger.info("Daily digest:", summary);
}
