import "server-only";
import { toolSpec, type ToolContext } from "./tools/types";
import type { AgentDefinition } from "./agents";
import type { AgentArticle, AgentMessage, AgentRun, MessageStore } from "./types";

/** The log keeps this much of a turn's reasoning summary. */
export const REASONING_CHARS = 4000;
/** A tool's result is cut at this size unless the tool sets its own limit (whole pages and SERP responses do). */
const MAX_RESULT_CHARS = 12_000;
/**
 * The most of a conversation sent with one model call: about 220,000 tokens, under the 272,000-token prompt size where
 * the model's price doubles (leaving room for the system prompt and tools). The stored conversation keeps everything.
 */
const MAX_CONVERSATION_CHARS = 800_000;
/** Once over the allowance, older results are shortened until the conversation is back to this size. */
const SHORTEN_TO_CHARS = 480_000;
const SHORTENED_CHARS = 1500;
const SHORTENED_NOTE = "… (older result shortened to keep the conversation affordable; read_source returns a page in full again)";

const shortened = (message: AgentMessage, keep: number): AgentMessage => ({ ...message, content: `${message.content.slice(0, keep)}${SHORTENED_NOTE}` });

/**
 * What the model is sent: the conversation within MAX_CONVERSATION_CHARS. Messages the agents wrote are always sent
 * whole. When a new message takes the conversation over the allowance, the oldest tool results are shortened until it is
 * back to SHORTEN_TO_CHARS; a single result larger than the whole allowance is cut to fit.
 *
 * The provider's prompt cache bills a conversation's unchanged start at a fraction of the price, so what was sent stays
 * as it was: the messages are replayed in order and each shortening is decided at the message that caused it. Later
 * turns only add to the end, and the start changes only at the next overflow, several pages later.
 */
export function conversationForModel(messages: AgentMessage[], budget = MAX_CONVERSATION_CHARS, target = SHORTEN_TO_CHARS) {
  if (messages.reduce((sum, m) => sum + m.content.length, 0) <= budget) return messages;
  const sent = [...messages];
  let total = 0;
  let oldest = 0;
  for (let i = 0; i < sent.length; i++) {
    total += sent[i].content.length;
    if (total <= budget) continue;
    for (; oldest < i && total > target; oldest++) {
      const m = sent[oldest];
      if (m.role !== "tool" || m.content.length <= SHORTENED_CHARS + SHORTENED_NOTE.length) continue;
      sent[oldest] = shortened(m, SHORTENED_CHARS);
      total += sent[oldest].content.length - m.content.length;
    }
    if (total > budget && sent[i].role === "tool") {
      const m = sent[i];
      const keep = Math.max(SHORTENED_CHARS, budget - (total - m.content.length) - SHORTENED_NOTE.length);
      sent[i] = shortened(m, keep);
      total += sent[i].content.length - m.content.length;
    }
  }
  return sent;
}

/** "write_section(sectionId: s3, heading: Pricing, markdown: …1,240 chars)": arguments short enough for one log line. */
export function callSummary(name: string, rawArgs: string) {
  let args: unknown;
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return `${name}(…)`;
  }
  if (!args || typeof args !== "object") return `${name}()`;
  const parts = Object.entries(args).map(([key, value]) => {
    if (typeof value === "string") return `${key}: ${value.length > 90 ? `…${value.length.toLocaleString()} chars` : value}`;
    if (Array.isArray(value)) return `${key}: [${value.length}]`;
    if (value && typeof value === "object") return `${key}: {…}`;
    return `${key}: ${String(value)}`;
  });
  return `${name}(${parts.join(", ")})`;
}

const clip = (value: unknown, max = MAX_RESULT_CHARS) => {
  const text = JSON.stringify(value) ?? "null";
  return text.length > max ? `${text.slice(0, max)}… (cut)` : text;
};

/**
 * One turn of an agent: the model sees its conversation (starting with its brief) and calls tools, which run right
 * away. The turn's messages are saved together, so a turn interrupted by a restart is simply run again. On its last
 * turn the agent is made to call its submit tool. Returns whether the agent submitted its work.
 */
export async function runTurn(
  definition: AgentDefinition,
  article: AgentArticle,
  run: AgentRun,
  ctx: Omit<ToolContext, "article" | "agent">,
  messages: MessageStore,
): Promise<{ submitted: boolean }> {
  const tools = definition.tools();
  const submitTool = tools.find((t) => t.submit)!;
  const history = await messages.load(article.id, run.agent, run.id);
  const added: AgentMessage[] = [];
  if (!history.length) {
    added.push({ role: "user", content: definition.brief(article, run) });
    ctx.log(run.instructions ? `Started: ${run.instructions}` : "Started", "start");
  }
  const lastTurn = run.turns >= definition.maxTurns - 1;
  if (lastTurn)
    added.push({ role: "user", content: `This is your last turn: call ${submitTool.name} now with the best work you have.` });

  const reply = await ctx.providers.chat({
    system: definition.system,
    messages: conversationForModel([...history, ...added]),
    tools: tools.map(toolSpec),
    effort: definition.effort,
    model: definition.model,
    ...(lastTurn ? { forceTool: submitTool.name } : {}),
  });
  run.turns++;
  added.push({ role: "assistant", content: reply.content, ...(reply.toolCalls.length ? { toolCalls: reply.toolCalls } : {}), ...(reply.passback && { reasoning: reply.passback }) });

  let submitted = false;
  if (reply.reasoning?.trim()) ctx.log(reply.reasoning.trim().slice(0, REASONING_CHARS), "thinking");
  if (reply.content.trim()) ctx.log(reply.content.trim().slice(0, 600), "message");
  if (!reply.toolCalls.length)
    added.push({ role: "user", content: `Continue with your tools. When your work is done, call ${submitTool.name}.` });
  for (const call of reply.toolCalls) {
    if (submitted) {
      added.push({ role: "tool", toolCallId: call.id, name: call.name, content: clip({ error: "Not run: your work was already submitted." }) });
      continue;
    }
    const tool = tools.find((t) => t.name === call.name);
    ctx.log(callSummary(call.name, call.arguments), "call");
    let result: unknown;
    if (!tool) result = { error: `Unknown tool "${call.name}". Your tools: ${tools.map((t) => t.name).join(", ")}.` };
    else {
      let args: unknown;
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        args = undefined;
      }
      const parsed = args === undefined ? null : tool.schema.safeParse(args);
      if (!parsed?.success)
        result = {
          error: `Invalid arguments: ${parsed ? parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ") : "not valid JSON"}`,
        };
      else {
        try {
          result = await tool.run(parsed.data as never, { ...ctx, article, agent: run.agent });
        } catch (error) {
          result = { error: `The tool failed: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}` };
        }
      }
    }
    if (tool?.submit && result && typeof result === "object" && "submitted" in result) submitted = true;
    else if (result && typeof result === "object" && "error" in result && typeof result.error === "string")
      ctx.log(result.error.slice(0, 300), "error");
    added.push({ role: "tool", toolCallId: call.id, name: call.name, content: clip(result, tool?.maxResultChars) });
  }
  await messages.append(article.id, run.agent, run.id, added);
  return { submitted };
}
