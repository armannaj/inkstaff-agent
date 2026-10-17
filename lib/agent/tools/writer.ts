import { cleanLinks } from "../content/links";
import { wordCount } from "../content/markdown";
import { DraftNotesSchema, SectionInputSchema } from "../schemas";
import { readSource } from "./research";
import { defineTool, refuse, type AgentTool } from "./types";

const writeSection = defineTool({
  name: "write_section",
  description:
    "Write or rewrite one planned section (its complete Markdown body, without the heading). First drafts go in plan order, one section at a time. Links to pages nobody read are removed.",
  schema: SectionInputSchema,
  async run({ sectionId, heading, markdown, listItems }, { article, log }) {
    const { state, input } = article;
    const plan = state.plan;
    if (!plan) return refuse("There is no plan yet.");
    const index = plan.sections.findIndex((s) => s.id === sectionId);
    if (index < 0) return refuse(`"${sectionId}" isn't a planned section. Planned: ${plan.sections.map((s) => s.id).join(", ")}.`);
    const missing = plan.sections.slice(0, index).find((p) => !state.sections.some((s) => s.id === p.id));
    if (missing) return refuse(`Write the sections in order: "${missing.heading}" (${missing.id}) comes first.`);
    if (!markdown.trim()) return refuse("The section is empty.");
    if (/^#\s/m.test(markdown)) return refuse("Don't put an H1 (# …) inside a section.");
    const draft = { id: sectionId, heading: heading.trim() || plan.sections[index].heading, markdown, listItems };
    const existing = state.sections.findIndex((s) => s.id === sectionId);
    const next = existing >= 0 ? state.sections.map((s) => (s.id === sectionId ? draft : s)) : [...state.sections, draft];
    // Kept in plan order; link limits and repeated internal links are counted across the whole article.
    next.sort((a, b) => plan.sections.findIndex((p) => p.id === a.id) - plan.sections.findIndex((p) => p.id === b.id));
    const { sections, removed } = cleanLinks(next, state, input);
    state.sections = sections;
    const section = sections.find((s) => s.id === sectionId)!;
    state.changedSinceReview = true;
    log(`${existing >= 0 ? "Rewrote" : "Wrote"} "${section.heading}"`);
    return {
      saved: sectionId,
      words: wordCount(section.markdown),
      ...(removed.length ? { removedLinks: removed } : {}),
      remaining: plan.sections.filter((p) => !state.sections.some((s) => s.id === p.id)).map((p) => p.id),
    };
  },
});

const submitDraft = defineTool({
  name: "submit_draft",
  description: "Hand the draft to the Director. Ends your work. Every planned section must be written.",
  schema: DraftNotesSchema,
  submit: true,
  async run(notes, { article, log }) {
    const { state } = article;
    const missing = (state.plan?.sections ?? []).filter((p) => !state.sections.some((s) => s.id === p.id));
    if (missing.length) return refuse(`Still unwritten: ${missing.map((m) => `${m.id} "${m.heading}"`).join(", ")}.`);
    state.draftNotes = notes;
    log("Submitted the draft", "submit");
    return { submitted: true };
  },
});

export const writerTools = (): AgentTool[] => [readSource, writeSection, submitDraft];
