import { test } from "node:test";
import assert from "node:assert/strict";
import { articleInputSchema, competitorPolicy, DEFAULT_INPUT } from "@/lib/schemas";
import { step } from "./engine";
import { decisionProblem, defaultDecision, finishVerdict } from "./director";
import { checkArticle, titleProblems } from "./checks";
import { cleanLinks, headingAnchors } from "./content/links";
import { assignSectionIds } from "./tools/submit";
import { callSummary, conversationForModel, runTurn } from "./harness";
import { htmlToMarkdown } from "./web/markdown";
import { AGENT_MODELS } from "@/lib/config";
import { calculatedNumbers, unsupportedNumbers } from "./content/verify";
import { reviewerTools } from "./tools/reviewer";
import { markdownToHtml, publishMarkdown } from "./publish/publish";
import { youtubeVideoId } from "./web/youtube";
import { maxWords } from "./checks";
import { task } from "./agents";
import { AGENT_DEFINITIONS, ARTICLE_GOAL } from "./agents";
import { emptyState } from "./store";
import { addCost } from "./runner";
import type { AgentProviders, ModelReply } from "./providers";
import type { AgentArticle, AgentMessage, AgentState, PlanSection, Source } from "./types";

const website = {
  websiteUrl: "https://example.com",
  brandName: "Example",
  productDescription: "Example crossposts posts.",
  targetAudience: "",
  writingGuidelines: "",
  excludedPages: [],
};
function article(state: Partial<AgentState> = {}): AgentArticle {
  return {
    id: "a1",
    productId: 1,
    title: "t",
    status: "running",
    input: { ...DEFAULT_INPUT, productId: 1, primaryKeyword: "buffer alternative" },
    state: { ...emptyState(website), ...state },
    version: 0,
    contentMarkdown: "",
    wordCount: 0,
    error: null,
    control: null,
    createdAt: "",
    updatedAt: "",
    publishedAt: null,
  };
}
const source = (id: string, url: string, content: string, sourceType: Source["sourceType"] = "primary"): Source => ({
  id,
  url,
  title: id,
  publisher: new URL(url).hostname,
  publicationDate: null,
  accessedAt: "",
  content,
  facts: [],
  credibility: "",
  sourceType,
});
const planSection = (id: string, heading: string, item: string | null = null): PlanSection => ({
  id,
  heading,
  purpose: "",
  keyPoints: [],
  sourceIds: [],
  item,
  answers: [],
  internalLinks: [],
  targetWords: 200,
});
function memoryStores() {
  const messages = new Map<string, AgentMessage[]>();
  const assets = new Map<string, { base64: string; mimeType: string }>();
  return {
    messages: {
      load: async (_a: string, _agent: string, runId: string) => messages.get(runId) ?? [],
      append: async (_a: string, _agent: string, runId: string, added: AgentMessage[]) =>
        void messages.set(runId, [...(messages.get(runId) ?? []), ...added]),
    },
    assets: { save: async (id: string, _a: string, image: { base64: string; mimeType: string }) => void assets.set(id, image), get: async (id: string) => assets.get(id) ?? null },
    raw: { messages, assets },
  };
}
const call = (name: string, args: unknown) => ({ id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) });

test("section IDs survive a re-plan when the heading or item is unchanged", () => {
  const first = assignSectionIds([planSection("", "Intro"), planSection("", "Alpha: best for teams", "Alpha")]);
  assert.deepEqual(first.map((s) => s.id), ["s1", "s2"]);
  const second = assignSectionIds([planSection("", "Alpha: best for agencies", "Alpha"), planSection("", "New"), planSection("", "Intro")], first);
  assert.deepEqual(second.map((s) => s.id), ["s2", "s3", "s1"]);
});

test("links are kept to any page that was read (competitors' too: citing is an editorial call) and site pages; never to unread pages", () => {
  const state = {
    website,
    sitePages: [{ url: "https://example.com/pricing", title: "", summary: "" }],
    sources: [source("source-1", "https://docs.test/a", ""), source("source-2", "https://rival.test/blog", "", "competitor")],
  };
  const { sections, removed } = cleanLinks(
    [{ id: "s1", heading: "H", markdown: "See [docs](https://docs.test/a), [rival](https://rival.test/blog), [made up](https://nowhere.test) and [pricing](https://example.com/pricing).", listItems: [] }],
    state,
    { internalLinks: "auto", externalLinks: "auto" },
  );
  assert.deepEqual(removed, ["https://nowhere.test"]);
  assert.match(sections[0].markdown, /\[docs\]\(https:\/\/docs\.test\/a\), \[rival\]\(https:\/\/rival\.test\/blog\), made up and \[pricing\]/);
});

test("code checks flag invented numbers, unwritten sections and title problems", () => {
  const a = article({
    sources: [source("source-1", "https://docs.test/a", "Creator costs $12 a month for 4 accounts.")],
    plan: { sections: [planSection("s1", "One"), planSection("s2", "Two")] } as AgentState["plan"],
    sections: [{ id: "s1", heading: "One", markdown: "Creator costs $12 a month. It grew 340% last year.", listItems: [] }],
    metadata: { h1: "How to Choose a Tool in 2025", slug: "x", metaDescription: "", excerpt: "", primaryKeyword: "", secondaryKeywords: [] },
  });
  const issues = checkArticle(a);
  assert.ok(issues.some((i) => i.severity === "critical" && i.sectionId === "s2"));
  assert.ok(issues.some((i) => /340/.test(i.problem) && !/\$12/.test(i.problem)));
  const title = titleProblems(a, new Date("2026-10-01"));
  assert.ok(title.some((p) => /primary keyword/.test(p)));
  assert.ok(title.some((p) => /this year, 2026/.test(p)));
});

test("the Director must follow the order of work, and finishes only on a clean review or at the round limit", () => {
  const empty = article();
  const base = { instructions: "", issueIds: [], accepted: [], reason: "" };
  assert.match(decisionProblem(empty, { ...base, next: "writer" }) ?? "", /no editorial plan/);
  assert.match(decisionProblem(empty, { ...base, next: "finish" }) ?? "", /Nothing has been reviewed/);
  assert.equal(defaultDecision(empty).next, "research");
  const review = (round: number, severity: "major" | "minor") => ({
    verdict: "revise" as const,
    summary: "",
    round,
    at: new Date(2026, 0, round).toISOString(),
    issues: [{ id: `r${round}-1`, severity, owner: "writer" as const, sectionId: "s1", problem: "", fix: "" }],
  });
  const written = {
    dossier: {} as AgentState["dossier"],
    draftNotes: { notes: "" },
    mediaNotes: { notes: "" },
    cover: { headline: "x", artDirection: "", style: "", altText: "", assetId: "c1" },
    plan: { h1: "x", sections: [planSection("s1", "One")] } as unknown as AgentState["plan"],
    sections: [{ id: "s1", heading: "One", markdown: "Fine.", listItems: [] }],
  };
  const major = article({ ...written, reviews: [review(1, "major")] });
  assert.match(decisionProblem(major, { ...base, next: "finish" }) ?? "", /Critical or major issues are still open/);
  assert.equal(defaultDecision(major).next, "writer");
  const minor = article({ ...written, reviews: [review(1, "minor")] });
  assert.equal(finishVerdict(minor).status, "ready");
  const limit = article({ ...written, reviews: [review(1, "major"), review(2, "major"), review(3, "major")] });
  assert.deepEqual(finishVerdict(limit), { allowed: true, status: "needs_review" });
  assert.match(decisionProblem(limit, { ...base, next: "writer" }) ?? "", /review limit/);
});

