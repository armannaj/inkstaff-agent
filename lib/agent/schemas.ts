import { z } from "zod";
import { ARTICLE_GOALS } from "@/lib/schemas";

export const SOURCE_TYPES = [
  "primary",
  "research",
  "news",
  "independent",
  "vendor",
  "competitor",
  "forum",
  "other",
] as const;
export const CONTENT_FORMATS = ["comparison", "how_to", "list", "explainer"] as const;
export const ListItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  bestFor: z.string().nullable(),
  strengths: z.array(z.string()),
  limitations: z.array(z.string()),
  pricing: z.string().nullable(),
  url: z.string().describe("The item's own site, if it is a read source; otherwise empty."),
});

/**
 * The documents the agents hand each other, each submitted through the agent's submit_… tool and checked here.
 */

const sourceIds = z.array(z.string()).describe("IDs of read sources (source-N) that back this.");

export const ResearchDossierSchema = z.object({
  summary: z.string().describe("What searchers find for this keyword today and what is missing, in a few paragraphs: findings, not advice."),
  searchIntent: z.string().describe("What the searcher wants, as the results show it."),
  serp: z.object({
    results: z
      .array(z.object({ position: z.number(), type: z.string(), url: z.string(), title: z.string() }))
      .describe("The results page as Google shows it, top to bottom: organic results and other result types."),
    whatRanks: z.string().describe("Who ranks and with what kind of page."),
    aiOverview: z
      .object({
        text: z.string().describe("What it says."),
        references: z.array(z.object({ url: z.string(), title: z.string() })).describe("The pages it cites."),
      })
      .nullable()
      .describe("Google's AI overview for the keyword; null when there is none."),
    features: z.string().describe("What else the results page shows besides the links (People also ask, videos, ...)."),
    commonItemsOrTopics: z.array(z.string()),
  }),
  landscape: z
    .object({
      pages: z.array(
        z.object({
          url: z.string(),
          covers: z.string().describe("What the page covers."),
          presentation: z
            .string()
            .describe("How it presents it: structure, tables, screenshots, other images, videos, interactive parts."),
          depth: z.string(),
          freshness: z.string().describe("How current it is, and how you can tell."),
          misses: z.string().describe("What it leaves out or gets wrong."),
        }),
      ),
      videos: z.array(
        z.object({
          url: z.string(),
          title: z.string(),
          channel: z.string(),
          covers: z.string().describe("What the video covers."),
          presentation: z.string().describe("How: format (walkthrough, review, talking head...), length, quality."),
          freshness: z.string(),
          misses: z.string().describe("What it leaves out or gets wrong."),
        }),
      ),
      missing: z.array(z.string()).describe("What a searcher can't get from the ranking pages or videos today."),
    })
    .describe("What exists for this search today, in text (the ranking pages) and video: each one's coverage and presentation, and what is missing."),
  keywords: z
    .array(
      z.object({
        keyword: z.string(),
        searchVolume: z.number().nullable().describe("Monthly searches."),
        growth: z.string().describe("How demand has moved, as the data shows (monthly, quarterly, yearly)."),
        cpc: z.number().nullable().describe("USD."),
        competition: z.string().nullable(),
        difficulty: z.number().nullable().describe("Keyword difficulty, 0-100."),
        intent: z.string().nullable(),
        note: z.string(),
      }),
    )
    .describe("The article's keyword(s) and related ones, with their keyword data."),
  readerQuestions: z.array(z.string()),
  entities: z
    .array(z.object({ name: z.string(), role: z.string(), sourceIds }))
    .describe("Products, tools or options the ranking pages and videos cover, each with its own sources."),
  gaps: z.array(z.string()).describe("What you couldn't find out."),
  sources: z
    .array(
      z.object({
        id: z.string(),
        sourceType: z
          .enum(SOURCE_TYPES)
          .describe(
            "primary: the official site, docs, pricing or help page of what it describes. competitor: sells something competing with the product. vendor, research, news, independent, forum, other.",
          ),
        facts: z.array(z.string()),
        credibility: z.string(),
      }),
    )
    .describe("A note for every source you read."),
});

export const EditorialPlanSchema = z.object({
  goal: z.enum(ARTICLE_GOALS).describe("What the article is for beyond ranking: the author's goal when set; yours when the author left it to you."),
  format: z.enum(CONTENT_FORMATS),
  reader: z.string(),
  angle: z.string().describe("What this page gives the reader that the ranking pages don't."),
  readerNeeds: z.array(z.string()).describe("The questions the article must answer."),
  h1: z.string().describe("The title. The site publishes it as the page title Google shows."),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  metaDescription: z.string(),
  excerpt: z.string(),
  secondaryKeywords: z.array(z.string()),
  selectionMethodology: z.string().nullable().describe("For lists: how the items were chosen. Otherwise null."),
  targetWords: z.number().int().positive(),
  sections: z
    .array(
      z.object({
        heading: z.string(),
        purpose: z.string(),
        keyPoints: z.array(z.string()),
        sourceIds,
        item: z.string().nullable().describe("For list articles: the one item this section covers. Otherwise null."),
        answers: z.array(z.string()).describe("readerNeeds this section answers."),
        internalLinks: z.array(z.string()).describe("Your site's pages (from site_pages) to link here."),
        targetWords: z.number().int().positive(),
      }),
    )
    .min(2)
    .max(20),
  media: z
    .array(
      z.object({
        kind: z.enum(["screenshot", "illustration", "infographic", "video"]),
        section: z.number().int().min(1).describe("The section's number in this plan (1 = the first section)."),
        what: z
          .string()
          .describe(
            "screenshot: the page's URL. illustration: the scene. infographic: its title and items. video: the YouTube URL, from search_youtube (published as an embedded player).",
          ),
        why: z.string(),
      }),
    )
    .describe("Every image, screenshot, infographic and video in the article, and where. [] for none. The cover is always made."),
  coverIdea: z.string().describe("What the cover should show: a short headline idea and one simple motif."),
});

export const DraftNotesSchema = z.object({
  notes: z.string().describe("What you wrote or changed, and anything the reviewer should look at."),
});
export const MediaNotesSchema = z.object({
  notes: z.string().describe("Which images you placed where, and why."),
});

export const ReviewReportSchema = z.object({
  verdict: z.enum(["approve", "revise"]),
  summary: z.string(),
  issues: z.array(
    z.object({
      id: z.string().describe("Unique, e.g. r1-3."),
      severity: z
        .enum(["critical", "major", "minor"])
        .describe(
          "critical: wrong or harmful (false facts, broken promise of the title, missing core of the search intent). major: hurts the article's goal (a missing reader need, a weak or unsupported section, a misleading image). minor: polish that doesn't change whether the article meets its goal.",
        ),
      owner: z.string().describe("The name of the agent that can fix it (see team in your brief)."),
      sectionId: z.string().nullable(),
      problem: z.string(),
      fix: z.string(),
    }),
  ),
});

/** A Director decision as recorded on the article: which agent it started (or finish), and why. */
export const DirectorDecisionSchema = z.object({
  /** An agent's name, or "finish". */
  next: z.string(),
  instructions: z.string(),
  issueIds: z.array(z.string()),
  accepted: z.array(z.string()),
  reason: z.string(),
});

export const SectionInputSchema = z.object({
  sectionId: z.string(),
  heading: z.string(),
  markdown: z.string().describe("The section body in Markdown, without its heading."),
  listItems: z.array(ListItemSchema).describe("For a list item section: exactly that item. Otherwise []."),
});
