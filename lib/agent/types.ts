import type { z } from "zod";
import type { ArticleInput } from "@/lib/schemas";
import type {
  DirectorDecisionSchema,
  DraftNotesSchema,
  EditorialPlanSchema,
  ListItemSchema,
  MediaNotesSchema,
  ResearchDossierSchema,
  ReviewReportSchema,
  SOURCE_TYPES,
} from "./schemas";

/** The agents' types. The article input (the "New article" form) is defined in lib/schemas.ts. */
export type { ArticleInput };

/** A worker agent's name: a key of AGENT_DEFINITIONS (agents.ts), the one place agents are defined. */
export type WorkerAgent = string;
export type AgentName = WorkerAgent | "director";

/** "research" → "Research". */
export const agentLabel = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** The product's writing settings, copied onto the article when it is created. */
export type Website = {
  websiteUrl: string;
  brandName: string;
  productDescription: string;
  targetAudience: string;
  writingGuidelines: string;
  excludedPages: string[];
  coverStyle?: string;
};

export type SourceType = (typeof SOURCE_TYPES)[number];
/** A page an agent read. Only read pages may be cited or linked. */
export type Source = {
  id: string;
  url: string;
  title: string;
  publisher: string;
  publicationDate: string | null;
  accessedAt: string;
  content: string;
  facts: string[];
  credibility: string;
  sourceType: SourceType;
  /** The page's raw HTML, kept in agent_assets (it can be megabytes); `content` is the extracted text code checks use. */
  rawAssetId?: string;
};
/** A page of the product's own site, found by site_pages; it may be linked. */
export type SitePage = { url: string; title: string; summary: string };

export type ListItem = z.infer<typeof ListItemSchema>;
export type Section = { id: string; heading: string; markdown: string; listItems: ListItem[] };

export type ArticleImage = {
  id: string;
  sectionId: string;
  kind: "screenshot" | "illustration" | "infographic";
  altText: string;
  /** Screenshot: the page captured. Illustration: the scene drawn. Infographic: its title. */
  subject: string;
  /** Illustrations and infographics: the technique it was drawn in, within the house style (none: the house style's own). */
  style?: string;
  /** Infographics: the exact text drawn, which the image is checked against. */
  infographic?: InfographicSpec;
  assetId?: string;
  error?: string;
};
export type InfographicSpec = { title: string; points: { label: string; detail?: string }[] };
/** A YouTube video placed in a section, from a YouTube search. */
export type ArticleVideo = {
  id: string;
  sectionId: string;
  url: string;
  title: string;
  channel: string;
  durationSeconds?: number;
  views?: number;
  publishedAt?: string;
  reason: string;
};
export type Cover = {
  headline: string;
  artDirection: string;
  style: string;
  assetId?: string;
  altText: string;
  /** What the image actually reads when the headline came out wrong. */
  textIssue?: string;
};
export type Metadata = {
  h1: string;
  slug: string;
  metaDescription: string;
  excerpt: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
};
export type ExistingPost = { url: string; slug: string; title: string; headings: string[]; content: string };
export type Publication = {
  slug: string;
  url: string | null;
  publishedAt: string;
  updatedAt: string;
  /** Public URL of each uploaded image, by asset ID. */
  assets: Record<string, string>;
  response: string;
};

export type ResearchDossier = z.infer<typeof ResearchDossierSchema>;
export type EditorialPlan = z.infer<typeof EditorialPlanSchema>;
export type PlanSection = EditorialPlan["sections"][number] & { id: string };
/** A media item of the plan, tied to its section. */
export type PlannedMedia = Omit<EditorialPlan["media"][number], "section"> & { sectionId: string };
export type DraftNotes = z.infer<typeof DraftNotesSchema>;
export type MediaNotes = z.infer<typeof MediaNotesSchema>;
export type ReviewIssue = z.infer<typeof ReviewReportSchema>["issues"][number] & {
  /** Found by the code checks rather than the reviewer. */
  fromChecks?: boolean;
};
export type ReviewReport = Omit<z.infer<typeof ReviewReportSchema>, "issues"> & {
  issues: ReviewIssue[];
  round: number;
  at: string;
};
export type DirectorDecision = z.infer<typeof DirectorDecisionSchema> & { at: string; overridden?: string };

/** One line of the activity timeline the editor page shows. */
export type TimelineEvent = {
  at: string;
  agent: AgentName | "system" | "human";
  /** call: a tool call (text = name and arguments); tool/error: what came of it; message: text an agent wrote. */
  kind: "start" | "call" | "tool" | "message" | "thinking" | "submit" | "decision" | "note" | "error";
  text: string;
};

