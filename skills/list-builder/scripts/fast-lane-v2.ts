#!/usr/bin/env tsx
/**
 * Fast Lane v2 — guess-and-validate email finding, run on our own engine.
 *
 * v1 ran the ladder inside a Clay workflow. That cost us the one control that
 * mattered: concurrency. Clay only exposes batch size, and the reachable
 * operating points were "178 concurrent / 43% punts / 240 per min" or
 * "46 concurrent / 33% punts / 20 per min". v2 owns the loop, so concurrency is
 * pinned and self-tunes on the punt rate.
 *
 * What v2 adds over v1:
 *   1. Domain PRE-FLIGHT — one sentinel probe per unique domain classifies it as
 *      catch-all / unverifiable / good. Bad domains cost 1 call instead of 6.
 *   2. Convention LEARNING — the first contact on a domain pays the full ladder;
 *      the rest try the learned pattern first (1 call). Only pays off on lists
 *      with several contacts per company, so it is measured and reported.
 *   3. Wrong-person GUARDS — bare-name patterns are refused on large employers
 *      (headcount from Prospeo /search-company), and any hit already cached
 *      under a DIFFERENT
 *      person is rejected.
 *   4. Adaptive CONCURRENCY — punt rate is the control variable, not batch size.
 *   5. Pluggable VALIDATOR — leadmagic | millionverifier, one per run, never mixed.
 *   6. Batched cache write-back — one upsert per 500 hits, not one per contact.
 *
 * Usage:
 *   npx tsx fast-lane-v2.ts --run=<slug> --csv=contacts.csv
 *        [--validator=leadmagic|millionverifier] [--conc=40] [--limit=N]
 *        [--no-preflight] [--no-writeback]
 *
 * Input CSV: first_name,last_name,domain[,company_name,linkedin_url]
 */
import https from "node:https";
import { URL } from "node:url";
import { execFileSync } from "node:child_process";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parseArgs, readCsv, writeCsv, loadEnv, prospeoSearch, prospeoCompanyRow } from "../../list-expander/scripts/lib";

loadEnv();

// ---------------------------------------------------------------- config

const args = parseArgs();
const run = String(args.run ?? "default");
const dir = join(homedir(), "output", "list-builder", run);
mkdirSync(dir, { recursive: true });
const VALIDATOR = String(args.validator ?? "leadmagic") as "leadmagic" | "millionverifier";
const START_CONC = Number(args.conc ?? 40);
const PREFLIGHT = !args["no-preflight"];
const WRITEBACK = !args["no-writeback"];

