import "server-only";
import { z } from "zod";
import { AGENT_EFFORT, AGENT_MODELS, AGENT_MAX_DIRECTOR_TURNS, AGENT_MAX_REVIEW_ROUNDS } from "@/lib/config";
import { AGENT_DEFINITIONS, AGENT_NAMES, ARTICLE_GOAL, isAgent, product, task } from "./agents";
import { finishVerdict, openBlockingIssues, reviewRounds } from "./rules";
import { callSummary, REASONING_CHARS } from "./harness";
import { toolSpec, type AgentTool } from "./tools/types";
import type { AgentProviders } from "./providers";
import {
  agentLabel,
  type AgentArticle,
  type AgentMessage,
  type AgentStatus,
  type DirectorDecision,
  type MessageStore,
  type TimelineEvent,
} from "./types";

type Decision = Omit<DirectorDecision, "at" | "overridden">;
type Log = (agent: TimelineEvent["agent"], text: string, kind: TimelineEvent["kind"]) => void;
export type DirectorContext = { providers: AgentProviders; messages: MessageStore; log: Log };

/** Why a decision can't be carried out now, or null. Each agent says what it needs first (`ready`). */
export function decisionProblem(article: AgentArticle, decision: Pick<Decision, "next"> & { issueIds?: string[] }): string | null {
  if (decision.next !== "finish" && !isAgent(decision.next))
    return `There is no agent "${decision.next}". The team: ${AGENT_NAMES.join(", ")}.`;
  if (decision.next === "finish") {
    const verdict = finishVerdict(article);
    return verdict.allowed ? null : verdict.reason!;
  }
  if (reviewRounds(article.state) >= AGENT_MAX_REVIEW_ROUNDS)
    return `The review limit (${AGENT_MAX_REVIEW_ROUNDS} rounds) is reached; finish now.`;
  return repeatProblem(article, decision.next, decision.issueIds ?? []) ?? AGENT_DEFINITIONS[decision.next].ready(article);
}

/**
 * Running an agent again straight after it handed back its work changes nothing, unless it has review issues to fix or
 * the author has sent a note since. (An agent stopped before submitting may run again.)
 */
function repeatProblem(article: AgentArticle, agent: string, issueIds: string[]) {
  const { state } = article;
  const last = state.decisions.at(-1);
  if (!last || last.next !== agent || issueIds.length) return null;
  const submitted = state.timeline.some((e) => e.agent === agent && e.kind === "submit" && e.at >= last.at);
  if (!submitted || state.humanNotes.some((n) => n.at > last.at)) return null;
  return `The ${agent} agent just handed back its work and has no review issues to fix, so running it again won't change it. Its whole report is in its result. Choose the next step.`;
}

/** The obvious next step, for when the Director's calls are refused three turns in a row. */
export function defaultDecision(article: AgentArticle): Decision {
  const { state } = article;
  const base = { instructions: "", issueIds: [], accepted: [], reason: "The Director's choices were refused; code chose the next step." };
  if (!decisionProblem(article, { next: "finish" })) return { ...base, next: "finish" };
  const open = openBlockingIssues(state);
  if (open.length && !state.changedSinceReview && reviewRounds(state) < AGENT_MAX_REVIEW_ROUNDS && isAgent(open[0].owner)) {
    const owner = open[0].owner;
    return { ...base, next: owner, issueIds: open.filter((i) => i.owner === owner).map((i) => i.id), instructions: "Fix the listed review issues." };
  }
  // The first agent in the team's order that hasn't run yet and can.
  const next = AGENT_NAMES.find((agent) => !state.decisions.some((d) => d.next === agent) && !AGENT_DEFINITIONS[agent].ready(article));
  return next ? { ...base, next } : { ...base, next: "finish" };
}

const RunAgentSchema = z.object({
  agent: z.string().describe("The agent's name, from the team list."),
  instructions: z.string().describe("What you need from the agent now: its work, or the fixes. How to do it is the agent's call."),
  issueIds: z.array(z.string()).default([]).describe("Review issue IDs this agent must fix."),
  accepted: z.array(z.string()).default([]).describe("Minor issue IDs you decide the article can live with."),
  reason: z.string(),
});
const FinishSchema = z.object({
  accepted: z.array(z.string()).default([]).describe("Minor issue IDs the article ships with."),
  reason: z.string(),
});
const directorTools = () => [
  {
    name: "run_agent",
    description:
      "Start one agent. It works until it hands back its document; its report then arrives as this call's result. One agent at a time.",
    schema: RunAgentSchema,
  },
  {
    name: "finish",
    description:
      "Hand the article to the author. Allowed when the latest review leaves nothing critical or major and nothing changed since, or when the review limit is reached.",
    schema: FinishSchema,
  },
];

