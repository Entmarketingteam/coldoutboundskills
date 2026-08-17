#!/usr/bin/env tsx
/**
 * Fast Lane Email Waterfall — guess-and-validate email finding.
 *
 * Sibling to emails-clay.ts (New Email Finder 6/7). This lane trades coverage
 * for throughput: it guesses the 8 most common name patterns and validates each
 * with LeadMagic, with no provider waterfall behind it. Every hit is written
 * back to the Email Database Cache by the routine itself.
 *
 * Use 6/7 when you want maximum coverage. Use this when 6/7's queue is the
 * bottleneck, or to cheaply skim the easy wins off a large list first.
 *
 * Usage:
 *   npx tsx fast-lane-emails.ts --run=<slug> --csv=contacts.csv [--batch=500] [--poll=20] [--limit=N] [--noRetry]
 *
 * Input CSV needs: first_name, last_name, domain  (optional: company_name, linkedin_url)
 *
 * Runs a second pass automatically over any contact LeadMagic punted on, since
 * a punt means the contact was never actually tested. --noRetry skips that.
 *
 * Resumable: results append to fastlane-results.jsonl keyed by row id; ids
 * already on disk are skipped. Outputs:
 *   fastlane-found.csv   — rows WITH a validated email
 *   fastlane-missed.csv  — misses, with the reason
 *   fastlane-retry.csv   — contacts still punting after the retry pass
 *
 * CAVEAT — guess-and-validate proves an address EXISTS, never that it belongs to
 * your prospect. Benchmarked at 17.5% of hits differing from the known-good
 * address, with the wrong-person cases concentrated on large employers. The
 * `last` and `fl` patterns were dropped for this reason; `first` is retained for
 * coverage and remains the riskiest surviving pattern.
 */
import { execSync } from "child_process";
import { createHash } from "crypto";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parseArgs, readCsv, writeCsv, sleep } from "../../list-expander/scripts/lib";

// The Clay workflow that runs the guess-and-validate ladder in YOUR workspace.
// Pass --routine=workflow:<id> or set CLAY_FASTLANE_ROUTINE_ID. No Clay workspace?
// fast-lane-v2.ts runs the identical ladder locally with no Clay at all.
const args = parseArgs();
const ROUTINE_ID = String(args.routine ?? process.env.CLAY_FASTLANE_ROUTINE_ID ?? "");
if (!ROUTINE_ID) {
  console.error(
    "Usage: npx tsx fast-lane-emails.ts --run=<slug> --csv=<contacts.csv> --routine=workflow:<id>\n" +
    "  --routine (or CLAY_FASTLANE_ROUTINE_ID) is REQUIRED: a Clay workflow in YOUR\n" +
    "  workspace running the guess-and-validate ladder.\n" +
    "  No Clay? fast-lane-v2.ts runs the same ladder locally.");
  process.exit(1);
}
const run = String(args.run ?? "default");
const dir = join(homedir(), "output", "list-builder", run);
mkdirSync(dir, { recursive: true });
const csvPath = String(args.csv ?? join(dir, "contacts-merged.csv"));
const BATCH = Number(args.batch ?? 500);
const POLL = Number(args.poll ?? 20) * 1000;
const resultsPath = join(dir, "fastlane-results.jsonl");

