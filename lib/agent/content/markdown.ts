import type { AgentState } from "../types";

/** The whole article as Markdown: title, sections, then an older article's separate FAQ, if it has one. */
export function articleMarkdown(state: Pick<AgentState, "metadata" | "plan" | "sections" | "faq">) {
  const title = state.metadata?.h1 || state.plan?.h1;
  return [
    title ? `# ${title}` : "",
    ...state.sections.map((s) => `## ${s.heading}\n\n${s.markdown}`),
    state.faq.length
      ? `## Frequently asked questions\n\n${state.faq.map((f) => `### ${f.question}\n\n${f.answer}`).join("\n\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
export function wordCount(markdown: string) {
  return markdown
    .replace(/\[[^\]]*\]\([^)]*\)/g, (s) => s.slice(1, s.indexOf("]")))
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}
