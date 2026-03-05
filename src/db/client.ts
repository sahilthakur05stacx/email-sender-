import { logger } from "../utils/logger";

/** Env vars — read lazily so dotenv.config() has time to run */
export function env() {
  return {
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_KEY: process.env.SUPABASE_SERVICE_KEY!,
    API_KEY: process.env.API_KEY!,
    N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL!,
    TRACKING_API_URL: process.env.TRACKING_API_URL!,
  };
}

/** Reusable Supabase REST fetch with auth headers */
export async function supabaseFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_KEY } = env();
  const url = `${SUPABASE_URL}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    },
  });
}

/** Write a row to scheduler_logs table */
export async function writeSchedulerLog(log: {
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
    await supabaseFetch("/rest/v1/scheduler_logs", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(log),
    });
  } catch (err) {
    logger.error({ err }, "Failed to write scheduler log");
  }
}

/** Reset recipients stuck as "in_queue" for more than 30 minutes back to "pending" */
export async function resetStaleRecipients(): Promise<number> {
  try {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const res = await supabaseFetch(
      `/rest/v1/campaign_recipients?status=eq.in_queue&updated_at=lt.${thirtyMinAgo}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ status: "pending" }),
      },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, "Failed to reset stale recipients");
      return 0;
    }
    const rows = await res.json();
    const count = Array.isArray(rows) ? rows.length : 0;
    if (count > 0) {
      logger.info({ count }, "Reset stale in_queue recipients back to pending");
    }
    return count;
  } catch (err) {
    logger.error({ err }, "Failed to reset stale recipients");
    return 0;
  }
}

/** Get how many emails this sender has already sent today (across all their campaigns) */
export async function getSenderTodayCount(senderId: string): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();

  try {
    // Step 1: Get all campaign IDs that belong to this sender
    const campaignsRes = await supabaseFetch(
      `/rest/v1/campaigns?select=id&sender_id=eq.${senderId}`,
    );
    if (!campaignsRes.ok) return 0;
    const campaigns = await campaignsRes.json();
    if (!campaigns.length) return 0;

    const campaignIds = campaigns.map((c: any) => c.id).join(",");

    // Step 2: Count email_logs sent today for those campaigns
    const logsRes = await supabaseFetch(
      `/rest/v1/email_logs?select=id&campaign_id=in.(${campaignIds})&created_at=gte.${todayISO}`,
      { headers: { Prefer: "count=exact" } },
    );

    const contentRange = logsRes.headers.get("content-range");
    if (contentRange) {
      const total = contentRange.split("/")[1];
      return parseInt(total) || 0;
    }
    return 0;
  } catch (err) {
    logger.error({ err }, "Failed to get sender daily count");
    return 0;
  }
}
