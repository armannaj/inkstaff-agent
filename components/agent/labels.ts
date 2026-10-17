import type { AgentStatus } from "@/lib/agent/types";

export const STATUS_LABELS: Record<AgentStatus, string> = {
  queued: "Queued",
  running: "Agents working",
  paused: "Paused",
  ready: "Review passed",
  needs_review: "Needs your review",
  failed: "Failed",
};
export const formatUsd = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
