#!/usr/bin/env tsx
// Pull Smartlead analytics to CSV.
// Run: npx tsx scripts/smartlead-pull-analytics.ts --campaign-id 12345

import { required, parseArgs, writeCsv, fetchJson } from "./_lib.ts";

const API = "https://server.smartlead.ai/api/v1";

async function main() {
  const { flags } = parseArgs();
  const campaignId = flags["campaign-id"];
  const since = (flags.since as string) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const until = (flags.until as string) || new Date().toISOString().slice(0, 10);
  const output = (flags.output as string) || "analytics.csv";

  // A bare `--campaign-id` (no value) parses as boolean true — reject anything non-string.
  if (typeof campaignId !== "string") { console.error("Usage: --campaign-id <id> [--since YYYY-MM-DD] [--until YYYY-MM-DD]"); process.exit(1); }

  const key = required("SMARTLEAD_API_KEY");

  console.log(`Pulling Smartlead analytics for campaign ${campaignId}, ${since} → ${until}...`);

  // fetchJson retries 429/5xx with backoff, fails fast on other 4xx (with status + body detail,
  // never the URL — which carries api_key), guards JSON parsing, and times out. No silent
  // all-zero "success" on a bad key or campaign id.

  // Overall stats
  const overall: any = await fetchJson(`${API}/campaigns/${campaignId}/analytics?api_key=${key}`);

  // By-date stats
  const byDate: any = await fetchJson(`${API}/campaigns/${campaignId}/analytics-by-date?api_key=${key}&start_date=${since}&end_date=${until}`);

  // Print summary
  console.log("\nOverall stats:");
  console.log(`  Sent:      ${overall?.sent_count || 0}`);
  console.log(`  Opened:    ${overall?.open_count || 0}`);
  console.log(`  Clicked:   ${overall?.click_count || 0}`);
  console.log(`  Replied:   ${overall?.reply_count || 0}`);
  console.log(`  Bounced:   ${overall?.bounce_count || 0}`);
  console.log(`  Unsub:     ${overall?.unsubscribed_count || 0}`);

  const sent = overall?.sent_count || 0;
  if (sent > 0) {
    const openRate = ((overall?.open_count || 0) / sent * 100).toFixed(1);
    const replyRate = ((overall?.reply_count || 0) / sent * 100).toFixed(1);
    const bounceRate = ((overall?.bounce_count || 0) / sent * 100).toFixed(1);
    console.log(`  Open rate: ${openRate}%`);
    console.log(`  Reply rate: ${replyRate}%`);
    console.log(`  Bounce rate: ${bounceRate}%`);
  }

  // Save CSV
  const rows = Array.isArray(byDate) ? byDate : (byDate?.data || []);
  if (rows.length > 0) {
    writeCsv(output, rows);
    console.log(`\nSaved daily breakdown to ${output}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