test("the Director can't rerun an agent that just handed back its work with nothing to fix; it sees the Editor's whole plan", () => {
  const plan = {
    goal: "traffic", format: "list", h1: "9 Buffer Alternatives", slug: "buffer-alternative", excerpt: "e", metaDescription: "m", targetWords: 2400,
    sections: [{ ...planSection("s1", "One"), purpose: "p", keyPoints: ["k"], sourceIds: ["source-1"], internalLinks: ["https://example.com/a"] }, planSection("s2", "Two")],
    media: [{ kind: "illustration", sectionId: "s1", what: "a desk", why: "w" }],
    coverIdea: "c",
  } as unknown as AgentState["plan"];
  const a = article({
    dossier: {} as AgentState["dossier"],
    plan,
    decisions: [{ at: "2026-10-04T12:04:00.000Z", next: "editor", instructions: "", issueIds: [], accepted: [], reason: "" }],
    timeline: [{ at: "2026-10-04T12:15:00.000Z", agent: "editor", kind: "submit", text: "Submitted the plan" }],
  });
  const base = { instructions: "", accepted: [], reason: "" };
  assert.match(decisionProblem(a, { ...base, next: "editor", issueIds: [] }) ?? "", /just handed back its work/);
  assert.equal(decisionProblem(a, { ...base, next: "editor", issueIds: ["r1-1"] }), null, "with review issues it may run again");
  assert.equal(decisionProblem(a, { ...base, next: "writer", issueIds: [] }), null);
  a.state.humanNotes = [{ at: "2026-10-04T12:20:00.000Z", text: "Add screenshots", handled: false }];
  assert.equal(decisionProblem(a, { ...base, next: "editor", issueIds: [] }), null, "an author note since lets it run again");
  a.state.humanNotes = [];
  a.state.timeline = [];
  assert.equal(decisionProblem(a, { ...base, next: "editor", issueIds: [] }), null, "an agent stopped before submitting may run again");

  const report = JSON.stringify(AGENT_DEFINITIONS.editor.report(a));
  for (const part of ['"slug":"buffer-alternative"', '"excerpt":"e"', '"targetWords":2400', '"media"', '"coverIdea"', '"sourceIds":["source-1"]', '"internalLinks"'])
    assert.ok(report.includes(part), `the Director sees ${part}`);
  assert.ok(!report.includes('"keyPoints"') && !report.includes('"purpose"'));
});

test("a turn's reasoning summary is logged as a thinking row; reasoning tokens are tallied per agent", async () => {
  const stores = memoryStores();
  const a = article({ plan: { h1: "x", sections: [planSection("s1", "One")] } as unknown as AgentState["plan"] });
  const logs: [string, string][] = [];
  const providers = {
    chat: async () => ({ reasoning: "**Planning the section**\n\nThe pricing facts come from source-1.", content: "", toolCalls: [] }) satisfies ModelReply,
  } as unknown as AgentProviders;
  const run = { id: "run1", agent: "writer" as const, instructions: "", issueIds: [], turns: 0, startedAt: "" };
  await runTurn(AGENT_DEFINITIONS.writer, a, run, { providers, assets: stores.assets, log: (t, k) => logs.push([k ?? "tool", t]), charge: () => {} }, stores.messages);
  assert.deepEqual(logs.find(([kind]) => kind === "thinking"), ["thinking", "**Planning the section**\n\nThe pricing facts come from source-1."]);

  const passback = { model: "openai/gpt-6-luna-pro", details: [{ type: "reasoning.encrypted", data: "gAAAA", format: "openai-responses-v1" }] };
  const withPassback = { chat: async () => ({ content: "", toolCalls: [], passback }) satisfies ModelReply } as unknown as AgentProviders;
  const run2 = { id: "run2", agent: "writer" as const, instructions: "", issueIds: [], turns: 0, startedAt: "" };
  await runTurn(AGENT_DEFINITIONS.writer, a, run2, { providers: withPassback, assets: stores.assets, log: () => {}, charge: () => {} }, stores.messages);
  const saved = stores.raw.messages.get("run2")!.find((m) => m.role === "assistant");
  assert.deepEqual(saved && "reasoning" in saved ? saved.reasoning : null, passback, "the turn's reasoning is kept, with its model, for the next turn");

  addCost(a, "editor", [{ usd: 0.2, reasoningTokens: 438 }, { usd: 0.1, reasoningTokens: 0 }, { usd: 0.01 }]);
  assert.deepEqual(a.state.cost.reasoning, { editor: { turns: 2, tokens: 438, turnsWithout: 1 } }, "a call without a reasoning count (vision, DataForSEO) isn't a model turn");
  assert.equal(a.state.cost.calls, 3);
  assert.ok(Math.abs(a.state.cost.byAgent.editor - 0.31) < 1e-9);
});

test("an agent's last turn forces its submit tool; bad calls get an error the model can read", async () => {
  const stores = memoryStores();
  const a = article({ plan: { h1: "x", sections: [planSection("s1", "One")] } as unknown as AgentState["plan"] });
  const seen: { forceTool?: string }[] = [];
  const providers = {
    chat: async (args: { forceTool?: string }) => {
      seen.push(args);
      return { content: "", toolCalls: [call("write_section", { sectionId: "s9" }), call("nope", {})] } satisfies ModelReply;
    },
  } as unknown as AgentProviders;
  const run = { id: "run1", agent: "writer" as const, instructions: "", issueIds: [], turns: AGENT_DEFINITIONS.writer.maxTurns - 1, startedAt: "" };
  const result = await runTurn(AGENT_DEFINITIONS.writer, a, run, { providers, assets: stores.assets, log: () => {}, charge: () => {} }, stores.messages);
  assert.equal(result.submitted, false);
  assert.equal(seen[0].forceTool, "submit_draft");
  const saved = stores.raw.messages.get("run1")!;
  assert.equal(saved[0].role, "user");
  const tools = saved.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(tools[0], /Invalid arguments/);
  assert.match(tools[1], /Unknown tool/);
});

