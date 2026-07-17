#!/usr/bin/env tsx
/**
 * Campaign + per-inbox sent + reply + bounce audit.
 *
 * Applies the 1% rule:
 *   - flag_low_reply = TRUE if sent >= 200 AND reply_rate < 1%
 *   - flag_high_bounce = TRUE if sent >= 50 AND bounce_rate > 3%
 *
 * Two output files:
 *   1. <out>-campaigns.csv — campaign-level aggregates (authoritative for 1% rule)
 *   2. <out>-inboxes.csv    — best-effort per-inbox stats from mailbox-statistics
 *
 * Progress is checkpointed to <out>-campaigns.checkpoint.jsonl — rerunning after
 * a crash resumes instead of re-pulling completed campaigns. The checkpoint is
 * deleted after a fully successful run.
 *
 * Usage:
 *   export SMARTLEAD_API_KEY=xxx
 *   npx tsx scripts/audit-performance.ts --out=/tmp/audit/performance
 *   npx tsx scripts/audit-performance.ts --client-id=5560 --out=/tmp/audit/perf
 *   npx tsx scripts/audit-performance.ts --campaign-ids=12345,67890 --out=/tmp/audit/perf
 */

import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  appendFileSync,
  unlinkSync,
} from "fs";
import { dirname } from "path";

const API_BASE = "https://server.smartlead.ai/api/v1";
const API_KEY = process.env.SMARTLEAD_API_KEY;
if (!API_KEY) {
  console.error("Missing env: SMARTLEAD_API_KEY");
  process.exit(1);
}

const LOW_REPLY_THRESHOLD = 1.0; // percent
const LOW_REPLY_MIN_SENT = 200;
const HIGH_BOUNCE_THRESHOLD = 3.0;
const HIGH_BOUNCE_MIN_SENT = 50;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const idsRaw = get("--campaign-ids");
  let campaignIds: number[] | undefined;
  if (idsRaw) {
    campaignIds = idsRaw.split(",").map((s) => {
      const token = s.trim();
      const n = Number(token);
      if (!Number.isInteger(n) || token === "") {
        console.error(`--campaign-ids contains a non-integer id: "${token}"`);
        process.exit(1);
      }
      return n;
    });
  }
  return {
    clientId: get("--client-id"),
    out: get("--out") ?? "/tmp/audit/performance",
    maxCampaigns: get("--max-campaigns") ? Number(get("--max-campaigns")) : Infinity,
    campaignIds,
  };
}

async function fetchJson(url: string): Promise<any> {
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
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
      const t = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`);
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

async function listCampaigns(clientId?: string): Promise<any[]> {
  const url = new URL(`${API_BASE}/campaigns`);
  url.searchParams.set("api_key", API_KEY!);
  if (clientId) url.searchParams.set("client_id", clientId);
  const data = await fetchJson(url.toString());
  return Array.isArray(data) ? data : data.data ?? [];
}

async function campaignAnalytics(id: number): Promise<any> {
  const url = `${API_BASE}/campaigns/${id}/analytics?api_key=${API_KEY}`;
  return fetchJson(url);
}

async function campaignMailboxStats(id: number): Promise<any[]> {
  const url = `${API_BASE}/campaigns/${id}/mailbox-statistics?api_key=${API_KEY}`;
  const data = await fetchJson(url);
  return Array.isArray(data) ? data : data.data ?? [];
}

async function campaignEmailAccounts(campaignId: number): Promise<any[]> {
  const url = `${API_BASE}/campaigns/${campaignId}/email-accounts?api_key=${API_KEY}`;
  const data = await fetchJson(url);
  return Array.isArray(data) ? data : data.data ?? [];
}

interface CampaignRow {
  campaign_id: number;
  name: string;
  status: string;
  sent: number;
  replies: number;
  bounces: number;
  reply_rate_pct: number;
  bounce_rate_pct: number;
  flag_low_reply: boolean;
  flag_high_bounce: boolean;
}

interface InboxRow {
  inbox_id: number;
  email: string;
  domain: string;
  sent: number;
  replies: number;
  bounces: number;
  reply_rate_pct: number;
  bounce_rate_pct: number;
  flag_low_reply: boolean;
  flag_high_bounce: boolean;
  campaigns: string;
}

interface CampaignFailure {
  campaign_id: number;
  error: string;
}

function toCsv<T>(rows: T[], headers: string[]): string {
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      headers
        .map((h) => `"${String((r as any)[h] ?? "").replace(/"/g, '""')}"`)
        .join(",")
    );
  }
  return lines.join("\n");
}

