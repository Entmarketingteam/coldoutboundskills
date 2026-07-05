#!/usr/bin/env tsx
/**
 * Check SPF/DKIM/DMARC for a set of sending domains.
 *
 * Usage:
 *   npx tsx scripts/check-domain-auth.ts --from-csv=/tmp/audit/inboxes.csv --out=/tmp/audit/auth.csv
 *   npx tsx scripts/check-domain-auth.ts --domains=a.co,b.co --out=/tmp/audit/auth.csv
 *
 * CSV input must have a column named `domain` or `email` (domain extracted from email).
 * DKIM selector defaults to "default" (Zapmail convention). Override with --dkim-selector=XYZ.
 */

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const DOMAIN_RE = /^[A-Za-z0-9.-]+$/;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  return {
    csv: get("--from-csv"),
    domains: get("--domains"),
    out: get("--out") ?? "/tmp/audit/auth.csv",
    dkimSelector: get("--dkim-selector") ?? "default",
  };
}

interface DigResult {
  out: string;
  err?: string;
}

/** Run dig; distinguish "record absent" (out="") from "lookup failed" (err set). Retries once. */
function dig(name: string): DigResult {
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = execFileSync("dig", ["TXT", name, "+short"], { timeout: 10000 })
        .toString()
        .trim();
      return { out };
    } catch (err) {
      lastErr = String(err).slice(0, 120);
    }
  }
  return { out: "", err: lastErr };
}

interface AuthRow {
  domain: string;
  spf_present: boolean;
  spf_strict: boolean;
  spf_record: string;
  dkim_present: boolean;
  dkim_selector: string;
  dmarc_present: boolean;
  dmarc_policy: string;
  dmarc_record: string;
  lookup_error: string;
  notes: string;
}

function check(domain: string, dkimSelector: string): AuthRow {
  const spfRes = dig(domain);
  const dkimRes = dig(`${dkimSelector}._domainkey.${domain}`);
  const dmarcRes = dig(`_dmarc.${domain}`);

  const spfMatches = spfRes.out.split("\n").filter((l) => l.includes("v=spf1"));
  const spf = spfMatches[0]?.replace(/^"|"$/g, "") ?? "";
  const spf_present = spf.length > 0;
  const spf_strict = spf.includes("-all");

  const dkim_present = dkimRes.out.includes("v=DKIM1") || dkimRes.out.includes("p=");

  const dmarcMatches = dmarcRes.out.split("\n").filter((l) => l.includes("v=DMARC1"));
  const dmarc = dmarcMatches[0]?.replace(/^"|"$/g, "") ?? "";
  const dmarc_present = dmarc.length > 0;
  const dmarc_policy =
    dmarc.match(/p=(\w+)/)?.[1] ?? (dmarc_present ? "unknown" : "");

  const lookupErrors: string[] = [];
  if (spfRes.err) lookupErrors.push("SPF");
  if (dkimRes.err) lookupErrors.push("DKIM");
  if (dmarcRes.err) lookupErrors.push("DMARC");

  const notes: string[] = [];
  if (spfRes.err) notes.push("SPF DNS lookup failed — result unknown, do NOT treat as missing");
  else if (!spf_present) notes.push("SPF missing — add `v=spf1 include:<provider> ~all`");
  else if (!spf_strict) notes.push("SPF loose (~all or +all) — consider -all once confirmed");
  if (dkimRes.err) notes.push("DKIM DNS lookup failed — result unknown, do NOT treat as missing");
  else if (!dkim_present) notes.push(`DKIM missing at ${dkimSelector}._domainkey`);
  if (dmarcRes.err) notes.push("DMARC DNS lookup failed — result unknown, do NOT treat as missing");
  else if (!dmarc_present) notes.push("DMARC missing — add `v=DMARC1; p=none; rua=mailto:...`");
  else if (dmarc_policy === "none") notes.push("DMARC policy=none — no enforcement yet");

  return {
    domain,
    spf_present,
    spf_strict,
    spf_record: spf,
    dkim_present,
    dkim_selector: dkimSelector,
    dmarc_present,
    dmarc_policy,
    dmarc_record: dmarc,
    lookup_error: lookupErrors.length
      ? `lookup failed: ${lookupErrors.join("/")} (${(spfRes.err || dkimRes.err || dmarcRes.err || "").slice(0, 80)})`
      : "",
    notes: notes.join("; "),
  };
}