test("a full run: research → editor → writer → graphics → reviewer, a fix round, then finished", async () => {
  const stores = memoryStores();
  const a = article({ sources: [source("source-1", "https://docs.test/pricing", "Creator costs $12 a month for 4 accounts.")] });
  const replies: Record<string, ModelReply[]> = {
    Research: [
      { content: "", toolCalls: [call("web_search", { query: "buffer alternative pricing" })] },
      {
        content: "",
        toolCalls: [
          call("submit_research", {
            summary: "S",
            searchIntent: "list",
            serp: {
              results: [{ position: 1, type: "organic", url: "https://rival.test/list", title: "8 Buffer alternatives" }],
              whatRanks: "lists",
              aiOverview: { text: "Popular alternatives include Later and Hootsuite.", references: [{ url: "https://rival.test/list", title: "8 Buffer alternatives" }] },
              features: "People also ask",
              commonItemsOrTopics: [],
            },
            landscape: {
              pages: [{ url: "https://rival.test/list", covers: "8 tools", presentation: "a screenshot per tool, one comparison table", depth: "shallow", freshness: "2025 prices", misses: "free plans" }],
              videos: [{ url: "https://www.youtube.com/watch?v=abcDEF12345", title: "Buffer alternatives compared", channel: "SocialTools", covers: "5 tools", presentation: "8-minute screen walkthrough", freshness: "2026", misses: "pricing" }],
              missing: ["current free-plan limits"],
            },
            keywords: [{ keyword: "buffer alternative", searchVolume: 2400, growth: "+20% over the year", cpc: 6.1, competition: "LOW", difficulty: 31, intent: "commercial", note: "" }],
            readerQuestions: [],
            entities: [],
            gaps: [],
            sources: [{ id: "source-1", sourceType: "primary", facts: ["Creator $12"], credibility: "Official" }],
          }),
        ],
      },
    ],
    Editor: [
      { content: "", toolCalls: [call("submit_plan", {
            goal: "signups",
            format: "explainer",
            reader: "r",
            angle: "a",
            readerNeeds: ["What does it cost?"],
            h1: "Buffer Alternative Pricing Explained",
            slug: "buffer-alternative",
            metaDescription: "m",
            excerpt: "e",
            secondaryKeywords: [],
            selectionMethodology: null,
            targetWords: 400,
            sections: [
              { heading: "What it costs", purpose: "p", keyPoints: [], sourceIds: ["source-1", "source-99"], item: null, answers: [], internalLinks: [], targetWords: 200 },
              { heading: "Who it suits", purpose: "p", keyPoints: [], sourceIds: [], item: null, answers: [], internalLinks: [], targetWords: 200 },
            ],
            media: [],
            coverIdea: "Pricing",
          })] }, // refused: YouTube not searched yet
      { content: "", toolCalls: [call("search_youtube", { query: "buffer alternatives" })] },
      { content: "", toolCalls: [call("submit_plan", {
            goal: "signups",
            format: "explainer",
            reader: "r",
            angle: "a",
            readerNeeds: ["What does it cost?"],
            h1: "Buffer Alternative Pricing Explained",
            slug: "buffer-alternative",
            metaDescription: "m",
            excerpt: "e",
            secondaryKeywords: [],
            selectionMethodology: null,
            targetWords: 400,
            sections: [
              { heading: "What it costs", purpose: "p", keyPoints: [], sourceIds: ["source-1", "source-99"], item: null, answers: [], internalLinks: [], targetWords: 200 },
              { heading: "Who it suits", purpose: "p", keyPoints: [], sourceIds: [], item: null, answers: [], internalLinks: [], targetWords: 200 },
            ],
            media: [{ kind: "video", section: 1, what: "https://www.youtube.com/watch?v=abcDEF12345", why: "Shows the prices" }],
            coverIdea: "Pricing, plainly",
          })] },
    ],
    Writer: [
      { content: "", toolCalls: [call("write_section", { sectionId: "s2", heading: "Who it suits", markdown: "Teams.", listItems: [] })] },
      { content: "", toolCalls: [call("write_section", { sectionId: "s1", heading: "What it costs", markdown: "Creator is [$12 a month](https://docs.test/pricing).", listItems: [] })] },
      { content: "", toolCalls: [call("write_section", { sectionId: "s2", heading: "Who it suits", markdown: "It suits 87% of solo creators.", listItems: [] })] },
      { content: "", toolCalls: [call("submit_draft", { notes: "done" })] },
      { content: "", toolCalls: [call("write_section", { sectionId: "s2", heading: "Who it suits", markdown: "It suits solo creators.", listItems: [] }), call("submit_draft", { notes: "fixed" })] },
    ],
    Graphics: [
      { content: "", toolCalls: [call("generate_cover", { headline: "Buffer Alternative Pricing", artDirection: "a calendar" })] },
      {
        content: "",
        toolCalls: [
          call("add_video", { sectionId: "s1", url: "https://www.youtube.com/watch?v=made-up", reason: "x" }), // refused
          call("add_video", { sectionId: "s1", url: "https://www.youtube.com/watch?v=abcDEF12345", reason: "Walks through the pricing" }),
          call("submit_media", { notes: "cover and one video" }),
        ],
      },
    ],
    Reviewer: [
      { content: "", toolCalls: [call("submit_review", { verdict: "approve", summary: "Fine", issues: [] })] },
      { content: "", toolCalls: [call("submit_review", { verdict: "approve", summary: "Fine now", issues: [{ id: "x", severity: "minor", owner: "writer", sectionId: "s1", problem: "Could be warmer", fix: "Warm it up" }] })] },
    ],
  };
  const runAgent = (agent: string, extra: object = {}) => ({ content: "", toolCalls: [call("run_agent", { agent, instructions: `Do ${agent}`, reason: "next", ...extra })] });
  replies.Director = [
    runAgent("research"),
    runAgent("editor"),
    runAgent("writer"),
    runAgent("graphics"),
    runAgent("reviewer"),
    { content: "Looks done.", toolCalls: [call("finish", { reason: "approved" })] }, // refused: the code check found an invented number
    runAgent("writer", { issueIds: ["r1-check-1"] }),
    runAgent("reviewer"),
    { content: "", toolCalls: [call("finish", { accepted: ["r2-1"], reason: "only a minor issue left" })] },
  ];
  let lastPrompt = "";
  const directorConversations: AgentMessage[][] = [];
  const providers: AgentProviders = {
    chat: async ({ system, messages }) => {
      const agent = Object.keys(replies).find((name) => system.startsWith(`You are the ${name} agent`) || system.startsWith(`You are the ${name} of`))!;
      if (agent === "Director") directorConversations.push(messages);
      const reply = replies[agent].shift();
      assert.ok(reply, `No scripted reply left for ${agent}`);
      return reply;
    },
    vision: async (_url, instruction) => (instruction.startsWith("Transcribe") ? "BUFFER ALTERNATIVE PRICING" : "A picture."),
    serp: async () => ({ response: { items: [] }, organic: [{ url: "https://docs.test/pricing", title: "Pricing", description: "", position: 1 }] }),
    generateImage: async (prompt) => {
      lastPrompt = prompt;
      return { base64: "aW1hZ2U=", mimeType: "image/png" };
    },
    embed: async () => [[1]],
    youtube: async () => ({
      items: [{ type: "youtube_video", url: "https://www.youtube.com/watch?v=abcDEF12345", title: "Buffer alternatives compared", channel_name: "SocialTools", duration_time_seconds: 480, views_count: 12000 }],
    }),
    keywordData: async () => ({ response: { items: [] }, costUsd: 0.01 }),
    youtubeSubtitles: async () => ({ items: [] }),
  };
  let result: { done: boolean; status?: string } = { done: false };
  for (let i = 0; i < 40 && !result.done; i++)
    result = await step(a, { providers, charge: () => {}, assets: stores.assets, messages: stores.messages });

  assert.equal(result.status, "ready");
  const { state } = a;
  assert.equal(state.sources[0].sourceType, "primary");
  const reviewerBrief = [...stores.raw.messages.values()].find((m) => m.some((x) => x.role === "tool" && x.name === "submit_review"))![0];
  assert.match(reviewerBrief.content, /a screenshot per tool, one comparison table/);
  assert.deepEqual(state.plan!.sections[0].sourceIds, ["source-1"]);
  assert.equal(state.metadata!.h1, "Buffer Alternative Pricing Explained");
  assert.deepEqual(state.sections.map((s) => s.markdown), ["Creator is [$12 a month](https://docs.test/pricing).", "It suits solo creators."]);
  assert.ok(state.cover?.assetId && !state.cover.textIssue);
  assert.deepEqual(state.videos.map((v) => [v.url, v.channel, v.durationSeconds]), [["https://www.youtube.com/watch?v=abcDEF12345", "SocialTools", 480]]);
  assert.match(publishMarkdown(state, {}), /<iframe [^>]*src="https:\/\/www\.youtube\.com\/embed\/abcDEF12345" title="Buffer alternatives compared"[^>]*allowfullscreen><\/iframe>/);
  const graphicsRun = [...stores.raw.messages.values()].find((m) => m.some((x) => x.role === "tool" && x.name === "add_video"))!;
  assert.match(JSON.stringify(graphicsRun), /Only videos from this article's YouTube searches/);
  const editorRun = [...stores.raw.messages.values()].find((m) => m.some((x) => x.role === "tool" && x.name === "submit_plan"))!;
  assert.match(JSON.stringify(editorRun), /Search YouTube for related videos first/);
  assert.deepEqual(state.plan!.media, [{ kind: "video", what: "https://www.youtube.com/watch?v=abcDEF12345", why: "Shows the prices", sectionId: "s1" }]);
  assert.equal(AGENT_DEFINITIONS.graphics.tools().some((t) => t.name === "search_youtube"), false);
  assert.match(lastPrompt, /Buffer Alternative Pricing/);
  assert.equal(state.cover!.style, "ink-marker", "with no style saved for the product, covers use the default");
  // Round 1: the reviewer approved, but the code check's invented-number issue turned it into "revise".
  assert.equal(state.reviews[0].verdict, "revise");
  assert.ok(state.reviews[0].issues.some((i) => i.id === "r1-check-1" && /87/.test(i.problem)));
  // The Director is one conversation: each worker's report is the result of its run_agent call, and a refused finish
  // comes back as an error it reacts to.
  const thread = directorConversations.at(-1)!;
  assert.equal(directorConversations.length, 9);
  assert.doesNotMatch(JSON.stringify(thread), /Budget|spentUsd|\$15/, "the Director sees no dollar budget or spend");
  assert.equal(thread.filter((m) => m.role === "assistant").length, 8);
  const results = thread.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
  assert.equal(results[0].agent, "research");
  assert.equal(results[4].agent, "reviewer");
  assert.equal(results[4].report.verdict, "revise");
  assert.equal(results[4].report.canFinish.allowed, false);
  assert.match(results[5].error, /Critical or major issues are still open/);
  assert.equal(results.at(-1).agent, "reviewer");
  assert.deepEqual(a.state.decisions.map((d) => d.next), ["research", "editor", "writer", "graphics", "reviewer", "writer", "reviewer", "finish"]);
  assert.equal(state.reviews[1].issues.length, 1);
  assert.match(state.outcome ?? "", /Accepted minor issues: r2-1/);
  // The writer's out-of-order first section was refused, and the refusal reached the model.
  const writerRun = [...stores.raw.messages.values()].find((m) => m.some((x) => x.role === "tool" && x.name === "write_section"))!;
  assert.match(JSON.stringify(writerRun), /Write the sections in order/);
  assert.equal(replies.Writer.length + replies.Reviewer.length + replies.Graphics.length + replies.Director.length, 0);
});

test("totals the text calculates from sourced figures pass the number check; unexplained or wrong ones don't", () => {
  const evidence = "Standard $50, extra user $5, $5.99 and $2.99 per account, $149 per user.";
  const flagged = (markdown: string) => unsupportedNumbers([{ id: "s", markdown }], evidence).flatMap((u) => u.missing);
  assert.deepEqual(flagged("For four users: **[$50 Standard](https://x.test) + (1 × [$5 per user](https://x.test)) = $55/month**. So $55 in total."), []);
  assert.deepEqual(flagged("- **Ten accounts:** (5 × $5.99) + (5 × $2.99) = **$44.90/month**."), []);
  assert.deepEqual(flagged("Two users cost $298/month."), ["298"]);
  assert.deepEqual(flagged("$149 × 2 = $300 per month."), ["300"]);
  assert.deepEqual(calculatedNumbers("Add-ons cost $5/month = $60 a year."), []);
});

test("the log shows each tool call with short arguments, and refusals as errors", async () => {
  assert.equal(
    callSummary("write_section", JSON.stringify({ sectionId: "s3", markdown: "x".repeat(1200), listItems: [] })),
    "write_section(sectionId: s3, markdown: …1,200 chars, listItems: [0])",
  );
  const stores = memoryStores();
  const a = article({ plan: { h1: "x", sections: [planSection("s1", "One")] } as unknown as AgentState["plan"] });
  const logs: [string, string | undefined][] = [];
  const providers = {
    chat: async () => ({ content: "Starting with the intro.", toolCalls: [call("write_section", { sectionId: "s9", heading: "H", markdown: "x", listItems: [] })] }),
  } as unknown as AgentProviders;
  const run = { id: "r", agent: "writer" as const, instructions: "Write it", issueIds: [], turns: 0, startedAt: "" };
  await runTurn(AGENT_DEFINITIONS.writer, a, run, { providers, assets: stores.assets, log: (t, k) => logs.push([k ?? "tool", t]), charge: () => {} }, stores.messages);
  assert.deepEqual(logs.map(([kind]) => kind), ["start", "message", "call", "error"]);
  assert.match(logs[3][1] ?? "", /isn't a planned section/);
});

test("the reviewer rates images in context, and graphics can regenerate one in place", async () => {
  const stores = memoryStores();
  await stores.assets.save("asset-1", "a1", { base64: "aW1n", mimeType: "image/webp" });
  const a = article({
    sections: [{ id: "s1", heading: "Alpha: best for teams", markdown: "Alpha is…", listItems: [] }],
    plan: { h1: "x", sections: [planSection("s1", "Alpha: best for teams", "Alpha")] } as unknown as AgentState["plan"],
    images: [{ id: "img-1", sectionId: "s1", kind: "screenshot", altText: "Alpha home page", subject: "https://alpha.test", assetId: "asset-1" }],
  });
  let prompt = "";
  const providers = {
    vision: async (_url: string, instruction: string) => {
      prompt = instruction;
      return '```json\n{"relevance": 2, "quality": 1, "problems": ["cookie wall covers the page"], "recommendation": "regenerate", "notes": "retake the pricing page"}\n```';
    },
    screenshot: async () => ({ base64: "bmV3", mimeType: "image/webp" }),
  } as unknown as AgentProviders;
  const ctx = { article: a, providers, assets: stores.assets, agent: "reviewer" as const, log: () => {}, charge: () => {} };
  const reviewTool = reviewerTools().find((t) => t.name === "review_image")!;
  const review = (await reviewTool.run({ imageId: "img-1" } as never, ctx)) as { recommendation: string; quality: number };
  assert.equal(review.recommendation, "regenerate");
  assert.equal(review.quality, 1);
  assert.match(prompt, /section "Alpha: best for teams" about Alpha/);
  const regenerate = AGENT_DEFINITIONS.graphics.tools().find((t) => t.name === "regenerate_image")!;
  await regenerate.run({ imageId: "img-1", url: "https://alpha.test/pricing" } as never, { ...ctx, agent: "graphics" });
  assert.equal(a.state.images.length, 1);
  assert.equal(a.state.images[0].subject, "https://alpha.test/pricing");
  assert.notEqual(a.state.images[0].assetId, "asset-1");
  assert.equal(a.state.changedSinceReview, true);
});

test("the Director's refused choices are explained to it; three in a row and code starts the obvious next agent", async () => {
  const stores = memoryStores();
  const a = article();
  const providers = {
    chat: async () => ({ content: "", toolCalls: [call("run_agent", { agent: "writer", instructions: "Write", reason: "eager" })] }),
  } as unknown as AgentProviders;
  for (let i = 0; i < 3; i++) await step(a, { providers, charge: () => {}, assets: stores.assets, messages: stores.messages });
  assert.equal(a.state.run?.agent, "research");
  assert.equal(a.state.decisions[0].overridden, "three refused choices in a row");
  const thread = stores.raw.messages.get(a.state.director!.runId)!;
  const errors = thread.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content).error);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /no editorial plan/);
  assert.match(thread.at(-1)!.role === "user" ? (thread.at(-1) as { content: string }).content : "", /code started research/);
});

