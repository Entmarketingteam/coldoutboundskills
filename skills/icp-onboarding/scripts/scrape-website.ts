#!/usr/bin/env tsx
/**
 * Minimal website scraper for ICP onboarding.
 *
 * Fetches the homepage and follows links to /about, /pricing, /customers,
 * /case-studies, and a few others. Strips HTML to text. Outputs JSON.
 *
 * Usage:
 *   npx tsx scripts/scrape-website.ts --url=https://example.com --out=/tmp/scrape.json
 */

import { writeFileSync } from "fs";

const PAGES_TO_TRY = [
  "/",
  "/about",
  "/about-us",
  "/pricing",
  "/customers",
  "/case-studies",
  "/who-we-serve",
  "/solutions",
  "/product",
];

interface Page {
  url: string;
  status: number;
  text: string;
  title: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  let url = get("--url");
  const out = get("--out") ?? "/tmp/scrape.json";
  if (!url) {
    console.error("Usage: scrape-website.ts --url=https://example.com [--out=path]");
    process.exit(1);
  }
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    new URL(url);
  } catch {
    console.error(`Invalid --url: ${url} — pass a full URL like https://example.com`);
    process.exit(1);
  }
  return { url, out };
}

function stripHtml(html: string): { text: string; title: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text, title };
}

async function fetchPage(url: string): Promise<Page> {
  let lastStatus = 0;
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.status === 429 || resp.status >= 500) {
        lastStatus = resp.status;
        lastErr = `HTTP ${resp.status}`;
        continue;
      }
      const html = await resp.text();
      const { text, title } = stripHtml(html);
      return { url, status: resp.status, text: text.slice(0, 8000), title };
    } catch (err) {
      lastStatus = 0;
      lastErr = String(err);
      continue;
    }
  }
  return { url, status: lastStatus, text: `ERROR: ${lastErr}`, title: "" };
}

async function main() {
  const { url, out } = parseArgs();
  const base = new URL(url);

  // Fetch all candidate pages in parallel; keep original path order
  const results = await Promise.all(
    PAGES_TO_TRY.map((path) => fetchPage(new URL(path, base).toString()))
  );

  const pages: Page[] = [];
  for (const page of results) {
    if (page.status === 200 && page.text.length > 200) {
      pages.push(page);
      console.error(`✓ ${page.url} (${page.text.length} chars)`);
    } else {
      console.error(`✗ ${page.url} (${page.status})`);
    }
  }

  if (pages.length === 0) {
    console.error(`Scraped 0 pages from ${base.hostname} — site unreachable or blocking`);
    process.exit(1);
  }

  const result = { domain: base.hostname, pages };
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.error(`\nWrote ${out} — ${pages.length} pages, ${JSON.stringify(result).length} chars`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
