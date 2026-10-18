"use client";
import { useEffect, useState } from "react";
import { CheckIcon, CircleDashedIcon, LoaderCircleIcon } from "lucide-react";
import { agentLabel, type AgentCost, type AgentRun, type AgentStatus, type TimelineEvent } from "@/lib/agent/types";
import { cn } from "@/lib/utils";
import { formatUsd } from "./labels";

type NodeState = "working" | "waiting" | "done" | "idle";

/** The current time, ticking every second. Null until mounted, so the server and the first render agree. */
function useNow() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A line from the Director to an agent; work flows down it while that agent runs. */
function Flow({ active, className }: { active: boolean; className?: string }) {
  return <div aria-hidden className={cn("w-0.5", active ? "agent-flow" : "bg-border", className)} />;
}

function Node({ label, state, detail, cost }: { label: string; state: NodeState; detail: string; cost?: number }) {
  return (
    <div
      className={cn(
        "relative flex w-full max-w-36 flex-col items-center gap-0.5 rounded-lg border px-1 py-2 text-center transition-all duration-500",
        state === "working" && "agent-halo scale-105 border-sky-500 bg-sky-500/10",
        state === "waiting" && "border-sky-500/40 bg-sky-500/5",
        state === "done" && "border-emerald-500/40",
        state === "idle" && "border-dashed opacity-55",
      )}
    >
      {state === "working" ? (
        <LoaderCircleIcon className="size-4 animate-spin text-sky-500" />
      ) : state === "done" ? (
        <CheckIcon className="size-4 text-emerald-500" />
      ) : (
        <CircleDashedIcon className={cn("size-4", state === "waiting" ? "text-sky-500/70" : "text-muted-foreground")} />
      )}
      <span className="max-w-full truncate text-xs font-medium sm:text-sm">{label}</span>
      <span className="max-w-full truncate text-[11px] tabular-nums text-muted-foreground">{detail}</span>
      {cost !== undefined && cost > 0 && (
        <span className="text-[11px] font-medium tabular-nums text-foreground/80">{formatUsd(cost)}</span>
      )}
    </div>
  );
}

/** The article's spend, flashing on each change with the amount it went up by. */
function LiveCost({ usd, budgetUsd }: { usd: number; budgetUsd: number }) {
  const [shown, setShown] = useState(usd);
  const [delta, setDelta] = useState(0);
  if (usd !== shown) {
    setDelta(usd - shown);
    setShown(usd);
  }
  const share = budgetUsd > 0 ? Math.min(1, usd / budgetUsd) : 0;
  return (
    <div className="flex min-w-32 flex-col items-end gap-1">
      <p className="relative text-sm">
        {delta > 0 && (
          <span key={`d${usd}`} className="cost-delta absolute -top-3.5 right-0 text-[11px] font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
            +{formatUsd(delta)}
          </span>
        )}
        <span key={usd} className="cost-tick inline-block rounded px-1 font-semibold tabular-nums">
          {formatUsd(usd)}
        </span>
        <span className="text-muted-foreground"> of {formatUsd(budgetUsd)}</span>
      </p>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted" role="meter" aria-label="Budget spent" aria-valuemin={0} aria-valuemax={budgetUsd} aria-valuenow={usd}>
        <div
          className={cn("h-full rounded-full transition-[width] duration-700", share > 0.8 ? "bg-amber-500" : "bg-sky-500")}
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * The team while it works: the Director above its agents, the one working now lit up with work flowing to it, and
 * what each has cost so far. The cost updates with every poll.
 */
export function AgentTeam({
  team,
  status,
  run,
  cost,
  timeline,
  budgetUsd,
}: {
  team: string[];
  status: AgentStatus;
  run: AgentRun | null;
  cost: AgentCost;
  timeline: TimelineEvent[];
  budgetUsd: number;
}) {
  const now = useNow();
  const queued = status === "queued";
  const runs = new Map<string, number>();
  for (const e of timeline) if (e.kind === "start") runs.set(e.agent, (runs.get(e.agent) ?? 0) + 1);
  const deciding = !queued && !run;
  const current = run?.agent;
  const elapsed = run && now ? ` · ${clock(now - Date.parse(run.startedAt))}` : "";

  return (
    <section aria-label="Agent team" className="rounded-xl border p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-medium" aria-live="polite">
          <span className="relative flex size-2.5">
            {!queued && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />}
            <span className={cn("relative inline-flex size-2.5 rounded-full", queued ? "bg-muted-foreground" : "bg-emerald-500")} />
          </span>
          {queued
            ? "Waiting for a free slot"
            : current
              ? `${agentLabel(current)} is working`
              : "The Director is deciding the next step"}
        </p>
        <LiveCost usd={cost.totalUsd} budgetUsd={budgetUsd} />
      </div>

      <div className="mt-5 flex flex-col items-center">
        <div className="w-28 sm:w-36">
          <Node
            label="Director"
            state={queued ? "idle" : deciding ? "working" : "waiting"}
            detail={queued ? "queued" : deciding ? "deciding…" : `waiting on ${agentLabel(current!)}`}
            cost={cost.byAgent.director}
          />
        </div>
        <Flow active={!!current} className="h-5" />
      </div>
      <div className="relative grid gap-1.5 sm:gap-3" style={{ gridTemplateColumns: `repeat(${team.length}, minmax(0, 1fr))` }}>
        <div aria-hidden className="absolute top-0 h-0.5 bg-border" style={{ left: `${50 / team.length}%`, right: `${50 / team.length}%` }} />
        {team.map((name) => {
          const working = current === name;
          const times = runs.get(name) ?? 0;
          const state: NodeState = working ? "working" : times ? "done" : "idle";
          return (
            <div key={name} className="flex flex-col items-center">
              <Flow active={working} className="h-4" />
              <Node
                label={agentLabel(name)}
                state={state}
                detail={working ? `turn ${run!.turns + 1}${elapsed}` : times > 1 ? `${times} runs` : times ? "done" : "waiting"}
                cost={cost.byAgent[name]}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
