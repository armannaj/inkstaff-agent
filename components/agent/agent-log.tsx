"use client";
import { useEffect, useRef } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { agentLabel, type TimelineEvent } from "@/lib/agent/types";

const FIXED_COLORS: Record<string, string> = { director: "text-amber-300", human: "text-zinc-100", system: "text-zinc-400" };
const PALETTE = ["text-sky-300", "text-violet-300", "text-emerald-300", "text-pink-300", "text-orange-300", "text-teal-300", "text-lime-300", "text-rose-300"];
/** Each agent keeps one colour, picked from its name, so a new agent gets one without a list to update. */
function colorOf(agent: string) {
  if (FIXED_COLORS[agent]) return FIXED_COLORS[agent];
  let hash = 0;
  for (const char of agent) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}
const who = (agent: TimelineEvent["agent"]) =>
  agent === "human" ? "You" : agent === "system" ? "System" : agentLabel(agent);
const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function Line({ event }: { event: TimelineEvent }) {
  const color = colorOf(event.agent);
  const body = (() => {
    switch (event.kind) {
      case "decision":
        return <span className={`font-semibold ${color}`}>◆ {who(event.agent)} {event.text}</span>;
      case "start":
        return (
          <span className={`font-semibold ${color}`}>
            ▸ {who(event.agent)} · {event.text}
          </span>
        );
      case "call":
        return (
          <span>
            <span className={color}>●</span> <span className="text-zinc-100">{event.text}</span>
          </span>
        );
      case "error":
        return <span className="pl-4 text-red-400">⎿ {event.text}</span>;
      case "message":
        return <span className="whitespace-pre-wrap pl-4 italic text-zinc-400">“{event.text}”</span>;
      case "thinking":
        return (
          <details className="pl-4 text-zinc-500">
            <summary className="cursor-pointer select-none hover:text-zinc-300">✻ {who(event.agent)} thinking</summary>
            <p className="mt-1 whitespace-pre-wrap border-l border-zinc-800 pl-3">{event.text}</p>
          </details>
        );
      case "submit":
        return <span className="font-semibold text-emerald-400">✓ {who(event.agent)}: {event.text}</span>;
      case "note":
        return <span className={`font-semibold ${color}`}>» {who(event.agent)}: {event.text}</span>;
      default:
        return <span className="pl-4 text-zinc-400">⎿ {event.text}</span>;
    }
  })();
  return (
    <li className="flex gap-3 break-words">
      <span className="shrink-0 text-zinc-600">{time(event.at)}</span>
      <span className="min-w-0">{body}</span>
    </li>
  );
}

/**
 * Every step the agents took, like a terminal: tool calls with their arguments, what came of them, decisions and
 * reviews. Follows the newest line while you're at the bottom; scroll up to read without being pulled back.
 */
export function AgentLog({ events, working }: { events: TimelineEvent[]; working?: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [events.length, working]);
  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="max-h-[28rem] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300"
      role="log"
      aria-live="polite"
      aria-label="Agent log"
    >
      {!events.length && <p className="text-zinc-500">Waiting for the agents to start…</p>}
      <ol className="space-y-1">
        {events.map((event, i) => (
          <Line key={i} event={event} />
        ))}
      </ol>
      {working && (
        <p className="mt-2 flex items-center gap-2 text-zinc-400">
          <LoaderCircleIcon className="size-3 animate-spin" /> {working}
        </p>
      )}
    </div>
  );
}
