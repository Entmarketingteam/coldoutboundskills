#!/usr/bin/env tsx
// End-to-end Smartlead campaign creation: create → save sequence → attach inboxes → add leads.
// Run: npx tsx scripts/smartlead-create-campaign.ts --name "My First" --sequence sequence.json --leads leads.csv [--yes]
// Resumable: the created campaign id is saved to .smartlead-campaign.json —
// pass --campaign-id <id> to skip creation and resume steps 2-5.

import { required, parseArgs, readCsv, writeCsv, confirm, fetchJson } from "./_lib.ts";
import fs from "node:fs";

const API = "https://server.smartlead.ai/api/v1";

const STATE_FILE = ".smartlead-campaign.json";

// fetchJson retries 429/5xx with backoff, fails fast on other 4xx (with body detail),
// guards JSON parsing, and times out. Error messages never include the URL (api_key is a query param).
async function smartleadPost(path: string, body: any, key: string): Promise<any> {
  return fetchJson(`${API}${path}?api_key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function smartleadGet(path: string, key: string): Promise<any> {
  return fetchJson(`${API}${path}${path.includes("?") ? "&" : "?"}api_key=${key}`);
}

// Paginate email-accounts (offset/limit) until a short page.
async function fetchAllAccounts(key: string): Promise<any[]> {
  const all: any[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const resp = await smartleadGet(`/email-accounts?offset=${offset}&limit=${limit}`, key);
    const page: any[] = Array.isArray(resp) ? resp : (resp?.data || []);
    all.push(...page);
    if (page.length < limit) break;
  }
  return all;
}

async function main() {
  const { flags } = parseArgs();
  const name = (flags.name as string) || `Campaign ${new Date().toISOString().slice(0, 10)}`;
  const sequenceFile = (flags.sequence as string) || "sequence.json";
  const leadsFile = (flags.leads as string) || "leads.csv";
  const resumeCampaignId = flags["campaign-id"];

  const key = required("SMARTLEAD_API_KEY");

  // 0. Validate inputs UP FRONT, before any API call or spend.
  // A bare `--campaign-id` (no value) parses as boolean true — reject it.
  if (resumeCampaignId !== undefined && typeof resumeCampaignId !== "string") {
    console.error("Error: --campaign-id requires a value (the campaign id to resume), e.g. --campaign-id 12345.");
    process.exit(1);
  }
  if (!fs.existsSync(sequenceFile)) {
    console.error(`Error: sequence file not found: ${sequenceFile}. Pass --sequence <file> (a JSON array of sequence steps).`);
    process.exit(1);
  }
  let sequences: any;
  try {
    sequences = JSON.parse(fs.readFileSync(sequenceFile, "utf8"));
  } catch (e: any) {
    console.error(`Error: could not parse ${sequenceFile} as JSON: ${e.message}`);
    process.exit(1);
  }
  if (!fs.existsSync(leadsFile)) {
    console.error(`Error: leads file not found: ${leadsFile}. Pass --leads <file>.`);
    process.exit(1);
  }
  const leads = readCsv(leadsFile);

  let campaignId: string | number;

  if (resumeCampaignId && resumeCampaignId !== "true") {
    campaignId = resumeCampaignId;
    console.log(`Resuming with existing campaign ${campaignId} — skipping creation.`);
  } else {
    // 1. Confirm before spend (campaign creation)
    console.log(`About to create Smartlead campaign:`);
    console.log(`  Name:           ${name}`);
    console.log(`  Sequence steps: ${Array.isArray(sequences) ? sequences.length : 1}`);
    console.log(`  Leads:          ${leads.length}`);
    if (!flags.yes) {
      const ok = await confirm("Proceed? (y/N)");
      if (!ok) { console.error("Aborted. Pass --yes to skip this prompt."); process.exit(1); }
    }

    console.log(`Creating campaign "${name}"...`);
    const created = await smartleadPost("/campaigns/create", { name }, key);
    campaignId = created?.id || created?.campaign_id;
    if (!campaignId) throw new Error(`Campaign create failed: ${JSON.stringify(created).slice(0, 300)}`);
    // Persist immediately so a mid-run crash can resume instead of creating a duplicate.
    fs.writeFileSync(STATE_FILE, JSON.stringify({ campaignId, name, createdAt: new Date().toISOString() }, null, 2));
    console.log(`✅ Campaign created: ${campaignId} (saved to ${STATE_FILE} — resume with --campaign-id ${campaignId})`);
  }

  // 2. Save sequence
  console.log(`Saving sequence from ${sequenceFile}...`);
  await smartleadPost(`/campaigns/${campaignId}/sequences`, { sequences }, key);
  console.log(`✅ Sequence saved (${Array.isArray(sequences) ? sequences.length : 1} steps)`);

  // 3. Attach all warmed email accounts (paginated)
  console.log("Fetching email accounts...");
  const list = await fetchAllAccounts(key);
  const ids = list.map((a: any) => a.id).filter(Boolean);
  if (ids.length > 0) {
    console.log(`Attaching ${ids.length} email accounts...`);
    await smartleadPost(`/campaigns/${campaignId}/email-accounts`, { email_account_ids: ids }, key);
    console.log(`✅ Accounts attached.`);
  } else {
    console.warn("⚠️  No email accounts found — campaign cannot send until accounts are attached.");
  }

  // 4. Add leads in batches of 100
  console.log(`Adding ${leads.length} leads in batches of 100...`);
  let added = 0;
  const failedRows: any[] = [];
  for (let i = 0; i < leads.length; i += 100) {
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
      await smartleadPost(`/campaigns/${campaignId}/leads`, { lead_list: batch }, key);
      added += batch.length;
      process.stdout.write(`  ${added}/${leads.length}\r`);
    } catch (e: any) {
      console.error(`\n  batch ${i}-${Math.min(i + 100, leads.length)} failed: ${e.message}`);
      failedRows.push(...leads.slice(i, i + 100).map(l => ({ ...l, failure_reason: e.message })));
    }
  }
  console.log(`\n✅ Added ${added} leads.`);
  if (failedRows.length > 0) {
    writeCsv("failed-leads.csv", failedRows);
    console.error(`❌ ${failedRows.length} leads failed — saved to failed-leads.csv. Retry with smartlead-add-leads.ts --campaign-id ${campaignId}`);
  }

  // 5. Set default schedule (M-F 9-5, 30 emails/day/inbox)
  console.log("Setting default schedule...");
  try {
    await smartleadPost(`/campaigns/${campaignId}/schedule`, {
      timezone: "America/New_York",
      days_of_the_week: [1, 2, 3, 4, 5],
      start_hour: "09:00",
      end_hour: "17:00",
      min_time_btw_emails: 10,
      max_new_leads_per_day: 30,
    }, key);
    console.log("✅ Schedule set.");
  } catch (e: any) {
    console.warn(`⚠️  Schedule failed: ${e.message}`);
  }

  console.log();
  console.log("✅ Campaign ready in DRAFT status.");
  console.log(`   https://app.smartlead.ai/app/email-campaign/${campaignId}`);
  console.log();
  console.log("Next:");
  console.log(`  1. Visit the URL above, review the sequence + leads`);
  console.log(`  2. Run the launch checklist from references/12-launch-checklist.md`);
  console.log(`  3. Hit Start in the Smartlead UI`);
  if (failedRows.length > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
