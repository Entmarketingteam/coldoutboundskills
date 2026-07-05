#!/usr/bin/env tsx
/**
 * Phase 4: Email waterfall + description enrichment + MV validation.
 *
 * - For leads missing email: hit Prospeo enrich-person
 * - For leads with thin company_description: scrape their company domain
 * - Validate all candidate emails with MillionVerifier (only "ok" emails kept)
 *
 * Usage:
 *   export PROSPEO_API_KEY=xxx
 *   export MILLIONVERIFIER_API_KEY=xxx
 *   npx tsx scripts/phase-enrich.ts --leads-file=/tmp/auto/leads.json --out=/tmp/auto/enriched.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { dirname } from "path";

const PROSPEO_KEY = process.env.PROSPEO_API_KEY;
const MV_KEY = process.env.MILLIONVERIFIER_API_KEY;
if (!PROSPEO_KEY) {
  console.error("Missing env: PROSPEO_API_KEY");
  process.exit(1);
}
if (!MV_KEY) {
  console.error("Warning: MILLIONVERIFIER_API_KEY not set — skipping validation");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const enrichConcurrency = Number(get("--concurrency") ?? 5);
  if (!Number.isInteger(enrichConcurrency) || enrichConcurrency < 1) {
    console.error("--concurrency must be a positive integer");
    process.exit(1);
  }
  return {
    leadsFile: get("--leads-file"),
    out: get("--out") ?? "/tmp/auto/enriched.json",
    enrichConcurrency,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bounded retry with exponential backoff on 429/5xx/network errors
// (pattern from cold-email-starter-kit/scripts/_lib.ts retry()).
// NOTE: never include the request URL in errors/logs — MV puts the API key in the query string.
async function fetchWithRetry(url: string, init: RequestInit, label: string, timeoutMs = 30000, attempts = 5): Promise<Response> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error(`${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
      } else {
        return resp;
      }
    } catch (e: any) {
      lastErr = new Error(`${label}: ${e?.message ?? e}`);
    }
    if (i < attempts - 1) await sleep(Math.min(1000 * 2 ** i, 30000));
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr?.message ?? lastErr}`);
}

async function enrichEmail(lead: any): Promise<string> {
  if (!lead.first_name || !lead.last_name || !lead.company_domain) return "";
  // 429/5xx retried with backoff inside fetchWithRetry; throws on exhaustion (counted as a failure, not a miss)
  const resp = await fetchWithRetry(
    "https://api.prospeo.io/email-finder",
    {
      method: "POST",
      headers: { "X-KEY": PROSPEO_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({
        first_name: lead.first_name,
        last_name: lead.last_name,
        company: lead.company_domain,
      }),
    },
    "[Prospeo email-finder]"
  );
  if (resp.status === 404) return ""; // genuine "email not found"
  if (!resp.ok) {
    throw new Error(`[Prospeo email-finder] ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
  }
  let data: any;
  try {
    data = await resp.json();
  } catch {
    throw new Error("[Prospeo email-finder] response was not valid JSON");
  }
  const email = data.response?.email || data.email || "";
  if (typeof email === "string" && email.includes("@")) return email;
  return "";
}

async function scrapeDescription(domain: string): Promise<string> {
  if (!domain) return "";
  try {
    const resp = await fetch(`https://${domain}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return "";
    const html = await resp.text();
    const meta = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if (meta && meta[1].length > 30) return meta[1].trim().slice(0, 500);
    const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
    if (og && og[1].length > 30) return og[1].trim().slice(0, 500);
    return "";
  } catch {
    return "";
  }
}

async function verifyEmail(email: string): Promise<"ok" | "invalid" | "skip"> {
  if (!MV_KEY) return "skip";
  // never log the URL here — it contains the MV API key
  try {
    const resp = await fetchWithRetry(
      `https://api.millionverifier.com/api/v3/?api=${MV_KEY}&email=${encodeURIComponent(email)}&timeout=10`,
      {},
      "[MV]",
      15000
    );
    if (!resp.ok) return "skip";
    let data: any;
    try {
      data = await resp.json();
    } catch {
      return "skip";
    }
    if (data.error) {
      console.error(`[MV] API error: ${String(data.error).slice(0, 150)}`);
      return "skip";
    }
    const result = data.resultcode ?? data.result;
    // account/API problems (no verdict at all) must not be treated as "invalid"
    if (result === undefined || result === null) return "skip";
    return result === 1 || result === "ok" ? "ok" : "invalid";
  } catch (e: any) {
    console.error(`[MV] request failed: ${(e?.message ?? String(e)).slice(0, 150)}`);
    return "skip";
  }
}

async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (t: T) => Promise<R>,
  failures?: string[]
): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx]);
      } catch (e: any) {
        // log the error message only — never keys/URLs
        const msg = (e?.message ?? String(e)).slice(0, 200);
        console.error(`  ! item ${idx} failed: ${msg}`);
        failures?.push(msg);
        out[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const { leadsFile, out, enrichConcurrency } = parseArgs();
  if (!leadsFile) {
    console.error("Usage: --leads-file=path [--out=path]");
    process.exit(1);
  }
  let data: any;
  try {
    data = JSON.parse(readFileSync(leadsFile, "utf8"));
  } catch (e: any) {
    console.error(`Cannot read leads file ${leadsFile}: ${e?.message ?? e}`);
    process.exit(1);
  }
  const leads: any[] = data.leads || data;
  if (!Array.isArray(leads) || !leads.length) {
    console.error(`Leads file ${leadsFile} contains no leads`);
    process.exit(1);
  }

  // Progress checkpoint: paid enrich/verify results are persisted so a crashed
  // run resumes instead of re-spending Prospeo/MV credits from scratch.
  mkdirSync(dirname(out), { recursive: true });
  const progressFile = `${out}.progress.json`;
  let progress: { enrich: Record<string, string>; verify: Record<string, string> } = { enrich: {}, verify: {} };
  if (existsSync(progressFile)) {
    try {
      progress = JSON.parse(readFileSync(progressFile, "utf8"));
      progress.enrich ??= {};
      progress.verify ??= {};
      console.error(`[Enrich] Resuming from ${progressFile}`);
    } catch {
      console.error(`[Enrich] Ignoring unreadable checkpoint ${progressFile}`);
    }
  }
  let completedSinceSave = 0;
  const record = (section: "enrich" | "verify", key: string, value: string) => {
    progress[section][key] = value;
    if (++completedSinceSave % 50 === 0) writeFileSync(progressFile, JSON.stringify(progress));
  };
  const keyOf = (l: any) => l.linkedin_url || `${l.first_name}|${l.last_name}|${l.company_domain}`;

  let alreadyHad = 0,
    enrichHits = 0,
    enrichMisses = 0;

  // 1. Email waterfall — only enrich leads without email
  console.error(`[Enrich] Running email waterfall on ${leads.length} leads...`);
  const needEmail = leads.filter((l) => !l.email || !l.email.includes("@"));
  alreadyHad = leads.length - needEmail.length;
  // Apply checkpointed results, only call the paid API for the rest
  const enrichTodo = needEmail.filter((l) => !(keyOf(l) in progress.enrich));
  for (const l of needEmail) {
    const cached = progress.enrich[keyOf(l)];
    if (cached) l.email = cached;
  }
  if (enrichTodo.length < needEmail.length) {
    console.error(`[Enrich] ${needEmail.length - enrichTodo.length} enrich results loaded from checkpoint`);
  }
  const enrichFailures: string[] = [];
  await pool(
    enrichTodo,
    enrichConcurrency,
    async (l) => {
      const email = await enrichEmail(l);
      record("enrich", keyOf(l), email);
      if (email) l.email = email;
      return email;
    },
    enrichFailures
  );
  enrichHits = needEmail.filter((l) => l.email && l.email.includes("@")).length;
  enrichMisses = needEmail.length - enrichHits - enrichFailures.length;
  writeFileSync(progressFile, JSON.stringify(progress));
  console.error(
    `[Enrich] Already had: ${alreadyHad}, Prospeo enrich hits: ${enrichHits}, misses: ${enrichMisses}, failures: ${enrichFailures.length}`
  );

  // 2. Description enrichment for leads with thin desc
  console.error(`[Enrich] Enriching thin company descriptions...`);
  const needDesc = leads.filter(
    (l) => (!l.company_description || l.company_description.length < 50) && l.company_domain
  );
  const descResults = await pool(needDesc, enrichConcurrency, (l) => scrapeDescription(l.company_domain));
  let descHits = 0;
  needDesc.forEach((l, i) => {
    if (descResults[i]) {
      l.company_description = descResults[i];
      descHits++;
    }
  });
  console.error(`[Enrich] Description scrapes: ${descHits} / ${needDesc.length}`);

  // 3. Validate emails via MillionVerifier
  const withEmail = leads.filter((l) => l.email && l.email.includes("@"));
  let mvOk = 0,
    mvInvalid = 0,
    mvSkip = 0;
  if (MV_KEY) {
    console.error(`[Enrich] Validating ${withEmail.length} emails with MillionVerifier...`);
    const verifyTodo = withEmail.filter((l) => !(l.email in progress.verify));
    if (verifyTodo.length < withEmail.length) {
      console.error(`[Enrich] ${withEmail.length - verifyTodo.length} MV results loaded from checkpoint`);
    }
    await pool(verifyTodo, enrichConcurrency, async (l) => {
      const result = await verifyEmail(l.email);
      record("verify", l.email, result);
      return result;
    });
    writeFileSync(progressFile, JSON.stringify(progress));
    for (const l of withEmail) {
      const result = progress.verify[l.email] ?? "skip";
      if (result === "ok") mvOk++;
      else if (result === "invalid") {
        mvInvalid++;
        l.email = ""; // clear invalid emails
      } else mvSkip++;
    }
    console.error(`[Enrich] MV: ${mvOk} ok, ${mvInvalid} invalid, ${mvSkip} skip`);
  }

  const finalWithEmail = leads.filter((l) => l.email && l.email.includes("@"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        leads: finalWithEmail,
        allLeads: leads,
        stats: {
          total: leads.length,
          already_had_email: alreadyHad,
          enrich_hits: enrichHits,
          enrich_misses: enrichMisses,
          description_hits: descHits,
          mv_ok: mvOk,
          mv_invalid: mvInvalid,
          final_with_email: finalWithEmail.length,
        },
      },
      null,
      2
    )
  );
  console.error(`\nWrote ${out} — ${finalWithEmail.length} leads with valid email`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
