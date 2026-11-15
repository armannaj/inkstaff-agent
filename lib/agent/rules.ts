import { AGENT_MAX_REVIEW_ROUNDS } from "@/lib/config";
import { checkArticle } from "./checks";
import { AUTHOR, type AgentArticle, type AgentState, type ReviewIssue, type ReviewReport } from "./types";

/** When an article may be handed over. Used by the Director's guard rails and by the reviewer's report. */
const blocking = (issue: ReviewIssue) => issue.severity !== "minor";

/** Review rounds since the author's last note: a note starts a new cycle with a fresh allowance. */
export function reviewRounds(state: AgentState) {
  const lastNote = state.humanNotes.at(-1)?.at ?? "";
  return state.reviews.filter((r) => r.at > lastNote).length;
}
export function openBlockingIssues(state: AgentState) {
  return state.reviews.at(-1)?.issues.filter(blocking) ?? [];
}

/**
 * The review the article is approved by: the latest one, when it left nothing critical or major and the author hasn't
 * sent a note since (a note asks for new work, which needs its own review).
 */
export function approval(state: AgentState): ReviewReport | undefined {
  const review = state.reviews.at(-1);
  if (!review || review.issues.some(blocking)) return undefined;
  return review.at > (state.humanNotes.at(-1)?.at ?? "") ? review : undefined;
}

/** Can the article be handed over now, and as what. */
export function finishVerdict(article: Pick<AgentArticle, "input" | "state">) {
  const { state } = article;
  if (!state.reviews.length) return { allowed: false, reason: "Nothing has been reviewed yet." };
  const open = openBlockingIssues(state);
  const checks = checkArticle(article).filter(blocking);
  const approved = !!approval(state);
  // The minor fixes of the polish pass, made after an approving review, aren't reviewed again.
  const reviewed = !state.changedSinceReview || approved;
  const clean = !open.length && !checks.length && reviewed;
  if (reviewRounds(state) >= AGENT_MAX_REVIEW_ROUNDS)
    return { allowed: true, status: clean ? ("ready" as const) : ("needs_review" as const) };
  if (!reviewed) return { allowed: false, reason: "The article changed after the last review; review it again." };
  if (clean) return { allowed: true, status: "ready" as const };
  if (approved)
    return {
      allowed: false,
      reason: `The code checks find problems in what changed after the review (${checks.map((i) => i.id).join(", ")}). Run the reviewer.`,
    };
  // What is open is the author's to fix: more rounds can't change it.
  if (!checks.length && open.every((i) => i.owner === AUTHOR)) return { allowed: true, status: "needs_review" as const };
  return {
    allowed: false,
    reason: `Critical or major issues are still open (${[...open, ...checks].map((i) => i.id).join(", ")}). Send them to their owners; only minor issues can be accepted.`,
  };
}

/** An issue only the author can fix is never sent to an agent. Returns why these issues can't be sent, or null. */
export function authorOnlyProblem(state: AgentState, issueIds: string[]): string | null {
  const ids = (state.reviews.at(-1)?.issues ?? []).filter((i) => i.owner === AUTHOR && issueIds.includes(i.id)).map((i) => i.id);
  return ids.length ? `${ids.join(", ")}: only the author can fix this, no agent's tools can. The author sees it at handoff; leave it out.` : null;
}

/**
 * After an approving review the article can ship. Its minor issues may still get one polish pass: each agent once, sent
 * minor issues of that review, and what that changes isn't reviewed again (the code checks still run: if they then
 * find something, the reviewer looks once more). Returns why an agent can't be started now, or null.
 */
export function polishProblem(article: Pick<AgentArticle, "input" | "state">, agent: string, issueIds: string[]): string | null {
  const { state } = article;
  const review = approval(state);
  if (!review) return null;
  const broken = state.changedSinceReview && checkArticle(article).some(blocking);
  if (agent === "reviewer")
    return broken ? null : "The last review approved the article, and the minor fixes made since aren't reviewed again. Finish.";
  if (broken) return "The code checks find problems in what changed after the review. Run the reviewer.";
  const minor = review.issues.filter((i) => i.owner !== AUTHOR).map((i) => i.id);
  if (!issueIds.length || issueIds.some((id) => !minor.includes(id)))
    return `The last review approved the article. Before finishing, an agent can only be sent minor issues of that review (${minor.join(", ") || "there are none"}), each agent once. Otherwise finish.`;
  if (state.timeline.some((e) => e.agent === agent && e.kind === "submit" && e.at > review.at))
    return `The ${agent} agent already had its polish pass after the review. Finish.`;
  return null;
}

const HANDOFF_ISSUE_CHARS = 500;
/**
 * What the author needs to know at handoff, beyond the verdict, as lines of text: the issues the article still has
 * (spelled out, not as IDs), what only the author can add, and what couldn't be covered because nothing could be read.
 */
export function handoffNotes({ state }: Pick<AgentArticle, "state">): string[] {
  const lines: string[] = [];
  const list = (title: string, items: string[]) => {
    if (items.length) lines.push(title, ...items.map((item) => `- ${item}`));
  };
  const review = state.reviews.at(-1);
  if (review) {
    // Issues sent to an agent after the review: fixed (or tried) since, and not looked at again.
    const sent = new Set(state.decisions.filter((d) => d.at > review.at).flatMap((d) => d.issueIds));
    const text = (issue: ReviewIssue) => {
      const problem = issue.problem.length > HANDOFF_ISSUE_CHARS ? `${issue.problem.slice(0, HANDOFF_ISSUE_CHARS)}…` : issue.problem;
      return `${problem} (${issue.owner}${issue.sectionId ? `, ${issue.sectionId}` : ""})`;
    };
    const minor = review.issues.filter((i) => !blocking(i));
    list("Critical or major issues from the last review:", review.issues.filter(blocking).map((i) => `${i.severity}: ${text(i)}`));
    list("Minor issues left as they are:", minor.filter((i) => !sent.has(i.id)).map(text));
    list("Minor issues sent back for a last fix after the review, which wasn't reviewed again:", minor.filter((i) => sent.has(i.id)).map(text));
    list("Only you can add this (the Reviewer asks for it):", review.evidenceWanted ?? []);
  }
  list(
    "Left out, because no page about them could be read. Add their facts as owner material, or in a note, to have them covered:",
    (state.plan?.leftOut ?? []).map((item) => `${item.name}: ${item.reason}`),
  );
  const host = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };
  const read = new Set(state.sources.map((s) => host(s.url)));
  const unread = [...new Set((state.failedReads ?? []).map((f) => host(f.url)))].filter((h) => !read.has(h));
  if (unread.length) lines.push(`Sites the agents tried to read and couldn't: ${unread.join(", ")}.`);
  return lines;
}
