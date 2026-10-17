import "server-only";
import { z } from "zod";
import { OpenRouter } from "@openrouter/sdk";
import { postLive } from "@/lib/dataforseo";
import {
  AGENT_IMAGE_MODEL,
  AGENT_IMAGE_OPTIONS,
  AGENT_MODELS,
  AGENT_REASONING_PASSBACK,
  EMBEDDING_MODEL,
  LANGUAGE_CODE,
  LOCATION_CODE,
  VISION_MODEL,
} from "@/lib/config";
import type { AgentMessage } from "./types";

/**
 * One billed call: OpenRouter's or DataForSEO's own cost figure; null when the provider didn't report one. An agent's
 * model turn also reports how many reasoning tokens the model spent.
 */
export type CostEvent = { usd: number | null; reasoningTokens?: number };
export type OnCost = (event: CostEvent) => void;

export type OrganicResult = {
  url: string;
  title: string;
  description: string;
  position: number;
};
export type SerpResponse = { response: unknown; organic: OrganicResult[] };

const OrganicItemSchema = z.object({
  type: z.literal("organic"),
  rank_group: z.number(),
  url: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
});

export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
export type ModelReply = {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  /** The model's summary of its reasoning, when it gives one (OpenAI models summarize; the reasoning itself is hidden). */
  reasoning?: string;
  /** The reasoning to send back on the next turn (see AGENT_REASONING_PASSBACK), with the model that made it. */
  passback?: { model: string; details: unknown[] };
};
export type Effort = "low" | "medium" | "high";

/**
 * Everything the agents call outside the app: the model (tool calling, vision), web search,
 * image generation, screenshots and embeddings. An interface, so tests run the agents on fakes.
 */
export interface AgentProviders {
  chat(args: {
    system: string;
    messages: AgentMessage[];
    tools: ToolSpec[];
    effort: Effort;
    /** The model to use; the default agent model when left out. */
    model?: string;
    /** Forces a call of this tool (an agent out of turns must submit). */
    forceTool?: string;
  }): Promise<ModelReply>;
  vision(dataUrl: string, instruction: string): Promise<string>;
  /**
   * Google results from DataForSEO's advanced SERP endpoint: its response exactly as returned (every item type: organic,
   * people also ask, featured snippet, AI overview, related searches, videos, forums, …), plus the organic results
   * pulled out for code (which pages to open).
   */
  serp(query: string, depth?: number): Promise<SerpResponse>;
  /** YouTube search results from DataForSEO's YouTube SERP endpoint, exactly as returned (videos, channels, playlists). */
  youtube(query: string): Promise<unknown>;
  /** A YouTube video's subtitles (its transcript, with timings) from DataForSEO, exactly as returned. */
  youtubeSubtitles(videoId: string): Promise<unknown>;
  /** DataForSEO Labs' keyword overview for up to 20 keywords, exactly as returned, with what it cost. */
  keywordData(
    keywords: string[],
  ): Promise<{ response: unknown; costUsd: number }>;
  generateImage(
    prompt: string,
    aspectRatio: string,
  ): Promise<{ base64: string; mimeType: string }>;
  /** `fresh` skips the service's cache; `fullPage` captures the whole page rather than the first screen. */
  screenshot?: (
    url: string,
    options?: { fresh?: boolean; fullPage?: boolean },
  ) => Promise<{ base64: string; mimeType: string }>;
  embed(texts: string[]): Promise<number[][]>;
}

/** Long reasoning turns can take minutes; the shared client gives up after two. */
const client = () => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY must be set in .env.local.");
  return new OpenRouter({
    apiKey,
    appTitle: "Inkstaff",
    timeoutMs: 300_000,
  });
};
type SdkMessage = Parameters<
  ReturnType<typeof client>["chat"]["send"]
>[0]["chatRequest"]["messages"][number];

