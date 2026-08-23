#!/usr/bin/env tsx
/**
 * Blitz API — find contacts at companies by domain, write CSV.
 *
 * Usage:
 *   export BLITZ_API_KEY=xxx
 *   export BLITZ_BASE_URL=https://api.useblitz.com  (or whatever your region)
 *   npx tsx scripts/find-contacts.ts \
 *     --domains-file=restaurants.csv \
 *     --titles=owner,founder,ceo \
 *     --out=contacts.csv
 *
 * Rows are appended to --out as each domain completes; processed domains are
 * tracked in <out>.done.txt so an interrupted run resumes instead of restarting.
 * Failed domains are written to <out>.failures.csv and the exit code is nonzero.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "fs";

const BLITZ_API_KEY = process.env.BLITZ_API_KEY;
const BLITZ_BASE_URL = process.env.BLITZ_BASE_URL ?? "https://api.useblitz.com";
if (!BLITZ_API_KEY) {
  console.error("Missing env: BLITZ_API_KEY");
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  return {
    domainsFile: get("--domains-file"),
    titles: (get("--titles") ?? "owner,founder,ceo,president,cto,vp")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    out: get("--out") ?? "contacts.csv",
    concurrency: Number(get("--concurrency") ?? 10),
  };
}

function readDomains(path: string): string[] {
  const text = readFileSync(path, "utf8").trim();
  const lines = text.split("\n");
  const header = lines[0].split(",").map((c) => c.replace(/"/g, "").trim());
  // If first line looks like a CSV header with company_domain column
  const idx = header.indexOf("company_domain");
  if (idx >= 0) {
    return lines
      .slice(1)
      .map((l) => l.split(",")[idx]?.replace(/^"|"$/g, "").trim())
      .filter(Boolean);
  }
  // Otherwise treat as one-per-line
  return lines.map((l) => l.split(",")[0].trim()).filter(Boolean);
}

function cleanDomain(d: string): string {
  return d
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .trim();
}

async function blitzCompany(domain: string): Promise<any> {
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    let resp: Response;
    try {
      resp = await fetch(`${BLITZ_BASE_URL}/api/enrichment/company`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BLITZ_API_KEY}`,
        },
        body: JSON.stringify({ domain }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      lastErr = `network error: ${String(err).slice(0, 200)}`;
      continue;
    }
    if (resp.status === 429 || resp.status >= 500) {
      lastErr = `HTTP ${resp.status}`;
      continue;
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`${resp.status}: ${t.slice(0, 200)}`);
    }
    try {
      return await resp.json();
    } catch (err) {
      lastErr = `invalid JSON body: ${String(err).slice(0, 200)}`;
      continue;
    }
  }
  throw new Error(`exhausted retries for ${domain} (${lastErr})`);
}

function matchesTitle(title: string, keywords: string[]): boolean {
  const t = title.toLowerCase();
  return keywords.some((kw) => t.includes(kw));
}

async function pool<T, R>(items: T[], concurrency: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        out[i] = { error: String(e) } as any;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

interface ContactRow {
  company_domain: string;
  first_name: string;
  last_name: string;
  job_title: string;
  linkedin_url: string;
  email: string;
  email_source: string;
  company_name: string;
  company_industry: string;
  company_headcount: string;
  company_phone: string;
}

const CSV_HEADERS: (keyof ContactRow)[] = [
  "company_domain",
  "first_name",
  "last_name",
  "job_title",
  "linkedin_url",
  "email",
  "email_source",
  "company_name",
  "company_industry",
  "company_headcount",
  "company_phone",
];

function toCsvLine(r: ContactRow): string {
  return CSV_HEADERS.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(",");
}

async function main() {
  const args = parseArgs();
  if (!args.domainsFile) {
    console.error("Usage: --domains-file=<path> [--titles=csv] [--out=path] [--concurrency=n]");
    process.exit(1);
  }
  if (!existsSync(args.domainsFile)) {
    console.error(`File not found: ${args.domainsFile}`);
    process.exit(1);
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 50) {
    console.error(`Invalid --concurrency: must be an integer between 1 and 50 (e.g. --concurrency=10)`);
    process.exit(1);
  }
  const rawDomains = readDomains(args.domainsFile);
  const allDomains = [...new Set(rawDomains.map(cleanDomain))].filter(Boolean);

  // Resume: skip domains already processed by a previous interrupted run
  const donePath = `${args.out}.done.txt`;
  let doneDomains = new Set<string>();
  if (existsSync(donePath) && existsSync(args.out)) {
    doneDomains = new Set(
      readFileSync(donePath, "utf8")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    console.error(`Resuming: ${doneDomains.size} domains already processed (tracked in ${donePath})`);
  } else {
    writeFileSync(args.out, CSV_HEADERS.join(",") + "\n");
    writeFileSync(donePath, "");
  }
  const domains = allDomains.filter((d) => !doneDomains.has(d));
  console.error(`Processing ${domains.length} of ${allDomains.length} unique domains (titles: ${args.titles.join(", ")})`);

  let processed = 0;
  let contactCount = 0;
  let withEmail = 0;
  const failures: { domain: string; error: string }[] = [];
  await pool(domains, args.concurrency, async (domain) => {
    processed++;
    if (processed % 50 === 0) console.error(`  ${processed}/${domains.length}`);
    try {
      const data = await blitzCompany(domain);
      const company = data.company ?? {};
      const employees = (data.employees ?? []).filter((e: any) =>
        matchesTitle(e.title || "", args.titles)
      );
      const rows: ContactRow[] = employees.map((e: any) => ({
        company_domain: domain,
        first_name: e.first_name || "",
        last_name: e.last_name || "",
        job_title: e.title || "",
        linkedin_url: e.linkedin_url || "",
        email: e.email || "",
        email_source: e.email ? "blitz" : "",
        company_name: company.name || "",
        company_industry: company.industry || "",
        company_headcount: String(company.headcount ?? ""),
        company_phone: company.phone || "",
      }));
      if (rows.length) {
        appendFileSync(args.out, rows.map(toCsvLine).join("\n") + "\n");
        contactCount += rows.length;
        withEmail += rows.filter((r) => r.email).length;
      }
      appendFileSync(donePath, domain + "\n");
    } catch (err) {
      const msg = String(err).slice(0, 200);
      console.error(`  ${domain}: ${msg.slice(0, 120)}`);
      failures.push({ domain, error: msg });
    }
  });

  console.error(`\nWrote ${args.out} — ${contactCount} contacts this run (${withEmail} with email)`);

  if (failures.length) {
    const failuresPath = `${args.out}.failures.csv`;
    writeFileSync(
      failuresPath,
      ["domain,error", ...failures.map((f) => `"${f.domain}","${f.error.replace(/"/g, '""')}"`)].join("\n")
    );
    console.error(`\n${failures.length} domains FAILED. First ${Math.min(failures.length, 10)}:`);
    for (const f of failures.slice(0, 10)) console.error(`  ${f.domain}: ${f.error.slice(0, 100)}`);
    console.error(`Full list: ${failuresPath}`);
    console.error(`Re-run the same command to retry failed domains (completed domains are skipped via ${donePath}).`);
    process.exit(1);
  }
  // Clean completion — remove the resume sidecar
  if (existsSync(donePath)) unlinkSync(donePath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
