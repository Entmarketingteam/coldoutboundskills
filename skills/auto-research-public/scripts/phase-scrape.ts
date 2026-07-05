#!/usr/bin/env tsx
/**
 * Phase 1: Scrape a target company's website.
 *
 * Fetches homepage, /about, /product, /pricing, /customers, /case-studies.
 * Strips HTML to text. Outputs JSON with { domain, pages: [{ url, text }] }.
 * NO AI calls.
 *
 * Usage:
 *   npx tsx scripts/phase-scrape.ts --domain=example.com --out=/tmp/auto/scrape.json
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const PAGES = ["/", "/about", "/about-us", "/product", "/pricing", "/customers", "/case-studies", "/solutions", "/who-we-serve"];

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const domain = get("--domain");
  const out = get("--out") ?? "/tmp/auto/scrape.json";
  if (!domain) {
    console.error("Usage: --domain=example.com [--out=path]");
    process.exit(1);
  }
  return { domain, out };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url: string): Promise<{ url: string; text: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ColdEmailKit/1.0)" },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        console.error(`  x ${url} (${resp.status})`);
        // one retry with backoff on rate-limit / server errors
        if ((resp.status === 429 || resp.status >= 500) && attempt === 0) {
          await sleep(2000);
          continue;
        }
        return null;
      }
      const html = await resp.text();
      const text = stripHtml(html);
      if (text.length < 200) return null;
      return { url, text };
    } catch (e: any) {
      console.error(`  x ${url} (${e?.message ?? e})`);
      if (attempt === 0) {
        await sleep(2000);
        continue;
      }
      return null;
    }
  }
  return null;
}

async function main() {
  const { domain, out } = parseArgs();
  const clean = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const base = `https://${clean}`;

  const pages: { url: string; text: string }[] = [];
  for (const path of PAGES) {
    const url = base + path;
    const page = await fetchPage(url);
    if (page) {
      pages.push(page);
      console.error(`  ✓ ${url} (${page.text.length} chars)`);
    }
  }

  if (!pages.length) {
    console.error(`\nNo pages scraped for ${clean} (blocked or unreachable)`);
    process.exit(1);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ domain: clean, pages }, null, 2));
  console.error(`\nWrote ${out} — ${pages.length} pages`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