/** A stored message in the SDK's shape. A turn's reasoning goes back only to the model that produced it. */
function toSdk(m: AgentMessage, model: string): SdkMessage {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "tool")
    return { role: "tool", toolCallId: m.toolCallId, content: m.content };
  return {
    role: "assistant",
    content: m.content || null,
    ...(AGENT_REASONING_PASSBACK &&
      m.reasoning?.model === model && {
        reasoningDetails: m.reasoning.details as never,
      }),
    ...(m.toolCalls?.length && {
      toolCalls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    }),
  };
}
function textOf(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item: unknown) =>
      item &&
      typeof item === "object" &&
      "text" in item &&
      typeof item.text === "string"
        ? item.text
        : "",
    )
    .join("");
}
const reportedCost = (value: unknown) =>
  z.object({ usage: z.object({ cost: z.number() }) }).safeParse(value).data
    ?.usage.cost ?? null;

export async function openRouterPost(path: string, body: unknown) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY must be set in .env.local.");
  const response = await fetch(`https://openrouter.ai/api/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(
      `OpenRouter ${path} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return response.json() as Promise<unknown>;
}

const TODAY = () => new Date().toISOString().slice(0, 10);

/** PNG, JPEG or WebP, from the file's first bytes (models don't all say which they returned). */
function imageType(body: Buffer) {
  if (
    body
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (body[0] === 0xff && body[1] === 0xd8) return "image/jpeg";
  if (
    body.subarray(0, 4).toString() === "RIFF" &&
    body.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  throw new Error(
    "The image model returned a file that isn't PNG, JPEG or WebP.",
  );
}

export function getAgentProviders(onCost: OnCost): AgentProviders {
  const screenshotKey = process.env.SCREENSHOTENGINE_API_KEY;
  return {
    async chat({
      system,
      messages,
      tools,
      effort,
      model: requested,
      forceTool,
    }) {
      const model = requested ?? AGENT_MODELS.director;
      const response = await client().chat.send({
        chatRequest: {
          model,
          maxTokens: 32_000,
          reasoning: { effort, summary: "detailed" },
          messages: [
            { role: "system", content: `${system}\n\nToday is ${TODAY()}.` },
            ...messages.map((m) => toSdk(m, model)),
          ],
          tools: tools.map((t) => ({ type: "function" as const, function: t })),
          ...(forceTool
            ? {
                toolChoice: {
                  type: "function" as const,
                  function: { name: forceTool },
                },
              }
            : {}),
        },
      });
      if (!("choices" in response))
        throw new Error(
          "OpenRouter returned a stream instead of a completion.",
        );
      onCost({
        usd: response.usage?.cost ?? null,
        reasoningTokens:
          response.usage?.completionTokensDetails?.reasoningTokens ?? 0,
      });
      const message = response.choices[0]?.message;
      if (!message) throw new Error("The model returned no answer.");
      const summaries = (message.reasoningDetails ?? []).flatMap((d) =>
        d.type === "reasoning.summary" ? [d.summary] : [],
      );
      return {
        reasoning: message.reasoning || summaries.join("\n\n") || undefined,
        ...(AGENT_REASONING_PASSBACK &&
          message.reasoningDetails?.length && {
            passback: { model, details: message.reasoningDetails },
          }),
        content: textOf(message.content),
        toolCalls: (message.toolCalls ?? []).map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: c.function.arguments || "{}",
        })),
      };
    },
    async vision(dataUrl, instruction) {
      const response = await client().chat.send({
        chatRequest: {
          model: VISION_MODEL,
          maxTokens: 2_000,
          reasoning: { effort: "low" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: instruction },
                { type: "image_url", imageUrl: { url: dataUrl } },
              ],
            },
          ],
        },
      });
      if (!("choices" in response))
        throw new Error(
          "OpenRouter returned a stream instead of a completion.",
        );
      onCost({ usd: response.usage?.cost ?? null });
      return textOf(response.choices[0]?.message.content).trim();
    },
    async serp(query, depth = 10) {
      const { result, costUsd } = await postLive(
        "/serp/google/organic/live/advanced",
        // The AI overview, even when Google loads it after the page: $0.002 more, refunded when there is none.
        {
          keyword: query,
          location_code: LOCATION_CODE,
          language_code: LANGUAGE_CODE,
          depth,
          device: "desktop",
          load_async_ai_overview: true,
        },
      );
      onCost({ usd: costUsd });
      const response = result.length === 1 ? result[0] : result;
      const items = result.flatMap((entry) =>
        entry &&
        typeof entry === "object" &&
        "items" in entry &&
        Array.isArray(entry.items)
          ? entry.items
          : [],
      );
      const organic = items.flatMap((item) => {
        const parsed = OrganicItemSchema.safeParse(item);
        return parsed.success
          ? [
              {
                url: parsed.data.url,
                title: parsed.data.title ?? "",
                description: parsed.data.description ?? "",
                position: parsed.data.rank_group,
              },
            ]
          : [];
      });
      return { response, organic };
    },
    async youtube(query) {
      const { result, costUsd } = await postLive(
        "/serp/youtube/organic/live/advanced",
        {
          keyword: query,
          location_code: LOCATION_CODE,
          language_code: LANGUAGE_CODE,
          device: "desktop",
        },
      );
      onCost({ usd: costUsd });
      return result.length === 1 ? result[0] : result;
    },
    async youtubeSubtitles(videoId) {
      const { result, costUsd } = await postLive(
        "/serp/youtube/video_subtitles/live/advanced",
        {
          video_id: videoId,
          location_code: LOCATION_CODE,
          language_code: LANGUAGE_CODE,
          device: "desktop",
        },
      );
      onCost({ usd: costUsd });
      return result.length === 1 ? result[0] : result;
    },
    async keywordData(keywords) {
      const { result, costUsd } = await postLive(
        "/dataforseo_labs/google/keyword_overview/live",
        {
          keywords,
          location_code: LOCATION_CODE,
          language_code: LANGUAGE_CODE,
          include_serp_info: true,
        },
      );
      onCost({ usd: costUsd });
      return { response: result.length === 1 ? result[0] : result, costUsd };
    },
    async generateImage(prompt, aspectRatio) {
      const response = await openRouterPost("images", {
        model: AGENT_IMAGE_MODEL,
        prompt,
        aspect_ratio: aspectRatio,
        n: 1,
        ...AGENT_IMAGE_OPTIONS,
      });
      onCost({ usd: reportedCost(response) });
      const item = z
        .object({
          data: z
            .array(
              z.object({
                b64_json: z.string().min(20).max(30_000_000).optional(),
                url: z.string().optional(),
              }),
            )
            .min(1),
        })
        .parse(response).data[0];
      // Most models return the image inline; some return a link to it.
      const body = item.b64_json
        ? Buffer.from(item.b64_json, "base64")
        : item.url
          ? Buffer.from(
              await (
                await fetch(item.url, { signal: AbortSignal.timeout(60_000) })
              ).arrayBuffer(),
            )
          : null;
      if (!body) throw new Error("The image model returned no image.");
      return { base64: body.toString("base64"), mimeType: imageType(body) };
    },
    ...(screenshotKey
      ? {
          async screenshot(
            url: string,
            {
              fresh = false,
              fullPage = false,
            }: { fresh?: boolean; fullPage?: boolean } = {},
          ) {
            const response = await fetch(
              "https://api.screenshotengine.com/v1/screenshot",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${screenshotKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  url,
                  format: "webp",
                  width: 1280,
                  height: fullPage ? "full" : 720,
                  blockBanners: true,
                  ...(fresh ? { cachePolicy: "no-cache" } : {}),
                }),
                signal: AbortSignal.timeout(90_000),
              },
            );
            const mimeType = response.headers
              .get("content-type")
              ?.split(";")[0]
              .trim();
            if (!response.ok)
              throw new Error(
                `ScreenshotEngine returned HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`,
              );
            if (
              !mimeType ||
              !["image/png", "image/jpeg", "image/webp"].includes(mimeType)
            )
              throw new Error("ScreenshotEngine did not return an image.");
            const body = Buffer.from(await response.arrayBuffer());
            if (body.length < 1000)
              throw new Error("ScreenshotEngine returned an empty image.");
            return { base64: body.toString("base64"), mimeType };
          },
        }
      : {}),
    async embed(texts) {
      // The product's site index (product_pages) is embedded with this model, so lookups must use it too.
      const response = await openRouterPost("embeddings", {
        model: EMBEDDING_MODEL,
        input: texts,
        encoding_format: "float",
      });
      onCost({ usd: reportedCost(response) });
      return z
        .object({
          data: z.array(
            z.object({ index: z.number(), embedding: z.array(z.number()) }),
          ),
        })
        .parse(response)
        .data.sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    },
  };
}
