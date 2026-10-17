import { z } from "zod";
import { EditorialPlanSchema, ResearchDossierSchema } from "../schemas";
import type { EditorialPlan, PlanSection } from "../types";
import { defineTool, refuse } from "./types";
import { searchedVideos } from "./graphics";
import { publicUrl } from "../web/url-safety";

export const submitResearch = defineTool({
  name: "submit_research",
  description:
    "Hand your research dossier to the Director. Ends your work. Include a note (type, facts, credibility) for every source you read.",
  schema: ResearchDossierSchema,
  submit: true,
  async run(dossier, { article, log }) {
    const { state } = article;
    if (!state.sources.length) return refuse("Read at least one page before submitting.");
    for (const note of dossier.sources) {
      const source = state.sources.find((s) => s.id === note.id);
      if (source) Object.assign(source, { sourceType: note.sourceType, facts: note.facts, credibility: note.credibility });
    }
    state.dossier = dossier;
    log(`Submitted the research dossier (${state.sources.length} sources)`, "submit");
    return { submitted: true };
  },
});

/**
 * Section IDs stay stable across re-plans: a section keeps its ID when its heading or item is unchanged, so its text
 * survives. Sections the new plan drops are removed from the draft.
 */
export function assignSectionIds(next: EditorialPlan["sections"], previous: PlanSection[] = []): PlanSection[] {
  let max = Math.max(0, ...previous.map((s) => Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0)));
  const taken = new Set<string>();
  return next.map((section) => {
    const match = previous.find(
      (p) =>
        !taken.has(p.id) &&
        (p.heading.trim().toLowerCase() === section.heading.trim().toLowerCase() ||
          (!!p.item && p.item.trim().toLowerCase() === section.item?.trim().toLowerCase())),
    );
    const id = match?.id ?? `s${++max}`;
    taken.add(id);
    return { ...section, id };
  });
}

export const submitPlan = defineTool({
  name: "submit_plan",
  description:
    "Hand the editorial plan to the Director. Ends your work. You own the title (h1), slug, meta description and excerpt.",
  schema: EditorialPlanSchema,
  submit: true,
  async run(plan, { article, log }) {
    const { state, input } = article;
    const items = plan.sections.filter((s) => s.item?.trim()).length;
    if (plan.format === "list" && items < 3)
      return refuse(
        `A list article's sections are its items: give each item its own section with item set. This plan has ${items}.`,
      );
    const sourceIds = new Set(state.sources.map((s) => s.id));
    const sitePages = new Set(state.sitePages.map((p) => p.url));
    const sections = assignSectionIds(
      plan.sections.map((s) => ({
        ...s,
        sourceIds: s.sourceIds.filter((id) => sourceIds.has(id)),
        internalLinks: s.internalLinks.filter((url) => sitePages.has(url)),
      })),
      state.plan?.sections,
    );
    // The media plan: what Graphics will make. Checked so it can be made as planned.
    if (!state.usage.videoSearches)
      return refuse("Search YouTube for related videos first (search_youtube); whether the plan includes one is your call.");
    const videos = searchedVideos(state.youtubeCache);
    const problems = plan.media.flatMap((m, i) => {
      if (m.section > sections.length) return [`media ${i + 1}: there is no section ${m.section}`];
      if (m.kind === "video" && !videos.has(m.what.trim().split("&")[0]))
        return [`media ${i + 1}: videos must be URLs from your YouTube searches`];
      if (m.kind === "screenshot") {
        try {
          publicUrl(m.what.trim());
        } catch {
          return [`media ${i + 1}: a screenshot needs the page's URL in "what"`];
        }
      }
      return [];
    });
    const images = plan.media.filter((m) => m.kind !== "video").length;
    if (input.imageCount !== "auto" && images > input.imageCount)
      problems.push(`the author asked for at most ${input.imageCount} images; the plan has ${images}`);
    if (problems.length) return refuse(`The media plan can't be made as is: ${problems.join("; ")}.`);
    const media = plan.media.map(({ section, ...m }) => ({ ...m, what: m.what.trim(), sectionId: sections[section - 1].id }));
    // A rewrite keeps the address of the post it replaces.
    const slug = state.existingPost?.slug ?? plan.slug;
    // The author's goal stands when set; the Editor's choice counts only when the author left it to the agents.
    state.plan = { ...plan, goal: input.goal === "auto" ? plan.goal : input.goal, slug, sections, media };
    state.sections = state.sections.filter((s) => sections.some((p) => p.id === s.id));
    state.images = state.images.filter((i) => sections.some((p) => p.id === i.sectionId));
    state.videos = state.videos.filter((v) => sections.some((p) => p.id === v.sectionId));
    state.metadata = {
      h1: plan.h1,
      slug,
      metaDescription: plan.metaDescription,
      excerpt: plan.excerpt,
      primaryKeyword: input.primaryKeyword,
      secondaryKeywords: plan.secondaryKeywords,
    };
    state.changedSinceReview = true;
    log(`Submitted the plan: "${plan.h1}", ${sections.length} sections, ${media.length} media`, "submit");
    return { submitted: true };
  },
});

export const noteSchema = z.object({ notes: z.string() });
