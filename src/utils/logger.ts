import pino from "pino";

// NOTE: LOG_LEVEL is read at import time. Set it as an env var (not just in .env)
// or accept the default "info". This runs before dotenv.config() due to import hoisting.
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

export const logger = pino({
  level: LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
});