function clay(cmd: string): any {
  const out = execSync(`clay ${cmd}`, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(out);
}

function rowId(r: Record<string, string>, i: number): string {
  const raw =
    r.linkedin_url ||
    `${r.domain}|${(r.first_name || "").toLowerCase()}|${(r.last_name || "").toLowerCase()}|${i}`;
  // Clay bulk ids max 64 chars — hash anything longer (stable across resumes)
  return raw.length <= 64 ? raw : createHash("md5").update(raw).digest("hex");
}

/**
 * LeadMagic answers "unknown" with credits_consumed 0 when it declines to probe
 * the mailbox — that is a punt, not a verdict, and it happens even at
 * concurrency 1. The routine surfaces those as inconclusive_provider_punt so
 * they can be re-run instead of being silently recorded as misses.
 */
const PUNT_SOURCES = new Set(["inconclusive_provider_punt", "exhausted_with_unknowns"]);

const done = new Map<string, any>();

async function runItems(items: { r: Record<string, string>; id: string }[], label: string) {
  const t0 = Date.now();
  for (let b = 0; b < items.length; b += BATCH) {
    const batch = items.slice(b, b + BATCH);
    const jsonl = batch
      .map(({ r, id }) =>
        JSON.stringify({
          id,
          inputs: {
            first_name: r.first_name,
            last_name: r.last_name,
            company_domain: r.domain,
            company_name: r.company_name || "",
            linkedin_url: r.linkedin_url || "",
          },
        }),
      )
      .join("\n");
    const bulkFile = join(dir, `fastlane-batch-${b}.jsonl`);
    writeFileSync(bulkFile, jsonl);

    const start = clay(`routines runs start ${ROUTINE_ID} --bulk ${bulkFile}`);
    const runId = start.routineRunId ?? start.toolRunId ?? start.runId;
    console.log(
      `${label} batch ${b / BATCH + 1}/${Math.ceil(items.length / BATCH)}: ${batch.length} rows -> ${runId}`,
    );

    let res: any;
    for (;;) {
      await sleep(POLL);
      res = clay(`routines runs get ${runId}`);
      if (res.status !== "in_progress") break;
      process.stdout.write(`  finished=${res.finished ?? 0}/${res.total ?? batch.length}   \r`);
    }
    console.log(`  status=${res.status} finished=${res.finished}/${res.total}`);

    // Bulk runs hand back a presigned JSONL rather than inline rows
    const url = res.resultUrl;
    if (!url) throw new Error(`no resultUrl for ${runId} (status=${res.status})`);
    const raw = execSync(`curl -sS "${url}"`, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

    const byId = new Map(batch.map(({ r, id }) => [id, r]));
    for (const line of raw.split("\n").filter(Boolean)) {
      const j = JSON.parse(line);
      const src = j.result ?? {};
      const rec = {
        id: j.id,
        status: j.status,
        final_email: src.final_email ?? "",
        final_source: src.final_source ?? "",
        guesses_checked: src.guesses_checked ?? 0,
        row: byId.get(j.id) ?? {},
      };
      done.set(rec.id, rec);
      appendFileSync(resultsPath, JSON.stringify(rec) + "\n");
    }

    const hits = [...done.values()].filter((d) => d.final_email).length;
    const mins = (Date.now() - t0) / 60000;
    console.log(
      `  running total: ${hits}/${done.size} found (${((100 * hits) / done.size).toFixed(1)}%), ${mins.toFixed(1)} min elapsed`,
    );
  }
}

async function main() {
  let rows = readCsv(csvPath);
  if (args.limit) rows = rows.slice(0, Number(args.limit));

  if (existsSync(resultsPath)) {
    for (const line of readFileSync(resultsPath, "utf8").split("\n").filter(Boolean)) {
      const j = JSON.parse(line);
      done.set(j.id, j);
    }
    console.log(`Resuming: ${done.size} results already on disk`);
  }

  const items = rows
    .map((r, i) => ({ r, id: rowId(r, i) }))
    .filter(({ r, id }) => !done.has(id) && r.first_name && r.last_name && r.domain);
  console.log(
    `${rows.length} contacts, ${items.length} to run (${rows.length - items.length} done/unrunnable)`,
  );

  await runItems(items, "pass1");

  // A punt is LeadMagic declining to answer, not a verdict, so a contact that
  // punted has NOT actually been tested. One automatic retry pass; in the
  // benchmark this recovered 2 of 9 and lifted 80% -> 84%.
  if (!args.noRetry) {
    const punted = [...done.values()].filter(
      (d) => !d.final_email && PUNT_SOURCES.has(d.final_source),
    );
    if (punted.length) {
      console.log(`\nretry pass: ${punted.length} contacts punted rather than answered`);
      for (const d of punted) done.delete(d.id);
      await runItems(
        punted.map((d) => ({ r: d.row as Record<string, string>, id: d.id })),
        "retry",
      );
    }
  }

  const all = [...done.values()];
  const found = all.filter((d) => d.final_email);
  const missed = all.filter((d) => !d.final_email);
  const retry = missed.filter((d) => PUNT_SOURCES.has(d.final_source));

  const flat = (d: any) => ({
    ...d.row,
    email: d.final_email,
    email_source: d.final_source,
    guesses_checked: d.guesses_checked,
  });
  writeCsv(join(dir, "fastlane-found.csv"), found.map(flat));
  writeCsv(join(dir, "fastlane-missed.csv"), missed.map(flat));
  writeCsv(join(dir, "fastlane-retry.csv"), retry.map(flat));

  const byPattern: Record<string, number> = {};
  for (const d of found) byPattern[d.final_source] = (byPattern[d.final_source] ?? 0) + 1;
  const byReason: Record<string, number> = {};
  for (const d of missed) byReason[d.final_source] = (byReason[d.final_source] ?? 0) + 1;
  const calls = all.reduce((s, d) => s + (Number(d.guesses_checked) || 0), 0);

  console.log(`\n=== Fast Lane: ${found.length}/${all.length} found (${((100 * found.length) / all.length).toFixed(1)}%) ===`);
  console.log(`LeadMagic calls: ${calls} (${(calls / Math.max(all.length, 1)).toFixed(2)} per contact)`);
  console.log("hits by pattern:", byPattern);
  console.log("misses by reason:", byReason);
  if (retry.length) {
    console.log(
      `\n!! ${retry.length} contacts STILL punted after the retry pass, so they were never actually tested. Re-run fastlane-retry.csv before treating them as unfindable.`,
    );
  }
  console.log(`\nwrote ${dir}/fastlane-{found,missed,retry}.csv`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
