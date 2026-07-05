#!/usr/bin/env tsx
// 4-phase Zapmail setup: NS switch → connect → inboxes → export.
// Run: npx tsx scripts/zapmail-full-setup.ts --domains purchased-domains.csv --platform smartlead
// Export only (after provisioning): npx tsx scripts/zapmail-full-setup.ts --only-export --platform smartlead [--contains jane]
//
// Outputs: inboxes.csv with per-inbox status and credentials.
// NS-switch progress is checkpointed to zapmail-setup-progress.json so a rerun
// skips already-switched domains (and the 20-minute DNS wait when nothing changed).

import fs from "node:fs";
import { env, required, parseArgs, readCsv, writeCsv, sleep, fetchJson } from "./_lib.ts";

const ZAPMAIL_NS = ["pns61.cloudns.net", "pns62.cloudns.com", "pns63.cloudns.net", "pns64.cloudns.uk"];
const PROGRESS_FILE = "zapmail-setup-progress.json";

async function dynadotSetNs(domains: string[], apiKey: string): Promise<void> {
  const params = new URLSearchParams();
  params.set("key", apiKey);
  params.set("command", "set_ns");
  params.set("domain", domains.join(","));
  ZAPMAIL_NS.forEach((ns, i) => params.set(`ns${i}`, ns));
  const url = `https://api.dynadot.com/api3.json?${params.toString().replace(/%2C/g, ",")}`;
  const r = await fetchJson<any>(url);
  if (r?.SetNsResponse?.ResponseCode !== 0) {
    throw new Error(`Dynadot set_ns failed: ${JSON.stringify(r).slice(0, 300)}`);
  }
}

// Returns the domains whose connect batch failed (after retries) instead of aborting the run.
async function zapmailConnect(domainNames: string[], apiKey: string): Promise<string[]> {
  const failed: string[] = [];
  for (let i = 0; i < domainNames.length; i += 50) {
    const batch = domainNames.slice(i, i + 50);
    try {
      await fetchJson("https://api.zapmail.ai/api/v2/domains/connect-domain", {
        method: "POST",
        headers: { "x-auth-zapmail": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ domainNames: batch }),
      });
    } catch (e: any) {
      console.error(`Zapmail connect batch failed: ${e.message}`);
      failed.push(...batch);
    }
    await sleep(3000);
  }
  return failed;
}

async function waitUntilAssignable(domainNames: string[], apiKey: string, timeoutMinutes = 30): Promise<Array<{ domain: string; uuid: string }>> {
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  const target = new Set(domainNames);
  const found: Array<{ domain: string; uuid: string }> = [];
  const seen = new Set<string>();

  while (Date.now() < deadline) {
    // paginate through assignable — HTTP errors throw (429/5xx retried with backoff
    // inside fetchJson) rather than being silently treated as end-of-pagination.
    for (let page = 1; page < 100; page++) {
      const j: any = await fetchJson(`https://api.zapmail.ai/api/v2/domains/assignable?limit=100&page=${page}`, {
        headers: { "x-auth-zapmail": apiKey },
      });
      const items: any[] = j?.data || [];
      if (items.length === 0) break;
      for (const item of items) {
        if (target.has(item.domainName) && !seen.has(item.domainName)) {
          found.push({ domain: item.domainName, uuid: item.uuid });
          seen.add(item.domainName);
        }
      }
      if (items.length < 100) break;
    }

    if (found.length / domainNames.length >= 0.95) {
      console.log(`${found.length}/${domainNames.length} assignable — proceeding.`);
      return found;
    }
    console.log(`${found.length}/${domainNames.length} assignable, waiting 5 min...`);
    await sleep(5 * 60 * 1000);
  }
  console.warn(`Timeout reached, ${found.length}/${domainNames.length} assignable.`);
  return found;
}

