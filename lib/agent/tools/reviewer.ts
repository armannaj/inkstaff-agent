import { z } from "zod";
import { checkArticle } from "../checks";
import { ReviewReportSchema } from "../schemas";
import { researchTools } from "./research";
import { inspectImage, listImages, reviewImage } from "./graphics";
import { defineTool, type AgentTool } from "./types";

const checkTool = defineTool({
  name: "check_article",
  description:
    "Run the code checks: unwritten sections, numbers no read source contains, research talk in the prose, length, competitor names, title rules, missing cover, failed images. They are added to your review automatically.",
  schema: z.object({}),
  async run(_args, { article }) {
    const issues = checkArticle(article);
    return issues.length ? { issues } : { issues: [], note: "The code checks found nothing." };
  },
});

const submitReview = defineTool({
  name: "submit_review",
  description:
    "Hand your review to the Director. Ends your work. Give every issue a severity and the agent that owns the fix; the code checks' issues are added for you.",
  schema: ReviewReportSchema,
  submit: true,
  async run(report, { article, log }) {
    const { state } = article;
    const round = state.reviews.length + 1;
    const checks = checkArticle(article).map((issue) => ({ ...issue, id: `r${round}-${issue.id}` }));
    const own = report.issues.map((issue, i) => ({ ...issue, id: `r${round}-${i + 1}` }));
    const issues = [...own, ...checks];
    const blocking = issues.some((i) => i.severity !== "minor");
    state.reviews.push({
      ...report,
      // A review can't approve what the code checks block.
      verdict: blocking ? "revise" : report.verdict,
      issues,
      round,
      at: new Date().toISOString(),
    });
    state.changedSinceReview = false;
    const counts = ["critical", "major", "minor"].map((s) => `${issues.filter((i) => i.severity === s).length} ${s}`);
    log(`Review round ${round}: ${blocking ? "revise" : report.verdict} (${counts.join(", ")})`, "submit");
    return { submitted: true };
  },
});

export const reviewerTools = (): AgentTool[] => [...researchTools(), checkTool, listImages, reviewImage, inspectImage, submitReview];
