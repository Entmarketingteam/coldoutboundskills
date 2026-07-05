#!/usr/bin/env tsx
/**
 * DiscoLike lookalike discovery.
 *
 * Usage:
 *   export DISCOLIKE_API_KEY=xxx
 *   npx tsx scripts/discover.ts --domains="clay.com,apollo.io" --country=US --limit=500 --out=lookalikes.csv
 *   npx tsx scripts/discover.ts --text="B2B cold email outreach" --out=lookalikes.csv
 *   npx tsx scripts/discover.ts --domains="..." --negation-domains="..." --max-companies=1000 --out=...
 *
 * Pass --yes to skip the spend confirmation (required for large non-interactive pulls).
 * A checkpoint file (<out>.checkpoint.json) lets an interrupted run resume where it left off.
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import readline from "node:readline";

const DISCOLIKE_BASE = "https://api.discolike.com/v1";
const API_KEY = process.env.DISCOLIKE_API_KEY;
if (!API_KEY) {
  console.error("Missing env: DISCOLIKE_API_KEY");
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  return {
    domains: get("--domains"),
    text: get("--text"),
    negationDomains: get("--negation-domains"),
    country: get("--country"),
    limit: Number(get("--limit") ?? 100),
    maxCompanies: Number(get("--max-companies") ?? 500),
    out: get("--out") ?? "lookalikes.csv",
    yes: args.includes("--yes") || args.includes("--force"),
  };
}

interface DiscoLikeCompany {
  domain: string;
  name?: string;
  description?: string;
  industry_groups?: Record<string, number>;
  employees?: string;
  address?: { country?: string; state?: string; city?: string };
  social_urls?: string[];
}

async function fetchJson(url: string): Promise<any> {
  const path = url.replace(/\?.*$/, "");
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { "x-discolike-key": API_KEY! },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      lastErr = `network error: ${String(err).slice(0, 200)}`;
      continue;
    }
    if (resp.status === 429 || resp.status >= 500) {
      lastErr = `HTTP ${resp.status}`;
      continue;
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`${path}: ${resp.status}: ${t.slice(0, 200)}`);
    }
    try {
      return await resp.json();
    } catch (err) {
      lastErr = `invalid JSON body: ${String(err).slice(0, 200)}`;
      continue;
    }
  }
  throw new Error(`${path}: exhausted retries (${lastErr})`);
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

function buildParams(args: ReturnType<typeof parseArgs>, offset: number): string {
  const p = new URLSearchParams();
  if (args.domains) p.set("domains", args.domains);
  if (args.text) p.set("text", args.text);
  if (args.negationDomains) p.set("negation_domains", args.negationDomains);
  if (args.country) p.set("country", args.country);
  p.set("limit", String(args.limit));
  if (offset) p.set("offset", String(offset));
  return p.toString();
}

function topIndustry(groups: Record<string, number> | undefined): string {
  if (!groups) return "";
  const entries = Object.entries(groups);
  if (!entries.length) return "";
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

function parseEmployeeMidpoint(e: string | undefined): number | "" {
  if (!e) return "";
  const m: Record<string, number> = {
    "1-10": 5,
    "11-50": 30,
    "51-200": 125,
    "201-500": 350,
    "501-1000": 750,
    "1001-5000": 3000,
    "5001-10000": 7500,
    "10001+": 15000,
  };
  return m[e] ?? "";
}

// Threshold above which a non-interactive run must pass --yes (records are billed).
const NON_INTERACTIVE_RECORD_CAP = 1000;

async function main() {
  const args = parseArgs();
  if (!args.domains && !args.text) {
    console.error("Usage: --domains=a,b OR --text='...'  (at least one required)");
    process.exit(1);
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    console.error(`Invalid --limit: must be a positive number (e.g. --limit=100)`);
    process.exit(1);
  }
  if (!Number.isFinite(args.maxCompanies) || args.maxCompanies <= 0) {
    console.error(`Invalid --max-companies: must be a positive number (e.g. --max-companies=500)`);
    process.exit(1);
  }

  // Resume from checkpoint if a previous run was interrupted
  const checkpointPath = `${args.out}.checkpoint.json`;
  let rows: any[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let apiCalls = 0;
  if (existsSync(checkpointPath)) {
    try {
      const cp = JSON.parse(readFileSync(checkpointPath, "utf8"));
      rows = Array.isArray(cp.rows) ? cp.rows : [];
      offset = Number(cp.offset) || 0;
      apiCalls = Number(cp.apiCalls) || 0;
      for (const r of rows) if (r.domain) seen.add(r.domain);
      console.error(`[DiscoLike] Resuming from checkpoint: ${rows.length} rows already fetched, offset=${offset}`);
    } catch (err) {
      console.error(`[DiscoLike] Ignoring unreadable checkpoint ${checkpointPath}: ${String(err).slice(0, 100)}`);
      rows = [];
      offset = 0;
      apiCalls = 0;
    }
  }

  // Count first
  let universe: number | null = null;
  try {
    const countUrl = `${DISCOLIKE_BASE}/count?${buildParams(args, 0)}`;
    const { count } = await fetchJson(countUrl);
    universe = Number(count);
    console.error(`[DiscoLike] Universe size: ${universe.toLocaleString()}`);
  } catch (err) {
    console.error(`[DiscoLike] Count check failed, proceeding anyway: ${String(err).slice(0, 100)}`);
  }

  // Estimate cost BEFORE spending; confirm unless --yes
  const planned = Math.max(0, (universe !== null ? Math.min(universe, args.maxCompanies) : args.maxCompanies) - rows.length);
  const plannedCalls = Math.ceil(planned / args.limit);
  const plannedCost = plannedCalls * 0.1 + (planned / 1000) * 2.0;
  console.error(`[DiscoLike] Planned pull: up to ${planned.toLocaleString()} records in ~${plannedCalls} API calls (est. ~$${plannedCost.toFixed(2)})`);
  if (!args.yes && planned > 0) {
    if (process.stdin.isTTY) {
      const ok = await confirm(`Proceed? (y/N)`);
      if (!ok) {
        console.error("Cancelled.");
        process.exit(0);
      }
    } else if (planned > NON_INTERACTIVE_RECORD_CAP) {
      console.error(
        `Non-interactive run without --yes and planned pull exceeds ${NON_INTERACTIVE_RECORD_CAP.toLocaleString()} records. Re-run with --yes to confirm spend.`
      );
      process.exit(1);
    }
  }

  let partial = false;
  while (rows.length < args.maxCompanies && offset < 10000) {
    const url = `${DISCOLIKE_BASE}/discover?${buildParams(args, offset)}`;
    let batch: DiscoLikeCompany[];
    try {
      const payload = await fetchJson(url);
      if (!Array.isArray(payload)) {
        throw new Error(`unexpected response shape (expected array): ${JSON.stringify(payload).slice(0, 200)}`);
      }
      batch = payload;
    } catch (err) {
      console.error(`[DiscoLike] Fetch failed at offset=${offset}: ${String(err).slice(0, 300)}`);
      partial = true;
      break;
    }
    apiCalls++;
    if (!batch.length) break;

    for (const c of batch) {
      const d = c.domain?.toLowerCase();
      if (!d || seen.has(d)) continue;
      seen.add(d);
      const linkedin = (c.social_urls ?? []).find((u) => u.includes("linkedin.com/company")) ?? "";
      rows.push({
        domain: d,
        company_name: c.name || "",
        industry: topIndustry(c.industry_groups),
        headcount_range: c.employees || "",
        headcount: parseEmployeeMidpoint(c.employees),
        location_country: c.address?.country || "",
        location_state: c.address?.state || "",
        location_city: c.address?.city || "",
        linkedin_url: linkedin,
        description: (c.description || "").slice(0, 500),
        source: "discolike",
      });
      if (rows.length >= args.maxCompanies) break;
    }

    console.error(`[DiscoLike] offset=${offset} returned=${batch.length} new_total=${rows.length}`);
    const exhausted = batch.length < args.limit;
    offset += args.limit;
    writeFileSync(checkpointPath, JSON.stringify({ offset, apiCalls, rows }));
    if (exhausted) break;
  }

  const estCost = apiCalls * 0.1 + (rows.length / 1000) * 2.0;
  console.error(`\n[DiscoLike] Done: ${rows.length} new companies, ${apiCalls} API calls (est. ~$${estCost.toFixed(2)})`);

  // Write CSV (always — even a partial run's rows are paid for)
  const headers = [
    "domain",
    "company_name",
    "industry",
    "headcount_range",
    "headcount",
    "location_country",
    "location_state",
    "location_city",
    "linkedin_url",
    "description",
    "source",
  ];
  const csv = [headers.join(",")];
  for (const r of rows) {
    csv.push(headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(","));
  }
  writeFileSync(args.out, csv.join("\n"));
  console.error(`Wrote ${args.out}`);

  if (partial) {
    console.error(`[DiscoLike] Run INCOMPLETE — list is partial. Checkpoint kept at ${checkpointPath}; re-run the same command to resume.`);
    process.exit(1);
  }
  if (existsSync(checkpointPath)) unlinkSync(checkpointPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
