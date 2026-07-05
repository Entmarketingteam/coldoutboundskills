#!/usr/bin/env tsx
/**
 * Phase 3 (Apollo): People search using APOLLO_API_KEY.
 * Drop-in replacement for phase-prospeo.ts — same output format.
 *
 * Uses Apollo /mixed_people/api_search with the same ICP filters
 * from filters.json. Falls back gracefully on rate limits.
 *
 * Usage:
 *   export APOLLO_API_KEY=xxx
 *   npx tsx scripts/phase-apollo.ts --filters-file=/tmp/auto/filters.json --max-leads=1000 --out=/tmp/auto/leads.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { dirname } from "path";
import { createHash } from "crypto";

const API_KEY = process.env.APOLLO_API_KEY;
if (!API_KEY) {
  console.error("Missing env: APOLLO_API_KEY");
  process.exit(1);
}

const APOLLO_BASE = "https://api.apollo.io/v1";

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
      console.error(`[Apollo] ${label} attempt ${i + 1}/${attempts} failed (${lastErr?.message ?? lastErr}) — retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
  throw new Error(`[Apollo] ${label} failed after ${attempts} attempts: ${lastErr?.message ?? lastErr}`);
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

// Post-filter: drop leads whose industry doesn't overlap with our target list
function industryMatches(industry: string, targetIndustries: string[]): boolean {
  if (!industry || !targetIndustries.length) return true; // no filter = keep all
  const ind = industry.toLowerCase();
  return targetIndustries.some((t) => ind.includes(t.toLowerCase()) || t.toLowerCase().includes(ind));
}

// Map Prospeo-style filters.json → Apollo search params
function buildApolloParams(filters: any, page: number) {
  // Apollo employee range format: "50,200" strings
  const empMin = filters.company_size_min ?? 50;
  const empMax = filters.company_size_max ?? 2000;

  // Apollo uses per_page max 100
  return {
    api_key: API_KEY,
    page,
    per_page: 100,
    person_titles: filters.job_titles ?? [],
    person_seniorities: (filters.seniorities ?? []).map((s: string) => s.toLowerCase()),
    organization_industry_tag_ids: [], // use q_organization_industry_fuzzy_match below
    q_organization_industry_fuzzy_match: filters.industries ?? [],
    organization_num_employees_ranges: [`${empMin},${empMax}`],
    person_locations: filters.countries?.includes("US") ? ["United States"] : filters.countries ?? [],
    contact_email_status: ["verified", "unverified", "likely to engage"],
  };
}

async function searchPage(params: any): Promise<{ people: any[]; total: number }> {
  const { api_key, ...body } = params;
  // 429/5xx retried inside fetchWithRetry; throws after retries are exhausted
  const resp = await fetchWithRetry(
    `${APOLLO_BASE}/mixed_people/api_search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": api_key as string,
      },
      body: JSON.stringify(body),
    },
    "search"
  );

  if (!resp.ok) {
    throw new Error(`[Apollo] search ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  }

  let data: any;
  try {
    data = await resp.json();
  } catch {
    throw new Error("[Apollo] search: response was not valid JSON");
  }
  return {
    people: data.people ?? [],
    total: data.pagination?.total_entries ?? 0,
  };
}

// Apollo search returns obfuscated stubs — bulk_match returns full person objects with all fields
let bulkMatchFailures = 0;
async function bulkMatchPeople(stubs: any[]): Promise<any[]> {
  if (!stubs.length) return [];

  const ids = stubs.map((p) => p.id).filter(Boolean);
  if (!ids.length) return [];

  const results: any[] = [];
  const CHUNK = 10; // Apollo bulk_match limit
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    try {
      const resp = await fetchWithRetry(
        `${APOLLO_BASE}/people/bulk_match`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "X-Api-Key": API_KEY as string,
          },
          body: JSON.stringify({
            details: chunk.map((id: string) => ({ id })),
            reveal_personal_emails: false,
          }),
        },
        "bulk_match"
      );
      if (resp.ok) {
        const data = await resp.json();
        results.push(...(data.matches ?? []));
      } else {
        bulkMatchFailures++;
        console.error(`[Apollo bulk_match] ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
      }
    } catch (e: any) {
      bulkMatchFailures++;
      console.error(`[Apollo bulk_match] Error: ${e?.message ?? e}`);
    }
    if (i + CHUNK < ids.length) await new Promise((r) => setTimeout(r, 300));
  }
  return results;
}

function mapPerson(p: any): Lead {
  const org = p.organization ?? {};
  return {
    first_name: p.first_name ?? "",
    last_name: p.last_name ?? "",
    email: p.email && !p.email.includes("*") ? p.email : "",
    linkedin_url: p.linkedin_url ?? "",
    job_title: p.title ?? p.headline ?? "",
    company_name: org.name ?? "",
    company_domain: org.primary_domain ?? org.website_url?.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] ?? "",
    company_industry: org.industry ?? "",
    company_headcount: org.estimated_num_employees ?? 0,
    company_location: [p.city, p.state].filter(Boolean).join(", ") || p.country || "",
    company_description: (org.keywords ?? []).slice(0, 10).join(", "),
  };
}

async function main() {
  const { filtersFile, maxLeads, maxPages, out } = parseArgs();
  if (!filtersFile) {
    console.error("Usage: --filters-file=path [--max-leads=1000] [--max-pages=40] [--out=path]");
    process.exit(1);
  }

  let filters: any;
  try {
    filters = JSON.parse(readFileSync(filtersFile, "utf8"));
  } catch (e: any) {
    console.error(`Cannot read filters file ${filtersFile}: ${e?.message ?? e}`);
    process.exit(1);
  }

  // Resume from a partial checkpoint if a previous run crashed mid-pagination
  const partialFile = `${out}.partial.json`;
  let all: Lead[] = [];
  let startPage = 1;
  if (existsSync(partialFile)) {
    try {
      const partial = JSON.parse(readFileSync(partialFile, "utf8"));
      all = partial.leads ?? [];
      startPage = (partial.lastPage ?? 0) + 1;
      console.error(`[Apollo] Resuming from ${partialFile}: ${all.length} leads, page ${startPage}`);
    } catch {
      console.error(`[Apollo] Ignoring unreadable checkpoint ${partialFile}`);
    }
  }
  const writePartial = (lastPage: number) => {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(partialFile, JSON.stringify({ lastPage, leads: all }));
  };

  console.error(`[Apollo] Searching up to ${maxPages} pages / ${maxLeads} leads...`);

  for (let page = startPage; page <= maxPages; page++) {
    const params = buildApolloParams(filters, page);
    const { people, total } = await searchPage(params);

    if (page === 1) console.error(`[Apollo] Total available: ${total}`);
    if (!people.length) break;

    // bulk_match returns full person objects (email + all company fields)
    const fullPeople = await bulkMatchPeople(people);
    const mapped = fullPeople
      .map(mapPerson)
      .filter((l) => l.first_name || l.last_name)
      .filter((l) => industryMatches(l.company_industry, filters.industries ?? []));
    all.push(...mapped);

    writePartial(page); // checkpoint so a crash/rerun resumes instead of re-spending credits
    if (page % 5 === 0) console.error(`[Apollo] Page ${page}: ${all.length} leads so far`);
    if (all.length >= maxLeads) break;

    await new Promise((r) => setTimeout(r, 500)); // be polite
  }

  const leads = all.slice(0, maxLeads);
  const withEmail = leads.filter((l) => l.email.includes("@")).length;
  const withDesc = leads.filter((l) => l.company_description.length > 50).length;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      { leads, stats: { total: leads.length, withEmail, withDesc, bulk_match_failures: bulkMatchFailures } },
      null,
      2
    )
  );
  rmSync(partialFile, { force: true });
  if (bulkMatchFailures) console.error(`[Apollo] ${bulkMatchFailures} bulk_match chunk(s) failed`);
  console.error(`\nWrote ${out} — ${leads.length} leads (${withEmail} with email, ${withDesc} with desc)`);
  if (!leads.length) {
    console.error("[Apollo] No leads found — failing so the pipeline halts");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