function toCsv(rows: AuthRow[]): string {
  const header = [
    "domain",
    "spf_present",
    "spf_strict",
    "dkim_present",
    "dkim_selector",
    "dmarc_present",
    "dmarc_policy",
    "lookup_error",
    "notes",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      header
        .map((k) => {
          const v = (r as any)[k];
          return `"${String(v).replace(/"/g, '""')}"`;
        })
        .join(",")
    );
  }
  return lines.join("\n");
}

/** Quote-aware CSV line splitter (handles commas inside quoted fields). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { cur += c; }
    } else {
      if (c === '"') { inQuote = true; }
      else if (c === ",") { out.push(cur); cur = ""; }
      else { cur += c; }
    }
  }
  out.push(cur);
  return out;
}

async function main() {
  const { csv, domains: dArg, out, dkimSelector } = parseArgs();

  // Verify dig exists before doing any work
  try {
    execFileSync("which", ["dig"], { stdio: "ignore" });
  } catch {
    console.error(
      "`dig` not found on PATH — install it first (macOS: `brew install bind`; Debian/Ubuntu: `apt install dnsutils`)."
    );
    process.exit(1);
  }

  let domains: string[] = [];
  if (dArg) {
    domains = dArg.split(",").map((d) => d.trim()).filter(Boolean);
  } else if (csv) {
    const text = readFileSync(csv, "utf8").trim();
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    const header = parseCsvLine(lines[0]).map((h) => h.trim());
    const domainCol = header.indexOf("domain");
    const emailCol = header.indexOf("email");
    const set = new Set<string>();
    for (const line of lines.slice(1)) {
      const cols = parseCsvLine(line);
      if (domainCol >= 0 && cols[domainCol]) set.add(cols[domainCol].trim());
      else if (emailCol >= 0 && cols[emailCol]) {
        const d = cols[emailCol].split("@")[1];
        if (d) set.add(d.trim());
      }
    }
    domains = [...set];
    if (!domains.length) {
      console.error(
        `No domain/email column values found in ${csv}; headers were: ${header.join(", ")}`
      );
      process.exit(1);
    }
  } else {
    console.error("Provide --from-csv=path or --domains=a.co,b.co");
    process.exit(1);
  }

  // Reject values that are not plausible domain names (also blocks shell-metacharacter garbage)
  const rejected = domains.filter((d) => !DOMAIN_RE.test(d));
  domains = domains.filter((d) => DOMAIN_RE.test(d));
  if (rejected.length) {
    console.error(`Skipping ${rejected.length} invalid domain value(s): ${rejected.slice(0, 10).join(", ")}`);
  }
  if (!domains.length) {
    console.error("No valid domains to check.");
    process.exit(1);
  }

  console.error(`Checking ${domains.length} domains...`);
  const rows: AuthRow[] = [];
  for (let i = 0; i < domains.length; i++) {
    rows.push(check(domains[i], dkimSelector));
    if ((i + 1) % 10 === 0) console.error(`  ${i + 1}/${domains.length}`);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, toCsv(rows));
  const missingSpf = rows.filter((r) => !r.spf_present && !r.lookup_error).length;
  const missingDkim = rows.filter((r) => !r.dkim_present && !r.lookup_error).length;
  const missingDmarc = rows.filter((r) => !r.dmarc_present && !r.lookup_error).length;
  const policyNone = rows.filter((r) => r.dmarc_policy === "none").length;
  const lookupFailed = rows.filter((r) => r.lookup_error).length;

  console.error(`\nWrote ${out}`);
  console.error(`  ${domains.length} domains checked`);
  console.error(`  ${missingSpf} missing SPF`);
  console.error(`  ${missingDkim} missing DKIM`);
  console.error(`  ${missingDmarc} missing DMARC`);
  console.error(`  ${policyNone} with DMARC policy=none`);
  if (rejected.length) console.error(`  ${rejected.length} invalid domain values skipped`);
  if (lookupFailed) {
    console.error(
      `  ${lookupFailed} domains had DNS lookup failures (see lookup_error column) — their results are unreliable`
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
