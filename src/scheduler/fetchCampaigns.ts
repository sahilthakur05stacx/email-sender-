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

  const data = await response.json();
  logger.info(`API status: ${response.status}`);

  if (!data.success) {
    logger.error("API error:", data.error || data);
    return { success: false, queue: [], error: data.error || "API returned success=false" };
  }

  const queue = data.queue || [];
  logger.info(`Found ${queue.length} active campaign(s)`);
  return { success: true, queue };
}

/** Mark recipients as in_queue before processing */
export async function markRecipientsInQueue(recipientIds: string[]): Promise<void> {
  const { SUPABASE_URL, SUPABASE_KEY, API_KEY } = env();

  await fetch(`${SUPABASE_URL}/functions/v1/get-campaign-queue`, {
    method: "PUT",
    headers: {
      "x-api-key": API_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_ids: recipientIds, status: "in_queue" }),
  });

  logger.info(`Marked ${recipientIds.length} as in_queue`);
}
