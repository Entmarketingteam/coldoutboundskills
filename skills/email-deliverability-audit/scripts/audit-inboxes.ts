#!/usr/bin/env tsx
/**
 * Pull inbox inventory from Smartlead and write to CSV.
 *
 * Usage:
 *   export SMARTLEAD_API_KEY=xxx
 *   npx tsx scripts/audit-inboxes.ts --all --out=/tmp/audit/inboxes.csv
 *   npx tsx scripts/audit-inboxes.ts --tag=active --out=/tmp/audit/active.csv
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const API_BASE = "https://server.smartlead.ai/api/v1";
const API_KEY = process.env.SMARTLEAD_API_KEY;
if (!API_KEY) {
  console.error("Missing env var: SMARTLEAD_API_KEY");
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const maxRaw = get("--max-inboxes");
  let maxInboxes = Infinity;
  if (maxRaw !== undefined) {
    maxInboxes = Number(maxRaw);
    if (!Number.isFinite(maxInboxes) || maxInboxes < 1) {
      console.error(`--max-inboxes must be a positive number, got: ${maxRaw}`);
      process.exit(1);
    }
  }
  return {
    all: args.includes("--all"),
    tag: get("--tag"),
    domain: get("--domain"),
    maxInboxes,
    out: get("--out") ?? "/tmp/audit/inboxes.csv",
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
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
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

async function listAll(maxInboxes: number = Infinity): Promise<any[]> {
  const all: any[] = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const url = `${API_BASE}/email-accounts?api_key=${API_KEY}&offset=${offset}&limit=${limit}`;
    const batch = await fetchJson(url);
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...batch);
    console.error(`  offset=${offset} total_so_far=${all.length}`);
    if (all.length >= maxInboxes) {
      all.length = Math.min(all.length, maxInboxes);
      break;
    }
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

function rowFor(i: any) {
  const email = i.from_email || i.email || "";
  const domain = email.split("@")[1] || "";
  const w = i.warmup_details ?? {};
  return {
    id: i.id,
    email,
    domain,
    from_name: i.from_name || "",
    tags: (i.tags ?? []).map((t: any) => t.name).join("|"),
    warmup_status: w.status ?? "",
    warmup_reputation: w.warmup_reputation ?? "",
    max_warmup_per_day: w.max_email_per_day ?? "",
    total_warmup_sent: w.total_sent_count ?? "",
    is_warmup_blocked: !!w.is_warmup_blocked,
    message_per_day: i.message_per_day ?? "",
    daily_sent_count: i.daily_sent_count ?? 0,
    is_smtp_success: !!i.is_smtp_success,
    is_imap_success: !!i.is_imap_success,
    smtp_host: i.smtp_host ?? "",
    client_id: i.client_id ?? "",
  };
}

async function main() {
  const { all: wantAll, tag, domain, out, maxInboxes } = parseArgs();
  if (!wantAll && !tag && !domain) {
    console.error("Provide --all, --tag=..., or --domain=...");
    process.exit(1);
  }
  let inboxes = await listAll(maxInboxes);
  if (tag) inboxes = inboxes.filter((i) => (i.tags ?? []).some((t: any) => t.name === tag));
  if (domain)
    inboxes = inboxes.filter((i) => (i.from_email || i.email || "").endsWith(`@${domain}`));
  const rows = inboxes.map(rowFor);
  if (!rows.length) {
    const selector = wantAll ? "--all" : tag ? `--tag=${tag}` : `--domain=${domain}`;
    console.error(`No inboxes matched ${selector}. ${out} was NOT written.`);
    process.exit(1);
  }
  const header = Object.keys(rows[0]);
  const csv = [header.join(",")];
  for (const r of rows) {
    csv.push(header.map((h) => `"${String((r as any)[h]).replace(/"/g, '""')}"`).join(","));
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, csv.join("\n"));
  console.error(`Wrote ${out} — ${rows.length} inboxes`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
