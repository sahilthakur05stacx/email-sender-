import dotenv from "dotenv";
import cron from "node-cron";

dotenv.config();

// Validate required env vars before starting
const requiredEnvVars = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "API_KEY", "N8N_WEBHOOK_URL", "TRACKING_API_URL"];
const missing = requiredEnvVars.filter((v) => !process.env[v]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

import { runScheduler } from "./runner";

const CRON_EXPRESSION = process.env.CRON_EXPRESSION || "0 * * * *";

// Run on configured schedule (default: every hour)
cron.schedule(CRON_EXPRESSION, runScheduler);
console.log(`Scheduler started on cron "${CRON_EXPRESSION}"`);
