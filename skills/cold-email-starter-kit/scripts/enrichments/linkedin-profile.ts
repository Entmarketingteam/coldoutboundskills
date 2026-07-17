#!/usr/bin/env tsx
// Enrich leads with LinkedIn profile data via RapidAPI LinkedIn Bulk Scraper.
// WARNING: LinkedIn ToS restricts scraping. Use at your own legal risk.
// Run: npx tsx scripts/enrichments/linkedin-profile.ts --input leads.csv --output leads-li.csv
// Resumable: rows that already have linkedin_headline are skipped, so re-running
// with --input leads-li.csv resumes instead of re-billing every row.

import { required, parseArgs, readCsv, writeCsv, createQueue, fetchJson } from "../_lib.ts";

async function main() {
  const { flags } = parseArgs();
  const input = (flags.input as string) || "leads.csv";
  const output = (flags.output as string) || "leads-li.csv";

  const key = required("RAPIDAPI_KEY");

  const leads = readCsv(input);
  console.log(`Enriching ${leads.length} leads with LinkedIn profile data...`);
  console.log("⚠️  Legal note: LinkedIn ToS restricts scraping. You are responsible for compliance.");

  const queue = createQueue(5);
  const errors: any[] = [];
  let enriched = 0;
  let skipped = 0;

  const enriched_rows = await Promise.all(leads.map(lead => queue.add(async () => {
    if (!lead.linkedin_url) return { ...lead };
    // Resume: skip rows already enriched on a previous run.
    if (lead.linkedin_headline) { skipped++; return { ...lead }; }
    try {
      // fetchJson retries 429/5xx with backoff, fails fast on other 4xx (with body detail), and times out.
      const j: any = await fetchJson("https://linkedin-bulk-data-scraper.p.rapidapi.com/person", {
        method: "POST",
        headers: {
          "X-RapidAPI-Key": key,
          "X-RapidAPI-Host": "linkedin-bulk-data-scraper.p.rapidapi.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ link: lead.linkedin_url }),
      });
      const p = j?.data || j;
      // Only count/emit rows where the response actually contains profile data.
      if (p && (p.headline || p.about || p.currentTenureYears)) {
        enriched++;
        return {
          ...lead,
          linkedin_headline: p.headline || "",
          linkedin_about: (p.about || "").slice(0, 500),
          linkedin_tenure_years: p.currentTenureYears || "",
        };
      }
      return { ...lead };
    } catch (e: any) {
      errors.push({ email: lead.email, error: e.message });
      return { ...lead };
    }
  })));

  writeCsv(output, enriched_rows);
  if (errors.length > 0) writeCsv("linkedin-profile-errors.csv", errors);

  if (skipped > 0) console.log(`Skipped ${skipped} rows already enriched (resume).`);
  console.log(`\n✅ Enriched ${enriched}/${leads.length} with LinkedIn data (${errors.length} errors)`);
  console.log(`Saved to ${output}`);
  if (errors.length > 0) {
    console.error(`${errors.length} rows failed — see linkedin-profile-errors.csv. Re-run with --input ${output} to retry only failed rows.`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
