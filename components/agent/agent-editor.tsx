"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LoaderCircleIcon, PauseIcon, PlayIcon, SendIcon, SquareIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  controlAgentAction,
  getAgentArticleAction,
  pollAgentArticleAction,
  publishAgentAction,
  regenerateAgentCoverAction,
  regenerateAgentImageAction,
  removeAgentImageAction,
  removeAgentVideoAction,
  resumeAgentAction,
  saveAgentEditsAction,
  sendAgentNoteAction,
} from "@/app/articles/actions";
import { agentLabel, type AgentArticle, type ArticleImage, type Section } from "@/lib/agent/types";
import { STATUS_LABELS, formatUsd } from "./labels";
import { AgentLog } from "./agent-log";
import { AgentTeam } from "./agent-team";

const TABS = ["Article", "SEO", "Plan", "Research", "Reviews", "Cost"] as const;
type Tab = (typeof TABS)[number];
type Result = { data?: AgentArticle; error?: string };

const active = (article: Pick<AgentArticle, "status">) => article.status === "queued" || article.status === "running";
const assetUrl = (id: string) => `/assets/${encodeURIComponent(id)}`;

function Markdown({ children, allowed }: { children: string; allowed: Set<string> }) {
  return (
    <div className="blog-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) =>
            href && allowed.has(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: () => null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function AgentEditor({
  initialArticle,
  publishTo,
  team,
  budgetUsd,
}: {
  initialArticle: AgentArticle;
  publishTo: string | null;
  /** The worker agents, in their usual order of work. */
  team: string[];
  budgetUsd: number;
}) {
  const [article, setArticle] = useState(initialArticle);
  const [tab, setTab] = useState<Tab>("Article");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, Section>>({});
  const [seo, setSeo] = useState(initialArticle.state.metadata);
  const [note, setNote] = useState("");
  const { state } = article;
  const working = active(article);
  const dirty = Object.keys(drafts).length > 0 || JSON.stringify(seo) !== JSON.stringify(state.metadata);
  const allowed = useMemo(
    () => new Set([...state.sitePages.map((p) => p.url), ...state.sources.map((s) => s.url)]),
    [state.sitePages, state.sources],
  );

  // While the agents work, the page only watches: the server runs them, so the page can be closed anytime. Each poll
  // brings the new log lines and the status; the rest of the article at most every 15 s, and only when it changed
  // (the database bills what it sends). When the run ends, the whole view is loaded once.
  const latest = useRef(article);
  useEffect(() => {
    latest.current = article;
  });
  useEffect(() => {
    if (!working) return;
    let viewedAt = Date.now();
    const timer = setInterval(async () => {
      const current = latest.current;
      const timeline = current.state.timeline;
      const since = timeline.at(-1)?.at ?? "";
      const withView = Date.now() - viewedAt > 15_000;
      const result = await pollAgentArticleAction(current.id, since, current.version, withView);
      const poll = result.data;
      if (!poll) return;
      if (!active(poll)) {
        const full = await getAgentArticleAction(current.id);
        if (full.data) {
          setArticle(full.data);
          setSeo(full.data.state.metadata);
        }
        return;
      }
      if (withView) viewedAt = Date.now();
      const known = new Set(timeline.filter((e) => e.at >= since).map((e) => JSON.stringify(e)));
      const fresh = poll.events.filter((e) => !known.has(JSON.stringify(e)));
      setArticle((prev) => ({
        ...prev,
        status: poll.status,
        title: poll.title,
        wordCount: poll.wordCount,
        error: poll.error,
        control: poll.control,
        ...(poll.state ? { version: poll.version } : {}),
        state: { ...(poll.state ?? prev.state), run: poll.run, cost: poll.cost, timeline: [...prev.state.timeline, ...fresh] },
      }));
    }, 2500);
    return () => clearInterval(timer);
  }, [working, article.id]);

  async function run(label: string, call: () => Promise<Result>, success?: string) {
    setBusy(label);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await call();
      if (result.error) setError(result.error);
      else if (result.data) {
        setArticle(result.data);
        setSeo(result.data.state.metadata);
        if (success) setNotice(success);
        return true;
      }
    } catch {
      setError("Something went wrong. Reload the page and try again.");
    } finally {
      setBusy(null);
    }
    return false;
  }

  async function save() {
    const sections = state.sections.map((s) => drafts[s.id] ?? s);
    const ok = await run(
      "save",
      () => saveAgentEditsAction(article.id, article.version, { sections, metadata: seo }),
      state.publication ? "Saved. Click Update post to put it live." : "Saved.",
    );
    if (ok) setDrafts({});
  }

  const lastReview = state.reviews.at(-1);
  const currentAgent = state.run?.agent;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-5 py-8 sm:px-8">
      <header className="space-y-4">
        <Link href="/" className="text-sm text-muted-foreground hover:underline">
          ← All articles
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-semibold tracking-tight">{article.title}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-1 text-sm text-muted-foreground">
              {working && <LoaderCircleIcon className="size-3.5 animate-spin text-sky-500" aria-hidden />}
              {STATUS_LABELS[article.status]} · {article.wordCount.toLocaleString()} words · {formatUsd(state.cost.totalUsd)}
              {state.publication && (
                <>
                  {" · "}
                  <a href={state.publication.url ?? undefined} target="_blank" rel="noopener noreferrer" className="underline">
                    Published
                  </a>
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {working ? (
              <>
                <Button variant="outline" disabled={!!busy || !!article.control} onClick={() => run("pause", () => controlAgentAction(article.id, "pause"))}>
                  <PauseIcon /> {article.control === "pause" ? "Pausing…" : "Pause"}
                </Button>
                <Button variant="outline" disabled={!!busy || !!article.control} onClick={() => run("stop", () => controlAgentAction(article.id, "stop"))}>
                  <SquareIcon /> {article.control === "stop" ? "Stopping…" : "Stop"}
                </Button>
              </>
            ) : (
              <>
                {(article.status === "paused" || article.status === "failed") && (
                  <Button variant="outline" disabled={!!busy} onClick={() => run("resume", () => resumeAgentAction(article.id))}>
                    <PlayIcon /> Resume
                  </Button>
                )}
                {dirty && (
                  <Button disabled={!!busy} onClick={save}>
                    {busy === "save" && <LoaderCircleIcon className="animate-spin" />} Save changes
                  </Button>
                )}
                <Button
                  variant={dirty ? "outline" : "default"}
                  disabled={!!busy || dirty || !publishTo || !state.metadata}
                  title={!publishTo ? "Set up publishing for this product under Products → Publishing." : undefined}
                  onClick={() => {
                    if (confirm(`${state.publication || state.existingPost ? "Update" : "Publish"} "${article.title}" on ${publishTo}?`))
                      void run("publish", () => publishAgentAction(article.id, article.version), "Published.");
                  }}
                >
                  {busy === "publish" ? <LoaderCircleIcon className="animate-spin" /> : <UploadIcon />}
                  {state.publication || state.existingPost ? "Update post" : "Publish"}
                </Button>
              </>
            )}
          </div>
        </div>
        {working ? (
          <div className="space-y-3">
            <AgentTeam team={team} status={article.status} run={state.run} cost={state.cost} timeline={state.timeline} budgetUsd={budgetUsd} />
            <AgentLog
              events={state.timeline}
              working={
                article.status === "queued"
                  ? "Waiting for a free slot…"
                  : currentAgent
                    ? `${agentLabel(currentAgent)} is working (turn ${state.run!.turns + 1})…`
                    : "The Director is deciding the next step…"
              }
            />
            <p className="text-xs text-muted-foreground">The agents run on the server. You can close this page and come back.</p>
          </div>
        ) : (
          state.timeline.length > 0 && (
            <details className="group rounded-xl border">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                Agent log · {state.timeline.length} events
                {state.timeline.length > 1 &&
                  ` · ${Math.max(1, Math.round((Date.parse(state.timeline.at(-1)!.at) - Date.parse(state.timeline[0].at)) / 60_000))} min`}
              </summary>
              <div className="px-4 pb-4">
                <AgentLog events={state.timeline} />
              </div>
            </details>
          )
        )}
        {state.outcome && !working && <p className="rounded-xl border p-4 text-sm">{state.outcome}</p>}
        {article.error && <p role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm text-destructive">{article.error}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
        {!working && (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run("note", () => sendAgentNoteAction(article.id, note), "Sent. The Director is on it.")) setNote("");
            }}
          >
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ask the agents for a change, e.g. “Add Sprout Social and shorten the intro”"
              aria-label="Note to the agents"
              disabled={!!busy || dirty}
            />
            <Button type="submit" variant="outline" disabled={!!busy || dirty || note.trim().length < 3}>
              <SendIcon /> Send to agents
            </Button>
          </form>
        )}
      </header>

      <nav className="flex flex-wrap gap-1 border-b" aria-label="Article views">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === name ? "border-foreground font-medium" : "border-transparent text-muted-foreground"}`}
          >
            {name}
            {name === "Reviews" && state.reviews.length ? ` (${state.reviews.length})` : ""}
          </button>
        ))}
      </nav>

      {tab === "Article" && (
        <div className="space-y-8">
          <CoverPanel article={article} disabled={working || !!busy || dirty} busy={busy === "cover"} onRegenerate={(o) => run("cover", () => regenerateAgentCoverAction(article.id, article.version, o))} />
          {!state.sections.length && <p className="text-sm text-muted-foreground">The sections appear here as the Writer writes them.</p>}
          {state.sections.map((section) => {
            const draft = drafts[section.id];
            return (
              <section key={section.id} className="space-y-3 border-b pb-8">
                {draft ? (
                  <div className="space-y-2">
                    <Input value={draft.heading} aria-label="Heading" onChange={(e) => setDrafts({ ...drafts, [section.id]: { ...draft, heading: e.target.value } })} />
                    <Textarea rows={16} value={draft.markdown} aria-label="Section Markdown" onChange={(e) => setDrafts({ ...drafts, [section.id]: { ...draft, markdown: e.target.value } })} />
                    <Button size="sm" variant="ghost" onClick={() => setDrafts(Object.fromEntries(Object.entries(drafts).filter(([id]) => id !== section.id)))}>
                      Discard changes
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="text-xl font-semibold">{section.heading}</h2>
                      {!working && (
                        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setDrafts({ ...drafts, [section.id]: section })}>
                          Edit
                        </Button>
                      )}
                    </div>
                    <Markdown allowed={allowed}>{section.markdown}</Markdown>
                  </>
                )}
                {state.images
                  .filter((image) => image.sectionId === section.id)
                  .map((image) => (
                    <ImageFigure
                      key={image.id}
                      image={image}
                      disabled={working || !!busy || dirty}
                      busy={busy === image.id}
                      onRegenerate={(subject) => run(image.id, () => regenerateAgentImageAction(article.id, article.version, image.id, subject))}
                      onRemove={() => {
                        if (confirm("Remove this image from the article?")) void run(image.id, () => removeAgentImageAction(article.id, article.version, image.id));
                      }}
                    />
                  ))}
                {state.videos
                  .filter((video) => video.sectionId === section.id)
                  .map((video) => (
                    <div key={video.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3 text-sm">
                      <a href={video.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1">
                        <span className="block font-medium underline underline-offset-4">▶ {video.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          YouTube · {video.channel}
                          {video.durationSeconds ? ` · ${Math.round(video.durationSeconds / 60)} min` : ""}
                          {video.views ? ` · ${video.views.toLocaleString()} views` : ""}
                        </span>
                        <span className="mt-1 block text-muted-foreground">{video.reason}</span>
                      </a>
                      {!working && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!!busy || dirty}
                          onClick={() => {
                            if (confirm("Remove this video from the article?"))
                              void run(video.id, () => removeAgentVideoAction(article.id, article.version, video.id));
                          }}
                        >
                          <Trash2Icon /> Remove
                        </Button>
                      )}
                    </div>
                  ))}
              </section>
            );
          })}
          {state.faq.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xl font-semibold">Frequently asked questions</h2>
              {state.faq.map((item, i) => (
                <div key={i}>
                  <h3 className="font-medium">{item.question}</h3>
                  <p className="text-sm">{item.answer}</p>
                </div>
              ))}
            </section>
          )}
        </div>
      )}

      {tab === "SEO" && (
        <div className="space-y-4">
          {!seo ? (
            <p className="text-sm text-muted-foreground">The Editor writes the title and meta with the plan.</p>
          ) : (
            (
              [
                ["h1", "Title (H1, published as the page title)"],
                ["slug", "Slug"],
                ["metaDescription", "Meta description"],
                ["excerpt", "Excerpt"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="block space-y-1.5 text-sm font-medium">
                <span>
                  {label}
                  {key === "h1" || key === "metaDescription" ? <span className="ml-2 font-normal text-muted-foreground">{seo[key].length} characters</span> : null}
                </span>
                {key === "metaDescription" || key === "excerpt" ? (
                  <Textarea rows={3} value={seo[key]} disabled={working} onChange={(e) => setSeo({ ...seo, [key]: e.target.value })} />
                ) : (
                  <Input
                    value={seo[key]}
                    disabled={working || (key === "slug" && !!(state.publication || state.existingPost))}
                    onChange={(e) => setSeo({ ...seo, [key]: e.target.value })}
                  />
                )}
              </label>
            ))
          )}
        </div>
      )}

      {tab === "Plan" && <JsonDocument title="Editorial plan (Editor)" value={state.plan} empty="The Editor hasn't planned the article yet." />}

      {tab === "Research" && (
        <div className="space-y-6">
          <JsonDocument title="Research dossier (Research)" value={state.dossier} empty="Research hasn't submitted its dossier yet." />
          <section className="space-y-2">
            <h2 className="font-semibold">Sources read ({state.sources.length})</h2>
            <ul className="space-y-2 text-sm">
              {state.sources.map((source) => (
                <li key={source.id}>
                  <a href={source.url} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-4">
                    {source.title}
                  </a>
                  <span className="text-muted-foreground"> · {source.id} · {source.sourceType}{source.publicationDate ? ` · ${source.publicationDate.slice(0, 10)}` : ""}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {tab === "Reviews" && (
        <div className="space-y-8">
          {!state.reviews.length && <p className="text-sm text-muted-foreground">No review yet.</p>}
          {[...state.reviews].reverse().map((review) => (
            <section key={review.round} className="space-y-3">
              <h2 className="font-semibold">
                Round {review.round}: {review.verdict === "approve" ? "approved" : "revise"}
              </h2>
              <p className="text-sm">{review.summary}</p>
              <ul className="space-y-2">
                {review.issues.map((issue) => {
                  const accepted = state.decisions.some((d) => d.accepted.includes(issue.id));
                  return (
                    <li key={issue.id} className="border-l-2 pl-3 text-sm">
                      <p className="font-medium">
                        <span className={issue.severity === "critical" ? "text-destructive" : issue.severity === "major" ? "text-amber-700 dark:text-amber-400" : ""}>
                          {issue.severity}
                        </span>{" "}
                        · {agentLabel(issue.owner)} · {issue.id}
                        {issue.fromChecks ? " · code check" : ""}
                        {accepted ? " · accepted by the Director" : ""}
                      </p>
                      <p>{issue.problem}</p>
                      <p className="text-muted-foreground">Fix: {issue.fix}</p>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {lastReview && state.decisions.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-semibold">Director&apos;s decisions</h2>
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {state.decisions.map((d, i) => (
                  <li key={i}>
                    {d.next === "finish" ? "Finish" : agentLabel(d.next)}: {d.reason}
                    {d.overridden ? <span className="text-muted-foreground"> (overruled: {d.overridden})</span> : null}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      )}

      {tab === "Cost" && (
        <div className="space-y-2 text-sm">
          <p>
            Total {formatUsd(state.cost.totalUsd)} over {state.cost.calls} calls
            {state.cost.unpricedCalls ? ` (${state.cost.unpricedCalls} without a reported cost, so the total is a lower bound)` : ""}.
          </p>
          <ul className="space-y-1">
            {Object.entries(state.cost.byAgent)
              .sort((a, b) => b[1] - a[1])
              .map(([agent, usd]) => (
                <li key={agent}>
                  {agentLabel(agent) ?? agent}: {formatUsd(usd)}
                </li>
              ))}
          </ul>
          {state.cost.reasoning && (
            <div className="space-y-1 pt-2">
              <p className="font-medium">Reasoning</p>
              <ul className="space-y-1 text-muted-foreground">
                {Object.entries(state.cost.reasoning).map(([agent, r]) => (
                  <li key={agent}>
                    {agentLabel(agent) ?? agent}: {r.tokens.toLocaleString()} reasoning tokens over {r.turns} model turns
                    {r.turnsWithout ? ` (${r.turnsWithout} with none)` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-muted-foreground">
            Searches {state.usage.searches} · pages read {state.usage.reads} · generated images {state.usage.images} · screenshots {state.usage.screenshots}
          </p>
        </div>
      )}
    </main>
  );
}

function JsonDocument({ title, value, empty }: { title: string; value: unknown; empty: string }) {
  return (
    <section className="space-y-2">
      <h2 className="font-semibold">{title}</h2>
      {value ? (
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-4 text-xs">{JSON.stringify(value, null, 2)}</pre>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

function ImageFigure({
  image,
  disabled,
  busy,
  onRegenerate,
  onRemove,
}: {
  image: ArticleImage;
  disabled: boolean;
  busy: boolean;
  onRegenerate: (subject?: string) => void;
  onRemove: () => void;
}) {
  const [subject, setSubject] = useState("");
  const screenshot = image.kind === "screenshot";
  const infographic = image.kind === "infographic";
  return (
    <figure className="space-y-2">
      {image.assetId ? (
        <Image unoptimized src={assetUrl(image.assetId)} alt={image.altText} width={1280} height={720} className="h-auto w-full rounded-lg border" />
      ) : (
        <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{image.error ?? "Not generated."}</div>
      )}
      <figcaption className="text-xs text-muted-foreground">{image.altText}</figcaption>
      <div className="flex flex-wrap items-center gap-2">
        {!infographic && (
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={disabled}
            type={screenshot ? "url" : "text"}
            placeholder={screenshot ? `Optional: another page (now ${image.subject})` : `Optional: another scene (now: ${image.subject.slice(0, 60)})`}
            className="h-8 min-w-56 flex-1 text-xs"
          />
        )}
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onRegenerate(subject.trim() || undefined)}>
          {busy && <LoaderCircleIcon className="animate-spin" />}
          {screenshot ? "Retake screenshot" : "Redraw"}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onRemove}>
          <Trash2Icon /> Remove
        </Button>
      </div>
    </figure>
  );
}

function CoverPanel({
  article,
  disabled,
  busy,
  onRegenerate,
}: {
  article: AgentArticle;
  disabled: boolean;
  busy: boolean;
  onRegenerate: (options: { headline?: string; artDirection?: string }) => void;
}) {
  const cover = article.state.cover;
  const [headline, setHeadline] = useState("");
  const [artDirection, setArtDirection] = useState("");
  return (
    <section aria-label="Cover image" className="overflow-hidden rounded-xl border">
      {cover?.assetId ? (
        <Image unoptimized src={assetUrl(cover.assetId)} alt={cover.altText} width={1600} height={900} className="h-auto w-full" />
      ) : (
        <div className="flex aspect-video items-center justify-center bg-muted/30 text-sm text-muted-foreground">The Graphics agent makes the cover.</div>
      )}
      <div className="space-y-3 p-4">
        {cover?.textIssue && <p className="text-sm text-amber-700 dark:text-amber-400">The headline came out wrong: {cover.textIssue}. Redraw it.</p>}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={headline} onChange={(e) => setHeadline(e.target.value)} disabled={disabled} placeholder={`Headline (now: ${cover?.headline ?? "none"})`} />
          <Input value={artDirection} onChange={(e) => setArtDirection(e.target.value)} disabled={disabled} placeholder="Optional: a different motif" />
          <Button variant="outline" disabled={disabled} onClick={() => onRegenerate({ headline: headline || undefined, artDirection: artDirection || undefined })}>
            {busy && <LoaderCircleIcon className="animate-spin" />} Redraw cover
          </Button>
        </div>
      </div>
    </section>
  );
}
