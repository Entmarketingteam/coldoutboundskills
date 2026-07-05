#!/usr/bin/env tsx
// Add leads to an existing Smartlead campaign, in batches of 100.
// Run: npx tsx scripts/smartlead-add-leads.ts --campaign-id 12345 --leads leads.csv
// Resumable: successful batch indexes are checkpointed to
// .smartlead-add-leads.progress.<campaignId>.json — a rerun skips them.

import fs from "node:fs";
import path from "node:path";
import { required, parseArgs, readCsv, writeCsv, retry, redactSecrets } from "./_lib.ts";

const API = "https://server.smartlead.ai/api/v1";
const HOST = "server.smartlead.ai";

// Like fetchJson, but returns the Response after a 2xx so the success-path JSON
// parse can fail without mis-counting an already-uploaded batch as failed.
// (URL carries api_key as a query param — error messages never include it.)
async function postWithRetry(url: string, body: any): Promise<Response> {
  return retry(async () => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (e: any) {
      throw new Error(`Network error calling ${HOST}: ${redactSecrets(String(e?.message || e))}`);
    }
    if (!res.ok) {
      const text = await res.text();
      const err: any = new Error(`HTTP ${res.status} from ${HOST}: ${redactSecrets(text.slice(0, 300))}`);
      err.status = res.status;
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    }
    return res;
  });
}

async function main() {
  const { flags } = parseArgs();
  const campaignId = flags["campaign-id"] as string;
  const leadsFile = (flags.leads as string) || "leads.csv";
  if (!campaignId || campaignId === "true") { console.error("Usage: --campaign-id <id> --leads leads.csv"); process.exit(1); }

  const key = required("SMARTLEAD_API_KEY");
  const leads = readCsv(leadsFile);
  console.log(`Adding ${leads.length} leads to campaign ${campaignId}...`);

  // Checkpoint: batch start-indexes already uploaded on a previous run.
  const progressFile = `.smartlead-add-leads.progress.${campaignId}.json`;
  let done = new Set<number>();
  if (fs.existsSync(progressFile)) {
    try { done = new Set(JSON.parse(fs.readFileSync(progressFile, "utf8"))); } catch { done = new Set(); }
    if (done.size > 0) console.log(`Resuming: ${done.size} batch(es) already uploaded (from ${progressFile}).`);
  }

  let added = 0, duplicates = 0, failed = 0;
  const failedRows: any[] = [];

  for (let i = 0; i < leads.length; i += 100) {
    if (done.has(i)) { added += Math.min(100, leads.length - i); continue; }
    const batch = leads.slice(i, i + 100).map(l => ({
      email: l.email,
      first_name: l.first_name,
      last_name: l.last_name,
      company_name: l.company_name,
      custom_fields: {
        company_domain: l.company_domain,
        role_title: l.role_title,
        ai_customer_type: l.ai_customer_type,
        ai_company_mission: l.ai_company_mission,
        recent_news_title: l.recent_news_title,
        company_phone: l.company_phone,
      },
    }));
    try {
      const res = await postWithRetry(`${API}/campaigns/${campaignId}/leads?api_key=${key}`, { lead_list: batch });
      // 2xx: the batch is uploaded even if the response body is not valid JSON.
      try {
        const j: any = await res.json();
        added += j?.upload_count || batch.length;
        duplicates += j?.duplicate_count || 0;
      } catch {
        added += batch.length;
      }
      done.add(i);
      fs.writeFileSync(progressFile, JSON.stringify([...done]));
    } catch (e: any) {
      failed += batch.length;
      failedRows.push(...leads.slice(i, i + 100).map(l => ({ ...l, failure_reason: e.message })));
      console.error(`\n  batch ${i}-${Math.min(i + 100, leads.length)} failed: ${e.message}`);
    }
    process.stdout.write(`  processed ${Math.min(i + 100, leads.length)}/${leads.length}\r`);
  }
  console.log();

  if (failedRows.length > 0) writeCsv("failed-leads.csv", failedRows);

  console.log(`\n✅ Added: ${added}`);
  console.log(`⚠️  Duplicates: ${duplicates}`);
  console.log(`❌ Failed: ${failed}`);
  if (failed > 0) {
    console.log("Failed rows saved to failed-leads.csv for retry.");
    process.exit(1);
  }
  // Full success — clear the checkpoint.
  if (fs.existsSync(progressFile)) fs.unlinkSync(progressFile);
}

main().catch(e => { console.error(e); process.exit(1); });
