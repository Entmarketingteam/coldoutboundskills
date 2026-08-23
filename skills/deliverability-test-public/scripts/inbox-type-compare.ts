#!/usr/bin/env tsx
/**
 * Compare reply / bounce rates across inbox types (Gmail / Outlook / SMTP)
 * for a Smartlead account.
 *
 * Usage:
 *   export SMARTLEAD_API_KEY=xxx
 *   npx tsx scripts/inbox-type-compare.ts [--client-id=5560] [--days=7] [--campaign-ids=1,2,3]
 *
 * Note: stats are pulled one campaign at a time; a crash mid-run restarts from
 * zero. On large accounts, use --campaign-ids to scope (or retry) a subset —
 * the failure report at the end prints the exact retry command.
 */

const API_BASE = "https://server.smartlead.ai/api/v1";
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
  const daysRaw = get("--days");
  const days = Number(daysRaw ?? 7);
  if (!Number.isInteger(days) || days < 1) {
    console.error(`--days must be a positive integer, got: ${daysRaw}`);
    process.exit(1);
  }
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
    days,
    campaignIds,
  };
}

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
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

async function listEmailAccounts(): Promise<any[]> {
  const all: any[] = [];
  let offset = 0;
  while (true) {
    const url = `${API_BASE}/email-accounts?api_key=${API_KEY}&offset=${offset}&limit=100`;
    const batch = await fetchJson(url);
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
    offset += 100;
  }
  return all;
}

async function listCampaigns(clientId?: string): Promise<any[]> {
  const url = new URL(`${API_BASE}/campaigns`);
  url.searchParams.set("api_key", API_KEY!);
  if (clientId) url.searchParams.set("client_id", clientId);
  const data = await fetchJson(url.toString());
  return Array.isArray(data) ? data : data.data ?? [];
}

async function campaignInboxStats(campaignId: number, startDate: string, endDate: string): Promise<any[]> {
  // Per-inbox performance for a campaign in date range
  const url = new URL(`${API_BASE}/campaigns/${campaignId}/sequence-analytics-by-email-account`);
  url.searchParams.set("api_key", API_KEY!);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  const data = await fetchJson(url.toString());
  return Array.isArray(data) ? data : data.data ?? [];
}

function classifyType(raw: string | undefined, host: string | undefined): string {
  const s = (raw || "").toUpperCase();
  if (s.includes("GMAIL") || s.includes("GOOGLE") || s === "G_SUITE" || (host || "").includes("google"))
    return "G Suite / Gmail";
  if (s.includes("OUTLOOK") || s.includes("OFFICE365") || s.includes("MICROSOFT") || (host || "").includes("outlook"))
    return "Office365 / Outlook";
  return "SMTP";
}

