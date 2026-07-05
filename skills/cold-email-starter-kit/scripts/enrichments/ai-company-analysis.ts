#!/usr/bin/env tsx
// Enrich leads with AI-generated company analysis (GPT-4o-mini via OpenRouter).
// Adds columns: ai_company_summary, ai_industry_category, ai_customer_type, ai_company_mission
// Run: npx tsx scripts/enrichments/ai-company-analysis.ts --input leads.csv --output leads-ai.csv
// Resumable: rows that already have ai_company_summary are skipped, so re-running
// with --input leads-ai.csv resumes instead of re-billing every row.

import { required, parseArgs, readCsv, writeCsv, createQueue, fetchJson } from "../_lib.ts";

interface AiResult {
  company_summary?: string;
  industry_category?: string;
  customer_type?: string;
  company_mission?: string;
}

async function callLLM(prompt: string, model: string, key: string): Promise<AiResult | null> {
  // fetchJson retries 429/5xx with backoff, fails fast on other 4xx, and times out.
  const j: any = await fetchJson("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 500,
    }),
  }, { timeoutMs: 60000 });
  const content = j?.choices?.[0]?.message?.content;
  if (!content) return null;
  try {
    return JSON.parse(content) as AiResult;
  } catch {
    throw new Error(`LLM returned non-JSON content: ${String(content).slice(0, 200)}`);
  }
}

async function main() {
  const { flags } = parseArgs();
  const input = (flags.input as string) || "leads.csv";
  const output = (flags.output as string) || "leads-ai.csv";
  const model = (flags.model as string) || "openai/gpt-4o-mini";

  const key = required("OPENROUTER_API_KEY");

  const leads = readCsv(input);
  console.log(`Enriching ${leads.length} leads with AI analysis (${model})...`);

  const queue = createQueue(20);
  const errors: any[] = [];
  let enriched = 0;
  let skipped = 0;

  // One LLM call per unique company: cache the in-flight promise so concurrent
  // leads of the same company share a single paid call.
  const byCompany = new Map<string, Promise<AiResult | null>>();

  const enriched_rows = await Promise.all(leads.map(lead => queue.add(async () => {
    if (!lead.company_name) return { ...lead };
    // Resume: skip rows already enriched on a previous run.
    if (lead.ai_company_summary) { skipped++; return { ...lead }; }

    const prompt = `Given this company:
Name: ${lead.company_name}
Domain: ${lead.company_domain || "unknown"}
Industry: ${lead.company_industry || "unknown"}
Headcount: ${lead.company_headcount || "unknown"}

Provide:
1. company_summary: one-sentence what they do (max 15 words)
2. industry_category: specific vertical (e.g. "HR tech", "defense contracting")
3. customer_type: who they sell to (max 10 words)
4. company_mission: what they exist to help customers achieve (max 15 words)

Respond as JSON with exactly these keys: {"company_summary", "industry_category", "customer_type", "company_mission"}`;

    let call = byCompany.get(lead.company_name);
    if (!call) {
      call = callLLM(prompt, model, key);
      byCompany.set(lead.company_name, call);
      // Drop failed calls from the cache so a later lead of the same company can retry.
      call.catch(() => byCompany.delete(lead.company_name));
    }

    try {
      const result = await call;
      if (result && result.company_summary) {
        enriched++;
        return {
          ...lead,
          ai_company_summary: result.company_summary || "",
          ai_industry_category: result.industry_category || "",
          ai_customer_type: result.customer_type || "",
          ai_company_mission: result.company_mission || "",
        };
      }
      return { ...lead };
    } catch (e: any) {
      errors.push({ email: lead.email, company: lead.company_name, error: e.message });
      return { ...lead };
    }
  })));

  writeCsv(output, enriched_rows);
  if (errors.length > 0) writeCsv("ai-company-analysis-errors.csv", errors);

  if (skipped > 0) console.log(`Skipped ${skipped} rows already enriched (resume).`);
  console.log(`\n✅ Enriched ${enriched}/${leads.length} with AI analysis (${errors.length} errors)`);
  console.log(`Saved to ${output}`);
  if (errors.length > 0) {
    console.error(`${errors.length} rows failed — see ai-company-analysis-errors.csv. Re-run with --input ${output} to retry only failed rows.`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
