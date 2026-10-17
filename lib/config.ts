/**
 * Inkstaff settings. Every value can be set in the environment (.env.local; see .env.example); the defaults below are
 * used when a variable is unset. API keys and credentials are read where they are used and never have defaults.
 */

const raw = (name: string) => process.env[name]?.trim() || undefined;

const text = (name: string, fallback: string) => raw(name) ?? fallback;

function number(name: string, fallback: number) {
  const value = raw(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, not "${value}".`);
  return parsed;
}

function bool(name: string, fallback: boolean) {
  const value = raw(name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true or false, not "${value}".`);
}

type Effort = "low" | "medium" | "high";
function effort(name: string, fallback: Effort): Effort {
  const value = raw(name);
  if (value === undefined) return fallback;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`${name} must be low, medium or high, not "${value}".`);
}

function json<T>(name: string, fallback: T): T {
  const value = raw(name);
  if (value === undefined) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${name} must be JSON.`);
  }
}

// --- Storage ---------------------------------------------------------------------------------------------------------

/** The SQLite database file. Created, with its tables, on first use. */
export const DATABASE_PATH = text("DATABASE_PATH", "data/inkstaff.db");

// --- Market ----------------------------------------------------------------------------------------------------------

/** Where Google and YouTube results and keyword data come from (DataForSEO's location and language codes). */
export const LOCATION_CODE = number("DATAFORSEO_LOCATION_CODE", 2840);
export const LANGUAGE_CODE = text("DATAFORSEO_LANGUAGE_CODE", "en");

// --- Models (OpenRouter ids, https://openrouter.ai/models) -----------------------------------------------------------

/**
 * The model each agent runs on. The agents that make the content's decisions (Editor, Writer, Reviewer) and the Director
 * (whose routing decides how the run goes) run on a strong model; Research (which reads the most) and Graphics (which
 * makes the planned media, checked by vision and the Reviewer) can run on a cheaper one. All must support tool calling.
 */
export const AGENT_MODELS = {
  director: text("MODEL_DIRECTOR", "openai/gpt-6.1-sol"),
  research: text("MODEL_RESEARCH", "openai/gpt-6-luna-pro"),
  editor: text("MODEL_EDITOR", "openai/gpt-6.1-sol"),
  writer: text("MODEL_WRITER", "openai/gpt-6.1-sol"),
  graphics: text("MODEL_GRAPHICS", "openai/gpt-6-luna-pro"),
  reviewer: text("MODEL_REVIEWER", "anthropic/claude-sonnet-5.5"),
} as const;
/** Reasoning effort per agent: low, medium or high. Higher thinks longer: better judgment, slower, more expensive. */
export const AGENT_EFFORT = {
  director: effort("EFFORT_DIRECTOR", "medium"),
  research: effort("EFFORT_RESEARCH", "medium"),
  editor: effort("EFFORT_EDITOR", "high"),
  writer: effort("EFFORT_WRITER", "medium"),
  graphics: effort("EFFORT_GRAPHICS", "low"),
  reviewer: effort("EFFORT_REVIEWER", "high"),
} as const;
/** Looks at images (screenshots, drawn images, rendered pages). Must accept image inputs. */
export const VISION_MODEL = text("MODEL_VISION", AGENT_MODELS.graphics);
/**
 * Send each turn's reasoning back to the model on the agent's next turn (OpenAI's encrypted reasoning, through
 * OpenRouter), so it continues its reasoning between tool calls rather than starting over. Off: every turn reasons afresh.
 */
export const AGENT_REASONING_PASSBACK = bool("REASONING_PASSBACK", true);
/** In-article illustrations, infographics and the cover (OpenRouter Images API). */
export const AGENT_IMAGE_MODEL = text("IMAGE_MODEL", "openai/gpt-image-2.5-flare");
/**
 * Model-specific settings sent with every image request, as JSON; each model accepts different ones (OpenRouter lists
 * them at /api/v1/images/models). GPT Image: {"quality": "low" | "medium" | "high"}. Gemini: resolution, output_format.
 */
export const AGENT_IMAGE_OPTIONS = json<Record<string, string | number>>("IMAGE_OPTIONS", { quality: "high" });
/**
 * Embeds your site's pages and each lookup to find internal links. Changing it makes pages indexed with the old model
 * unusable until the site is indexed again (Products → Index website).
 */
export const EMBEDDING_MODEL = text("EMBEDDING_MODEL", "openai/text-embedding-3-small");
/** Summarizes each page of your site when it is indexed. */
export const SITE_SUMMARY_MODEL = text("MODEL_SITE_SUMMARY", AGENT_MODELS.research);

// --- Limits per article ----------------------------------------------------------------------------------------------

/** Hard spending stop per article (model, search and image calls). The article is handed over when reached. */
export const AGENT_BUDGET_USD = number("ARTICLE_BUDGET_USD", 15);
/** Articles the server writes at the same time; the rest wait in the queue. */
export const AGENT_CONCURRENCY = number("AGENT_CONCURRENCY", 2);
/** Reviewer → fix → review cycles before the Director must hand the article over, marked "Needs review". */
export const AGENT_MAX_REVIEW_ROUNDS = number("MAX_REVIEW_ROUNDS", 3);
/** Director turns per article (each decision, refusal or reaction to a report is one); then the article is handed over. */
export const AGENT_MAX_DIRECTOR_TURNS = number("MAX_DIRECTOR_TURNS", 40);
/** Model turns one agent run may take before it must submit its work. */
export const AGENT_MAX_TURNS = {
  research: number("MAX_TURNS_RESEARCH", 30),
  editor: number("MAX_TURNS_EDITOR", 20),
  writer: number("MAX_TURNS_WRITER", 40),
  graphics: number("MAX_TURNS_GRAPHICS", 30),
  reviewer: number("MAX_TURNS_REVIEWER", 20),
} as const;
/** Google searches and pages read (shared by the Research, Editor and Reviewer agents). */
export const AGENT_MAX_SEARCHES = number("MAX_SEARCHES", 15);
export const AGENT_MAX_READS = number("MAX_READS", 25);
/** YouTube searches and transcripts; DataForSEO charges about $0.006 per transcript. */
export const AGENT_MAX_VIDEO_SEARCHES = number("MAX_VIDEO_SEARCHES", 5);
export const AGENT_MAX_TRANSCRIPTS = number("MAX_TRANSCRIPTS", 10);
/** Paid keyword data calls (keyword_data) and their spend. */
export const AGENT_MAX_PAID_DATA_CALLS = number("MAX_PAID_DATA_CALLS", 4);
export const AGENT_PAID_DATA_BUDGET_USD = number("PAID_DATA_BUDGET_USD", 0.1);
/** Generated images per article (illustrations, covers, retries); screenshots count separately. */
export const AGENT_MAX_IMAGES = number("MAX_IMAGES", 10);
export const AGENT_MAX_SCREENSHOTS = number("MAX_SCREENSHOTS", 15);

// --- Site index ------------------------------------------------------------------------------------------------------

/** Pages of a product's site indexed for internal links (its home page, priority pages, then its sitemap). */
export const SITE_INDEX_MAX_PAGES = number("SITE_INDEX_MAX_PAGES", 200);