function directorSystem() {
  const team = AGENT_NAMES.map((name) => `- ${name}: ${AGENT_DEFINITIONS[name].description}`).join("\n");
  return `You are the Director of a team of agents writing one blog article. You decide who works next, by calling run_agent; when an agent is done, its report comes back to you as the result. You finish with finish.
The team:
${team}
The usual flow is the team's order: ${AGENT_NAMES.join(" → ")}. Review issues carry a severity: critical and major ones must be fixed by the agent that owns them; minor ones you may accept when they don't affect the article's goal. Give each agent the issue IDs it must fix. Up to ${AGENT_MAX_REVIEW_ROUNDS} review rounds; then finish.
You coordinate; you don't make content decisions. What the article covers, its structure, angle, length, tone and media are the Editor's decisions, judged by the Reviewer. Your instructions say what the agent must deliver or fix and pass on what it needs (review issue IDs, the author's notes); they don't say what the content should be.
One agent at a time. If a call is refused, the result says why; choose again. If the author sends a note, act on it first.`;
}

function directorBrief(article: AgentArticle) {
  return [
    `## The article\n${JSON.stringify(task(article), null, 1)}`,
    `## The product\n${JSON.stringify(product(article), null, 1)}`,
    ARTICLE_GOAL(article),
    article.state.existingPost ? `## It replaces the existing post\n${article.state.existingPost.url} ("${article.state.existingPost.title}")` : "",
    // No dollar figures: the spending cap is enforced in code (engine.ts), and a budget in view makes agents skimp.
    "Start the work.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Every tool call must have a result before the next model call; a restart between saves can leave one open. */
function unansweredCalls(history: AgentMessage[]) {
  const answered = new Set(history.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
  return history.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).filter((c) => !answered.has(c.id)) : []));
}

function startAgent(article: AgentArticle, decision: Decision, toolCallId: string | null, log: Log, overridden?: string) {
  const { state } = article;
  const agent = decision.next;
  state.decisions.push({ ...decision, at: new Date().toISOString(), ...(overridden ? { overridden } : {}) });
  state.run = { id: crypto.randomUUID(), agent, instructions: decision.instructions, issueIds: decision.issueIds, turns: 0, startedAt: new Date().toISOString() };
  state.director!.pending = { toolCallId, agent };
  log("director", `→ ${agentLabel(agent)}: ${decision.reason}${decision.issueIds.length ? ` (fix ${decision.issueIds.join(", ")})` : ""}`, "decision");
}

/** Ends the run: the article goes to the author. */
export function finishArticle(article: AgentArticle, status: AgentStatus, outcome: string, log: Log) {
  article.state.run = null;
  article.state.outcome = outcome;
  for (const note of article.state.humanNotes) note.handled = true;
  log("director", outcome, "decision");
  return { done: true, status };
}

/**
 * The worker the Director started is done: its report becomes the result of the Director's parked run_agent call
 * (or a message, if code started it), so the Director's next turn reacts to it.
 */
export async function deliverReport(article: AgentArticle, ctx: Pick<DirectorContext, "messages">, submitted: boolean) {
  const thread = article.state.director;
  if (!thread?.pending) return;
  const { agent, toolCallId } = thread.pending;
  const content = JSON.stringify({
    agent,
    submitted,
    ...(submitted ? {} : { note: "The agent ran out of turns without handing back its work." }),
    report: AGENT_DEFINITIONS[agent].report(article),
  });
  await ctx.messages.append(article.id, "director", thread.runId, [
    toolCallId ? { role: "tool", toolCallId, name: "run_agent", content } : { role: "user", content: `Report from ${agent}: ${content}` },
  ]);
  thread.pending = null;
}

/**
 * One Director turn. The Director is an agent with its own saved conversation: it reads the latest reports and calls
 * run_agent or finish. A run_agent call isn't answered right away: the call is parked, the worker runs over the
 * following steps, and its report is added as the call's result (deliverReport). Code refuses calls that can't be
 * carried out (an agent not ready, finishing with open issues) with the reason as the result.
 */
