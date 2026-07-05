#!/usr/bin/env tsx
// End-to-end Instantly campaign creation: create → add leads → activate.
// Run: npx tsx scripts/instantly-create-campaign.ts --name "My First" --sequence sequence.json --leads leads.csv [--yes]
// Resumable: the created campaign id is saved to .instantly-campaign.json —
// pass --campaign-id <id> to skip creation and resume adding leads.

import { required, parseArgs, readCsv, writeCsv, confirm, fetchJson } from "./_lib.ts";
import fs from "node:fs";

const API = "https://api.instantly.ai";

const STATE_FILE = ".instantly-campaign.json";

async function instantlyFetch(path: string, init: RequestInit = {}, key: string): Promise<any> {
  // fetchJson retries 429/5xx with backoff, fails fast on other 4xx (with body detail), and times out.
  return fetchJson(`${API}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers as any),
    },
  });
}

async function fetchAllAccounts(key: string): Promise<string[]> {
  const emails: string[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const q = `/api/v2/accounts?limit=100${startingAfter ? `&starting_after=${encodeURIComponent(startingAfter)}` : ""}`;
    const resp = await instantlyFetch(q, {}, key);
    const page: any[] = Array.isArray(resp) ? resp : (resp?.items || resp?.data || []);
    emails.push(...page.map((a: any) => a.email).filter(Boolean));
    startingAfter = resp?.next_starting_after;
    if (!startingAfter || page.length === 0) break;
  }
  return emails;
}

async function main() {
  const { flags } = parseArgs();
  const name = (flags.name as string) || `Campaign ${new Date().toISOString().slice(0, 10)}`;
  const sequenceFile = (flags.sequence as string) || "sequence.json";
  const leadsFile = (flags.leads as string) || "leads.csv";
  const autoActivate = !!flags["auto-activate"];
  const resumeCampaignId = flags["campaign-id"] as string | undefined;

  const key = required("INSTANTLY_API_KEY");

  // 0. Validate inputs UP FRONT, before any API call or spend.
  if (!fs.existsSync(sequenceFile)) {
    console.error(`Error: sequence file not found: ${sequenceFile}. Pass --sequence <file> (a JSON array of sequence steps).`);
    process.exit(1);
  }
  let sequences: any[];
  try {
    sequences = JSON.parse(fs.readFileSync(sequenceFile, "utf8"));
  } catch (e: any) {
    console.error(`Error: could not parse ${sequenceFile} as JSON: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(sequences)) sequences = [sequences];
  if (!fs.existsSync(leadsFile)) {
    console.error(`Error: leads file not found: ${leadsFile}. Pass --leads <file>.`);
    process.exit(1);
  }
  const leads = readCsv(leadsFile);

  let campaignId: string;

  if (resumeCampaignId && resumeCampaignId !== "true") {
    campaignId = resumeCampaignId;
    console.log(`Resuming with existing campaign ${campaignId} — skipping creation.`);
  } else {
    // 1. Fetch warmed accounts (all pages)
    console.log("Fetching email accounts...");
    const accountEmails = await fetchAllAccounts(key);
    console.log(`Found ${accountEmails.length} accounts.`);
    if (accountEmails.length === 0) {
      console.error("Error: no email accounts found in this Instantly workspace — the campaign could never send. Connect/warm accounts first.");
      process.exit(1);
    }

    // 2. Confirm before spend (campaign creation, and possibly activation)
    console.log(`\nAbout to create Instantly campaign:`);
    console.log(`  Name:           ${name}`);
    console.log(`  Email accounts: ${accountEmails.length}`);
    console.log(`  Sequence steps: ${sequences.length}`);
    console.log(`  Leads:          ${leads.length}`);
    console.log(`  Auto-activate:  ${autoActivate ? "YES — will start sending" : "no (draft)"}`);
    if (!flags.yes) {
      const ok = await confirm("Proceed? (y/N)");
      if (!ok) { console.error("Aborted. Pass --yes to skip this prompt."); process.exit(1); }
    }

    // 3. Create campaign
    console.log(`Creating campaign "${name}"...`);
    const payload: any = {
      name,
      email_list: accountEmails,
      sequences,
      daily_limit: 30,
      campaign_schedule: {
        schedules: [{
          name: "Business hours",
          timing: { from: "09:00", to: "17:00" },
          days: { "1": true, "2": true, "3": true, "4": true, "5": true, "0": false, "6": false },
          timezone: "America/New_York",
        }],
      },
    };
    const created = await instantlyFetch("/api/v2/campaigns", {
      method: "POST",
      body: JSON.stringify(payload),
    }, key);
    campaignId = created?.id;
    if (!campaignId) throw new Error(`Campaign create failed: ${JSON.stringify(created).slice(0, 300)}`);
    // Persist immediately so a mid-run crash can resume instead of creating a duplicate.
    fs.writeFileSync(STATE_FILE, JSON.stringify({ campaignId, name, createdAt: new Date().toISOString() }, null, 2));
    console.log(`✅ Campaign created: ${campaignId} (saved to ${STATE_FILE} — resume with --campaign-id ${campaignId})`);
  }

  // 4. Add leads in batches of 1000
  console.log(`Adding ${leads.length} leads in batches of 1000...`);
  let added = 0;
  const failedRows: any[] = [];
  for (let i = 0; i < leads.length; i += 1000) {
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
      await instantlyFetch("/api/v2/leads/bulk-create", {
        method: "POST",
        body: JSON.stringify({ campaign: campaignId, leads: batch }),
      }, key);
      added += batch.length;
      process.stdout.write(`  ${added}/${leads.length}\r`);
    } catch (e: any) {
      console.error(`\n  batch ${i}-${Math.min(i + 1000, leads.length)} failed: ${e.message}`);
      failedRows.push(...leads.slice(i, i + 1000));
    }
  }
  console.log(`\n✅ Added ${added} leads.`);
  if (failedRows.length > 0) {
    writeCsv("failed-leads.csv", failedRows);
    console.error(`❌ ${failedRows.length} leads failed — saved to failed-leads.csv. Retry with: --campaign-id ${campaignId} against instantly-add-leads.ts`);
  }

  // 5. Activate (optional) — only when every lead uploaded
  if (autoActivate) {
    if (failedRows.length > 0) {
      console.error("Skipping --auto-activate because some leads failed to upload.");
    } else {
      console.log("Activating campaign...");
      await instantlyFetch(`/api/v2/campaigns/${campaignId}/activate`, { method: "POST" }, key);
      console.log("✅ Campaign ACTIVE.");
    }
  }

  console.log();
  console.log(`✅ Campaign ready: https://app.instantly.ai/app/campaign/${campaignId}`);
  if (!autoActivate) console.log("   Review in the UI, then activate manually (or re-run with --auto-activate).");
  if (failedRows.length > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
