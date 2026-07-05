#!/usr/bin/env tsx
// Pull Instantly analytics to CSV.
// Run: npx tsx scripts/instantly-pull-analytics.ts --campaign-id abc123

import { required, parseArgs, writeCsv, fetchJson } from "./_lib.ts";

const API = "https://api.instantly.ai";

async function main() {
  const { flags } = parseArgs();
  const campaignId = flags["campaign-id"] as string;
  const since = (flags.since as string) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const until = (flags.until as string) || new Date().toISOString().slice(0, 10);
  const output = (flags.output as string) || "analytics.csv";
  if (!campaignId || campaignId === "true") { console.error("Usage: --campaign-id <id> [--since YYYY-MM-DD] [--until YYYY-MM-DD]"); process.exit(1); }

  const key = required("INSTANTLY_API_KEY");

  console.log(`Pulling Instantly analytics for ${campaignId}, ${since} → ${until}...`);

  const headers = { "Authorization": `Bearer ${key}` };

  // fetchJson retries 429/5xx with backoff, fails fast on other 4xx (with status + body detail),
  // guards JSON parsing, and times out — no silent all-zero "success" on auth errors.

  // Overall stats
  const overall: any = await fetchJson(
    `${API}/api/v2/campaigns/analytics?campaign_id=${campaignId}&start_date=${since}&end_date=${until}`,
    { headers }
  );

  // Daily breakdown
  const daily: any = await fetchJson(
    `${API}/api/v2/campaigns/analytics/daily?campaign_id=${campaignId}&start_date=${since}&end_date=${until}`,
    { headers }
  );

  // Summary
  const o = Array.isArray(overall) ? overall[0] : (overall?.data || overall);
  if (o) {
    console.log("\nOverall stats:");
    console.log(`  Sent:      ${o.emails_sent_count ?? o.sent ?? 0}`);
    console.log(`  Opened:    ${o.open_count ?? 0}`);
    console.log(`  Replied:   ${o.reply_count ?? 0}`);
    console.log(`  Bounced:   ${o.bounced_count ?? o.bounce_count ?? 0}`);
    console.log(`  Unsub:     ${o.unsubscribed_count ?? 0}`);
  }

  const rows = Array.isArray(daily) ? daily : (daily?.data || []);
  if (rows.length > 0) {
    writeCsv(output, rows);
    console.log(`\nSaved daily breakdown to ${output}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