async function createMailboxes(
  assignable: Array<{ domain: string; uuid: string }>,
  firstName: string, lastName: string,
  prefix1: string, prefix2: string,
  apiKey: string,
): Promise<Record<string, string[]>> {
  const results: Record<string, string[]> = {};
  const postBatch = (body: Record<string, any>) => fetchJson<any>("https://api.zapmail.ai/api/v2/mailboxes", {
    method: "POST",
    headers: { "x-auth-zapmail": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  for (let i = 0; i < assignable.length; i += 25) {
    const batch = assignable.slice(i, i + 25);
    const body: Record<string, any> = {};
    for (const { uuid, domain } of batch) {
      body[uuid] = [
        { firstName, lastName, mailboxUsername: prefix1, domainName: domain },
        { firstName, lastName, mailboxUsername: prefix2, domainName: domain },
      ];
    }
    let batchOk = false;
    try {
      const resp = await postBatch(body);
      if (resp && (resp.error || resp.errors)) {
        throw new Error(`Zapmail reported errors: ${JSON.stringify(resp).slice(0, 200)}`);
      }
      batchOk = true;
    } catch (e: any) {
      console.warn(`Batch failed (${e.message}), retrying individually...`);
    }
    if (batchOk) {
      batch.forEach(({ domain }) => { results[domain] = ["created"]; });
    } else {
      for (const { uuid, domain } of batch) {
        try {
          const single: any = { [uuid]: [
            { firstName, lastName, mailboxUsername: prefix1, domainName: domain },
            { firstName, lastName, mailboxUsername: prefix2, domainName: domain },
          ] };
          const resp = await postBatch(single);
          if (resp && (resp.error || resp.errors)) {
            throw new Error(JSON.stringify(resp).slice(0, 200));
          }
          results[domain] = ["created"];
        } catch (e: any) {
          console.warn(`Individual ${domain} also failed: ${e.message}`);
        }
        await sleep(500);
      }
    }
    await sleep(3000);
  }
  return results;
}

async function exportToPlatform(app: "SMARTLEAD" | "INSTANTLY", contains: string, apiKey: string): Promise<any> {
  return fetchJson("https://api.zapmail.ai/api/v2/exports/mailboxes", {
    method: "POST",
    headers: { "x-auth-zapmail": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      apps: [app], ids: [], excludeIds: [], tagIds: [], contains, status: "ACTIVE",
    }),
  });
}

async function main() {
  const { flags } = parseArgs();
  const domainsFile = (flags.domains as string) || "purchased-domains.csv";
  const firstName = (flags["first-name"] as string) || env.SENDER_FIRST_NAME || "Jane";
  const lastName = (flags["last-name"] as string) || env.SENDER_LAST_NAME || "Doe";
  const prefix1 = (env.SENDER_EMAIL_PREFIX_1 || firstName.toLowerCase());
  const prefix2 = (env.SENDER_EMAIL_PREFIX_2 || `${firstName.toLowerCase()}${lastName.toLowerCase()}`);
  const platformArg = (flags.platform as string) || "smartlead";
  const platform: "SMARTLEAD" | "INSTANTLY" = platformArg.toLowerCase() === "instantly" ? "INSTANTLY" : "SMARTLEAD";
  const skipWait = !!flags["skip-wait"];
  const contains = (typeof flags.contains === "string" && flags.contains) ? flags.contains : prefix1;

  const zapmailKey = required("ZAPMAIL_API_KEY");

  // Export-only mode: skip phases 1-4 entirely.
  if (flags["only-export"]) {
    console.log(`Export-only mode: exporting ACTIVE inboxes containing "${contains}" to ${platform}...`);
    const result = await exportToPlatform(platform, contains, zapmailKey);
    console.log(`✅ Export submitted: ${JSON.stringify(result).slice(0, 200)}`);
    return;
  }

  const dynadotKey = required("DYNADOT_API_KEY");

  if (!fs.existsSync(domainsFile)) {
    console.error(`Input file not found: ${domainsFile}. Run dynadot-bulk-purchase.ts first or pass --domains <path>.`);
    process.exit(1);
  }
  const rows = readCsv(domainsFile);
  const domains = rows.filter(r => r.status === "purchased").map(r => r.domain);
  if (domains.length === 0) {
    console.error("No purchased domains found in input CSV.");
    process.exit(1);
  }

  console.log(`Zapmail full setup for ${domains.length} domains.`);
  console.log(`Platform: ${platform}   Sender: ${firstName} ${lastName}`);
  console.log(`Inboxes: ${prefix1}@... and ${prefix2}@... (2 per domain = ${domains.length * 2} total)`);
  console.log();

  const failures: Array<{ domain: string; phase: string; error: string }> = [];

  // Progress file: skip NS switches already done in a previous run.
  let nsSwitched = new Set<string>();
  if (fs.existsSync(PROGRESS_FILE)) {
    try { nsSwitched = new Set(JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")).nsSwitched || []); } catch { /* corrupt — start fresh */ }
  }
  const saveProgress = () => fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ nsSwitched: Array.from(nsSwitched) }));

  // Phase 1: NS switch
  console.log("Phase 1/4: Dynadot NS switch...");
  const toSwitch = domains.filter(d => !nsSwitched.has(d));
  if (toSwitch.length < domains.length) {
    console.log(`  ${domains.length - toSwitch.length} domain(s) already switched per ${PROGRESS_FILE}, skipping those.`);
  }
  const nsOk: string[] = domains.filter(d => nsSwitched.has(d));
  for (let i = 0; i < toSwitch.length; i += 100) {
    const batch = toSwitch.slice(i, i + 100);
    try {
      await dynadotSetNs(batch, dynadotKey);
      batch.forEach(d => { nsSwitched.add(d); nsOk.push(d); });
      saveProgress();
    } catch (e: any) {
      console.error(`  NS switch batch failed: ${e.message}`);
      batch.forEach(d => failures.push({ domain: d, phase: "ns-switch", error: e.message }));
    }
  }
  console.log(`✅ NS switched for ${nsOk.length}/${domains.length} domains.\n`);
  if (nsOk.length === 0) {
    console.error("❌ No domains had their NS switched. Aborting.");
    failures.forEach(f => console.error(`  ${f.domain} [${f.phase}]: ${f.error}`));
    process.exit(1);
  }

  // Phase 2: Wait for DNS propagation (skipped when nothing new was switched)
  if (!skipWait && toSwitch.length > 0) {
    console.log("Phase 2/4: Waiting 20 minutes for DNS propagation...");
    for (let m = 20; m > 0; m--) {
      process.stdout.write(`  ${m} min remaining...\r`);
      await sleep(60 * 1000);
    }
    console.log("  Done waiting.       \n");
  } else if (!skipWait) {
    console.log("Phase 2/4: all domains previously switched — skipping DNS wait.\n");
  }

  // Phase 3: Connect on Zapmail
  console.log("Phase 3/4: Connecting domains on Zapmail...");
  const connectFailed = await zapmailConnect(nsOk, zapmailKey);
  connectFailed.forEach(d => failures.push({ domain: d, phase: "connect", error: "connect-domain request failed" }));
  const connected = nsOk.filter(d => !connectFailed.includes(d));
  if (connected.length === 0) {
    console.error("❌ No domains connected on Zapmail. Aborting.");
    failures.forEach(f => console.error(`  ${f.domain} [${f.phase}]: ${f.error}`));
    process.exit(1);
  }
  console.log("Connected. Polling for assignable status...");
  const assignable = await waitUntilAssignable(connected, zapmailKey, 30);
  const assignableSet = new Set(assignable.map(a => a.domain));
  connected.filter(d => !assignableSet.has(d)).forEach(d => failures.push({ domain: d, phase: "assignable", error: "not assignable within timeout" }));
  console.log(`✅ ${assignable.length} domains assignable.\n`);

  // Phase 4: Create inboxes
  console.log("Phase 4/4: Creating inboxes...");
  const inboxResults = await createMailboxes(assignable, firstName, lastName, prefix1, prefix2, zapmailKey);
  const inboxRows: any[] = [];
  for (const { domain } of assignable) {
    const status = inboxResults[domain] ? "created" : "failed";
    if (status === "failed") failures.push({ domain, phase: "mailbox", error: "mailbox creation failed" });
    inboxRows.push({ email: `${prefix1}@${domain}`, domain, status });
    inboxRows.push({ email: `${prefix2}@${domain}`, domain, status });
  }
  writeCsv("inboxes.csv", inboxRows);
  console.log(`✅ ${Object.keys(inboxResults).length} domains have inboxes created.\n`);

  console.log("Inbox provisioning takes 4-6 hours. You can walk away.");
  console.log("When ACTIVE, run the export manually OR re-run with --only-export:");
  console.log(`  npx tsx scripts/zapmail-full-setup.ts --only-export --platform ${platformArg} --contains ${contains}`);
  console.log();
  console.log("Export now (will pick up only ACTIVE inboxes):");
  try {
    const result = await exportToPlatform(platform, contains, zapmailKey);
    console.log(`✅ Export submitted: ${JSON.stringify(result).slice(0, 200)}`);
  } catch (e: any) {
    // Expected when inboxes are still provisioning — a warning, not a failure.
    console.warn(`⚠️  Export skipped (inboxes likely still provisioning): ${e.message}`);
    console.log("Re-run export after 4-6 hours when inboxes are ACTIVE (see --only-export above).");
  }

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} domain(s) did not complete setup:`);
    failures.forEach(f => console.error(`  ${f.domain} [${f.phase}]: ${f.error}`));
    process.exit(1);
  }
  console.log(`\n✅ All ${domains.length} domains completed setup.`);
}

main().catch(e => { console.error(e); process.exit(1); });