// A bare first name on a huge employer validates as deliverable while belonging
// to someone else (keith@ebay.com, singh@amazon.com). Refuse those.
const BARE_NAME_MAX_HEADCOUNT = 1000;
const BARE_PATTERNS = new Set(["first"]);

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Read an env var from the process env or a .env file (repo root, then ~/.env). */
function envOrNull(name: string): string | null {
  if (process.env[name]) return String(process.env[name]);
  for (const f of [join(process.cwd(), ".env"), join(homedir(), ".env")]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
    if (m) {
      const v = m[1].replace(/["']/g, "").trim();
      if (v) return v;
    }
  }
  return null;
}
function envVal(name: string): string {
  const v = envOrNull(name);
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const LM_KEY = VALIDATOR === "leadmagic" ? envVal("LEADMAGIC_API_KEY") : "";
const MV_KEY = VALIDATOR === "millionverifier" ? (envOrNull("MILLIONVERIFIER_API_KEY") ?? envVal("MILLION_VERIFIER_API_KEY")) : "";
// OPTIONAL email-cache database (Supabase or any PostgREST endpoint + Postgres URL).
// Unset ⇒ corroboration and cache write-back are skipped, everything else runs.
const SB_KEY = envOrNull("EMAIL_CACHE_SERVICE_KEY");
const SB_URL = envOrNull("EMAIL_CACHE_REST_URL");
const CACHE_DB_URL = envOrNull("EMAIL_CACHE_DB_URL");
if (!SB_KEY || !SB_URL) console.log("[cache] EMAIL_CACHE_REST_URL/EMAIL_CACHE_SERVICE_KEY not set — skipping cache write-back");
if (!CACHE_DB_URL) console.log("[cache] EMAIL_CACHE_DB_URL not set — skipping the wrong-person corroboration check");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- http
// keepAlive:false is deliberate — pooled sockets are the documented trigger for
// LeadMagic punt storms in long-lived processes.
const agent = new https.Agent({ keepAlive: false, maxSockets: 400 });

function request(
  method: string,
  urlStr: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs = 90000,
): Promise<{ status: number; body: string; headers: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        method,
        agent,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { "User-Agent": UA, ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers as any }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- validator

type Verdict = "valid" | "invalid" | "catch_all" | "unknown" | "error";

/**
 * `unknown` is NOT a verdict — for LeadMagic it means the server declined to
 * probe (and bills 0). Callers must treat it as "not tested", never as a miss.
 */
async function validate(email: string): Promise<{ verdict: Verdict; billed: boolean }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (VALIDATOR === "leadmagic") {
        const r = await request(
          "POST",
          "https://api.leadmagic.io/v1/people/email-validation",
          { "X-API-Key": LM_KEY, "Content-Type": "application/json" },
          JSON.stringify({ email }),
        );
        if (r.status === 429 || r.status >= 500) {
          const ra = Number(r.headers["retry-after"]) || 0;
          await sleep(ra ? ra * 1000 : 2500 * (attempt + 1));
          continue;
        }
        if (r.status !== 200) return { verdict: "error", billed: false };
        const j = JSON.parse(r.body);
        const s = String(j.email_status ?? "").toLowerCase();
        const billed = Number(j.credits_consumed ?? 0) > 0;
        if (s === "valid") return { verdict: "valid", billed };
        if (s === "invalid") return { verdict: "invalid", billed };
        if (s.includes("catch")) return { verdict: "catch_all", billed };
        // A 0-billed "unknown" is the server declining to probe, not a verdict.
        // Call-level punt rate is only ~8%, but a contact tries ~5 candidates, so
        // ~35% of contacts hit at least one punt and get abandoned. Retrying the
        // SAME candidate inline collapses that back to near zero.
        if (!billed && attempt < 2) {
          await sleep(1200 * (attempt + 1));
          continue;
        }
        return { verdict: "unknown", billed };
      } else {
        const r = await request(
          "GET",
          `https://api.millionverifier.com/api/v3/?api=${MV_KEY}&email=${encodeURIComponent(email)}&timeout=20`,
          {},
        );
        if (r.status === 429 || r.status >= 500) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        if (r.status !== 200) return { verdict: "error", billed: false };
        const j = JSON.parse(r.body);
        const s = String(j.result ?? "").toLowerCase();
        // MV `error` is a credit-gap signal, not a verdict — retry it
        if (s === "error") {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        if (s === "ok") return { verdict: "valid", billed: true };
        if (s === "invalid" || s === "disposable") return { verdict: "invalid", billed: true };
        if (s === "catch_all") return { verdict: "catch_all", billed: true };
        return { verdict: "unknown", billed: true };
      }
    } catch {
      await sleep(1500 * (attempt + 1));
    }
  }
  return { verdict: "error", billed: false };
}

// ---------------------------------------------------------------- concurrency
// Punt rate is the control variable. v1 hand-tuned batch size three times and
// still never found the safe operating point; this converges on it.
class Pool {
  size: number;
  private active = 0;
  private q: (() => void)[] = [];
  private window: boolean[] = [];

  constructor(size: number) {
    this.size = size;
  }
  private next() {
    while (this.active < this.size && this.q.length) {
      this.active++;
      this.q.shift()!();
    }
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((r) => this.q.push(r));
    else this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.next();
    }
  }
  /** feed each result's "was this a punt" so the pool can retune itself */
  record(punt: boolean) {
    this.window.push(punt);
    if (this.window.length < 120) return;
    const rate = this.window.filter(Boolean).length / this.window.length;
    const before = this.size;
    if (rate > 0.25) this.size = Math.max(8, Math.floor(this.size * 0.6));
    else if (rate < 0.1) this.size = Math.min(90, this.size + 6);
    this.window = [];
    if (this.size !== before)
      console.log(`  [pool] punt rate ${(rate * 100).toFixed(0)}% -> concurrency ${before} => ${this.size}`);
    this.next();
  }
}

// ---------------------------------------------------------------- permutations

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "phd", "md", "mba", "cpa", "esq", "dds", "rn", "jd", "dvm", "do", "pe"]);
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "sir", "rev", "capt", "lt", "col", "gen", "hon"]);

