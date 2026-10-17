/** Runs once when the Next.js server starts: starts the agents' background runner. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Not awaited: the server must not wait for the queue to start.
    const { startRunner } = await import("@/lib/agent/runner");
    setTimeout(startRunner, 5_000);
  }
}
