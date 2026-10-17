import "server-only";
import { AGENT_BUDGET_USD } from "@/lib/config";
import { AGENT_DEFINITIONS } from "./agents";
import { deliverReport, directorTurn, finishArticle } from "./director";
import { runTurn } from "./harness";
import type { AgentProviders } from "./providers";
import type { AgentArticle, AgentName, AgentStatus, AssetStore, MessageStore, TimelineEvent } from "./types";
import { agentLabel } from "./types";

/** The log keeps every event; this only guards against a runaway article growing without bound. */
const TIMELINE_MAX = 5000;

export type StepContext = {
  providers: AgentProviders;
  charge: (usd: number | null) => void;
  assets: AssetStore;
  messages: MessageStore;
};

/** Adds a line to the article's log. */
export function logEvent(article: AgentArticle, agent: TimelineEvent["agent"], text: string, kind: TimelineEvent["kind"] = "tool") {
  article.state.timeline.push({ at: new Date().toISOString(), agent, kind, text });
  if (article.state.timeline.length > TIMELINE_MAX) article.state.timeline.splice(0, article.state.timeline.length - TIMELINE_MAX);
}

/** Which agent the next step's cost belongs to. */
export const stepAgent = (article: AgentArticle): AgentName => article.state.run?.agent ?? "director";

/**
 * One step of an article: a turn of the worker agent that is running, or a turn of the Director. When a worker hands
 * back its document, its report goes into the Director's conversation and the Director takes the next step. The
 * state is changed in place; the runner saves it after every step.
 */
export async function step(article: AgentArticle, ctx: StepContext): Promise<{ done: boolean; status?: AgentStatus }> {
  const log = (agent: TimelineEvent["agent"], text: string, kind: TimelineEvent["kind"]) => logEvent(article, agent, text, kind);
  if (article.state.cost.totalUsd >= AGENT_BUDGET_USD)
    return finishArticle(article, "needs_review", `Stopped at the $${AGENT_BUDGET_USD} budget. Review what was done.`, log);

  const run = article.state.run;
  if (!run) return directorTurn(article, { providers: ctx.providers, messages: ctx.messages, log });

  const definition = AGENT_DEFINITIONS[run.agent];
  const { submitted } = await runTurn(
    definition,
    article,
    run,
    { providers: ctx.providers, assets: ctx.assets, charge: ctx.charge, log: (text, kind) => log(run.agent, text, kind ?? "tool") },
    ctx.messages,
  );
  if (submitted || run.turns >= definition.maxTurns) {
    if (!submitted) log(run.agent, `${agentLabel(run.agent)} ran out of turns without submitting.`, "error");
    article.state.run = null;
    await deliverReport(article, ctx, submitted);
  }
  return { done: false };
}
