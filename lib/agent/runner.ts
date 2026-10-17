import "server-only";
import { setTimeout as sleep } from "node:timers/promises";
import { AGENT_CONCURRENCY } from "@/lib/config";
import { DataForSeoError } from "@/lib/dataforseo";
import { getAgentProviders, type CostEvent } from "./providers";
import { logEvent, step, stepAgent } from "./engine";
import { claimForRun, claimableIds, commitAgentArticle, dbAssets, dbMessages, readControl } from "./store";
import type { AgentArticle } from "./types";

/**
 * Runs articles in the background, in this server process. Not tied to a request, so it has no time limit and the
 * page can be closed. Every step is saved; after a restart or deploy, `kickRunner` (called on server start) picks up
 * articles whose lease expired and continues from their last step. The DB lease guarantees one worker per article.
 */
type RunnerState = { active: Set<string>; scheduled: boolean };
const global = globalThis as typeof globalThis & { blogAgentRunner?: RunnerState };
const runner = (global.blogAgentRunner ??= { active: new Set(), scheduled: false });

/** Temporary failures (network, rate limits, provider 5xx) are retried; others fail the article. */
const RETRY_DELAYS_MS = [10_000, 30_000, 90_000];
function retryable(error: unknown) {
  if (error instanceof DataForSeoError) return error.isRetryable;
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed|socket|HTTP (408|409|425|429|5\d\d)|rate limit|overloaded|Too Many Requests|5\d\d/i.test(message);
}

/** Adds a step's billed calls to the article's cost, and its model turns' reasoning tokens to the agent's tally. */
export function addCost(article: AgentArticle, agent: string, events: CostEvent[]) {
  const cost = article.state.cost;
  for (const { usd, reasoningTokens } of events) {
    if (reasoningTokens !== undefined) {
      cost.reasoning ??= {};
      const tally = (cost.reasoning[agent] ??= { turns: 0, tokens: 0, turnsWithout: 0 });
      tally.turns++;
      tally.tokens += reasoningTokens;
      if (!reasoningTokens) tally.turnsWithout++;
    }
    cost.calls++;
    if (usd == null) cost.unpricedCalls++;
    else {
      cost.totalUsd += usd;
      cost.byAgent[agent] = (cost.byAgent[agent] ?? 0) + usd;
    }
  }
}

async function work(id: string) {
  const claim = await claimForRun(id);
  if (!claim) return;
  let { article } = claim;
  const { token } = claim;
  let failures = 0;
  while (true) {
    const control = await readControl(id);
    if (control) {
      logEvent(article, "human", control === "pause" ? "Paused" : "Stopped", "note");
      if (control === "stop") article.state.outcome = "Stopped by you. Review what was done, or send the agents a note to continue.";
      await commitAgentArticle(article, token, { status: control === "pause" ? "paused" : "needs_review", control: null });
      return;
    }
    const events: CostEvent[] = [];
    const agent = stepAgent(article);
    const before = structuredClone(article.state);
    try {
      const result = await step(article, {
        providers: getAgentProviders((event) => events.push(event)),
        charge: (usd) => events.push({ usd }),
        assets: dbAssets,
        messages: dbMessages,
      });
      addCost(article, agent, events);
      failures = 0;
      article = await commitAgentArticle(article, token, {
        status: result.status ?? "running",
        keepLease: !result.done,
      });
      if (result.done) return;
    } catch (error) {
      // A half-done step is discarded (its messages weren't saved), but what it cost is kept.
      article.state = before;
      addCost(article, agent, events);
      const message = error instanceof Error ? error.message.slice(0, 500) : "The step failed.";
      if (retryable(error) && failures < RETRY_DELAYS_MS.length) {
        logEvent(article, "system", `Temporary error, retrying: ${message.slice(0, 160)}`, "error");
        article = await commitAgentArticle(article, token, { keepLease: true });
        await sleep(RETRY_DELAYS_MS[failures++]);
        continue;
      }
      console.error("Blog agent step failed", { id, agent, error });
      logEvent(article, "system", `Failed: ${message.slice(0, 200)}`, "error");
      await commitAgentArticle(article, token, { status: "failed", error: message });
      return;
    }
  }
}

/** Starts work on queued (and abandoned) articles, up to AGENT_CONCURRENCY at once. Safe to call anytime. */
export function kickRunner() {
  if (runner.scheduled) return;
  runner.scheduled = true;
  setTimeout(async () => {
    runner.scheduled = false;
    try {
      const free = AGENT_CONCURRENCY - runner.active.size;
      if (free <= 0) return;
      const ids = (await claimableIds(free + runner.active.size)).filter((id) => !runner.active.has(id)).slice(0, free);
      for (const id of ids) {
        runner.active.add(id);
        void work(id)
          .catch((error) => console.error("Blog agent runner error", { id, error }))
          .finally(() => {
            runner.active.delete(id);
            kickRunner();
          });
      }
    } catch (error) {
      console.error("Blog agent runner could not check the queue", error);
    }
  }, 0);
}

/** Called once on server start: resumes articles a restart interrupted, and checks the queue every minute. */
export function startRunner() {
  kickRunner();
  setInterval(kickRunner, 60_000).unref();
}
