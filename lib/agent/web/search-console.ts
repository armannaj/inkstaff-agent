import "server-only";
import { readFile } from "node:fs/promises";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";

/**
 * Google Search Console, read-only, through a service account (GSC_CREDENTIALS_PATH: the account's JSON key file).
 * The service account must be added as a user on each Search Console property it should read.
 */
const CredentialsSchema = z.object({ client_email: z.string(), private_key: z.string() });
const API = "https://www.googleapis.com/webmasters/v3";

let cached: { token: string; expires: number } | undefined;

export const hasSearchConsole = () => Boolean(process.env.GSC_CREDENTIALS_PATH);

async function accessToken() {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const path = process.env.GSC_CREDENTIALS_PATH;
  if (!path) throw new Error("Search Console isn't connected: set GSC_CREDENTIALS_PATH to a service account key file.");
  const credentials = CredentialsSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/webmasters.readonly" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(credentials.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(await importPKCS8(credentials.private_key, "RS256"));
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Google sign-in for Search Console failed (HTTP ${response.status}).`);
  const { access_token, expires_in } = z.object({ access_token: z.string(), expires_in: z.number() }).parse(await response.json());
  cached = { token: access_token, expires: Date.now() + expires_in * 1000 };
  return access_token;
}

async function call(path: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Search Console returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json() as Promise<unknown>;
}

/** The property covering a website: its domain property, or a URL-prefix property for the site. */
export async function propertyFor(websiteUrl: string) {
  const host = new URL(websiteUrl).hostname.replace(/^www\./, "");
  const { siteEntry = [] } = z
    .object({ siteEntry: z.array(z.object({ siteUrl: z.string() })).optional() })
    .parse(await call("/sites"));
  const sites = siteEntry.map((s) => s.siteUrl);
  return (
    sites.find((s) => s === `sc-domain:${host}`) ??
    sites.find((s) => /^https?:\/\//.test(s) && new URL(s).hostname.replace(/^www\./, "") === host) ??
    null
  );
}

/**
 * Search Analytics over the last `days` (Google's data lags about two days), or the `days` before that with
 * `offsetDays`, returned exactly as the API sends it.
 * https://developers.google.com/webmaster-tools/v1/searchanalytics/query
 */
export async function searchAnalytics(
  property: string,
  options: {
    dimensions: string[];
    page?: string;
    queryContains?: string;
    days: number;
    rowLimit: number;
    /** Shift the window this many days further back, e.g. `days` for the period before. */
    offsetDays?: number;
  },
) {
  const end = new Date(Date.now() - (2 + (options.offsetDays ?? 0)) * 86_400_000);
  const start = new Date(end.getTime() - options.days * 86_400_000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const filters = [
    ...(options.page ? [{ dimension: "page", operator: "equals", expression: options.page }] : []),
    ...(options.queryContains ? [{ dimension: "query", operator: "contains", expression: options.queryContains }] : []),
  ];
  const request = {
    startDate: day(start),
    endDate: day(end),
    dimensions: options.dimensions,
    ...(filters.length ? { dimensionFilterGroups: [{ filters }] } : {}),
    rowLimit: options.rowLimit,
  };
  return { request, response: await call(`/sites/${encodeURIComponent(property)}/searchAnalytics/query`, request) };
}
