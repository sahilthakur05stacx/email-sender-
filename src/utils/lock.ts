/**
 * Distributed run lock — prevents overlapping scheduler runs.
 * Currently uses an in-memory boolean.
 * TODO: Replace with Redis/pg advisory lock for multi-instance deploys.
 */

let isRunning = false;

export function acquireLock(): boolean {
  if (isRunning) return false;
  isRunning = true;
  return true;
}

export function releaseLock(): void {
  isRunning = false;
}

export function isLocked(): boolean {
  return isRunning;
}
