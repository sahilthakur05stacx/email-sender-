import { env } from "../db/client";
import { logger } from "../utils/logger";

/** Fetch active campaigns with pending recipients from the queue edge function */
export async function fetchCampaigns(): Promise<{ success: boolean; queue: any[]; error?: string }> {
  const { SUPABASE_URL, SUPABASE_KEY, API_KEY } = env();

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

  if (!response.ok) {
    logger.error({ status: response.status }, "Campaign queue API returned non-OK status");
    return { success: false, queue: [], error: `API returned status ${response.status}` };
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    logger.error("Campaign queue API returned non-JSON response");
    return { success: false, queue: [], error: "API returned non-JSON response" };
  }

  logger.info(`API status: ${response.status}`);

  // DEBUG: dump full raw response (truncated)
  const rawJson = JSON.stringify(data);
  logger.info(`DEBUG — raw API response (${rawJson.length} chars): ${rawJson.slice(0, 2000)}`);

  if (!data.success) {
    logger.error({ error: data.error || data }, "Campaign queue API error");
    return { success: false, queue: [], error: data.error || "API returned success=false" };
  }

  const queue = data.queue || [];
  logger.info(`Found ${queue.length} active campaign(s)`);

  // Debug: log raw response for each campaign
  for (const c of queue) {
    logger.info({
      name: c.name,
      pending_count: c.pending_count,
      pending_recipients_count: c.pending_recipients?.length ?? 0,
      has_templates: !!c.templates?.length,
      template_count: c.templates?.length ?? 0,
      sender: c.sender?.email,
      sender_id: c.sender_id,
    }, "DEBUG — raw campaign data");
    // Log first recipient if exists
    if (c.pending_recipients?.length > 0) {
      const r = c.pending_recipients[0];
      logger.info({
        id: r.id,
        contact_id: r.contact_id,
        contact_email: r.contact?.email,
        contact_name: r.contact?.full_name,
        current_step: r.current_step,
        email_log_id: r.email_log_id,
        status: r.status,
      }, "DEBUG — first recipient");
    }
  }

  return { success: true, queue };
}

/** Mark recipients as in_queue before processing */
export async function markRecipientsInQueue(recipientIds: string[]): Promise<void> {
  if (!recipientIds.length) return;
  const { SUPABASE_URL, SUPABASE_KEY, API_KEY } = env();

  const res = await fetch(`${SUPABASE_URL}/functions/v1/get-campaign-queue`, {
    method: "PUT",
    headers: {
      "x-api-key": API_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_ids: recipientIds, status: "in_queue" }),
  });

  if (!res.ok) {
    logger.warn({ status: res.status }, "Failed to mark recipients as in_queue");
  } else {
    logger.info(`Marked ${recipientIds.length} as in_queue`);
  }
}

/** Reset skipped recipients back to pending (edge function marks all fetched as in_queue) */
export async function resetRecipientsToPending(recipientIds: string[]): Promise<void> {
  if (!recipientIds.length) return;
  const { SUPABASE_URL, SUPABASE_KEY, API_KEY } = env();

  const res = await fetch(`${SUPABASE_URL}/functions/v1/get-campaign-queue`, {
    method: "PUT",
    headers: {
      "x-api-key": API_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_ids: recipientIds, status: "pending" }),
  });

  if (!res.ok) {
    logger.warn({ status: res.status }, "Failed to reset recipients to pending");
  }
}
