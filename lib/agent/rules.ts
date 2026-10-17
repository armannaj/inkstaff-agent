import { AGENT_MAX_REVIEW_ROUNDS } from "@/lib/config";
import { checkArticle } from "./checks";
import type { AgentArticle, AgentState, ReviewIssue } from "./types";

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

/** Can the article be handed over now, and as what. */
export function finishVerdict(article: Pick<AgentArticle, "input" | "state">) {
  const { state } = article;
  if (!state.reviews.length) return { allowed: false, reason: "Nothing has been reviewed yet." };
  const open = openBlockingIssues(state);
  const checks = checkArticle(article).filter(blocking);
  const clean = !open.length && !checks.length && !state.changedSinceReview;
  if (reviewRounds(state) >= AGENT_MAX_REVIEW_ROUNDS)
    return { allowed: true, status: clean ? ("ready" as const) : ("needs_review" as const) };
  if (state.changedSinceReview) return { allowed: false, reason: "The article changed after the last review; review it again." };
  if (clean) return { allowed: true, status: "ready" as const };
  return {
    allowed: false,
    reason: `Critical or major issues are still open (${[...open, ...checks].map((i) => i.id).join(", ")}). Send them to their owners; only minor issues can be accepted.`,
  };
}
