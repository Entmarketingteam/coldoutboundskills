#!/usr/bin/env tsx
// Full paginated Prospeo search → CSV.
// Run: npx tsx scripts/prospeo-full-export.ts --title "VP Sales" --location "United States" --headcount-min 50 --headcount-max 200 --limit 2000 [--yes]
//
// Handles state-by-state splitting when total > 25K results.
// Progress is checkpointed to <output>.progress.json so a rerun resumes
// instead of restarting (and re-spending credits).
// Output: leads.csv

import fs from "node:fs";
import { required, parseArgs, readCsv, writeCsv, sleep, multiFlag, confirm, fetchJson, numFlag } from "./_lib.ts";

const US_STATES = [
  "California", "Texas", "Florida", "New York", "Illinois", "Pennsylvania",
  "Ohio", "Georgia", "North Carolina", "Michigan", "New Jersey", "Virginia",
  "Washington", "Arizona", "Massachusetts", "Tennessee", "Indiana", "Missouri",
  "Maryland", "Wisconsin", "Colorado", "Minnesota", "South Carolina", "Alabama",
  "Louisiana", "Kentucky", "Oregon", "Oklahoma", "Connecticut", "Utah",
];

async function searchPage(filters: any, page: number, apiKey: string): Promise<any> {
  // fetchJson: 30s timeout, retries 429/5xx/network with backoff, fails fast on other 4xx.
  return fetchJson("https://api.prospeo.io/search-person", {
    method: "POST",
    headers: { "X-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ page, filters }),
  });
}

function mapResult(r: any): Record<string, string> {
  const p = r.person || {};
  const c = r.company || {};
  const loc = p.location || {};
  return {
    email: p.email || "",
    first_name: p.first_name || "",
    last_name: p.last_name || "",
    full_name: p.full_name || "",
    role_title: p.current_job_title || "",
    linkedin_url: p.linkedin_url || "",
    city: loc.city || "",
    state: loc.state || "",
    country: loc.country || "",
    company_name: c.name || "",
    company_domain: c.domain || "",
    company_industry: c.industry || "",
    company_headcount: (c.headcount || "").toString(),
    company_linkedin: c.linkedin_url || "",
  };
}

async function main() {
  const { flags } = parseArgs();
  const titles = multiFlag(flags, "title");
  const location = (flags.location as string) || "United States";
  const headcountMin = numFlag(flags, "headcount-min");
  const headcountMax = numFlag(flags, "headcount-max");
  const industries = multiFlag(flags, "industry");
  const techs = multiFlag(flags, "tech");
  const limit = numFlag(flags, "limit", 2000)!;
  const output = (flags.output as string) || "leads.csv";
  const verifiedOnly = flags["verified-only"] !== "false";
  const skipConfirm = !!flags.yes;

  if (titles.length === 0) {
    console.error("Usage: --title 'VP Sales' --title 'Head of Sales' [--location 'United States'] [--headcount-min 50] [--headcount-max 200] [--industry 'Software Development'] [--limit 2000] [--output leads.csv] [--yes]");
    process.exit(1);
  }

  const apiKey = required("PROSPEO_API_KEY");

  const baseFilters: any = {
    person_location_search: { include: [location === "United States" ? "United States #US" : location] },
    person_job_title: { include: titles, match_only_exact_job_titles: false },
  };
  if (headcountMin !== undefined || headcountMax !== undefined) {
    baseFilters.company_headcount_custom = {};
    if (headcountMin !== undefined) baseFilters.company_headcount_custom.min = headcountMin;
    if (headcountMax !== undefined) baseFilters.company_headcount_custom.max = headcountMax;
  }
  if (industries.length > 0) baseFilters.company_industry = { include: industries };
  if (techs.length > 0) baseFilters.company_technology = { include: techs };
  if (verifiedOnly) baseFilters.person_contact_details = { email: ["VERIFIED"] };

  // Checkpoint: resume a previous run with identical filters instead of re-spending credits.
  const checkpointPath = `${output}.progress.json`;
  const filtersKey = JSON.stringify({ baseFilters, limit });
  let progress: { filtersKey: string; lastPage: number; doneStates: string[] } | null = null;
  if (fs.existsSync(checkpointPath)) {
    try {
      const p = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
      if (p.filtersKey === filtersKey) {
        progress = p;
        console.log(`Resuming from checkpoint ${checkpointPath}.`);
      } else {
        console.log("Checkpoint found but filters differ — starting fresh.");
      }
    } catch { /* corrupt checkpoint — start fresh */ }
  }

  const all: Record<string, string>[] = [];
  if (progress && fs.existsSync(output)) {
    for (const r of readCsv(output)) all.push(r);
    console.log(`Loaded ${all.length} previously collected leads from ${output}.`);
  }
  const doneStates = new Set<string>(progress?.doneStates || []);
  let lastPage = progress?.lastPage || 0;
  const failures: { where: string; error: string }[] = [];

  const saveProgress = () => {
    writeCsv(output, all);
    fs.writeFileSync(checkpointPath, JSON.stringify({ filtersKey, lastPage, doneStates: Array.from(doneStates) }));
  };

  // First page to get total count
  console.log("Checking total result count...");
  const first = await searchPage(baseFilters, 1, apiKey);
  const totalCount = first?.pagination?.total_count || 0;
  const totalPages = first?.pagination?.total_page || 0;

  if (totalCount === 0) {
    console.error("Prospeo returned 0 results. Try removing filters.");
    process.exit(1);
  }

  const willFetch = Math.min(limit, totalCount);
  const estCredits = willFetch; // 1 credit per result

  console.log(`Found ${totalCount} total matches.`);
  console.log(`Will fetch up to ${willFetch} results (~${estCredits} credits).`);
  if (!skipConfirm) {
    const ok = await confirm(`Confirm? (y/N)`);
    if (!ok) { console.log("Cancelled."); process.exit(0); }
  }

  if (totalCount >= 25000 && location === "United States") {
    // State-by-state fallback
    console.log(`Total > 25K, splitting by US state...`);
    // Don't discard the nationwide first page — those credits are already spent.
    if (!progress) (first?.results || []).forEach((r: any) => all.push(mapResult(r)));
    for (const state of US_STATES) {
      if (all.length >= limit) break;
      if (doneStates.has(state)) continue;
      let stateFailed = false;
      try {
        const stateFilters = JSON.parse(JSON.stringify(baseFilters));
        stateFilters.person_location_search.include = [`${state}, United States #US`];
        const sFirst = await searchPage(stateFilters, 1, apiKey);
        const sTotal = sFirst?.pagination?.total_count || 0;
        const sPages = Math.min(sFirst?.pagination?.total_page || 0, Math.ceil((limit - all.length) / 25));
        for (let p = 1; p <= sPages; p++) {
          if (all.length >= limit) break;
          try {
            const data = p === 1 ? sFirst : await searchPage(stateFilters, p, apiKey);
            (data?.results || []).forEach((r: any) => all.push(mapResult(r)));
          } catch (e: any) {
            failures.push({ where: `${state} page ${p}`, error: e.message });
            stateFailed = true;
          }
          await sleep(500);
        }
        console.log(`  ${state}: ${sTotal} available, collected ${all.length} total so far`);
      } catch (e: any) {
        failures.push({ where: `${state} (first page)`, error: e.message });
        console.error(`  ${state}: failed (${e.message}), will retry on resume.`);
        stateFailed = true;
      }
      // Only mark the state done if every page succeeded — a resume retries failed states.
      if (!stateFailed) doneStates.add(state);
      saveProgress();
    }
  } else {
    // Simple pagination (resumes at lastPage + 1 when checkpointed)
    const startPage = Math.max(1, lastPage + 1);
    for (let p = startPage; p <= totalPages; p++) {
      if (all.length >= limit) break;
      try {
        const data = p === 1 ? first : await searchPage(baseFilters, p, apiKey);
        (data?.results || []).forEach((r: any) => all.push(mapResult(r)));
      } catch (e: any) {
        failures.push({ where: `page ${p}`, error: e.message });
      }
      lastPage = p;
      process.stdout.write(`Page ${p}/${totalPages}, collected ${all.length}...\r`);
      if (p % 10 === 0) saveProgress();
      await sleep(500);
    }
    console.log();
  }

  const trimmed = all.slice(0, limit);

  // Dedupe by email
  const seen = new Set<string>();
  const deduped = trimmed.filter(r => {
    if (!r.email || seen.has(r.email)) return false;
    seen.add(r.email);
    return true;
  });

  writeCsv(output, deduped);
  console.log(`\n✅ Saved ${deduped.length} leads to ${output}`);

  if (failures.length > 0) {
    fs.writeFileSync(checkpointPath, JSON.stringify({ filtersKey, lastPage, doneStates: Array.from(doneStates) }));
    console.error(`\n⚠️  ${failures.length} request(s) failed:`);
    failures.forEach(f => console.error(`  ${f.where}: ${f.error}`));
    console.error(`Checkpoint kept at ${checkpointPath} — re-run the same command to resume.`);
    process.exit(1);
  }
  if (fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath);
}

main().catch(e => { console.error(e); process.exit(1); });
