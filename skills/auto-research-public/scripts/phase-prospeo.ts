#!/usr/bin/env tsx
/**
 * Phase 3: Prospeo search.
 *
 * Takes Prospeo filters JSON, runs paginated search, outputs leads JSON.
 *
 * Usage:
 *   export PROSPEO_API_KEY=xxx
 *   npx tsx scripts/phase-prospeo.ts --filters-file=/tmp/auto/filters.json --max-leads=1000 --out=/tmp/auto/leads.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { dirname } from "path";
import { createHash } from "crypto";

const API_KEY = process.env.PROSPEO_API_KEY;
if (!API_KEY) {
  console.error("Missing env: PROSPEO_API_KEY");
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const maxLeads = Number(get("--max-leads") ?? 1000);
  const maxPages = Number(get("--max-pages") ?? 40);
  if (!Number.isInteger(maxLeads) || maxLeads < 1 || !Number.isInteger(maxPages) || maxPages < 1) {
    console.error("--max-leads and --max-pages must be positive integers");
    process.exit(1);
  }
  return {
    filtersFile: get("--filters-file"),
    maxLeads,
    maxPages,
    out: get("--out") ?? "/tmp/auto/leads.json",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bounded retry with exponential backoff on 429/5xx/network errors
// (pattern from cold-email-starter-kit/scripts/_lib.ts retry()).
async function fetchWithRetry(url: string, init: RequestInit, label: string, attempts = 5): Promise<Response> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error(`${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
      } else {
        return resp;
      }
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) {
      const delay = Math.min(1000 * 2 ** i, 30000);
      console.error(`[Prospeo] ${label} attempt ${i + 1}/${attempts} failed (${lastErr?.message ?? lastErr}) — retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
  throw new Error(`[Prospeo] ${label} failed after ${attempts} attempts: ${lastErr?.message ?? lastErr}`);
}

interface Lead {
  first_name: string;
  last_name: string;
  email: string;
  linkedin_url: string;
  job_title: string;
  company_name: string;
  company_domain: string;
  company_industry: string;
  company_headcount: number;
  company_location: string;
  company_description: string;
}

async function main() {
  const { filtersFile, maxLeads, maxPages, out } = parseArgs();
  if (!filtersFile) {
    console.error("Usage: --filters-file=path [--max-leads=1000] [--max-pages=40] [--out=path]");
    process.exit(1);
  }
  let filters: any;
  let filtersHash = "";
  try {
    const raw = readFileSync(filtersFile, "utf8");
    filtersHash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    filters = JSON.parse(raw);
  } catch (e: any) {
    console.error(`Cannot read filters file ${filtersFile}: ${e?.message ?? e}`);
    process.exit(1);
  }

  // Resume from a partial checkpoint if a previous run crashed mid-pagination.
  // Provenance-tagged (script + filters hash) so a checkpoint left by phase-apollo.ts
  // (same --out default) or a run with different filters is never silently resumed.
  const CHECKPOINT_SOURCE = "phase-prospeo";
  const partialFile = `${out}.partial.json`;
  let all: Lead[] = [];
  let startPage = 1;
  if (existsSync(partialFile)) {
    try {
      const partial = JSON.parse(readFileSync(partialFile, "utf8"));
      if (partial.source !== CHECKPOINT_SOURCE || partial.filtersHash !== filtersHash) {
        console.error(
          `[Prospeo] Ignoring checkpoint ${partialFile} (source=${partial.source ?? "unknown"}, filters mismatch) — starting fresh`
        );
      } else {
        all = partial.leads ?? [];
        startPage = (partial.lastPage ?? 0) + 1;
        console.error(`[Prospeo] Resuming from ${partialFile}: ${all.length} leads, page ${startPage}`);
      }
    } catch {
      console.error(`[Prospeo] Ignoring unreadable checkpoint ${partialFile}`);
    }
  }
  const writePartial = (lastPage: number) => {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(partialFile, JSON.stringify({ source: CHECKPOINT_SOURCE, filtersHash, lastPage, leads: all }));
  };

  console.error(`[Prospeo] Searching up to ${maxPages} pages / ${maxLeads} leads...`);

  for (let page = startPage; page <= maxPages; page++) {
    const resp = await fetchWithRetry(
      "https://api.prospeo.io/search-person",
      {
        method: "POST",
        headers: { "X-KEY": API_KEY!, "Content-Type": "application/json" },
        body: JSON.stringify({ page, filters }),
      },
      `search page ${page}`
    );
    if (!resp.ok) {
      console.error(`[Prospeo] search ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
      writePartial(page - 1);
      process.exit(1);
    }
    let data: any;
    try {
      data = await resp.json();
    } catch {
      console.error("[Prospeo] search: response was not valid JSON");
      writePartial(page - 1);
      process.exit(1);
    }
    if (page === 1) {
      console.error(`[Prospeo] Total available: ${data.pagination?.total_count ?? "?"}`);
    }
    if (data.error || data.error_code) {
      console.error(`[Prospeo] API error ${data.error_code ?? ""}: ${data.filter_error || data.message || data.error || "unknown"}`);
      writePartial(page - 1);
      process.exit(1);
    }
    const results: Lead[] = (data.results ?? []).map((r: any) => ({
      first_name: r.person?.first_name || "",
      last_name: r.person?.last_name || "",
      email: (() => {
        const e = r.person?.email;
        if (typeof e === "string") return e;
        if (e?.email && e.revealed !== false && !e.email.includes("*")) return e.email;
        return "";
      })(),
      linkedin_url: r.person?.linkedin_url || "",
      job_title: r.person?.current_job_title || "",
      company_name: r.company?.name || "",
      company_domain: r.company?.domain || "",
      company_industry: r.company?.industry || "",
      company_headcount: r.company?.headcount || 0,
      company_location: r.company?.location?.state || r.company?.location?.country || "",
      company_description:
        r.company?.description || r.company?.description_ai || "",
    }));
    all.push(...results);
    if (page % 5 === 0) writePartial(page); // checkpoint so a crash/rerun resumes instead of re-spending credits
    if (page % 10 === 0) console.error(`[Prospeo] Page ${page}: ${all.length} total leads`);
    if (results.length < 25) break;
    if (all.length >= maxLeads) break;
    await new Promise((r) => setTimeout(r, 450));
  }

  const leads = all.slice(0, maxLeads);
  const withEmail = leads.filter((l) => l.email.includes("@")).length;
  const withDesc = leads.filter((l) => l.company_description.length > 50).length;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({ leads, stats: { total: leads.length, withEmail, withDesc } }, null, 2)
  );
  rmSync(partialFile, { force: true });
  console.error(`\nWrote ${out} — ${leads.length} leads (${withEmail} with email, ${withDesc} with desc)`);
  if (!leads.length) {
    console.error("[Prospeo] No leads found — failing so the pipeline halts");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
