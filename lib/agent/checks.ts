import { articleMarkdown, wordCount } from "./content/markdown";
import { PROCESS_JARGON, unsupportedNumbers } from "./content/verify";
import { competitorPolicy } from "@/lib/schemas";
import type { AgentArticle, ReviewIssue } from "./types";

/** Most body words for the requested length; null for "auto", where the agents decide. */
export function maxWords(input: AgentArticle["input"]) {
  if (input.length === "auto") return null;
  return input.length === "custom" ? input.customWordCount : ({ short: 1200, medium: 2200, long: 4000 } as const)[input.length];
}

const words = (value: string) =>
  value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.replace(/s$/, ""));

/** Problems with the title as the search result title. Empty when it's fine. */
export function titleProblems(article: Pick<AgentArticle, "input" | "state">, now = new Date()) {
  const title = article.state.metadata?.h1 ?? "";
  const problems: string[] = [];
  if (!title) return ["There is no title."];
  if (title.length > 65) problems.push(`The title has ${title.length} characters; Google cuts titles past about 60.`);
  const keyword = words(article.input.primaryKeyword);
  const reach = keyword.length + 3;
  if (!keyword.every((w) => words(title).slice(0, reach).includes(w)))
    problems.push(`The primary keyword "${article.input.primaryKeyword}" isn't within the title's first ${reach} words.`);
  const years = title.match(/\b(19|20)\d{2}\b/g) ?? [];
  if (years.some((y) => Number(y) !== now.getUTCFullYear()))
    problems.push(`A year in the title must be this year, ${now.getUTCFullYear()}.`);
  const items = (article.state.plan?.sections ?? []).flatMap((s) => s.item?.trim() || []);
  const counts = (title.replace(/\b(19|20)\d{2}\b/g, "").match(/\b\d+\b/g) ?? []).map(Number);
  if (items.length && counts.length) {
    const subjects = items.filter((item) => words(item).every((w) => keyword.includes(w))).length;
    const allowed = new Set([items.length, items.length - subjects]);
    if (counts.some((c) => !allowed.has(c)))
      problems.push(`The title says ${counts.join(", ")} but the list covers ${items.length} items (${items.join(", ")}).`);
  }
  return problems;
}

/** Text a number may come from: read pages, the author's material, the product's own description. */
function numberEvidence(article: Pick<AgentArticle, "input" | "state">) {
  const { state, input } = article;
  return [
    ...state.sources.map((s) => s.content),
    input.ownerMaterial ?? "",
    state.website.productDescription,
    ...state.sitePages.map((p) => `${p.title} ${p.summary}`),
  ].join("\n");
}

/**
 * What code finds wrong with the article. The Reviewer sees these and they are added to its review; the Director
 * can't finish while a critical or major one is open (unless the review rounds run out).
 */
export function checkArticle(article: Pick<AgentArticle, "input" | "state">): ReviewIssue[] {
  const { state, input } = article;
  const issues: Omit<ReviewIssue, "id">[] = [];
  const plan = state.plan;
  for (const section of plan?.sections ?? [])
    if (!state.sections.some((s) => s.id === section.id && s.markdown.trim()))
      issues.push({
        severity: "critical",
        owner: "writer",
        sectionId: section.id,
        problem: `The planned section "${section.heading}" isn't written.`,
        fix: "Write it.",
      });
  const bySection = new Map<string, string[]>();
  for (const claim of unsupportedNumbers(state.sections, numberEvidence(article)))
    bySection.set(claim.sectionId, [...(bySection.get(claim.sectionId) ?? []), `"${claim.sentence}" (${claim.missing.join(", ")})`]);
  for (const [sectionId, sentences] of bySection)
    issues.push({
      severity: "major",
      owner: "writer",
      sectionId,
      problem: `Numbers that appear in no read source: ${sentences.slice(0, 4).join("; ")}`,
      fix: "Use the figure a read source states (and link it), show the calculation from sourced figures, or remove the number.",
    });
  for (const section of state.sections) {
    const jargon = PROCESS_JARGON.exec(section.markdown);
    if (jargon)
      issues.push({
        severity: "major",
        owner: "writer",
        sectionId: section.id,
        problem: `The prose talks about the research process ("${jargon[0]}"), which readers never saw.`,
        fix: "Name the real source and its date, or say plainly what isn't known.",
      });
  }
  const max = maxWords(input);
  const total = wordCount(articleMarkdown({ ...state, faq: [] }));
  if (max && state.sections.length && total > max)
    issues.push({
      severity: "major",
      owner: "writer",
      sectionId: null,
      problem: `The article has ${total} words; the maximum for this length is ${max}.`,
      fix: `Cut repetition and tangents to at most ${max} words, keeping the direct answer.`,
    });
  if (competitorPolicy(input) === "not_allowed") {
    const brands = [
      ...new Set(
        state.sources
          .filter((s) => s.sourceType === "competitor")
          .map((s) => s.publisher.replace(/^www\./, "").split(".")[0])
          .filter((b) => b.length >= 4),
      ),
    ];
    for (const section of state.sections) {
      const text = section.markdown.replace(/\]\([^)]*\)/g, "]");
      const brand = brands.find((b) => new RegExp(`\\b${b}\\b`, "i").test(text));
      if (brand)
        issues.push({
          severity: "major",
          owner: "writer",
          sectionId: section.id,
          problem: `It names ${brand}, a competitor, although competing products are set to "Not allowed".`,
          fix: `Remove ${brand} and other competing products.`,
        });
    }
  }
  if (state.metadata)
    for (const problem of titleProblems(article))
      issues.push({ severity: "major", owner: "editor", sectionId: null, problem, fix: "Rewrite the title (h1) in the plan." });
  if (state.sections.length && state.mediaNotes && !state.cover?.assetId)
    issues.push({
      severity: "major",
      owner: "graphics",
      sectionId: null,
      problem: "The article has no cover image.",
      fix: "Generate the cover.",
    });
  for (const image of state.images.filter((i) => !i.assetId))
    issues.push({
      severity: "minor",
      owner: "graphics",
      sectionId: image.sectionId,
      problem: `Image ${image.id} failed: ${image.error ?? "not generated"}.`,
      fix: "Retry it, replace it, or remove it.",
    });
  return issues.map((issue, i) => ({ ...issue, id: `check-${i + 1}`, fromChecks: true }));
}
