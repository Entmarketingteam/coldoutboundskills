#!/usr/bin/env tsx
// Add leads to an existing Instantly campaign. Batches of 1000.
// Run: npx tsx scripts/instantly-add-leads.ts --campaign-id abc123 --leads leads.csv
// Resumable: successful batch indexes are checkpointed to
// .instantly-add-leads.progress.<campaignId>.json — a rerun skips them.

import fs from "node:fs";
import path from "node:path";
import { required, parseArgs, readCsv, writeCsv, fetchJson } from "./_lib.ts";

const API = "https://api.instantly.ai";

async function main() {
  const { flags } = parseArgs();
  const campaignId = flags["campaign-id"];
  const leadsFile = (flags.leads as string) || "leads.csv";
  // A bare `--campaign-id` (no value) parses as boolean true — reject anything non-string.
  if (typeof campaignId !== "string") { console.error("Usage: --campaign-id <id> --leads leads.csv"); process.exit(1); }

  const key = required("INSTANTLY_API_KEY");
  const leads = readCsv(leadsFile);
  console.log(`Adding ${leads.length} leads to Instantly campaign ${campaignId}...`);

  // Checkpoint: batch start-indexes already uploaded on a previous run.
  // Tied to the leads file identity (path + row count) so a rerun against a
  // different file (e.g. failed-leads.csv) never skips the wrong rows.
  const progressFile = `.instantly-add-leads.progress.${campaignId}.json`;
  const leadsFilePath = path.resolve(leadsFile);
  let done = new Set<number>();
  if (fs.existsSync(progressFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(progressFile, "utf8"));
      if (saved?.file === leadsFilePath && saved?.rows === leads.length && Array.isArray(saved?.batches)) {
        done = new Set<number>(saved.batches);
      } else {
        console.log(`Ignoring checkpoint ${progressFile}: it was written for a different leads file.`);
      }
    } catch { done = new Set(); }
    if (done.size > 0) console.log(`Resuming: ${done.size} batch(es) already uploaded (from ${progressFile}).`);
  }
  const saveProgress = () =>
    fs.writeFileSync(progressFile, JSON.stringify({ file: leadsFilePath, rows: leads.length, batches: [...done] }));

  let added = 0, failed = 0;
  const failedRows: any[] = [];

  for (let i = 0; i < leads.length; i += 1000) {
    if (done.has(i)) { added += Math.min(1000, leads.length - i); continue; }
    const batch = leads.slice(i, i + 1000).map(l => ({
      email: l.email,
      first_name: l.first_name,
      last_name: l.last_name,
      company_name: l.company_name,
      custom_variables: {
        company_domain: l.company_domain,
        role_title: l.role_title,
        ai_customer_type: l.ai_customer_type || "",
        ai_company_mission: l.ai_company_mission || "",
        recent_news_title: l.recent_news_title || "",
        company_phone: l.company_phone || "",
      },
    }));
    try {
      // fetchJson retries 429/5xx with backoff, fails fast on other 4xx (with body detail), and times out.
      await fetchJson(`${API}/api/v2/leads/bulk-create`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ campaign: campaignId, leads: batch }),
      });
      added += batch.length;
      done.add(i);
      saveProgress();
    } catch (e: any) {
      // Bad auth or bad campaign id will fail every batch — abort immediately.
      if (e?.status === 401 || e?.status === 404) {
        console.error(`\nAborting: ${e.message}`);
        console.error(e.status === 404 ? "Check --campaign-id — the campaign was not found." : "Check INSTANTLY_API_KEY.");
        process.exit(1);
      }
      failed += batch.length;
      failedRows.push(...leads.slice(i, i + 1000));
      console.error(`\n  batch ${i}-${Math.min(i + 1000, leads.length)} failed: ${e.message}`);
    }
    process.stdout.write(`  processed ${Math.min(i + 1000, leads.length)}/${leads.length}\r`);
  }
  console.log();

  if (failedRows.length > 0) writeCsv("failed-leads.csv", failedRows);

  console.log(`\n✅ Added: ${added}`);
  console.log(`❌ Failed: ${failed}`);
  if (failed > 0) {
    console.log("Failed rows saved to failed-leads.csv for retry.");
    process.exit(1);
  }
  // Full success — clear the checkpoint.
  if (fs.existsSync(progressFile)) fs.unlinkSync(progressFile);
}

main().catch(e => { console.error(e); process.exit(1); });
