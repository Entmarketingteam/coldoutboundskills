#!/usr/bin/env tsx
// Enrich leads with recent company news via OpenWebNinja (RapidAPI).
// Adds columns: recent_news_title, recent_news_url, recent_news_date, recent_news_snippet
// Run: npx tsx scripts/enrichments/company-news.ts --input leads.csv --output leads-news.csv --days 90

import { required, parseArgs, readCsv, writeCsv, createQueue, fetchJson } from "../_lib.ts";

const BLOCKLIST_KEYWORDS = ["obituary", "wikipedia", "jobs.", "careers.", "lawsuit", "indictment"];

function isBlocked(item: any): boolean {
  const text = `${item?.title || ""} ${item?.snippet || ""} ${item?.url || ""}`.toLowerCase();
  return BLOCKLIST_KEYWORDS.some(k => text.includes(k));
}

interface NewsRecord { title: string; url: string; date: string; snippet: string }

async function fetchNews(companyName: string, days: number, key: string): Promise<NewsRecord | null> {
  const url = new URL("https://openweb-ninja.p.rapidapi.com/google-search");
  url.searchParams.set("query", `"${companyName}" news OR blog OR announcement`);
  url.searchParams.set("num_results", "5");
  url.searchParams.set("date_range", `${days}d`);

  // fetchJson retries 429/5xx with backoff, fails fast on other 4xx (with body detail), and times out.
  const j: any = await fetchJson(url.toString(), {
    headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": "openweb-ninja.p.rapidapi.com" },
  });
  const results = (j?.results || []).filter((r: any) => !isBlocked(r)).slice(0, 1);
  if (results.length === 0) return null; // definitive no-result
  const top = results[0];
  return { title: top.title || "", url: top.url || "", date: top.date || "", snippet: top.snippet || "" };
}

async function main() {
  const { flags } = parseArgs();
  const input = (flags.input as string) || "leads.csv";
  const output = (flags.output as string) || "leads-news.csv";
  const days = Number(flags.days ?? 90);
  if (!Number.isInteger(days) || days <= 0) {
    console.error("Error: --days must be a positive integer (e.g. --days 90).");
    process.exit(1);
  }

  const key = required("RAPIDAPI_KEY");

  const leads = readCsv(input);
  console.log(`Enriching ${leads.length} leads with recent news (last ${days} days)...`);

  const queue = createQueue(5);
  const errors: any[] = [];
  let enriched = 0;

  // Dedupe by company_name: cache the in-flight promise so concurrent leads of
  // the same company share one paid call. Failed calls are evicted so a later
  // lead can retry — only definitive no-result (null) stays cached.
  const byCompany = new Map<string, Promise<NewsRecord | null>>();

  const enriched_rows = await Promise.all(leads.map(lead => queue.add(async () => {
    if (!lead.company_name) return { ...lead };

    let call = byCompany.get(lead.company_name);
    if (!call) {
      call = fetchNews(lead.company_name, days, key);
      byCompany.set(lead.company_name, call);
      call.catch(() => byCompany.delete(lead.company_name));
    }

    try {
      const record = await call;
      if (!record) return { ...lead };
      enriched++;
      return { ...lead, recent_news_title: record.title, recent_news_url: record.url, recent_news_date: record.date, recent_news_snippet: record.snippet };
    } catch (e: any) {
      errors.push({ company: lead.company_name, error: e.message });
      return { ...lead };
    }
  })));

  writeCsv(output, enriched_rows);
  if (errors.length > 0) writeCsv("company-news-errors.csv", errors);

  console.log(`\n✅ Enriched ${enriched}/${leads.length} with news (${errors.length} errors)`);
  console.log(`Saved to ${output}`);
  if (errors.length > 0) {
    console.error(`${errors.length} companies failed — see company-news-errors.csv.`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