const clean = (s: string) =>
  (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/gi, "o").replace(/ł/gi, "l").replace(/æ/gi, "ae").replace(/œ/gi, "oe").replace(/ß/g, "ss").replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

function tokens(raw: string): string[] {
  if (!raw) return [];
  return raw.replace(/\(.*?\)/g, " ").split(",")[0]
    .split(/[\s._-]+/).map(clean)
    .filter((t) => t && !SUFFIXES.has(t) && !TITLES.has(t));
}

export function bareDomain(d: string): string {
  if (!d) return "";
  let x = String(d).trim().toLowerCase().replace(/^[a-z]+:\/\//, "");
  x = x.split("/")[0].split("?")[0].split("@").pop()!;
  x = x.replace(/^www\d*\./, "").replace(/[^a-z0-9.\-]/g, "");
  return x.includes(".") && !x.startsWith(".") && !x.endsWith(".") ? x : "";
}

// measured over 44,543 validated cache rows; `last` and `fl` dropped for
// wrong-person risk, `first_last`/`first-last` are ~0.36% combined and excluded
const PATTERNS: [string, (f: string, l: string) => string][] = [
  ["flast", (f, l) => f[0] + l],
  ["first.last", (f, l) => `${f}.${l}`],
  ["first", (f) => f],
  ["firstl", (f, l) => f + l[0]],
  ["f.last", (f, l) => `${f[0]}.${l}`],
  ["firstlast", (f, l) => f + l],
];

function candidates(first_name: string, last_name: string, domain: string) {
  let ft = tokens(first_name);
  let lt = tokens(last_name);
  const dom = bareDomain(domain);
  if (ft.length > 1 && !lt.length) { lt = [ft[ft.length - 1]]; ft = [ft[0]]; }
  const f = ft[0] ?? "";
  const l = lt[lt.length - 1] ?? "";
  if (!f || !l || !dom) return { ok: false as const, dom, list: [] as { pat: string; email: string }[] };
  const seen = new Set<string>();
  const list: { pat: string; email: string }[] = [];
  for (const [pat, fn] of PATTERNS) {
    const loc = fn(f, l);
    if (loc && !seen.has(loc)) { seen.add(loc); list.push({ pat, email: `${loc}@${dom}` }); }
  }
  return { ok: true as const, dom, list };
}

// ---------------------------------------------------------------- enrichers

/** Company headcount for the bare-name guard, via Prospeo /search-company.
 *  Returns null on any miss/error — the guard then simply does not fire. */
async function headcount(domain: string): Promise<number | null> {
  try {
    const r = await prospeoSearch("search-company", { company: { websites: { include: [domain] } } });
    if (r.error || !r.results?.length) return null;
    const hc = Number(prospeoCompanyRow(r.results[0]).employee_count ?? 0);
    return Number.isFinite(hc) && hc > 0 ? hc : null;
  } catch { return null; }
}

function psql(sql: string): string[] {
  const url = CACHE_DB_URL;
  if (!url) throw new Error("EMAIL_CACHE_DB_URL not set");
  return execFileSync("psql", [url, "-At", "-c", sql], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .split("\n").filter(Boolean);
}

/**
 * Reject a hit that is already cached under a DIFFERENT person. This is the
 * cheapest defence against the wrong-person failure and runs batched, off the
 * hot path — not a per-contact lookup.
 */
function corroborate(hits: { email: string; first: string; last: string }[]): Map<string, string> {
  const bad = new Map<string, string>();
  if (!CACHE_DB_URL) return bad;
  for (let i = 0; i < hits.length; i += 400) {
    const chunk = hits.slice(i, i + 400);
    const list = chunk.map((h) => `'${h.email.replace(/'/g, "''")}'`).join(",");
    if (!list) continue;
    let out: string[];
    try {
      out = psql(
        `SELECT lower(email)||'|'||coalesce(lower(firstname),'')||'|'||coalesce(lower(lastname),'')
         FROM public."Email Database Cache" WHERE lower(email) IN (${list.toLowerCase()});`,
      );
    } catch { continue; }
    const owner = new Map<string, [string, string]>();
    for (const line of out) {
      const [em, fn, ln] = line.split("|");
      if (fn || ln) owner.set(em, [fn, ln]);
    }
    for (const h of chunk) {
      const o = owner.get(h.email.toLowerCase());
      if (!o) continue;
      const [ofn, oln] = o;
      const sameLast = oln && clean(oln) === clean(h.last);
      const sameFirst = ofn && clean(ofn) === clean(h.first);
      // cached under a clearly different human -> refuse
      if (oln && ofn && !sameLast && !sameFirst) bad.set(h.email, `${ofn} ${oln}`);
    }
  }
  return bad;
}

async function upsertCache(rows: any[]) {
  if (!SB_URL || !SB_KEY) return;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    try {
      const r = await request(
        "POST",
        `${SB_URL}/rest/v1/Email%20Database%20Cache`,
        {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        JSON.stringify(chunk),
        60000,
      );
      if (r.status >= 300) console.log(`  [cache] upsert HTTP ${r.status}: ${r.body.slice(0, 200)}`);
    } catch (e: any) { console.log(`  [cache] upsert failed: ${e.message}`); }
  }
}

// ---------------------------------------------------------------- main

type Row = Record<string, string>;

async function main() {
  const csvPath = String(args.csv ?? join(dir, "contacts.csv"));
  if (!args.csv && !existsSync(csvPath)) {
    console.error("Usage: npx tsx fast-lane-v2.ts --run=<slug> --csv=contacts.csv\n" +
      "  [--validator=leadmagic|millionverifier] [--conc=40] [--limit=N] [--no-preflight] [--no-writeback]\n" +
      "  Input CSV columns: first_name,last_name,domain[,company_name,linkedin_url]");
    process.exit(1);
  }
  let rows = readCsv(csvPath) as Row[];
  if (args.limit) rows = rows.slice(0, Number(args.limit));

  const resultsPath = join(dir, `v2-results-${VALIDATOR}.jsonl`);
  const done = new Set<string>();
  if (existsSync(resultsPath))
    for (const l of readFileSync(resultsPath, "utf8").split("\n").filter(Boolean))
      done.add(JSON.parse(l).key);

  const work = rows
    .map((r) => ({ r, key: `${clean(r.first_name)}|${clean(r.last_name)}|${bareDomain(r.domain)}` }))
    .filter((x) => x.key.split("|").every(Boolean) && !done.has(x.key));

  const byDomain = new Map<string, typeof work>();
  for (const w of work) {
    const d = bareDomain(w.r.domain);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d)!.push(w);
  }
  const density = work.length / Math.max(byDomain.size, 1);
  console.log(`validator=${VALIDATOR}  contacts=${work.length}  domains=${byDomain.size}  density=${density.toFixed(2)}/domain`);
  console.log(density < 1.3
    ? "  convention learning will barely help on this list (near-unique domains) — expected"
    : "  convention learning should pay off here");

  const pool = new Pool(START_CONC);
  const stats = { calls: 0, preflightCalls: 0, hits: 0, tested: 0, untested: 0, skippedDomain: 0, guardRejects: 0, sentinelPunts: 0, errors: 0 };
  const pending: any[] = [];
  let flushed = 0;

  // Incremental write-back: a killed run must not lose the emails it already found.
  // The corroboration guard still runs at the end over the full set.
  const flushHits = async (batch: any[]) => {
    const today = new Date().toISOString().slice(0, 10);
    await upsertCache(batch.map((p) => ({
      email: p.email,
      firstname: p.first || undefined,
      lastname: p.last || undefined,
      company_domain: p.dom || undefined,
      company_name: p.row.company_name || undefined,
      person_linkedin_URL: p.row.linkedin_url || undefined,
      last_verified_date: today,
      Domain_Validation_Status: "ok",
      type: `fast_lane_v2_${VALIDATOR}_valid`,
    })));
    console.log(`  [cache] flushed ${batch.length} hits`);
  };
  const t0 = Date.now();
  let processed = 0;

  const record = (key: string, r: Row, email: string, source: string, conf: string, checked: number) => {
    appendFileSync(resultsPath, JSON.stringify({ key, email, source, confidence: conf, checked, row: r }) + "\n");
    processed++;
    if (email) stats.hits++;
    if (processed % 250 === 0) {
      const mins = (Date.now() - t0) / 60000;
      console.log(
        `  ${processed}/${work.length} | hits ${stats.hits} | calls ${stats.calls} | conc ${pool.size} | ${(processed / mins).toFixed(0)}/min`,
      );
    }
  };

  const check = async (email: string) => {
    stats.calls++;
    const v = await validate(email);
    if (v.verdict === "error") stats.errors++;
    // count errors as well as punts: a timeout storm is exactly when the pool
    // must shrink, and watching only `unknown` left it blind to them
    pool.record(v.verdict === "unknown" || v.verdict === "error");
    return v;
  };

  // one domain's contacts, resolved together so the convention is learned once
  const doDomain = async (dom: string, items: typeof work) => {
    // --- pre-flight: classify the domain with a single sentinel probe
    let hc: number | null = null;
    if (PREFLIGHT) {
      const sentinel = `zq7x2k9v${Math.floor(Math.random() * 1e6)}@${dom}`;
      stats.preflightCalls++;
      const s = await pool.run(() => check(sentinel));
      if (s.verdict === "valid" || s.verdict === "catch_all") {
        stats.skippedDomain += items.length;
        for (const it of items) record(it.key, it.r, "", "catch_all_domain", "n/a", 1);
        return;
      }
      // A punted sentinel means the provider declined ONE probe — it is not
      // evidence the domain is unverifiable. Discarding the domain here threw
      // away ~half the list. Fall through to the ladder instead; the real
      // candidates often resolve fine.
      if (s.verdict === "unknown" || s.verdict === "error") stats.sentinelPunts++;
    }

    let learned: string | null = null;
    for (const it of items) {
      const c = candidates(it.r.first_name, it.r.last_name, it.r.domain);
      if (!c.ok) { record(it.key, it.r, "", "no_candidates", "n/a", 0); continue; }

      // learned convention first, then the measured-frequency ladder
      const ordered = learned
        ? [...c.list.filter((x) => x.pat === learned), ...c.list.filter((x) => x.pat !== learned)]
        : c.list;

      let found = "", pat = "", checked = 0, sawUnknown = false, sawError = false, catchAll = false;
      for (const cand of ordered) {
        // wrong-person guard: refuse a bare first name at a large employer
        if (BARE_PATTERNS.has(cand.pat)) {
          if (hc === null) hc = await pool.run(() => headcount(dom));
          if (hc !== null && hc > BARE_NAME_MAX_HEADCOUNT) { stats.guardRejects++; continue; }
        }
        checked++;
        const v = await pool.run(() => check(cand.email));
        if (v.verdict === "valid") { found = cand.email; pat = cand.pat; break; }
        if (v.verdict === "catch_all") { catchAll = true; break; }
        if (v.verdict === "unknown") sawUnknown = true;
        if (v.verdict === "error") sawError = true;
      }

      if (found) {
        learned ??= pat;
        stats.tested++;
        const conf = pat === "first" ? "medium" : "high";
        record(it.key, it.r, found, `fast_lane_v2:${pat}`, conf, checked);
        pending.push({ email: found, first: it.r.first_name, last: it.r.last_name, row: it.r, dom, conf });
        if (WRITEBACK && pending.length - flushed >= 200) {
          const batch = pending.slice(flushed);
          flushed = pending.length;
          void flushHits(batch);
        }
      } else if (catchAll) {
        record(it.key, it.r, "", "catch_all_domain", "n/a", checked);
      } else if (sawUnknown || sawError) {
        stats.untested++;
        record(it.key, it.r, "", sawError ? "transport_error" : "inconclusive_provider_punt", "n/a", checked);
      } else {
        stats.tested++;
        record(it.key, it.r, "", "exhausted", "n/a", checked);
      }
    }
  };

  // domains are independent; the pool bounds real concurrency, so fan them out
  const domains = [...byDomain.entries()];
  // Lanes must comfortably exceed pool size or THEY become the limiter: each lane
  // walks one domain's ladder sequentially, so N lanes generate only ~N in-flight
  // calls. Over-provisioning is safe — surplus lanes just block on the pool.
  const LANES = Math.max(64, Math.floor(START_CONC * 4));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: LANES }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= domains.length) return;
        const [dom, items] = domains[i];
        try { await doDomain(dom, items); }
        catch (e: any) { for (const it of items) record(it.key, it.r, "", `error:${e.message}`.slice(0, 60), "n/a", 0); }
      }
    }),
  );

  // ---- correctness guard + batched write-back
  console.log(`\ncorroborating ${pending.length} hits against the cache...`);
  const bad = corroborate(pending.map((p) => ({ email: p.email, first: p.first, last: p.last })));
  const clean_ = pending.filter((p) => !bad.has(p.email));
  if (bad.size) {
    console.log(`  REJECTED ${bad.size} hits already cached under a different person:`);
    for (const [em, who] of [...bad].slice(0, 10)) console.log(`    ${em} -> cached as ${who}`);
  }

  if (WRITEBACK && clean_.length) {
    const today = new Date().toISOString().slice(0, 10);
    await upsertCache(clean_.map((p) => ({
      email: p.email,
      firstname: p.first,
      lastname: p.last,
      company_domain: p.dom,
      company_name: p.row.company_name || undefined,
      person_linkedin_URL: p.row.linkedin_url || undefined,
      last_verified_date: today,
      Domain_Validation_Status: "ok",
      type: `fast_lane_v2_${VALIDATOR}_valid`,
    })));
    console.log(`  wrote ${clean_.length} rows to Email Database Cache`);
  }

  // ---- report
  const all = readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const hits = all.filter((r) => r.email && !bad.has(r.email));
  const untested = all.filter((r) => ["inconclusive_provider_punt", "domain_unverifiable"].includes(r.source));
  const tested = all.length - untested.length;
  const mins = (Date.now() - t0) / 60000;
  const byPat: Record<string, number> = {};
  for (const h of hits) byPat[h.source] = (byPat[h.source] ?? 0) + 1;

  writeCsv(join(dir, `v2-found-${VALIDATOR}.csv`), hits.map((h) => ({ ...h.row, email: h.email, email_source: h.source, confidence: h.confidence })));
  writeCsv(join(dir, `v2-untested-${VALIDATOR}.csv`), untested.map((h) => h.row));

  console.log(`\n=== Fast Lane v2 (${VALIDATOR}) ===`);
  console.log(`processed        ${all.length} in ${mins.toFixed(1)} min (${(all.length / mins).toFixed(0)}/min)`);
  console.log(`found            ${hits.length}`);
  console.log(`  of TESTED      ${((100 * hits.length) / Math.max(tested, 1)).toFixed(1)}%   (tested=${tested})`);
  console.log(`  of ALL         ${((100 * hits.length) / Math.max(all.length, 1)).toFixed(1)}%`);
  console.log(`untested         ${untested.length} (punt or unverifiable domain)`);
  console.log(`validator calls  ${stats.calls} (${(stats.calls / Math.max(all.length, 1)).toFixed(2)}/contact, ${stats.preflightCalls} preflight)`);
  console.log(`domain skips     ${stats.skippedDomain} contacts behind catch-all domains`);
  console.log(`transport errors ${stats.errors} calls failed after retries (timeout/5xx)`);
  console.log(`sentinel punts   ${stats.sentinelPunts} domains whose preflight was inconclusive (ladder ran anyway)`);
  console.log(`guard rejects    ${stats.guardRejects} bare-name candidates refused on large employers`);
  console.log(`corroboration    ${bad.size} hits rejected as a different person`);
  console.log(`final concurrency ${pool.size}`);
  console.log(`hits by pattern  `, byPat);
}

main().catch((e) => { console.error(e); process.exit(1); });
