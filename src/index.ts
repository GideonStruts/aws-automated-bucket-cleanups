import { runCleanup } from "./cleanup.ts";
import type { Env } from "./config.ts";

export interface ScheduledEvent {
  /** EventBridge scheduled time, ISO-8601. Manual invokes can omit it. */
  time?: string;
}

export async function handler(event: ScheduledEvent = {}, env: Env = process.env) {
  const scheduledAt = event.time ? new Date(event.time) : new Date();
  const now = Number.isNaN(scheduledAt.getTime()) ? new Date() : scheduledAt;
  console.log(JSON.stringify({ event: "cleanup_started", scheduledTime: now.toISOString() }));
  return runCleanup(env, { now });
}
