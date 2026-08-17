#!/usr/bin/env tsx
/**
 * Phase 5 — email finding via a Clay email-finder function. EVERY contact goes
 * through it — provider emails are never trusted as the send address. The
 * function's Final Email / Final Source (validated inside the function) is the
 * sole authority.
 *
 * REQUIRES YOUR OWN CLAY WORKSPACE: the `clay` CLI logged in, plus an email-finder
 * function whose id you pass as --function=function:<id> or CLAY_EMAIL_FUNCTION_ID.
 * The function must accept the inputs "Linkedin Url", "First Name", "Last Name",
 * "Company Domain", "Company Name" and return "Final Email" + "Final Source".
 * No Clay? Use fast-lane-v2.ts (guess-and-validate against LeadMagic or
 * MillionVerifier) on the same contacts CSV — see SKILL.md "Emails without Clay".
 *
 * Usage:
 *   npx tsx emails-clay.ts --run=<slug> --csv=contacts-merged.csv --function=function:<id> [--batch=2000] [--poll=30] [--limit=N]
 *
 * Resumable: results append to clay-results.jsonl keyed by row id; already-done
 * ids are skipped on re-run. Outputs:
 *   leads-final.csv    — rows WITH a Clay Final Email (send-ready)
 *   leads-no-email.csv — misses (retry, or run fast-lane-v2.ts over them)
 */
import { execSync } from "child_process";
import { createHash } from "crypto";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parseArgs, readCsv, writeCsv } from "../../list-expander/scripts/lib";

const args = parseArgs();
const FUNCTION_ID = String(args.function ?? process.env.CLAY_EMAIL_FUNCTION_ID ?? "");
if (!FUNCTION_ID) {
  console.error(
    "Usage: npx tsx emails-clay.ts --run=<slug> --csv=<contacts.csv> --function=function:<id>\n" +
    "  --function (or CLAY_EMAIL_FUNCTION_ID) is REQUIRED: the id of an email-finder\n" +
    "  function in YOUR Clay workspace returning 'Final Email' / 'Final Source'.\n" +
    "  No Clay? Run fast-lane-v2.ts over the same CSV instead.");
  process.exit(1);
}
const run = String(args.run ?? "default");
const dir = join(homedir(), "output", "list-builder", run);
mkdirSync(dir, { recursive: true });
const csvPath = String(args.csv ?? join(dir, "contacts-merged.csv"));
const BATCH = Number(args.batch ?? 2000);
const POLL = Number(args.poll ?? 30) * 1000;
const resultsPath = join(dir, "clay-results.jsonl");

function clay(cmd: string): any {
  const out = execSync(`clay ${cmd}`, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(out);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rowId(r: Record<string, string>, i: number): string {
  const raw = r.linkedin_url || `${r.domain}|${(r.first_name || "").toLowerCase()}|${(r.last_name || "").toLowerCase()}|${i}`;
  // Clay bulk ids max 64 chars — hash anything longer (stable across resumes)
  if (raw.length <= 64) return raw;
  return createHash("md5").update(raw).digest("hex");
}

async function main() {
  let rows = readCsv(csvPath);
  if (args.limit) rows = rows.slice(0, Number(args.limit));

  const done = new Map<string, any>();
  if (existsSync(resultsPath)) {
    for (const line of readFileSync(resultsPath, "utf8").split("\n").filter(Boolean)) {
      const j = JSON.parse(line); done.set(j.id, j);
    }
    console.log(`Resuming: ${done.size} results already on disk`);
  }

  const items = rows
    .map((r, i) => ({ r, id: rowId(r, i) }))
    .filter(({ r, id }) => !done.has(id) && r.first_name && r.last_name && r.domain);
  console.log(`${rows.length} contacts, ${items.length} to run through Clay (${rows.length - items.length} done/unrunnable)`);

  for (let b = 0; b < items.length; b += BATCH) {
    const batch = items.slice(b, b + BATCH);
    const jsonl = batch.map(({ r, id }) => JSON.stringify({
      id,
      inputs: {
        "Linkedin Url": r.linkedin_url ? encodeURI(r.linkedin_url) : "",
        "First Name": r.first_name,
        "Last Name": r.last_name,
        "Company Domain": r.domain,
        "Company Name": r.company_name || r.domain,
      },
    })).join("\n");
    const bulkFile = join(dir, `clay-batch-${b}.jsonl`);
    writeFileSync(bulkFile, jsonl);
    // CLI ≥0.1.x syntax: `routines runs` (old `tools runs` removed)
    const start = clay(`routines runs start ${FUNCTION_ID} --bulk ${bulkFile}`);
    const runId = start.toolRunId ?? start.routineRunId ?? start.runId;
    console.log(`batch ${b / BATCH + 1}/${Math.ceil(items.length / BATCH)}: ${batch.length} rows → toolRunId ${runId}`);

    // poll until complete (Clay shares a workspace queue — can sit behind big runs)
    let res: any; let polls = 0;
    for (;;) {
      await sleep(POLL);
      res = clay(`routines runs get ${runId} --limit ${Math.min(batch.length + 10, 100)}`);
      const st = res.status ?? res.run?.status;
      const fin = res.finished ?? res.run?.finished ?? "?";
      process.stdout.write(`  status=${st} finished=${fin}/${batch.length}   \r`);
      if (st === "complete" || st === "completed") break;
      // resilient: skip a batch that fails validation / errors / hangs instead of killing the whole run
      if (st === "failed" || st === "error" || st === "validation_failed") { console.error(`\n  run ${runId} status=${st} — skipping this batch`); res = { data: [] }; break; }
      if (++polls > 40) { console.error(`\n  run ${runId} stuck (status=${st}) after ${polls} polls — skipping this batch`); res = { data: [] }; break; }
    }
    // Bulk runs return results via resultUrl (JSONL); inline runs return data[]
    let data: any[] = res.data ?? res.run?.data ?? [];
    if (!data.length && res.resultUrl) {
      const txt = await (await fetch(res.resultUrl)).text();
      data = txt.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    }
    let hits = 0;
    for (const d of data) {
      const rec = { id: d.id, final_email: d.result?.["Final Email"] ?? "", final_source: d.result?.["Final Source"] ?? "", result: d.result ?? {} };
      done.set(d.id, rec);
      appendFileSync(resultsPath, JSON.stringify(rec) + "\n");
      if (rec.final_email) hits++;
    }
    console.log(`\n  batch done: ${hits}/${data.length} emails found`);
  }

  // join back
  const withEmail: Record<string, unknown>[] = [];
  const misses: Record<string, unknown>[] = [];
  rows.forEach((r, i) => {
    const d = done.get(rowId(r, i));
    const out = { ...r, final_email: d?.final_email ?? "", final_source: d?.final_source ?? "not_run", clay_raw: d ? JSON.stringify(d.result) : "" };
    (d?.final_email ? withEmail : misses).push(out);
  });
  writeCsv(join(dir, "leads-final.csv"), withEmail);
  writeCsv(join(dir, "leads-no-email.csv"), misses);
  console.log(`\nFINAL: ${withEmail.length} send-ready leads (Clay Final Email) → leads-final.csv`);
  console.log(`${misses.length} without email → leads-no-email.csv (retry later, or run fast-lane-v2.ts over them)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