/**
 * The Director's own thread. Its conversation is in agent_messages under `runId`. While a worker runs, the Director's
 * run_agent call is parked in `pending`; the worker's report becomes that call's result when it is done.
 */
export type DirectorThread = {
  runId: string;
  turns: number;
  /** Director turns in a row whose calls code refused; after three, code picks the obvious next step. */
  refusals: number;
  pending: { toolCallId: string | null; agent: WorkerAgent } | null;
};

/** The agent currently working. Its conversation is in agent_messages under `id`. */
export type AgentRun = {
  id: string;
  agent: WorkerAgent;
  instructions: string;
  /** Review issues the Director sent with this run. */
  issueIds: string[];
  turns: number;
  startedAt: string;
};

export type AgentCost = {
  totalUsd: number;
  calls: number;
  /** Calls whose cost the provider didn't report, so the total is a lower bound. */
  unpricedCalls: number;
  byAgent: Record<string, number>;
  /** Per agent: its model turns, the reasoning tokens they spent, and how many spent none. Missing on older articles. */
  reasoning?: Record<string, { turns: number; tokens: number; turnsWithout: number }>;
};

export type Usage = {
  searches: number;
  /** YouTube searches. */
  videoSearches: number;
  /** YouTube transcripts read (missing on older articles). */
  transcripts?: number;
  reads: number;
  paidDataCalls: number;
  paidDataUsd: number;
  images: number;
  screenshots: number;
};

export type AgentState = {
  website: Website;
  existingPost?: ExistingPost;
  sources: Source[];
  sitePages: SitePage[];
  /** serp_overview results by keyword, so agents asking again don't pay again. */
  serpOverviews?: Record<string, unknown>;
  /** web_search responses by query and depth, for the same reason. */
  searchCache?: Record<string, unknown>;
  /** search_youtube responses by query; add_video only accepts videos from them. */
  youtubeCache?: Record<string, unknown>;
  /** video_transcript responses by video ID, so a transcript is paid for once. */
  transcriptCache?: Record<string, unknown>;
  dossier?: ResearchDossier;
  plan?: Omit<EditorialPlan, "sections" | "media"> & { sections: PlanSection[]; media?: PlannedMedia[] };
  sections: Section[];
  /**
   * The FAQ as a separate field, published after the last section. Older articles only: an FAQ is now a section the
   * Editor plans and the Writer writes, like any other. Kept so those articles still show and publish theirs.
   */
  faq: { question: string; answer: string }[];
  images: ArticleImage[];
  videos: ArticleVideo[];
  cover?: Cover;
  metadata?: Metadata;
  draftNotes?: DraftNotes;
  mediaNotes?: MediaNotes;
  reviews: ReviewReport[];
  decisions: DirectorDecision[];
  director?: DirectorThread;
  run: AgentRun | null;
  usage: Usage;
  cost: AgentCost;
  timeline: TimelineEvent[];
  /** Notes the author sent to the agents; the Director reads the ones not yet handled. */
  humanNotes: { at: string; text: string; handled: boolean }[];
  /** Sections or images changed after the latest review, so finishing needs a fresh one. */
  changedSinceReview: boolean;
  publication?: Publication;
  /** Why the run ended, shown to the author. */
  outcome?: string;
};

export type AgentStatus = "queued" | "running" | "paused" | "ready" | "needs_review" | "failed";

export type AgentArticle = {
  id: string;
  productId: number;
  title: string;
  status: AgentStatus;
  input: ArticleInput;
  state: AgentState;
  version: number;
  contentMarkdown: string;
  wordCount: number;
  error: string | null;
  /** Pause or stop asked for from the page; the runner acts on it between turns. */
  control: "pause" | "stop" | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

/** Where images and agent conversations are kept (the database; fakes in tests). */
export type AssetStore = {
  save: (id: string, articleId: string, image: { base64: string; mimeType: string }) => Promise<void>;
  get: (id: string) => Promise<{ base64: string; mimeType: string } | null>;
};
/** One run's conversation is its rows in agent_messages, in order. */
export type MessageStore = {
  load: (articleId: string, agent: AgentName, runId: string) => Promise<AgentMessage[]>;
  append: (articleId: string, agent: AgentName, runId: string, messages: AgentMessage[]) => Promise<void>;
};

/** A stored model message, converted to OpenRouter's shape when sent. */
export type AgentMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: { id: string; name: string; arguments: string }[];
      /** The turn's reasoning as the model returned it (encrypted), sent back on later turns to the same model only. */
      reasoning?: { model: string; details: unknown[] };
    }
  | { role: "tool"; toolCallId: string; name: string; content: string };
