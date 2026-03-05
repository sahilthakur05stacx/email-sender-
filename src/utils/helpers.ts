import { env } from "../db/client";
import { logger } from "./logger";

/** Get template for current step from resolved_templates (or fallback to templates) */
export function getTemplateForStep(
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

/** Generate tracking pixel + link rewrites via the tracking API */
export async function generateTracking(params: {
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
    const { TRACKING_API_URL, API_KEY } = env();
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
      logger.error(`  Tracking API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    logger.error({ err }, "Tracking API call failed");
    return null;
  }
}

/** Check if current server time is within the contact's allowed sending window (time_from - time_to) */
export function isWithinSendingWindow(timeFrom?: string | null, timeTo?: string | null): boolean {
  // If no window defined, allow sending anytime
  if (!timeFrom || !timeTo) return true;

  // Parse "HH:MM" strings
  const [fromH, fromM] = timeFrom.split(":").map(Number);
  const [toH, toM] = timeTo.split(":").map(Number);

  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const fromMinutes = fromH * 60 + fromM;
  const toMinutes = toH * 60 + toM;

  return currentMinutes >= fromMinutes && currentMinutes <= toMinutes;
}
