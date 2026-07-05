#!/usr/bin/env tsx
/**
 * Create + poll + pull a Smartlead Smart Delivery spam placement test.
 *
 * Usage:
 *   export SMARTLEAD_API_KEY=xxx
 *   npx tsx scripts/run-spam-test.ts --campaign-id=12345 --senders=100 --out=/tmp/spam-test.json [--yes]
 *   npx tsx scripts/run-spam-test.ts --test-id=999 --out=/tmp/spam-test.json   # resume an existing test
 *
 * Notes:
 *   - Creating a test consumes Smart Delivery credits and sends from live inboxes —
 *     the script asks for confirmation unless --yes is passed.
 *   - After creation the test id is checkpointed to <out>.testid.json; if the run dies,
 *     rerun with --test-id=<id> to resume polling/reports instead of creating a new test.
 *   - Only 2 provider pools are available: G Suite (20) and Office365 (21).
 *   - ~500 seed cap per test; stay under ~300 senders to avoid stalls.
 *   - is_warmup MUST be true or test truncates at ~9%.
 *   - Takes 5-20 minutes to complete.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from "fs";
import { dirname } from "path";
import readline from "readline";

const SERVER_BASE = "https://server.smartlead.ai/api/v1";
const DELIVERY_BASE = "https://smartdelivery.smartlead.ai/api/v1";
const API_KEY = process.env.SMARTLEAD_API_KEY;
if (!API_KEY) {
  console.error("Missing env: SMARTLEAD_API_KEY");
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const campaignId = get("--campaign-id");
  const resumeTestId = get("--test-id");
  const sendersRaw = get("--senders");
  let senders = 100;
  if (sendersRaw !== undefined) {
    senders = Number(sendersRaw);
    if (!Number.isInteger(senders) || senders < 1) {
      console.error(`--senders must be a positive integer, got: ${sendersRaw}`);
      process.exit(1);
    }
    if (senders > 300) {
      console.error(
        `WARNING: --senders=${senders} exceeds ~300 — tests may stall (see header notes).`
      );
    }
  }
  const out = get("--out") ?? "/tmp/spam-test.json";
  const testName = get("--name") ?? `audit-${new Date().toISOString().slice(0, 10)}`;
  const yes = args.includes("--yes");
  if (!campaignId && !resumeTestId) {
    console.error(
      "Usage: --campaign-id=12345 [--senders=100] [--out=path] [--yes] | --test-id=999 to resume"
    );
    process.exit(1);
  }
  return { campaignId, senders, out, testName, yes, resumeTestId };
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
    } catch (err) {
      lastErr = `network error: ${String(err).slice(0, 150)}`;
      console.error(`  [${lastErr}] retry ${attempt + 1}/5`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (resp.status === 429 || resp.status >= 500) {
      lastErr = `HTTP ${resp.status}`;
      const wait = 1000 * 2 ** attempt;
      console.error(`  [${resp.status}] retry ${attempt + 1}/5 in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    try {
      return await resp.json();
    } catch (err) {
      lastErr = `JSON parse error: ${String(err).slice(0, 150)}`;
      console.error(`  [${lastErr}] retry ${attempt + 1}/5`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
  }
  throw new Error(`Exhausted retries (last: ${lastErr})`);
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

async function main() {
  const { campaignId, senders: maxSenders, out, testName, yes, resumeTestId } = parseArgs();
  const checkpointPath = `${out}.testid.json`;

  let testId: any = resumeTestId;
  let createBody: any = null;

  if (!testId && existsSync(checkpointPath)) {
    let cp: any = null;
    try {
      cp = JSON.parse(readFileSync(checkpointPath, "utf8"));
    } catch {
      /* corrupt checkpoint — ignore */
    }
    if (cp?.test_id != null) {
      console.error(
        `Found existing test checkpoint ${checkpointPath} (test_id=${cp.test_id}, created ${cp.created_at}, campaign ${cp.campaign_id}).`
      );
      console.error(
        `Resume it with --test-id=${cp.test_id}, or delete ${checkpointPath} to create a new test. Refusing to create a duplicate.`
      );
      process.exit(1);
    }
  }

  if (testId) {
    console.error(`Resuming existing spam test id=${testId} (skipping creation)...`);
  } else {
    // 1. Pull campaign sender accounts
    console.error(`Fetching senders for campaign ${campaignId}...`);
    const accts = await fetchJson(
      `${SERVER_BASE}/campaigns/${campaignId}/email-accounts?api_key=${API_KEY}`
    );
    if (!Array.isArray(accts) || !accts.length) {
      throw new Error(`No email accounts on campaign ${campaignId}`);
    }
    const senderFromEmails = accts
      .map((a: any) => a.from_email)
      .filter(Boolean)
      .slice(0, maxSenders);
    console.error(`  Using ${senderFromEmails.length} senders (campaign has ${accts.length})`);

    // 2. Pull sequences to get sequence_mapping_id
    console.error("Fetching campaign sequences...");
    const seqData = await fetchJson(
      `${SERVER_BASE}/campaigns/${campaignId}/sequences?api_key=${API_KEY}`
    );
    const sequences = Array.isArray(seqData) ? seqData : seqData.sequences;
    if (!sequences?.length) throw new Error("Campaign has no sequences");
    const sequenceMappingId = sequences[0].id;
    console.error(`  Using sequence_mapping_id=${sequenceMappingId}`);

    // 3. Confirm + create spam test (spend/send operation)
    console.error(`\nAbout to create a Smart Delivery spam test (consumes credits, sends from live inboxes):`);
    console.error(`  campaign:  ${campaignId}`);
    console.error(`  senders:   ${senderFromEmails.length}`);
    console.error(`  providers: G Suite (20), Office365 (21)`);
    if (!yes) {
      if (!process.stdin.isTTY) {
        console.error("Refusing to create spam test without confirmation — pass --yes to run unattended.");
        process.exit(1);
      }
      const ok = await confirm("Proceed?");
      if (!ok) {
        console.error("Aborted.");
        process.exit(1);
      }
    }

    console.error("Creating spam test...");
    createBody = {
      test_name: testName,
      description: `Deliverability audit for campaign ${campaignId}`,
      campaign_id: Number(campaignId),
      sequence_mapping_id: sequenceMappingId,
      sender_accounts: senderFromEmails,
      provider_ids: [20, 21],
      spam_filters: ["spam_assassin"],
      link_checker: true,
      all_email_sent_without_time_gap: false,
      min_time_btwn_emails: 1,
      min_time_unit: "minutes",
      is_warmup: true,
    };
    const created = await fetchJson(
      `${DELIVERY_BASE}/spam-test/manual?api_key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      }
    );
    testId = created.id ?? created.spamTestId;
    if (testId == null) {
      throw new Error(`create response had no id: ${JSON.stringify(created).slice(0, 300)}`);
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      checkpointPath,
      JSON.stringify(
        { test_id: testId, created_at: new Date().toISOString(), campaign_id: campaignId },
        null,
        2
      )
    );
    console.error(`  Test created: id=${testId}`);
    console.error(
      `  Checkpoint written to ${checkpointPath} — if this run dies, resume with --test-id=${testId}`
    );
  }

  // 4. Poll for completion (max 25 min)
  console.error("Polling for completion (up to 25 min)...");
  const start = Date.now();
  let status: string | undefined;
  let completed = false;
  while (Date.now() - start < 25 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 30000));
    const detail = await fetchJson(`${DELIVERY_BASE}/spam-test/${testId}?api_key=${API_KEY}`);
    status = detail.status;
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.error(`  [${elapsed}s] status=${status} test_end_date=${detail.test_end_date}`);
    if (detail.test_end_date || status !== "ACTIVE") {
      completed = true;
      break;
    }
  }
  const timedOut = !completed;
  if (timedOut) {
    console.error(
      `WARNING: 25-min poll window expired before completion (last status=${status}) — reports below may be incomplete.`
    );
  }

  // 5. Pull reports
  console.error("Fetching reports...");
  const reports = {
    providerwise: await fetchJson(
      `${DELIVERY_BASE}/spam-test/report/${testId}/providerwise?api_key=${API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
    ).catch((e) => ({ error: String(e) })),
    groupwise: await fetchJson(
      `${DELIVERY_BASE}/spam-test/report/${testId}/groupwise?api_key=${API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
    ).catch((e) => ({ error: String(e) })),
    senderWise: await fetchJson(
      `${DELIVERY_BASE}/spam-test/report/${testId}/sender-account-wise?api_key=${API_KEY}`
    ).catch((e) => ({ error: String(e) })),
    spamFilterDetails: await fetchJson(
      `${DELIVERY_BASE}/spam-test/report/${testId}/spam-filter-details?api_key=${API_KEY}`
    ).catch((e) => ({ error: String(e) })),
    dkim: await fetchJson(
      `${DELIVERY_BASE}/spam-test/report/${testId}/dkim-details?api_key=${API_KEY}`
    ).catch((e) => ({ error: String(e) })),
    spf: await fetchJson(
      `${DELIVERY_BASE}/spam-test/report/${testId}/spf-details?api_key=${API_KEY}`
    ).catch((e) => ({ error: String(e) })),
    blacklist: await fetchJson(
      `${DELIVERY_BASE}/spam-test/report/${testId}/blacklist?api_key=${API_KEY}`
    ).catch((e) => ({ error: String(e) })),
  };

  const payload = { test_id: testId, status, timed_out: timedOut, create_body: createBody, reports };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(payload, null, 2));
  console.error(`\nWrote ${out}`);

  // Summary
  const pw = reports.providerwise;
  if (pw && !pw.error) {
    console.error("\n--- Placement summary ---");
    console.error(JSON.stringify(pw, null, 2).slice(0, 800));
  }

  if (timedOut) {
    console.error(
      `Test did not complete within the poll window. Re-pull later with: --test-id=${testId} --out=${out}`
    );
    process.exit(1);
  }
  if (existsSync(checkpointPath)) unlinkSync(checkpointPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
