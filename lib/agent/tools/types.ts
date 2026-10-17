import { z } from "zod";
import type { AgentProviders, ToolSpec } from "../providers";
import type { AgentArticle, AssetStore, TimelineEvent, WorkerAgent } from "../types";

/** What a tool can touch: the article (its state is changed in place and saved after the turn) and the providers. */
export type ToolContext = {
  article: AgentArticle;
  providers: AgentProviders;
  assets: AssetStore;
  agent: WorkerAgent;
  log: (text: string, kind?: TimelineEvent["kind"]) => void;
  /** Records a cost a tool paid outside the providers. */
  charge: (usd: number | null) => void;
};

/**
 * A tool an agent may call. `run` returns what the model sees. A submit tool returns `{ submitted: true }` when the
 * agent's document was accepted, which ends the agent's run.
 */
export type AgentTool = {
  name: string;
  description: string;
  schema: z.ZodType;
  submit?: boolean;
  /** How much of the result the model gets; tools that return whole pages or SERP responses raise it. */
  maxResultChars?: number;
  run: (args: never, ctx: ToolContext) => Promise<unknown>;
};

export const defineTool = <S extends z.ZodType>(tool: {
  name: string;
  description: string;
  schema: S;
  submit?: boolean;
  maxResultChars?: number;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}) => tool as unknown as AgentTool;

export function toolSpec(tool: AgentTool): ToolSpec {
  const parameters = z.toJSONSchema(tool.schema, { io: "input" }) as Record<string, unknown>;
  delete parameters.$schema;
  return { name: tool.name, description: tool.description, parameters };
}

/** A refusal the model reads and can act on (budget used up, unknown ID, page already read). */
export const refuse = (error: string) => ({ error });
