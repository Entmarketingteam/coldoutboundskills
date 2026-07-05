#!/usr/bin/env tsx
/**
 * Phase 7: Smartlead campaign creation + upload.
 *
 * Self-contained version of the GEX v2 campaign-launcher, with:
 * - Inbox selection via Smartlead tags (no Supabase)
 * - Local JSON state (no auto_research_inbox_assignments table)
 *
 * Usage:
 *   export SMARTLEAD_API_KEY=xxx
 *   npx tsx scripts/phase-upload.ts \
 *     --leads-file=/tmp/auto/personalized.json \
 *     --variants-file=/tmp/auto/variants.json \
 *     --domain=target.com \
 *     --inboxes-tag=active \
 *     --inbox-count=10 \
 *     --activate
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { dirname } from "path";
import readline from "readline";

const SL_BASE = "https://server.smartlead.ai/api/v1";
const API_KEY = process.env.SMARTLEAD_API_KEY;
if (!API_KEY) {
  console.error("Missing env: SMARTLEAD_API_KEY");
  process.exit(1);
}
const LEADS_BATCH = 100;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const inboxCount = Number(get("--inbox-count") ?? 10);
  if (!Number.isInteger(inboxCount) || inboxCount < 1) {
    console.error("--inbox-count must be a positive integer");
    process.exit(1);
  }
  const clientId = get("--client-id");
  if (clientId !== undefined && !Number.isInteger(Number(clientId))) {
    console.error("--client-id must be an integer");
    process.exit(1);
  }
  const inboxIds = get("--inbox-ids")?.split(",").map(Number); // explicit inbox IDs
  if (inboxIds?.some((n) => !Number.isInteger(n))) {
    console.error("--inbox-ids must be a comma-separated list of integers");
    process.exit(1);
  }
  return {
    leadsFile: get("--leads-file"),
    variantsFile: get("--variants-file"),
    domain: get("--domain"),
    inboxTag: get("--inboxes-tag") ?? "active",
    inboxDomain: get("--inbox-domain"), // fallback: filter by email domain substring
    inboxIds,
    inboxCount,
    clientId,
    experimentLog: get("--experiment-log"),
    activate: args.includes("--activate"),
    yes: args.includes("--yes"),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function confirmPrompt(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

// Bounded retry with exponential backoff on 429/5xx/network errors
// (pattern from cold-email-starter-kit/scripts/_lib.ts retry()).
// Never include the full URL in errors — the API key lives in the query string.
async function slFetch(method: "GET" | "POST", path: string, params: Record<string, any>, body?: any): Promise<any> {
  const url = new URL(SL_BASE + path);
  url.searchParams.set("api_key", API_KEY!);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const attempts = 5;
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    let resp: Response;
    try {
      resp = await fetch(url.toString(), {
        method,
        ...(body !== undefined
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
          : {}),
        signal: AbortSignal.timeout(60000),
      });
    } catch (e: any) {
      lastErr = new Error(`${method} ${path}: ${e?.message ?? e}`);
      if (i < attempts - 1) {
        console.error(`  [SL] ${method} ${path} attempt ${i + 1}/${attempts} failed — retrying`);
        await sleep(Math.min(1000 * 2 ** i, 30000));
      }
      continue;
    }
    if (resp.status === 429 || resp.status >= 500) {
      lastErr = new Error(`${method} ${path}: ${resp.status} ${(await resp.text().catch(() => "")).slice(0, 200)}`);
      if (i < attempts - 1) {
        console.error(`  [SL] ${method} ${path} got ${resp.status} — retrying`);
        await sleep(Math.min(1000 * 2 ** i, 30000));
      }
      continue;
    }
    if (!resp.ok) throw new Error(`${method} ${path}: ${resp.status} ${await resp.text().catch(() => "")}`);
    try {
      return await resp.json();
    } catch {
      throw new Error(`${method} ${path}: response was not valid JSON`);
    }
  }
  throw lastErr;
}
async function slGet(path: string, params: Record<string, any> = {}): Promise<any> {
  return slFetch("GET", path, params);
}
async function slPost(path: string, body: any, params: Record<string, any> = {}): Promise<any> {
  return slFetch("POST", path, params, body);
}

async function selectInboxes(
  tag: string,
  count: number,
  inboxDomain?: string,
  inboxIds?: number[]
): Promise<{ id: number; email: string }[]> {
  // Explicit IDs override everything
  if (inboxIds?.length) {
    return inboxIds.slice(0, count).map((id) => ({ id, email: "" }));
  }

  const all: any[] = [];
  let offset = 0;
  while (true) {
    const batch = await slGet("/email-accounts", { offset, limit: 100 });
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
    offset += 100;
  }

  // Filter: tagged OR (if no tag matches) domain-substring filter
  let candidates = all.filter((i: any) => i.is_smtp_success && !i.warmup_details?.is_warmup_blocked);
  const tagged = candidates.filter((i: any) => (i.tags ?? []).some((t: any) => t.name === tag));

  if (tagged.length) {
    candidates = tagged;
  } else if (inboxDomain) {
    console.error(`[Upload] No inboxes tagged '${tag}' — falling back to domain filter '${inboxDomain}'`);
    candidates = candidates.filter((i: any) => {
      const email: string = i.from_email || i.email || "";
      return email.includes(inboxDomain);
    });
  } else {
    throw new Error(`No inboxes matching tag=${tag} and no --inbox-domain fallback provided`);
  }

  candidates.sort((a, b) => (a.daily_sent_count ?? 0) - (b.daily_sent_count ?? 0));
  return candidates.slice(0, count).map((i: any) => ({ id: i.id, email: i.from_email || i.email }));
}

function buildBody(variantLabel: string, campaignId: number, bodyTemplate?: string): string {
  const v = variantLabel.toLowerCase();
  if (bodyTemplate) {
    // Replace placeholders with campaign-ID-scoped variants
    return bodyTemplate
      .replace(/\{\{situation_line\}\}/g, `{{situation_line_${v}_${campaignId}}}`)
      .replace(/\{\{value_line\}\}/g, `{{value_line_${v}_${campaignId}}}`)
      .replace(/\{\{cta_line\}\}/g, `{{cta_line_${v}_${campaignId}}}`);
  }
  return `Hi {{first_name}},<br><br>{{situation_line_${v}_${campaignId}}}<br><br>{{value_line_${v}_${campaignId}}}<div><br></div>{{cta_line_${v}_${campaignId}}}<br><br>%signature%<br><br>P.S. If this isn't relevant, just let me know and I won't reach out again.`;
}

async function main() {
  const args = parseArgs();
  if (!args.leadsFile || !args.variantsFile || !args.domain) {
    console.error(
      "Usage: --leads-file=... --variants-file=... --domain=... [--inboxes-tag=active] [--inbox-count=10] [--activate]"
    );
    process.exit(1);
  }

  // Validate all inputs BEFORE any Smartlead mutation
  let leadsRaw: any, variantsRaw: any;
  try {
    leadsRaw = JSON.parse(readFileSync(args.leadsFile, "utf8"));
  } catch (e: any) {
    console.error(`Cannot read leads file ${args.leadsFile}: ${e?.message ?? e}`);
    process.exit(1);
  }
  try {
    variantsRaw = JSON.parse(readFileSync(args.variantsFile, "utf8"));
  } catch (e: any) {
    console.error(`Cannot read variants file ${args.variantsFile}: ${e?.message ?? e}`);
    process.exit(1);
  }
  const leads: any[] = Array.isArray(leadsRaw) ? leadsRaw : leadsRaw?.leads;
  const variants: any[] = Array.isArray(variantsRaw) ? variantsRaw : variantsRaw?.variants;
  if (!Array.isArray(leads) || !leads.length) {
    console.error(`Leads file ${args.leadsFile} must be a non-empty array (or { leads: [...] })`);
    process.exit(1);
  }
  if (!Array.isArray(variants) || !variants.length) {
    console.error(`Variants file ${args.variantsFile} must be a non-empty array (or { variants: [...] })`);
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const campaignName = `[AUTO] ${today} ${args.domain}`;

  // Resumable state: a rerun completes the same campaign instead of duplicating it
  const stateFile = args.experimentLog
    ? `${args.experimentLog}.state.json`
    : `/tmp/auto/upload-state-${today}-${args.domain}.json`;
  interface UploadState {
    campaignId?: number;
    steps: string[];
    uploadedBatches: number[];
    uploadedLeads: number;
    inboxes?: { id: number; email: string }[];
  }
  let state: UploadState = { steps: [], uploadedBatches: [], uploadedLeads: 0 };
  if (existsSync(stateFile)) {
    try {
      state = { steps: [], uploadedBatches: [], uploadedLeads: 0, ...JSON.parse(readFileSync(stateFile, "utf8")) };
    } catch {
      console.error(`[Launch] Ignoring unreadable state file ${stateFile}`);
    }
  }
  const saveState = () => {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  };
  const done = (step: string) => state.steps.includes(step);
  const markDone = (step: string) => {
    state.steps.push(step);
    saveState();
  };

  // Spend confirmation: campaign creation (and possible activation) needs --yes when unattended
  console.error(`\n[Launch] Campaign: ${campaignName}`);
  console.error(`  Leads: ${leads.length} | Variants: ${variants.length}`);
  console.error(
    `  Inboxes: ${args.inboxIds?.length ? `ids=${args.inboxIds.join(",")}` : `tag='${args.inboxTag}'`} (count=${args.inboxCount})`
  );
  console.error(`  Activate after upload: ${args.activate ? "YES (live sending)" : "no (draft)"}`);
  if (state.campaignId) console.error(`  Resuming existing campaign #${state.campaignId} from ${stateFile}`);
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      console.error("Refusing to create/modify a campaign without confirmation in non-interactive mode. Pass --yes to proceed.");
      process.exit(1);
    }
    const ok = await confirmPrompt("Proceed? [y/N]");
    if (!ok) {
      console.error("Aborted.");
      process.exit(1);
    }
  }

  // 1. Create campaign (skipped when resuming)
  let campaignId: number;
  if (state.campaignId) {
    campaignId = state.campaignId;
  } else {
    const createBody: any = { name: campaignName };
    if (args.clientId) createBody.client_id = Number(args.clientId);
    const campaign = await slPost("/campaigns/create", createBody);
    campaignId = campaign.id;
    state.campaignId = campaignId;
    saveState();
    console.error(`  Campaign created: #${campaignId}`);
  }

  // 2. Save sequences with A/B/C variants
  if (!done("sequences")) {
    await slPost(`/campaigns/${campaignId}/sequences`, {
      sequences: [
        {
          seq_number: 1,
          seq_delay_details: { delay_in_days: 0 },
          seq_variants: variants.map((v: any) => ({
            variant_label: v.variant,
            subject: (v.subject || "").replace(/—/g, " - ").replace(/–/g, " - "),
            email_body: buildBody(v.variant, campaignId, v.body_template),
          })),
        },
      ],
    });
    markDone("sequences");
    console.error(`  Saved ${variants.length} variants`);
  }

  // 3. Select + add inboxes
  const inboxes = await selectInboxes(args.inboxTag, args.inboxCount, args.inboxDomain, args.inboxIds);
  if (!inboxes.length) throw new Error(`No inboxes matching tag=${args.inboxTag}`);
  let remainingIds = inboxes.map((i) => i.id);
  let retries = 0;
  while (remainingIds.length && retries < 50) {
    try {
      await slPost(`/campaigns/${campaignId}/email-accounts`, { email_account_ids: remainingIds });
      break;
    } catch (err: any) {
      const m = err.message?.match(/Email account id - (\d+) not allowed/);
      if (m) {
        const bad = Number(m[1]);
        remainingIds = remainingIds.filter((id) => id !== bad);
        retries++;
      } else throw err;
    }
  }
  console.error(`  Added ${remainingIds.length} inboxes (${retries} rejected)`);

  // 4. Upload leads in batches of 100
  let uploaded = 0;
  for (let i = 0; i < leads.length; i += LEADS_BATCH) {
    const batch = leads.slice(i, i + LEADS_BATCH).map((l: any) => ({
      email: l.email,
      first_name: l.first_name || "",
      last_name: l.last_name || "",
      company_name: l.company_name || "",
      custom_fields: {
        Title: l.job_title || "",
        LinkedIn: l.linkedin_url || "",
        Company_Domain: l.company_domain || "",
        Company_Industry: l.company_industry || "",
        [`situation_line_a_${campaignId}`]: l.situation_line_a || "",
        [`value_line_a_${campaignId}`]: l.value_line_a || "",
        [`cta_line_a_${campaignId}`]: l.cta_line_a || "",
        [`situation_line_b_${campaignId}`]: l.situation_line_b || "",
        [`value_line_b_${campaignId}`]: l.value_line_b || "",
        [`cta_line_b_${campaignId}`]: l.cta_line_b || "",
        [`situation_line_c_${campaignId}`]: l.situation_line_c || "",
        [`value_line_c_${campaignId}`]: l.value_line_c || "",
        [`cta_line_c_${campaignId}`]: l.cta_line_c || "",
      },
    }));
    try {
      await slPost(`/campaigns/${campaignId}/leads`, { lead_list: batch });
      uploaded += batch.length;
    } catch (err: any) {
      console.error(`    batch ${Math.floor(i / LEADS_BATCH) + 1}: ${err.message.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`  Uploaded ${uploaded} leads`);

  // 5. Settings + schedule
  await slPost(`/campaigns/${campaignId}/settings`, {
    track_settings: ["DONT_TRACK_EMAIL_OPEN", "DONT_TRACK_LINK_CLICK"],
    stop_lead_settings: "REPLY_TO_AN_EMAIL",
    send_as_plain_text: false,
    enable_ai_esp_matching: false,
  });
  await slPost(`/campaigns/${campaignId}/schedule`, {
    timezone: "America/New_York",
    days_of_the_week: [1, 2, 3, 4, 5],
    start_hour: "08:00",
    end_hour: "17:00",
    min_time_btw_emails: 8,
    max_new_leads_per_day: 1000,
  });

  // 6. Activate
  if (args.activate) {
    await slPost(`/campaigns/${campaignId}/status`, { status: "START" });
    console.error(`  Campaign #${campaignId} is LIVE`);
  } else {
    console.error(`  Campaign #${campaignId} created in DRAFT`);
  }

  // 7. Save local experiment log
  const result = {
    smartlead_campaign_id: campaignId,
    campaign_name: campaignName,
    domain: args.domain,
    date: today,
    inboxes_assigned: inboxes,
    variants,
    lead_count_uploaded: uploaded,
    launched_at: new Date().toISOString(),
    status: args.activate ? "launched" : "draft",
  };
  if (args.experimentLog) {
    mkdirSync(dirname(args.experimentLog), { recursive: true });
    writeFileSync(args.experimentLog, JSON.stringify(result, null, 2));
    console.error(`  Wrote experiment log to ${args.experimentLog}`);
  }

  console.log(JSON.stringify({ campaignId, inboxCount: inboxes.length, leadsUploaded: uploaded }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