export async function directorTurn(article: AgentArticle, ctx: DirectorContext): Promise<{ done: boolean; status?: AgentStatus }> {
  const { state } = article;
  const thread = (state.director ??= { runId: crypto.randomUUID(), turns: 0, refusals: 0, pending: null });
  if (thread.pending) await deliverReport(article, ctx, false);
  if (thread.turns >= AGENT_MAX_DIRECTOR_TURNS)
    return finishArticle(article, "needs_review", `Stopped after ${AGENT_MAX_DIRECTOR_TURNS} Director turns. Review what was done.`, ctx.log);

  const history = await ctx.messages.load(article.id, "director", thread.runId);
  const added: AgentMessage[] = [];
  if (!history.length) {
    added.push({ role: "user", content: directorBrief(article) });
    ctx.log("director", "Started", "start");
  }
  for (const call of unansweredCalls(history))
    added.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify({ error: "Interrupted by a restart; decide again." }) });
  const notes = state.humanNotes.filter((n) => !n.handled);
  if (notes.length) {
    added.push({ role: "user", content: `The author asks: ${notes.map((n) => n.text).join("\n")}` });
    for (const note of notes) note.handled = true;
  }

  const tools = directorTools();
  const reply = await ctx.providers.chat({
    system: directorSystem(),
    messages: [...history, ...added],
    tools: tools.map((t) => toolSpec(t as unknown as AgentTool)),
    effort: AGENT_EFFORT.director,
    model: AGENT_MODELS.director,
  });
  thread.turns++;
  added.push({ role: "assistant", content: reply.content, ...(reply.toolCalls.length ? { toolCalls: reply.toolCalls } : {}), ...(reply.passback && { reasoning: reply.passback }) });
  if (reply.reasoning?.trim()) ctx.log("director", reply.reasoning.trim().slice(0, REASONING_CHARS), "thinking");
  if (reply.content.trim()) ctx.log("director", reply.content.trim().slice(0, 600), "message");
  if (!reply.toolCalls.length) added.push({ role: "user", content: "Call run_agent or finish." });

  let outcome: { done: boolean; status?: AgentStatus } = { done: false };
  let acted = false;
  let refused = false;
  for (const call of reply.toolCalls) {
    const answer = (value: unknown) => added.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(value) });
    ctx.log("director", callSummary(call.name, call.arguments), "call");
    if (acted) {
      answer({ error: "Not run: one step at a time. Wait for the current agent's report." });
      continue;
    }
    let args: unknown;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      args = undefined;
    }
    if (call.name === "run_agent") {
      const parsed = RunAgentSchema.safeParse(args);
      if (!parsed.success) {
        answer({ error: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
        refused = true;
        continue;
      }
      const { agent, ...rest } = parsed.data;
      const problem = decisionProblem(article, { next: agent, issueIds: rest.issueIds });
      if (problem) {
        answer({ error: problem });
        ctx.log("director", problem, "error");
        refused = true;
        continue;
      }
      startAgent(article, { next: agent, ...rest }, call.id, ctx.log);
      acted = true;
    } else if (call.name === "finish") {
      const parsed = FinishSchema.safeParse(args ?? {});
      const verdict = finishVerdict(article);
      if (!parsed.success || !verdict.allowed) {
        const error = parsed.success ? verdict.reason! : "Invalid arguments.";
        answer({ error });
        ctx.log("director", error, "error");
        refused = true;
        continue;
      }
      state.decisions.push({ next: "finish", instructions: "", issueIds: [], accepted: parsed.data.accepted, reason: parsed.data.reason, at: new Date().toISOString() });
      answer({ finished: true });
      const accepted = parsed.data.accepted.length ? ` Accepted minor issues: ${parsed.data.accepted.join(", ")}.` : "";
      outcome = finishArticle(
        article,
        verdict.status!,
        verdict.status === "ready" ? `Finished: the review is clean.${accepted}` : `Finished with open issues after the review limit.${accepted} See the Reviews tab.`,
        ctx.log,
      );
      acted = true;
    } else {
      answer({ error: `Unknown tool "${call.name}". Use run_agent or finish.` });
      refused = true;
    }
  }

  thread.refusals = acted ? 0 : refused ? thread.refusals + 1 : thread.refusals;
  if (thread.refusals >= 3) {
    const fallback = defaultDecision(article);
    thread.refusals = 0;
    if (fallback.next === "finish") {
      const verdict = finishVerdict(article);
      outcome = finishArticle(article, verdict.allowed ? verdict.status! : "needs_review", "Finished by code after the Director's choices were refused.", ctx.log);
    } else {
      startAgent(article, fallback, null, ctx.log, "three refused choices in a row");
      added.push({ role: "user", content: `Your last choices were refused three times, so code started ${fallback.next}. Its report will follow.` });
    }
  }
  await ctx.messages.append(article.id, "director", thread.runId, added);
  return outcome;
}

export { finishVerdict, openBlockingIssues, reviewRounds };