async function main() {
  const { clientId, days, campaignIds } = parseArgs();
  const endDate = dateNDaysAgo(0);
  const startDate = dateNDaysAgo(days);
  console.error(`Pulling inbox inventory + campaign stats from ${startDate} to ${endDate}...`);

  const accounts = await listEmailAccounts();
  const accountTypeById = new Map<number, string>();
  for (const a of accounts) {
    accountTypeById.set(a.id, classifyType(a.type, a.smtp_host));
  }
  console.error(`  ${accounts.length} inbox accounts, ${new Set(accountTypeById.values()).size} types`);

  let active: any[];
  if (campaignIds?.length) {
    active = campaignIds.map((id) => ({ id }));
    console.error(`  ${active.length} campaigns (from --campaign-ids)`);
  } else {
    const campaigns = await listCampaigns(clientId);
    active = campaigns.filter((c) => c.status === "ACTIVE" || c.status === "DRAFTED" || c.status === "PAUSED" || c.status === "COMPLETED");
    console.error(`  ${active.length} campaigns`);
  }

  type Bucket = { inboxes: Set<number>; sent: number; replies: number; bounces: number };
  const buckets = new Map<string, Bucket>();
  const bucketFor = (k: string) => {
    if (!buckets.has(k))
      buckets.set(k, { inboxes: new Set(), sent: 0, replies: 0, bounces: 0 });
    return buckets.get(k)!;
  };

  const failures: { campaign_id: number; error: string }[] = [];
  let processed = 0;
  for (const c of active) {
    processed++;
    if (processed % 20 === 0) console.error(`  ${processed}/${active.length} campaigns processed`);
    let rows: any[];
    try {
      rows = await campaignInboxStats(c.id, startDate, endDate);
    } catch (err) {
      failures.push({ campaign_id: c.id, error: String(err).slice(0, 150) });
      console.error(`  campaign ${c.id} stats error: ${String(err).slice(0, 150)}`);
      continue;
    }
    for (const r of rows) {
      const id = r.email_account_id ?? r.id;
      const type = accountTypeById.get(id) ?? "unknown";
      const b = bucketFor(type);
      b.inboxes.add(id);
      b.sent += Number(r.sent_count ?? r.sent ?? 0);
      b.replies += Number(r.replied_count ?? r.replies ?? 0);
      b.bounces += Number(r.bounced_count ?? r.bounces ?? 0);
    }
  }

  // Print table
  console.log(`\nInbox Type Comparison — last ${days} days\n`);
  console.log(
    `Type                 Inboxes    Sent    Replies  Bounces   Reply %   Bounce %`
  );
  console.log(
    `------------------   -------   ------   ------   ------   -------   --------`
  );

  let totalSent = 0,
    totalReplies = 0,
    totalBounces = 0,
    totalInboxes = 0;

  const sorted = [...buckets.entries()].sort((a, b) => b[1].sent - a[1].sent);
  for (const [type, b] of sorted) {
    const replyPct = b.sent ? ((b.replies / b.sent) * 100).toFixed(2) : "0.00";
    const bouncePct = b.sent ? ((b.bounces / b.sent) * 100).toFixed(2) : "0.00";
    console.log(
      `${type.padEnd(18)}    ${String(b.inboxes.size).padStart(5)}   ${String(b.sent).padStart(6)}   ${String(b.replies).padStart(6)}   ${String(b.bounces).padStart(6)}   ${replyPct.padStart(6)}%   ${bouncePct.padStart(6)}%`
    );
    totalSent += b.sent;
    totalReplies += b.replies;
    totalBounces += b.bounces;
    totalInboxes += b.inboxes.size;
  }

  console.log(
    `------------------   -------   ------   ------   ------   -------   --------`
  );
  const tReply = totalSent ? ((totalReplies / totalSent) * 100).toFixed(2) : "0.00";
  const tBounce = totalSent ? ((totalBounces / totalSent) * 100).toFixed(2) : "0.00";
  console.log(
    `TOTAL                 ${String(totalInboxes).padStart(5)}   ${String(totalSent).padStart(6)}   ${String(totalReplies).padStart(6)}   ${String(totalBounces).padStart(6)}   ${tReply.padStart(6)}%   ${tBounce.padStart(6)}%`
  );

  // Takeaways
  if (sorted.length > 1) {
    const best = [...sorted].sort(
      (a, b) => b[1].replies / Math.max(b[1].sent, 1) - a[1].replies / Math.max(a[1].sent, 1)
    )[0];
    const worst = [...sorted].sort(
      (a, b) => a[1].replies / Math.max(a[1].sent, 1) - b[1].replies / Math.max(b[1].sent, 1)
    )[0];
    console.log(`\nTakeaways:`);
    console.log(
      `- Best reply rate: ${best[0]} (${((best[1].replies / Math.max(best[1].sent, 1)) * 100).toFixed(2)}%)`
    );
    console.log(
      `- Worst reply rate: ${worst[0]} (${((worst[1].replies / Math.max(worst[1].sent, 1)) * 100).toFixed(2)}%)`
    );
    const highBounce = sorted.filter((s) => s[1].sent > 500 && s[1].bounces / s[1].sent > 0.03);
    for (const [type, b] of highBounce) {
      console.log(
        `- ${type} has elevated bounce rate (${((b.bounces / b.sent) * 100).toFixed(2)}%) — run /email-deliverability-audit on these domains`
      );
    }
  }

  // Failure report + exit code
  if (failures.length) {
    console.error(`\nWARNING: stats failed for ${failures.length}/${active.length} campaigns — table above is incomplete:`);
    for (const f of failures) console.error(`  campaign ${f.campaign_id}: ${f.error}`);
    console.error(
      `Retry just the failed campaigns with: --campaign-ids=${failures.map((f) => f.campaign_id).join(",")}`
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
