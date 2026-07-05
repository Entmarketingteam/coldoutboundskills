#!/usr/bin/env tsx
// Enrich leads with company phone via Blitz API.
// Run: npx tsx scripts/enrichments/company-phone.ts --input leads.csv --output leads-with-phone.csv
// Resumable: rows that already have company_phone are skipped, so re-running
// with --input leads-with-phone.csv resumes instead of re-billing every row.

import { env, required, parseArgs, readCsv, writeCsv, createQueue, fetchJson } from "../_lib.ts";

async function main() {
  const { flags } = parseArgs();
  const input = (flags.input as string) || "leads.csv";
  const output = (flags.output as string) || "leads-with-phone.csv";

  const blitzKey = required("BLITZ_API_KEY");
  const blitzBase = env.BLITZ_BASE_URL || "https://api.blitz.us";

  const leads = readCsv(input);
  console.log(`Enriching ${leads.length} leads with company phones via Blitz...`);

  const queue = createQueue(10);
  const errors: any[] = [];
  let enriched = 0;
  let skipped = 0;

  const enriched_rows = await Promise.all(leads.map(lead => queue.add(async () => {
    if (!lead.company_domain) return { ...lead, company_phone: lead.company_phone || "" };
    // Resume: skip rows already enriched on a previous run.
    if (lead.company_phone) { skipped++; return { ...lead }; }
    try {
      // fetchJson retries 429/5xx with backoff, fails fast on other 4xx (with body detail), and times out.
      const j: any = await fetchJson(`${blitzBase}/api/enrichment/company`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${blitzKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ domain: lead.company_domain }),
      });
      const phone = j?.company?.phone || "";
      if (phone) enriched++;
      return { ...lead, company_phone: phone };
    } catch (e: any) {
      errors.push({ email: lead.email, domain: lead.company_domain, error: e.message });
      return { ...lead, company_phone: "" };
    }
  })));

  writeCsv(output, enriched_rows);
  if (errors.length > 0) writeCsv("company-phone-errors.csv", errors);

  if (skipped > 0) console.log(`Skipped ${skipped} rows already enriched (resume).`);
  console.log(`\n✅ Enriched ${enriched}/${leads.length} with phones (${errors.length} errors)`);
  console.log(`Saved to ${output}`);
  if (errors.length > 0) {
    console.error(`${errors.length} rows failed — see company-phone-errors.csv. Re-run with --input ${output} to retry only failed rows.`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