test("research tools: the reviewer has them all, view_page adds the rendered text, Search Console needs its key", async () => {
  const stores = memoryStores();
  const a = article();
  const providers = {
    serp: async () => ({
      response: { items: [{ type: "people_also_ask" }] },
      organic: [
        { url: "https://one.test/list", title: "Best tools", description: "", position: 1 },
        { url: "https://two.test/list", title: "Top picks", description: "", position: 2 },
      ],
    }),
    screenshot: async () => ({ base64: "aW1n", mimeType: "image/webp" }),
    vision: async () => "Standard $99 per user/month. Professional $199 per user/month.",
  } as unknown as AgentProviders;
  const ctx = { article: a, providers, assets: stores.assets, agent: "research" as const, log: () => {}, charge: () => {} };
  const tools = AGENT_DEFINITIONS.reviewer.tools();
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  for (const name of ["keyword_data", "web_search", "serp_overview", "read_page", "view_page", "search_console", "review_image", "submit_review"])
    assert.ok(tool(name), `the reviewer can use ${name}`);
  assert.equal(tool("keyword_overview"), undefined, "keyword_data replaces the chat's processed keyword_overview");
  const failing = { ...ctx, providers: { serp: async () => { throw new Error("DataForSEO task error 40101: Internal SE Server Error."); } } as unknown as AgentProviders };
  const searchesBefore = a.state.usage.searches;
  await assert.rejects(tool("web_search").run({ query: "buffer alternative free", depth: 10 } as never, failing));
  assert.equal(a.state.usage.searches, searchesBefore, "a failed DataForSEO call doesn't use up the search limit");

  const raw = { items: [{ keyword: "buffer alternative", keyword_info: { search_volume: 2400, cpc: 6.1, search_volume_trend: { yearly: 20 } } }] };
  let asked: string[] = [];
  const keywordCtx = { ...ctx, providers: { keywordData: async (k: string[]) => ((asked = k), { response: raw, costUsd: 0.0102 }) } as unknown as AgentProviders };
  assert.deepEqual(await tool("keyword_data").run({ keywords: ["Buffer alternative", "buffer alternative "] } as never, keywordCtx), raw);
  assert.deepEqual(asked, ["buffer alternative"]);
  assert.equal(a.state.usage.paidDataCalls, 1);
  a.state.usage.paidDataCalls = 99;
  assert.match(((await tool("keyword_data").run({ keywords: ["x"] } as never, keywordCtx)) as { error: string }).error, /budget/);
  a.state.usage.paidDataCalls = 0;
  assert.equal(AGENT_DEFINITIONS.graphics.tools().some((t) => t.name === "review_image"), false);

  const viewed = (await tool("view_page").run({ url: "https://www.hootsuite.com/plans" } as never, ctx)) as { id: string };
  assert.equal(viewed.id, "source-1");
  assert.match(a.state.sources[0].content, /\$199 per user/);
  assert.equal(a.state.usage.reads, 1);

  const previous = process.env.GSC_CREDENTIALS_PATH;
  delete process.env.GSC_CREDENTIALS_PATH;
  const gsc = (await tool("search_console").run({ days: 90 } as never, ctx)) as { error?: string };
  assert.match(gsc.error ?? "", /isn't connected/);
  if (previous) process.env.GSC_CREDENTIALS_PATH = previous;
});



test("search tools pass on DataForSEO's whole response; read_source returns the full page; long conversations shorten only old results", async () => {
  const stores = memoryStores();
  const long = "word ".repeat(30_000);
  const a = article({ sources: [source("source-1", "https://docs.test/a", long)] });
  let searches = 0;
  const providers = {
    serp: async () => {
      searches++;
      return { response: { se_results_count: 1000, items: [{ type: "featured_snippet", title: "Snippet" }, { type: "people_also_ask", items: [] }] }, organic: [] };
    },
  } as unknown as AgentProviders;
  const ctx = { article: a, providers, assets: stores.assets, agent: "research" as const, log: () => {}, charge: () => {} };
  const tools = AGENT_DEFINITIONS.research.tools();
  const search = tools.find((t) => t.name === "web_search")!;
  const first = (await search.run({ query: "buffer alternative", depth: 10 } as never, ctx)) as { items: { type: string }[] };
  assert.deepEqual(first.items.map((i) => i.type), ["featured_snippet", "people_also_ask"]);
  await search.run({ query: "Buffer alternative", depth: 10 } as never, ctx);
  assert.equal(searches, 1);
  const read = tools.find((t) => t.name === "read_source")!;
  assert.ok(read.maxResultChars! >= 150_000);
  const full = (await read.run({ sourceId: "source-1" } as never, ctx)) as { text: string };
  assert.equal(full.text.length, long.length);

  const big = "x".repeat(60_000);
  const messages: AgentMessage[] = [
    { role: "user", content: "brief" },
    ...Array.from({ length: 20 }, (_, i): AgentMessage => ({ role: "tool", toolCallId: `c${i}`, name: "read_source", content: big })),
  ];
  const sent = conversationForModel(messages);
  const size = (list: AgentMessage[]) => list.reduce((n, m) => n + m.content.length, 0);
  assert.ok(size(sent) < size(messages));
  assert.match(sent[1].content, /shortened/);
  assert.equal(sent.at(-1)!.content.length, big.length);
  assert.equal(sent[0].content, "brief");
  const short = messages.slice(0, 4);
  assert.equal(conversationForModel(short), short);
});

test("competing products: only 'not allowed' makes naming one an issue; the form's values parse", () => {
  const a = article({
    sources: [{ ...source("source-1", "https://buffer.com/pricing", "Buffer pricing"), sourceType: "competitor" }],
    sections: [{ id: "s1", heading: "Tools", markdown: "Buffer is one option.", listItems: [] }],
  });
  const flagged = () => checkArticle(a).some((i) => /competitor/.test(i.problem));
  assert.equal(flagged(), false);
  a.input.mentionCompetitors = "not_allowed";
  assert.equal(flagged(), true);
  a.input.mentionCompetitors = "allowed";
  assert.equal(flagged(), false);
  assert.equal(articleInputSchema.parse({ ...DEFAULT_INPUT, productId: 1, primaryKeyword: "buffer alternative", mentionCompetitors: "not_allowed" }).mentionCompetitors, "not_allowed");
  assert.equal(articleInputSchema.safeParse({ ...DEFAULT_INPUT, productId: 1, primaryKeyword: "buffer alternative", mentionCompetitors: true }).success, false);
  assert.equal(competitorPolicy({}), "auto");
});

test("Auto means the agents decide: no length cap, no link cap, style and image count left to them; a number from the author is a limit", async () => {
  const a = article();
  assert.equal(maxWords(a.input), null);
  const brief = task(a);
  assert.equal(brief.readingLevel, "your call");
  assert.equal(brief.imageStyle, "your call");
  assert.equal(brief.imagesInArticle, "your call");
  assert.equal(brief.internalLinksMax, "your call");
  const many = Array.from({ length: 30 }, (_, i) => `[p${i}](https://docs.test/${i})`).join(" ");
  const sources = Array.from({ length: 30 }, (_, i) => source(`source-${i + 1}`, `https://docs.test/${i}`, ""));
  assert.deepEqual(cleanLinks([{ id: "s1", heading: "H", markdown: many, listItems: [] }], { website, sitePages: [], sources }, a.input).removed, []);

  const stores = memoryStores();
  a.input.imageCount = 1;
  a.state.sections = [{ id: "s1", heading: "Pricing", markdown: "Pro costs $29 a month.", listItems: [] }];
  a.state.images = [{ id: "img-1", sectionId: "s1", kind: "screenshot", altText: "", subject: "https://x.test", assetId: "a1" }];
  const shown: string[] = [];
  const providers = {
    generateImage: async () => ({ base64: "aW1n", mimeType: "image/png" }),
    vision: async () => shown.shift() ?? "",
  } as unknown as AgentProviders;
  const ctx = { article: a, providers, assets: stores.assets, agent: "graphics" as const, log: () => {}, charge: () => {} };
  const tool = (name: string) => AGENT_DEFINITIONS.graphics.tools().find((t) => t.name === name)!;
  const spec = { sectionId: "s1", title: "Plan prices", points: [{ label: "Pro $29" }, { label: "Power $59" }], altText: "Prices" };
  assert.match(((await tool("create_infographic").run(spec as never, ctx)) as { error: string }).error, /asked for 1 image/);
  a.input.imageCount = "auto";
  assert.match(((await tool("create_infographic").run(spec as never, ctx)) as { error: string }).error, /59/);
  const okSpec = { ...spec, points: [{ label: "Pro $29" }, { label: "Basic" }] };
  shown.push("PLAN PRICES\nPro $29\nBasic");
  const made = (await tool("create_infographic").run(okSpec as never, ctx)) as { placed?: string };
  assert.equal(made.placed, "img-2");
  assert.equal(a.state.images[1].kind, "infographic");
});

test("the product's cover style is the house style: the agent can't change the cover's, and illustrations and infographics follow it", async () => {
  const stores = memoryStores();
  const a = article();
  a.state.website.coverStyle = "watercolor";
  a.state.sections = [{ id: "s1", heading: "Pricing", markdown: "Pro costs $29 a month.", listItems: [] }];
  const prompts: string[] = [];
  const providers = {
    generateImage: async (prompt: string) => (prompts.push(prompt), { base64: "aW1n", mimeType: "image/png" }),
    vision: async (_url: string, instruction: string) =>
      instruction.startsWith("Transcribe") ? "Pricing Made Simple" : '{"hasText": false, "altText": "A desk"}',
  } as unknown as AgentProviders;
  const ctx = { article: a, providers, assets: stores.assets, agent: "graphics" as const, log: () => {}, charge: () => {} };
  const tool = (name: string) => AGENT_DEFINITIONS.graphics.tools().find((t) => t.name === name)!;
  await tool("generate_cover").run({ headline: "Pricing Made Simple", artDirection: "a coin", style: "swiss-minimal" } as never, ctx);
  assert.equal(a.state.cover!.style, "watercolor");
  assert.match(prompts[0], /Watercolor Wash/);
  await tool("generate_illustration").run({ sectionId: "s1", scene: "a person comparing plans at a desk", altText: "A desk", style: "isometric scene" } as never, ctx);
  assert.match(prompts[1], /Drawn as isometric scene, in the palette and mood of this house style \("Watercolor Wash"\): Loose watercolor/);
  assert.equal(a.state.images[0].style, "isometric scene");
  a.input.imageStyle = "sketch";
  await tool("generate_illustration").run({ sectionId: "s1", scene: "a person comparing plans at a desk", altText: "A desk", style: "photo" } as never, ctx);
  assert.match(prompts[2], /Drawn as sketch, in the palette and mood of this house style/);
  const longAlt = `A person comparing plans at a desk, ${"with a long and careful description ".repeat(8)}`;
  await tool("generate_illustration").run({ sectionId: "s1", scene: "a person comparing plans at a desk", altText: longAlt, style: "isometric scene" } as never, ctx);
  assert.equal(a.state.images.at(-1)!.altText, longAlt, "alt text is kept as written, never cut");
  const brief = (agent: "research" | "editor" | "graphics" | "reviewer") => AGENT_DEFINITIONS[agent].brief(a, { agent, instructions: "", issueIds: [] } as never);
  assert.match(brief("editor"), /## House style[\s\S]*Watercolor Wash/);
  assert.match(brief("graphics"), /## House style/);
  assert.match(brief("reviewer"), /## House style/);
  assert.doesNotMatch(brief("research"), /House style|Watercolor/, "Research doesn't plan media");
});

test("the Editor has the Reviewer's tools (research, checks, judging media), except submitting a review", () => {
  const editor = AGENT_DEFINITIONS.editor.tools().map((t) => t.name);
  const reviewer = AGENT_DEFINITIONS.reviewer.tools().map((t) => t.name);
  assert.deepEqual(editor.filter((n) => n !== "submit_plan"), reviewer.filter((n) => n !== "submit_review"));
  assert.ok(editor.includes("check_article") && editor.includes("review_image") && editor.includes("serp_overview"));
  const research = AGENT_DEFINITIONS.research.tools().map((t) => t.name);
  assert.ok(research.includes("search_youtube") && research.includes("serp_overview"), "Research covers text and video");
  assert.equal(editor.filter((n) => n === "search_youtube").length, 1);
  // An FAQ is a section the Editor plans and the Writer writes; there is no separate FAQ field to fill.
  assert.deepEqual(AGENT_DEFINITIONS.writer.tools().map((t) => t.name), ["read_source", "write_section", "submit_draft"]);
  const older = article({ plan: { h1: "x", sections: [planSection("s1", "One")] } as unknown as AgentState["plan"] });
  const writerBrief = () => AGENT_DEFINITIONS.writer.brief(older, { agent: "writer", instructions: "", issueIds: [] } as never);
  assert.doesNotMatch(writerBrief(), /FAQ/);
  older.state.faq = [{ question: "Is Buffer free?", answer: "Yes." }];
  assert.match(writerBrief(), /FAQ already on this article/);
});

test("the Editor's media plan must be makeable: real sections, page URLs for screenshots, videos from a search, within the author's image limit", async () => {
  const stores = memoryStores();
  const a = article({ sources: [source("source-1", "https://docs.test/a", "")] });
  a.state.usage.videoSearches = 1;
  a.state.youtubeCache = { q: { items: [{ type: "youtube_video", url: "https://www.youtube.com/watch?v=abcDEF12345" }] } };
  a.input.imageCount = 1;
  const plan = (media: unknown[]) => ({
    goal: "traffic", format: "explainer", reader: "r", angle: "a", readerNeeds: [], h1: "Buffer Alternative Pricing", slug: "buffer-alternative",
    metaDescription: "m", excerpt: "e", secondaryKeywords: [], selectionMethodology: null, targetWords: 400, coverIdea: "c",
    sections: [{ heading: "One", purpose: "p", keyPoints: [], sourceIds: [], item: null, answers: [], internalLinks: [], targetWords: 200 }, { heading: "Two", purpose: "p", keyPoints: [], sourceIds: [], item: null, answers: [], internalLinks: [], targetWords: 200 }],
    media,
  });
  const submit = AGENT_DEFINITIONS.editor.tools().find((t) => t.name === "submit_plan")!;
  const ctx = { article: a, providers: {} as AgentProviders, assets: stores.assets, agent: "editor" as const, log: () => {}, charge: () => {} };
  const refused = (await submit.run(
    plan([
      { kind: "illustration", section: 3, what: "a desk", why: "w" },
      { kind: "screenshot", section: 1, what: "the pricing page", why: "w" },
      { kind: "video", section: 2, what: "https://www.youtube.com/watch?v=zzz", why: "w" },
    ]) as never,
    ctx,
  )) as { error: string };
  assert.match(refused.error, /no section 3/);
  assert.match(refused.error, /needs the page's URL/);
  assert.match(refused.error, /URLs from your YouTube searches/);
  assert.match(refused.error, /at most 1 images; the plan has 2/);
  const ok = await submit.run(
    plan([
      { kind: "screenshot", section: 2, what: " https://docs.test/a ", why: "w" },
      { kind: "video", section: 1, what: "https://www.youtube.com/watch?v=abcDEF12345", why: "w" },
    ]) as never,
    ctx,
  );
  assert.deepEqual(ok, { submitted: true });
  assert.equal(a.state.plan!.goal, "traffic", "on Auto the Editor's goal counts");
  a.input.goal = "signups";
  await submit.run(plan([]) as never, ctx);
  assert.equal(a.state.plan!.goal, "signups", "the author's goal stands");
  a.input.goal = "auto";
  await submit.run(
    plan([
      { kind: "screenshot", section: 2, what: " https://docs.test/a ", why: "w" },
      { kind: "video", section: 1, what: "https://www.youtube.com/watch?v=abcDEF12345", why: "w" },
    ]) as never,
    ctx,
  );
  assert.deepEqual(a.state.plan!.media!.map((m) => [m.kind, m.sectionId, m.what]), [["screenshot", "s2", "https://docs.test/a"], ["video", "s1", "https://www.youtube.com/watch?v=abcDEF12345"]]);
});

test("the article's goal: the author's setting, or the Editor's choice on Auto; given to the Editor, Writer, Reviewer and Director only", () => {
  const a = article();
  const brief = (agent: "research" | "editor" | "writer" | "graphics" | "reviewer") => AGENT_DEFINITIONS[agent].brief(a, { agent, instructions: "", issueIds: [] } as never);
  assert.equal(a.input.goal, "auto");
  assert.match(ARTICLE_GOAL(a), /left to the Editor[\s\S]*reach[\s\S]*sign-ups[\s\S]*awareness/);
  a.state.plan = { goal: "awareness" } as never;
  assert.match(ARTICLE_GOAL(a), /the article is for awareness[\s\S]*Chosen by the Editor/);
  a.input.goal = "signups";
  assert.match(ARTICLE_GOAL(a), /the article is for sign-ups/);
  assert.doesNotMatch(ARTICLE_GOAL(a), /Chosen by the Editor/);
  for (const agent of ["editor", "writer", "reviewer"] as const) assert.match(brief(agent), /## The goal/, `${agent} gets the goal`);
  for (const agent of ["research", "graphics"] as const) assert.doesNotMatch(brief(agent), /## The goal/, `${agent} doesn't`);
  assert.equal(articleInputSchema.parse({ ...DEFAULT_INPUT, productId: 1, primaryKeyword: "buffer alternative" }).goal, "auto");
});

test("read_source returns the whole page as Markdown from the stored raw HTML; code checks keep using its extracted text", async () => {
  const stores = memoryStores();
  const html = '<html><head><script>window.price=1</script></head><body><main><h2>Pro</h2><p>Pro costs $29 a month.</p><img src="/shot.png"></main></body></html>';
  await stores.assets.save("a1-source-1-html", "a1", { base64: Buffer.from(html).toString("base64"), mimeType: "text/html" });
  const a = article({ sources: [{ ...source("source-1", "https://tool.test/pricing", "Pro Pro costs $29 a month."), rawAssetId: "a1-source-1-html" }] });
  const ctx = { article: a, providers: {} as AgentProviders, assets: stores.assets, agent: "writer" as const, log: () => {}, charge: () => {} };
  const read = AGENT_DEFINITIONS.writer.tools().find((t) => t.name === "read_source")!;
  const result = (await read.run({ sourceId: "source-1" } as never, ctx)) as { markdown?: string; text?: string };
  assert.match(result.markdown ?? "", /## Pro/);
  assert.match(result.markdown ?? "", /Pro costs \$29 a month\./);
  assert.match(result.markdown ?? "", /!\[\]\(https:\/\/tool\.test\/shot\.png\)/);
  assert.doesNotMatch(result.markdown ?? "", /window\.price/);
  assert.equal(result.text, undefined);
  a.state.sections = [{ id: "s1", heading: "Pro", markdown: "Pro costs $29 a month.", listItems: [] }];
  assert.equal(checkArticle(a).some((i) => /29/.test(i.problem)), false);
});

test("pages become Markdown with absolute links and images, embedded videos kept as links, code dropped", () => {
  const md = htmlToMarkdown(
    '<html><head><style>.x{}</style></head><body><nav><a href="/pricing">Pricing</a></nav><h2>Plans</h2><table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$29</td></tr></table><img data-src="img/dash.png" alt="Dashboard screenshot"><svg><path d="M0"/></svg><iframe src="https://www.youtube.com/embed/abc"></iframe><script>track()</script></body></html>',
    "https://tool.test/plans/",
  );
  assert.match(md, /\[Pricing\]\(https:\/\/tool\.test\/pricing\)/);
  assert.match(md, /\| Pro\s+\| \$29\s+\|/);
  assert.match(md, /!\[Dashboard screenshot\]\(https:\/\/tool\.test\/plans\/img\/dash\.png\)/);
  assert.match(md, /\[Embedded video\]\(https:\/\/www\.youtube\.com\/embed\/abc\)/);
  assert.doesNotMatch(md, /track\(\)|\.x\{|M0/);
});

test("each request stays within the size allowance: newest results whole, older shortened, one oversized result cut", () => {
  const huge: AgentMessage[] = [
    { role: "user", content: "brief" },
    { role: "tool", toolCallId: "a", name: "read_source", content: "a".repeat(100_000) },
    { role: "tool", toolCallId: "b", name: "read_source", content: "b".repeat(2_000_000) },
  ];
  const sent = conversationForModel(huge);
  const size = sent.reduce((n, m) => n + m.content.length, 0);
  assert.ok(size <= 800_000 + 2_000);
  assert.ok(sent[2].content.startsWith("bbb") && sent[2].content.length > 700_000);
  assert.match(sent[1].content, /shortened/);
  assert.equal(AGENT_MODELS.research, "openai/gpt-6-luna-pro");
  assert.equal(AGENT_DEFINITIONS.research.model, "openai/gpt-6-luna-pro");
  assert.equal(AGENT_DEFINITIONS.editor.model, "openai/gpt-6.1-sol");
});

test("shortening keeps what was already sent unchanged, so the provider's prompt cache keeps working: the start changes only at an overflow", () => {
  const page = (i: number): AgentMessage => ({ role: "tool", toolCallId: `c${i}`, name: "read_source", content: `${i}`.repeat(60_000) });
  const messages: AgentMessage[] = [{ role: "user", content: "brief" }, ...Array.from({ length: 40 }, (_, i) => page(i))];
  let changes = 0;
  for (let n = 2; n <= messages.length; n++) {
    const before = conversationForModel(messages.slice(0, n - 1));
    const after = conversationForModel(messages.slice(0, n));
    assert.ok(after.reduce((sum, m) => sum + m.content.length, 0) <= 800_000);
    if (before.some((m, i) => m.content !== after[i].content)) changes++;
  }
  // Each overflow frees room for about five more pages: the start changes on about one read in five, not on every read.
  assert.ok(changes > 0 && changes <= 8, `the start changed ${changes} times in 40 reads`);
});

test("jump links: a #id link to a heading of the article stays (ids as common Markdown renderers make them); any other # link is removed", () => {
  const plan = {
    sections: [planSection("s1", "Buffer alternatives at a glance"), planSection("s2", "1. Metricool — for analytics with a free starting point"), planSection("s3", "Pricing")],
  } as unknown as AgentState["plan"];
  assert.deepEqual(
    headingAnchors([{ id: "s1", heading: "Buffer alternatives at a glance", markdown: "### Pricing (checked Oct 2026)" }], plan!.sections).map((a) => a.id),
    ["buffer-alternatives-at-a-glance", "pricing-", "1-metricool-for-analytics-with-a-free-starting-point", "pricing"],
    "planned sections not written yet count, so the first section can link ahead",
  );
  const table = "| Tool |\n|---|\n| [Metricool](#1-metricool-for-analytics-with-a-free-starting-point) |\n| [Pricing](#pricing) |\n| [Nope](#no-such-heading) |";
  const { sections, removed } = cleanLinks([{ id: "s1", heading: "Buffer alternatives at a glance", markdown: table, listItems: [] }], { website, sitePages: [], sources: [], plan }, { internalLinks: 1, externalLinks: 0 });
  assert.match(sections[0].markdown, /\[Metricool\]\(#1-metricool-for-analytics-with-a-free-starting-point\)/);
  assert.match(sections[0].markdown, /\[Pricing\]\(#pricing\)/);
  assert.doesNotMatch(sections[0].markdown, /no-such-heading/);
  assert.deepEqual(removed, ["#no-such-heading"], "jump links don't count against the link limits");
  const a = article({ plan });
  assert.match(AGENT_DEFINITIONS.writer.brief(a, { agent: "writer", instructions: "", issueIds: [] } as never), /## Headings of this article[\s\S]*1-metricool-for-analytics-with-a-free-starting-point/);
});

test("a page of the product's site may be linked more than once (a call to action can repeat); it counts once against the limit", () => {
  const sitePages = [{ url: "https://example.com/signin", title: "Sign in", summary: "" }];
  const sections = [
    { id: "s4", heading: "Example", markdown: "[Try it free](https://example.com/signin).", listItems: [] },
    { id: "s14", heading: "Next step", markdown: "Ready? [Start a free trial](https://example.com/signin).", listItems: [] },
  ];
  const { sections: cleaned, removed } = cleanLinks(sections, { website, sitePages, sources: [] }, { internalLinks: 1, externalLinks: 0 });
  assert.deepEqual(removed, []);
  assert.ok(cleaned.every((s) => s.markdown.includes("(https://example.com/signin)")));
});

test("videos: YouTube IDs from any URL shape; published as an embedded player (Markdown and HTML); transcripts are raw, paid once, limited", async () => {
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=Zhh81UPteSs&pp=ygUx"), "Zhh81UPteSs");
  assert.equal(youtubeVideoId("https://youtu.be/YST1sWFPDh4?t=30"), "YST1sWFPDh4");
  assert.equal(youtubeVideoId("https://www.youtube.com/shorts/abcDEF12345"), "abcDEF12345");
  assert.equal(youtubeVideoId("https://m.youtube.com/watch?v=x79OsBO0enU"), "x79OsBO0enU");
  assert.equal(youtubeVideoId("https://vimeo.com/123456"), null);
  assert.equal(youtubeVideoId("not a url"), null);

  const markdown = publishMarkdown(
    { sections: [{ id: "s1", heading: "Compare", markdown: "Text.", listItems: [] }], images: [], faq: [], videos: [{ sectionId: "s1", url: "https://www.youtube.com/watch?v=YST1sWFPDh4", title: 'Tools "compared" & ranked', channel: "C" }] } as never,
    {},
  );
  assert.match(markdown, /src="https:\/\/www\.youtube\.com\/embed\/YST1sWFPDh4" title="Tools &quot;compared&quot; &amp; ranked"/);
  assert.match(markdownToHtml(markdown), /<iframe [^>]*youtube\.com\/embed\/YST1sWFPDh4/, "content_html keeps the player");

  const a = article();
  const raw = { video_id: "YST1sWFPDh4", items: [{ type: "youtube_subtitles", text: "Metricool costs twenty dollars", start_time: 12, end_time: 15 }] };
  let calls = 0;
  const ctx = { article: a, providers: { youtubeSubtitles: async (id: string) => (calls++, { ...raw, video_id: id }) } as unknown as AgentProviders, assets: memoryStores().assets, agent: "research" as const, log: () => {}, charge: () => {} };
  const tool = AGENT_DEFINITIONS.research.tools().find((t) => t.name === "video_transcript")!;
  assert.deepEqual(await tool.run({ url: "https://youtu.be/YST1sWFPDh4" } as never, ctx), raw);
  await tool.run({ url: "https://www.youtube.com/watch?v=YST1sWFPDh4" } as never, ctx);
  assert.equal(calls, 1, "the same video isn't paid for twice");
  assert.equal(a.state.usage.transcripts, 1);
  assert.match(((await tool.run({ url: "https://vimeo.com/1" } as never, ctx)) as { error: string }).error, /YouTube video URL/);
  a.state.usage.transcripts = 10;
  assert.match(((await tool.run({ url: "https://youtu.be/abcDEF12345" } as never, ctx)) as { error: string }).error, /No transcripts left/);
  for (const agent of ["editor", "reviewer"] as const) assert.ok(AGENT_DEFINITIONS[agent].tools().some((t) => t.name === "video_transcript"));
});
