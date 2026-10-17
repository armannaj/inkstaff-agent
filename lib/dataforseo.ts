import "server-only";
import { z } from "zod";

const API_BASE = "https://api.dataforseo.com/v3";

export class DataForSeoError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "DataForSeoError";
  }

  /** Temporary upstream failures that can recover when the same request is retried. */
  get isRetryable() {
    return [500, 502, 503, 504, 40101, 40103, 50000, 50301, 50302, 50401].includes(this.statusCode ?? 0);
  }
}

/** The Basic auth value: DFS_AUTH (base64 of login:password) as given, else built from DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD. */
function basicAuth() {
  const auth = process.env.DFS_AUTH?.trim().replace(/^Basic\s+/i, "");
  if (auth) return auth;
  const login = process.env.DATAFORSEO_LOGIN?.trim();
  const password = process.env.DATAFORSEO_PASSWORD?.trim();
  return login && password ? Buffer.from(`${login}:${password}`).toString("base64") : null;
}

export const hasDataForSeo = () => basicAuth() !== null;

// Every DataForSEO v3 endpoint returns this envelope. HTTP is 200 even when a task fails, so both the top-level and
// task-level status_code must be checked (20000 = OK). See https://docs.dataforseo.com/v3/appendix/errors/
const envelopeSchema = z.object({
  status_code: z.number(),
  status_message: z.string(),
  cost: z.number().nullish(),
  tasks: z
    .array(
      z.object({
        status_code: z.number(),
        status_message: z.string(),
        cost: z.number().nullish(),
        result: z.array(z.unknown()).nullish(),
      }),
    )
    .nullish(),
});

/** Task finished but Google returned no results: an empty result, not an error. */
const NO_SEARCH_RESULTS = 40102;
/** Task finished with some pages missing; the returned pages are billed and usable. */
const PARTIAL_RESULTS = 40106;

/** POSTs a single task to a DataForSEO "live" endpoint: tasks[0].result, unvalidated, and what it cost. */
export async function postLive(path: string, task: Record<string, unknown>): Promise<{ result: unknown[]; costUsd: number }> {
  const auth = basicAuth();
  if (!auth) throw new DataForSeoError("Set DFS_AUTH, or DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD, in .env.local.", 401);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([task]),
      cache: "no-store",
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new DataForSeoError(`Could not reach DataForSEO: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) throw new DataForSeoError("DataForSEO rejected the credentials. Check DFS_AUTH, or DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.", 401);
  if (res.status === 402) throw new DataForSeoError("DataForSEO says payment is required. Check your account balance.", 402);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new DataForSeoError(`DataForSEO HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  const parsed = envelopeSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new DataForSeoError("Unexpected response format from DataForSEO.");
  const body = parsed.data;
  if (body.status_code !== 20000)
    throw new DataForSeoError(`DataForSEO error ${body.status_code}: ${body.status_message}`, body.status_code);
  const taskResult = body.tasks?.[0];
  if (!taskResult) throw new DataForSeoError("DataForSEO returned no task in the response.");
  const costUsd = body.cost ?? taskResult.cost ?? 0;
  if (taskResult.status_code === NO_SEARCH_RESULTS) return { result: [], costUsd };
  if (taskResult.status_code !== 20000 && taskResult.status_code !== PARTIAL_RESULTS)
    throw new DataForSeoError(`DataForSEO task error ${taskResult.status_code}: ${taskResult.status_message}`, taskResult.status_code);
  return { result: taskResult.result ?? [], costUsd };
}
