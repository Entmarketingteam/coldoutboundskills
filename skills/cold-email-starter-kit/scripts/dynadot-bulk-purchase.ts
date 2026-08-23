#!/usr/bin/env tsx
// Bulk-purchase a list of domains from Dynadot.
// Run: npx tsx scripts/dynadot-bulk-purchase.ts --list generated-domains.csv [--yes]
//
// Outputs: purchased-domains.csv (checkpointed after every registration —
// a rerun skips domains already marked "purchased" instead of re-buying).

import fs from "node:fs";
import { required, parseArgs, readCsv, writeCsv, sleep, confirm, fetchJson } from "./_lib.ts";

async function getWalletBalance(apiKey: string): Promise<number> {
  const j = await fetchJson<any>(`https://api.dynadot.com/api3.json?key=${apiKey}&command=account_info`);
  const raw = j?.AccountInfoResponse?.AccountInfo?.AccountBalance || "$0.00";
  return parseFloat(String(raw).replace(/[$,]/g, ""));
}

async function registerDomain(domain: string, apiKey: string): Promise<{ success: boolean; error?: string }> {
  try {
    const url = `https://api.dynadot.com/api3.json?key=${apiKey}&command=register&domain=${encodeURIComponent(domain)}&duration=1`;
    const r = await fetchJson<any>(url);
    const code = r?.RegisterResponse?.ResponseCode;
    if (code === 0) return { success: true };
    return { success: false, error: r?.RegisterResponse?.Error || "unknown" };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function main() {
  const { flags } = parseArgs();
  const listPath = (flags.list as string) || "generated-domains.csv";
  const skipConfirm = !!flags.yes;
  const outPath = "purchased-domains.csv";

  const apiKey = required("DYNADOT_API_KEY");

  if (!fs.existsSync(listPath)) {
    console.error(`Input file not found: ${listPath}. Run dynadot-generate-domains.ts first or pass --list <path>.`);
    process.exit(1);
  }

  const rows = readCsv(listPath);
  const available = rows.filter(r => r.available === "yes");
  if (available.length === 0) {
    console.error("No available domains in input CSV.");
    process.exit(1);
  }

  // Resume: skip domains already recorded as purchased in a previous (partial) run.
  const results: any[] = [];
  const alreadyPurchased = new Set<string>();
  if (fs.existsSync(outPath)) {
    for (const r of readCsv(outPath)) {
      if (r.status === "purchased") {
        alreadyPurchased.add(r.domain);
        results.push({ domain: r.domain, status: "purchased", price: r.price || "" });
      }
    }
    if (alreadyPurchased.size > 0) {
      console.log(`Resuming: ${alreadyPurchased.size} domain(s) already purchased per ${outPath}, skipping those.`);
    }
  }

  const toBuy = available.filter(r => !alreadyPurchased.has(r.domain));
  if (toBuy.length === 0) {
    console.log("All domains already purchased. Nothing to do.");
    console.log("Next step:");
    console.log("  npx tsx scripts/zapmail-full-setup.ts --domains purchased-domains.csv --platform smartlead");
    return;
  }

  const totalCost = toBuy.reduce((sum, r) => sum + parseFloat(r.price || "0"), 0);
  const balance = await getWalletBalance(apiKey);

  console.log(`Found ${toBuy.length} domains to purchase, total cost $${totalCost.toFixed(2)}.`);
  console.log(`Wallet balance: $${balance.toFixed(2)}`);
  console.log();

  if (balance < totalCost) {
    console.error(`Insufficient wallet balance. Need $${totalCost.toFixed(2)}, have $${balance.toFixed(2)}.`);
    console.error(`Top up at https://www.dynadot.com/account (add at least $${(totalCost - balance).toFixed(2)}).`);
    process.exit(1);
  }

  if (!skipConfirm) {
    const ok = await confirm(`About to spend $${totalCost.toFixed(2)} on ${toBuy.length} domains. Confirm? (y/N)`);
    if (!ok) { console.log("Cancelled."); process.exit(0); }
  }

  for (let i = 0; i < toBuy.length; i++) {
    const d = toBuy[i];
    process.stdout.write(`[${i + 1}/${toBuy.length}] ${d.domain} ... `);
    const result = await registerDomain(d.domain, apiKey);
    if (result.success) {
      console.log("✅");
      results.push({ domain: d.domain, status: "purchased", price: d.price });
    } else {
      console.log(`❌ ${result.error}`);
      results.push({ domain: d.domain, status: "failed", error: result.error });
    }
    // Checkpoint after every registration — real-money purchases must survive a crash.
    writeCsv(outPath, results);
    await sleep(500); // 0.5s pause between registrations
  }

  const purchased = results.filter(r => r.status === "purchased");
  const failed = results.filter(r => r.status === "failed");

  console.log();
  console.log(`✅ Purchased: ${purchased.length}`);
  console.log(`❌ Failed: ${failed.length}`);
  console.log();
  console.log(`Saved to ${outPath}`);
  console.log();
  console.log("Next step:");
  console.log("  npx tsx scripts/zapmail-full-setup.ts --domains purchased-domains.csv --platform smartlead");

  if (failed.length > 0) {
    console.error(`\n❌ ${failed.length} registration(s) failed:`);
    failed.forEach(r => console.error(`  ${r.domain}: ${r.error}`));
    console.error("Re-run the same command to retry failed domains (purchased ones are skipped).");
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
