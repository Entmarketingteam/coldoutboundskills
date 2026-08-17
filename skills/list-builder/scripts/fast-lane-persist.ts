#!/usr/bin/env tsx
/**
 * Persist Fast Lane v2 hits to the Email Database Cache.
 *
 * v2 originally only wrote back at end-of-run, so any interrupted run lost its
 * hits (1,224 emails were stranded on disk on 2026-08-11). This recovers them,
 * and applies the corroboration guard that also only ran at end-of-run.
 *
 * Usage: npx tsx fast-lane-persist.ts <run-slug>[,<run-slug>...] [--dry]
 */
import https from "node:https";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const runs = (process.argv[2] ?? "").split(",").filter(Boolean).filter((r) => !r.startsWith("--"));
const DRY = process.argv.includes("--dry");
if (!runs.length) {
  console.error("Usage: npx tsx fast-lane-persist.ts <run-slug>[,<run-slug>...] [--dry]\n" +
    "  Persists fast-lane-v2 hits to your own email cache. REQUIRES EMAIL_CACHE_REST_URL,\n" +
    "  EMAIL_CACHE_SERVICE_KEY and EMAIL_CACHE_DB_URL — without that table there is nothing to persist to.");
  process.exit(1);
}

function envVal(name: string): string {
  if (process.env[name]) return String(process.env[name]);
  for (const f of [join(process.cwd(), ".env"), join(homedir(), ".env")]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
    if (m) { const v = m[1].replace(/["']/g, "").trim(); if (v) return v; }
  }
  throw new Error(`missing env ${name}`);
}
// The email cache is OPTIONAL infrastructure (a Supabase/PostgREST table named
// "Email Database Cache"). Without it there is nothing to persist to — say so and stop.
const SB_HOST = envVal("EMAIL_CACHE_REST_URL").replace(/^https?:\/\//, "").replace(/\/$/, "");
const SB_KEY = envVal("EMAIL_CACHE_SERVICE_KEY");
const DB_URL = envVal("EMAIL_CACHE_DB_URL");
const clean = (s: string) => (s || "").normalize("NFKD").toLowerCase().replace(/[^a-z]/g, "");

type Hit = { email: string; first: string; last: string; dom: string; company: string; li: string; validator: string };
const hits = new Map<string, Hit>();

for (const run of runs) {
  for (const val of ["leadmagic", "millionverifier"]) {
    const p = join(homedir(), "output", "list-builder", run, `v2-results-${val}.jsonl`);
    if (!existsSync(p)) continue;
    let n = 0;
    for (const l of readFileSync(p, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(l);
      if (!r.email) continue;
      const row = r.row ?? {};
      hits.set(r.email.toLowerCase(), {
        email: r.email.toLowerCase(),
        first: row.first_name ?? "",
        last: row.last_name ?? "",
        dom: (row.domain ?? "").toLowerCase(),
        company: row.company_name ?? "",
        li: row.linkedin_url ?? "",
        validator: val,
      });
      n++;
    }
    console.log(`${run}/${val}: ${n} hits`);
  }
}
console.log(`\n${hits.size} unique emails to persist`);

// corroboration guard: refuse anything already cached under a different human
const all = [...hits.values()];
const rejected: string[] = [];
for (let i = 0; i < all.length; i += 400) {
  const chunk = all.slice(i, i + 400);
  const list = chunk.map((h) => `'${h.email.replace(/'/g, "''")}'`).join(",");
  let out = "";
  try {
    out = execFileSync("psql", [DB_URL, "-At", "-c",
      `SELECT lower(email)||'|'||coalesce(lower(firstname),'')||'|'||coalesce(lower(lastname),'')
       FROM public."Email Database Cache" WHERE lower(email) IN (${list});`],
      { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  } catch (e: any) { console.log("  psql error:", e.message.slice(0, 120)); continue; }
  const owner = new Map<string, [string, string]>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [em, fn, ln] = line.split("|");
    if (fn || ln) owner.set(em, [fn, ln]);
  }
  for (const h of chunk) {
    const o = owner.get(h.email);
    if (!o) continue;
    const [ofn, oln] = o;
    if (ofn && oln && clean(oln) !== clean(h.last) && clean(ofn) !== clean(h.first)) {
      rejected.push(`${h.email} -> cached as ${ofn} ${oln} (we said ${h.first} ${h.last})`);
      hits.delete(h.email);
    }
  }
}
console.log(`corroboration rejected ${rejected.length} as a different person`);
for (const r of rejected.slice(0, 15)) console.log("   " + r);

if (DRY) { console.log("\n--dry: nothing written"); process.exit(0); }

const agent = new https.Agent({ keepAlive: false });
const today = new Date().toISOString().slice(0, 10);
const rows = [...hits.values()].map((h) => ({
  email: h.email,
  firstname: h.first || undefined,
  lastname: h.last || undefined,
  company_domain: h.dom || undefined,
  company_name: h.company || undefined,
  person_linkedin_URL: h.li || undefined,
  last_verified_date: today,
  Domain_Validation_Status: "ok",
  type: `fast_lane_v2_${h.validator}_valid`,
}));

function post(body: string): Promise<number> {
  return new Promise((res, rej) => {
    const req = https.request({
      method: "POST", agent, hostname: SB_HOST,
      path: "/rest/v1/Email%20Database%20Cache",
      // No explicit Content-Length — let Node compute it. Setting it by hand
      // produced a PGRST102 "Empty or invalid json" on multi-byte payloads.
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json",
                 Prefer: "resolution=merge-duplicates,return=minimal" },
    }, (r) => { r.on("data", () => {}); r.on("end", () => res(r.statusCode ?? 0)); });
    req.on("error", rej); req.write(body); req.end();
  });
}

(async () => {
  let ok = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const st = await post(JSON.stringify(rows.slice(i, i + 500)));
    if (st < 300) ok += rows.slice(i, i + 500).length;
    else console.log(`  batch ${i} HTTP ${st}`);
  }
  console.log(`\nwrote ${ok}/${rows.length} rows to Email Database Cache`);
})();
