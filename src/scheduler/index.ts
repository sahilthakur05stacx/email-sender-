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
import { logger } from "../utils/logger";

const CRON_EXPRESSION = process.env.CRON_EXPRESSION || "0 * * * *";

// Startup info
logger.info("========================================");
logger.info("  Email Scheduler Starting...");
logger.info("========================================");
logger.info(`Supabase URL  : ${process.env.SUPABASE_URL}`);
logger.info(`Tracking API  : ${process.env.TRACKING_API_URL}`);
logger.info(`n8n Webhook   : ${process.env.N8N_WEBHOOK_URL ? "configured" : "NOT SET"}`);
logger.info(`Cron Schedule : ${CRON_EXPRESSION}`);
logger.info(`Max Emails/Run: ${process.env.MAX_EMAILS_PER_RUN || "unlimited"}`);
logger.info(`Log Level     : ${process.env.LOG_LEVEL || "info"}`);
logger.info(`Node Env      : ${process.env.NODE_ENV || "development"}`);
logger.info(`Started At    : ${new Date().toISOString()}`);
logger.info("========================================");

// Run on configured schedule (default: every hour)
cron.schedule(CRON_EXPRESSION, runScheduler);
logger.info("Cron scheduled — waiting for next trigger...");

// If RUN_NOW=true, run immediately (useful for testing)
if (process.env.RUN_NOW === "true") {
  logger.info("RUN_NOW=true — running scheduler immediately...");
  runScheduler();
}