async function main() {
  const { clientId, out, maxCampaigns, campaignIds } = parseArgs();

  // 1. Pick campaigns
  let campaigns: any[];
  if (campaignIds?.length) {
    campaigns = campaignIds.map((id) => ({ id, name: `(campaign ${id})`, status: "N/A" }));
    console.error(`${campaigns.length} campaigns (from --campaign-ids)`);
  } else {
    const all = await listCampaigns(clientId);
    campaigns = all.filter((c) =>
      ["ACTIVE", "PAUSED", "COMPLETED"].includes(c.status)
    );
    if (isFinite(maxCampaigns)) campaigns = campaigns.slice(0, maxCampaigns);
    console.error(`${campaigns.length} active/paused/completed campaigns`);
  }

  // Load checkpoint from a previous interrupted run (resume instead of restart)
  mkdirSync(dirname(out), { recursive: true });
  const checkpointPath = `${out}-campaigns.checkpoint.jsonl`;
  const checkpointed = new Map<number, CampaignRow>();
  if (existsSync(checkpointPath)) {
    for (const line of readFileSync(checkpointPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as CampaignRow;
        if (row && typeof row.campaign_id === "number") checkpointed.set(row.campaign_id, row);
      } catch {
        // skip corrupt checkpoint line
      }
    }
    if (checkpointed.size)
      console.error(`Resuming: ${checkpointed.size} campaigns already in checkpoint ${checkpointPath}`);
  }

  // 2. Campaign-level aggregates (1% rule at campaign level)
  const campaignRows: CampaignRow[] = [];
  const analyticsFailures: CampaignFailure[] = [];
  console.error("\n=== Campaign-level stats ===");
  for (let i = 0; i < campaigns.length; i++) {
    const c = campaigns[i];
    const cached = checkpointed.get(c.id);
    if (cached) {
      campaignRows.push(cached);
      continue;
    }
    try {
      const a = await campaignAnalytics(c.id);
      const sent = Number(a.sent_count ?? 0);
      const replies = Number(a.reply_count ?? 0);
      const bounces = Number(a.bounce_count ?? 0);
      const replyRate = sent ? (replies / sent) * 100 : 0;
      const bounceRate = sent ? (bounces / sent) * 100 : 0;
      const row: CampaignRow = {
        campaign_id: c.id,
        name: a.name || c.name || "",
        status: a.status || c.status || "",
        sent,
        replies,
        bounces,
        reply_rate_pct: Number(replyRate.toFixed(2)),
        bounce_rate_pct: Number(bounceRate.toFixed(2)),
        flag_low_reply: sent >= LOW_REPLY_MIN_SENT && replyRate < LOW_REPLY_THRESHOLD,
        flag_high_bounce: sent >= HIGH_BOUNCE_MIN_SENT && bounceRate > HIGH_BOUNCE_THRESHOLD,
      };
      campaignRows.push(row);
      appendFileSync(checkpointPath, JSON.stringify(row) + "\n");
      if ((i + 1) % 10 === 0)
        console.error(`  ${i + 1}/${campaigns.length} analytics pulled`);
    } catch (err) {
      const msg = String(err).slice(0, 150);
      analyticsFailures.push({ campaign_id: c.id, error: msg });
      console.error(`  campaign ${c.id} analytics error: ${msg}`);
    }
  }
  campaignRows.sort((a, b) => b.sent - a.sent);

  if (!campaignRows.length) {
    console.error(
      `\nNo campaign analytics succeeded (${analyticsFailures.length}/${campaigns.length} failed). No CSVs written — check API key / campaign ids.`
    );
    process.exit(1);
  }

  // 3. Per-inbox aggregation (best-effort from mailbox-statistics + email-accounts)
  console.error("\n=== Per-inbox aggregation (best-effort) ===");
  const inboxAgg = new Map<
    number,
    { email: string; sent: number; replies: number; bounces: number; campaigns: Set<number> }
  >();
  const inboxFailures: CampaignFailure[] = [];
  const sampledCampaigns = campaignRows.filter((c) => c.sent > 0).slice(0, 50);
  // mailbox-statistics only returns recent events (capped ~20 rows) — use for recent per-inbox hints
  // For proper per-inbox aggregates across the whole campaign, campaign-level flagging is more reliable
  for (const c of sampledCampaigns) {
    try {
      const inboxes = await campaignEmailAccounts(c.campaign_id);
      for (const inb of inboxes) {
        if (!inboxAgg.has(inb.id)) {
          inboxAgg.set(inb.id, {
            email: inb.from_email || inb.email || "",
            sent: 0,
            replies: 0,
            bounces: 0,
            campaigns: new Set(),
          });
        }
        inboxAgg.get(inb.id)!.campaigns.add(c.campaign_id);
      }
      const stats = await campaignMailboxStats(c.campaign_id);
      for (const s of stats) {
        const id = s.email_account_id;
        if (id == null) continue;
        if (!inboxAgg.has(id)) {
          inboxAgg.set(id, {
            email: s.from_email || "",
            sent: 0,
            replies: 0,
            bounces: 0,
            campaigns: new Set(),
          });
        }
        const agg = inboxAgg.get(id)!;
        agg.sent += Number(s.sent_count ?? 0);
        agg.replies += Number(s.reply_count ?? 0);
        agg.bounces += Number(s.bounce_count ?? 0);
      }
    } catch (err) {
      const msg = String(err).slice(0, 150);
      inboxFailures.push({ campaign_id: c.campaign_id, error: msg });
      console.error(`  campaign ${c.campaign_id} inbox aggregation error: ${msg}`);
    }
  }
  const inboxRows: InboxRow[] = [];
  for (const [id, agg] of inboxAgg) {
    const replyRate = agg.sent ? (agg.replies / agg.sent) * 100 : 0;
    const bounceRate = agg.sent ? (agg.bounces / agg.sent) * 100 : 0;
    inboxRows.push({
      inbox_id: id,
      email: agg.email,
      domain: agg.email.split("@")[1] || "",
      sent: agg.sent,
      replies: agg.replies,
      bounces: agg.bounces,
      reply_rate_pct: Number(replyRate.toFixed(2)),
      bounce_rate_pct: Number(bounceRate.toFixed(2)),
      flag_low_reply: agg.sent >= LOW_REPLY_MIN_SENT && replyRate < LOW_REPLY_THRESHOLD,
      flag_high_bounce: agg.sent >= HIGH_BOUNCE_MIN_SENT && bounceRate > HIGH_BOUNCE_THRESHOLD,
      campaigns: [...agg.campaigns].join("|"),
    });
  }
  inboxRows.sort((a, b) => b.sent - a.sent);

  // 4. Write CSVs
  const campaignHeaders = [
    "campaign_id",
    "name",
    "status",
    "sent",
    "replies",
    "bounces",
    "reply_rate_pct",
    "bounce_rate_pct",
    "flag_low_reply",
    "flag_high_bounce",
  ];
  writeFileSync(`${out}-campaigns.csv`, toCsv(campaignRows, campaignHeaders));
  const inboxHeaders = [
    "inbox_id",
    "email",
    "domain",
    "sent",
    "replies",
    "bounces",
    "reply_rate_pct",
    "bounce_rate_pct",
    "flag_low_reply",
    "flag_high_bounce",
    "campaigns",
  ];
  writeFileSync(`${out}-inboxes.csv`, toCsv(inboxRows, inboxHeaders));

  // 5. Summary
  const totalSent = campaignRows.reduce((s, c) => s + c.sent, 0);
  const totalReplies = campaignRows.reduce((s, c) => s + c.replies, 0);
  const totalBounces = campaignRows.reduce((s, c) => s + c.bounces, 0);
  const fleetReply = totalSent ? (totalReplies / totalSent) * 100 : 0;
  const fleetBounce = totalSent ? (totalBounces / totalSent) * 100 : 0;
  const camp1pct = campaignRows.filter((c) => c.flag_low_reply).length;
  const campHiBounce = campaignRows.filter((c) => c.flag_high_bounce).length;
  const inb1pct = inboxRows.filter((r) => r.flag_low_reply).length;

  console.log(`\n=== Fleet Performance Summary ===\n`);
  console.log(`Campaigns audited:       ${campaignRows.length}`);
  console.log(`Total sent:              ${totalSent.toLocaleString()}`);
  console.log(`Total replies:           ${totalReplies.toLocaleString()}`);
  console.log(`Total bounces:           ${totalBounces.toLocaleString()}`);
  console.log(`Fleet reply rate:        ${fleetReply.toFixed(2)}%  ${fleetReply >= 1 ? "PASS" : "FAIL (below 1%)"}`);
  console.log(`Fleet bounce rate:       ${fleetBounce.toFixed(2)}%  ${fleetBounce <= 2 ? "PASS" : "FAIL (above 2%)"}`);
  console.log(`\nCampaigns failing 1% rule (≥200 sent, <1% reply):   ${camp1pct}`);
  console.log(`Campaigns with bounce >3% (≥50 sent):                  ${campHiBounce}`);
  console.log(`Inboxes (aggregated) failing 1% rule:                  ${inb1pct}`);

  const offenders = campaignRows.filter((c) => c.flag_low_reply).slice(0, 10);
  if (offenders.length) {
    console.log(`\nTop campaigns failing the 1% rule:`);
    console.log(`id       sent     reply%   name`);
    for (const o of offenders) {
      console.log(
        `${String(o.campaign_id).padEnd(8)} ${String(o.sent).padStart(5)}    ${String(o.reply_rate_pct).padStart(5)}%   ${o.name.slice(0, 60)}`
      );
    }
  }

  console.log(`\nOutputs:`);
  console.log(`  ${out}-campaigns.csv  (authoritative — use this for 1% rule)`);
  console.log(`  ${out}-inboxes.csv    (best-effort per-inbox aggregation)`);

  // 6. Failure report + exit code
  console.log(
    `\nFailures: ${analyticsFailures.length}/${campaigns.length} campaign analytics, ${inboxFailures.length}/${sampledCampaigns.length} inbox aggregations`
  );
  if (analyticsFailures.length || inboxFailures.length) {
    for (const f of analyticsFailures)
      console.error(`  analytics failed: campaign ${f.campaign_id}: ${f.error}`);
    for (const f of inboxFailures)
      console.error(`  inbox agg failed: campaign ${f.campaign_id}: ${f.error}`);
    console.error(
      `Checkpoint kept at ${checkpointPath} — rerun the same command to retry only the failed campaigns.`
    );
    process.exit(1);
  }
  if (existsSync(checkpointPath)) unlinkSync(checkpointPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
