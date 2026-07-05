/**
 * Shared utilities for smartlead-inbox-manager scripts.
 */

import { readFileSync, existsSync } from "fs";

export const API_BASE = "https://server.smartlead.ai/api/v1";
export const API_KEY = process.env.SMARTLEAD_API_KEY;

if (!API_KEY) {
  console.error("Missing env var: SMARTLEAD_API_KEY");
  process.exit(1);
}

export function parseFlag(
  args: string[],
  flag: string,
  defaultValue?: string
): string | undefined {
  const arg = args.find((a) => a.startsWith(`${flag}=`));
  return arg ? arg.split("=").slice(1).join("=") : defaultValue;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export interface InboxAccount {
  id: number;
  from_email?: string;
  from_name?: string;
  email?: string;
  domain?: string;
  signature?: string | null;
  message_per_day?: number;
  tags?: { id: number; name: string; color?: string }[];
  warmup_details?: {
    status?: string;
    warmup_reputation?: string;
    max_email_per_day?: number;
    is_warmup_blocked?: boolean;
    total_sent_count?: number;
  };
  daily_sent_count?: number;
  is_smtp_success?: boolean;
  is_imap_success?: boolean;
  [key: string]: any;
}

/** Strip the API key from any string destined for logs/errors. */
function redact(s: string): string {
  return API_KEY ? s.split(API_KEY).join("***") : s;
}

export async function fetchJson(url: string, options?: RequestInit): Promise<any> {
  const maxAttempts = 5;
  let lastDetail = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      // Network error / timeout — retry like a transient 5xx.
      lastDetail = `network error: ${redact(String(err)).slice(0, 200)}`;
      if (attempt < maxAttempts - 1) {
        const wait = 1000 * 2 ** attempt;
        console.error(`  [network] retry ${attempt + 1}/${maxAttempts} in ${wait}ms (${lastDetail})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      break;
    }
    if (resp.status === 429 || resp.status >= 500) {
      const body = await resp.text().catch(() => "");
      lastDetail = `HTTP ${resp.status}: ${redact(body).slice(0, 200)}`;
      const wait = 1000 * 2 ** attempt;
      console.error(`  [${resp.status}] retry ${attempt + 1}/${maxAttempts} in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${redact(text).slice(0, 200)}`);
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid JSON from Smartlead (HTTP ${resp.status}): ${redact(text).slice(0, 200)}`
      );
    }
  }
  throw new Error(`Exhausted retries (last: ${lastDetail || "no response detail"})`);
}

export async function listAllInboxes(): Promise<InboxAccount[]> {
  const all: InboxAccount[] = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const url = `${API_BASE}/email-accounts?api_key=${API_KEY}&offset=${offset}&limit=${limit}`;
    const batch: InboxAccount[] = await fetchJson(url);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

/**
 * Given selector args, return the filtered list of inboxes.
 *
 * Supported flags:
 *   --all
 *   --ids=1,2,3
 *   --domain=example.com
 *   --tag=active
 *   --ids-from-csv=path (expects header `id` column)
 */
export async function selectInboxes(args: string[]): Promise<InboxAccount[]> {
  const all = await listAllInboxes();

  if (hasFlag(args, "--all")) return all;

  const ids = parseFlag(args, "--ids");
  if (ids) {
    const idSet = parseIds(ids.split(","), "--ids");
    return all.filter((a) => idSet.has(a.id));
  }

  const domain = parseFlag(args, "--domain");
  if (domain) {
    return all.filter((a) => (a.from_email || a.email || "").endsWith(`@${domain}`));
  }

  const tag = parseFlag(args, "--tag");
  if (tag) {
    return all.filter((a) => (a.tags ?? []).some((t) => t.name === tag));
  }

  const csv = parseFlag(args, "--ids-from-csv");
  if (csv) {
    if (!existsSync(csv)) {
      console.error(`CSV not found: ${csv}`);
      process.exit(1);
    }
    // Strip surrounding double quotes so CSVs written by list-health --out round-trip.
    const unq = (s: string) => s.trim().replace(/^"|"$/g, "");
    const text = readFileSync(csv, "utf8");
    const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0].split(",").map(unq);
    const idCol = header.indexOf("id");
    if (idCol < 0) {
      console.error(`CSV ${csv} missing 'id' column`);
      process.exit(1);
    }
    const csvIds = parseIds(
      lines.slice(1).map((l) => unq(l.split(",")[idCol] ?? "")),
      `CSV ${csv}`
    );
    return all.filter((a) => csvIds.has(a.id));
  }

  console.error(
    "No selector provided. Use --all, --ids=..., --domain=..., --tag=..., or --ids-from-csv=path"
  );
  process.exit(1);
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const queue = items.map((item, idx) => ({ item, idx }));
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length) {
      const { item, idx } = queue.shift()!;
      try {
        results[idx] = await worker(item, idx);
      } catch (err) {
        results[idx] = { error: String(err) } as any;
      }
    }
  });
  await Promise.all(runners);
  return results;
}
