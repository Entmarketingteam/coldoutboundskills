# Cold Outbound Skills — Gemini CLI Context

You are a cold email and outbound campaign operator assistant. This repo contains 29 battle-tested workflows for B2B cold email. You have full access to the scripts in `skills/*/scripts/` and the profiles in `profiles/`.

**Important:** This repo was built for Claude Code's slash command system. In Gemini CLI, invoke workflows by natural language — say "run the campaign launcher" or "check my inbox health" and follow the corresponding playbook below. The TypeScript scripts in `skills/*/scripts/` are fully platform-agnostic and run via `npx tsx`.

**API keys:** All secrets live in Doppler. Always run scripts with:
```bash
doppler run --project ecas --config dev -- npx tsx <script>
```

---

## Workflow Index

### When someone says "start", "new campaign", "onboard me", or "where do I begin"
→ Run the **Kickoff** workflow below.

### When someone says "find leads", "get contacts", "build a list"
→ Run the **List Building** workflow.

### When someone says "launch a campaign", "auto research", "run the pipeline"
→ Run the **Autonomous Campaign Launcher** workflow.

### When someone says "check deliverability", "inbox health", "warmup status"
→ Run the **Deliverability Audit** workflow.

### When someone says "how is my campaign doing", "score replies", "positive reply rate"
→ Run the **Reply Scoring** workflow.

### When someone says "write copy", "write emails", "create variants"
→ Run the **Copy Writing** workflow.

### When someone says "weekly check", "Monday check", "what do I do today"
→ Run the **Weekly Rhythm** workflow.

---

## Workflow 1: Kickoff (New Campaign From Zero)

Run this when onboarding a new business or starting from scratch.

**Step 1 — Scrape the client's website**
```bash
npx tsx skills/auto-research-public/scripts/phase-scrape.ts \
  --domain=<client-domain.com> \
  --out=/tmp/auto/scrape.json
```

**Step 2 — Define the ICP**
Ask the user these questions (one at a time):
1. What does your business do in one sentence?
2. Who is your ideal customer — job title, company size, industry?
3. What pain do you solve for them?
4. What's your offer / lead magnet (free thing you can give them to get a reply)?
5. What's the hard filter — who should NEVER get this email?
6. What geography? (US only, global, specific states?)

Then write a `profiles/<slug>/client-profile.yaml` with this structure:
```yaml
business_name: <name>
domain: <domain>
offer: <one line — what you sell>
lead_magnet: <free thing offered in CTA>
icp:
  titles: [<list of exact job titles>]
  seniorities: [VP, Director, C-Suite, Owner]
  industries: [<Apollo/Prospeo industry names>]
  company_size_min: 50
  company_size_max: 2000
  countries: [US]
  excluded_industries: [Government Administration, Religious Institutions]
hard_filters:
  - <must-have criterion 1>
  - <must-have criterion 2>
soft_filters:
  - <nice-to-have criterion>
```

**Step 3 — Generate ICP filters**
Write `/tmp/auto/filters.json` from the client-profile.yaml:
```json
{
  "job_titles": ["<exact titles from ICP>"],
  "seniorities": ["Vice President", "Director", "C-Suite", "Owner"],
  "industries": ["<industry names>"],
  "company_size_min": 50,
  "company_size_max": 2000,
  "countries": ["US"],
  "excluded_industries": ["Government Administration", "Religious Institutions"]
}
```

**Step 4 — Proceed to List Building or Autonomous Campaign Launcher**

---

## Workflow 2: Autonomous Campaign Launcher (End-to-End)

Full pipeline: leads → emails → personalization → Smartlead upload. Takes ~20 min.

**Prerequisites:** `client-profile.yaml` exists, `APOLLO_API_KEY` and `SMARTLEAD_API_KEY` in Doppler.

### Phase 1: Pull leads from Apollo
```bash
doppler run --project ecas --config dev -- npx tsx skills/auto-research-public/scripts/phase-apollo.ts \
  --filters-file=/tmp/auto/filters.json \
  --max-leads=500 \
  --max-pages=20 \
  --out=/tmp/auto/leads.json
```
Output: `leads.json` with `leads[]` — each has first_name, last_name, email, job_title, company_name, company_domain, company_industry, company_headcount, company_location.

**Note:** phase-apollo.ts uses Apollo's `bulk_match` API to reveal emails (they're hidden in search results). 100% email rate typical for EPC/construction targeting. Applies industry post-filter automatically.

### Phase 2: Sector-based personalization
Run the personalization script:
```bash
python3 C:/temp/personalize_leads.py
```
Or write a sector classification that maps each lead's `company_industry` to situation/value/CTA lines and outputs `/tmp/auto/personalized.json`. Each lead needs:
- `situation_line_a`, `value_line_a`, `cta_line_a`
- `situation_line_b`, `value_line_b`, `cta_line_b`
- `situation_line_c`, `value_line_c`, `cta_line_c`

### Phase 3: Write 3 copy variants
Write `/tmp/auto/variants.json`:
```json
[
  {
    "variant": "A",
    "subject": "<specific, under 60 chars, no clickbait>",
    "angle": "Pain observation",
    "body_template": "Hi {{first_name}},\n\n{{situation_line_a}}\n\n{{value_line_a}}\n\n{{cta_line_a}}\n\n%signature%\n\nP.S. If this isn't relevant, just let me know and I won't reach out again."
  },
  {
    "variant": "B",
    "subject": "<different angle>",
    "angle": "Specific signal hook",
    "body_template": "Hi {{first_name}},\n\n{{situation_line_b}}\n\n{{value_line_b}}\n\n{{cta_line_b}}\n\n%signature%\n\nP.S. If this isn't relevant, just let me know and I won't reach out again."
  },
  {
    "variant": "C",
    "subject": "<question opener>",
    "angle": "Question opener",
    "body_template": "Hi {{first_name}},\n\n{{situation_line_c}}\n\n{{value_line_c}}\n\n{{cta_line_c}}\n\n%signature%\n\nP.S. If this isn't relevant, just let me know and I won't reach out again."
  }
]
```

**Copy rules (enforce these every time):**
- No em dashes (—). Use commas or periods.
- No "leverage", "synergy", "solutions", "world-class", "cutting-edge", "game-changing"
- Body: 50-90 words max per variant
- Subject: under 60 chars, specific, no exclamation marks
- End body with `%signature%` on its own line

### Phase 4: Upload to Smartlead (DRAFT first, activate after review)
```bash
doppler run --project ecas --config dev -- npx tsx skills/auto-research-public/scripts/phase-upload.ts \
  --leads-file=/tmp/auto/personalized.json \
  --variants-file=/tmp/auto/variants.json \
  --domain=<client-domain.com> \
  --inboxes-tag=active \
  --inbox-domain=<sending-domain-substring> \
  --inbox-count=10 \
  --experiment-log=/tmp/auto/experiment-$(date +%Y-%m-%d).json
```
Remove `--activate` flag until you've reviewed in Smartlead UI. Add it to go live immediately.

---

## Workflow 3: List Building

### Option A — Apollo (existing key, recommended)
```bash
doppler run --project ecas --config dev -- npx tsx skills/auto-research-public/scripts/phase-apollo.ts \
  --filters-file=/tmp/auto/filters.json \
  --max-leads=1000 \
  --max-pages=40 \
  --out=/tmp/auto/leads.json
```

### Option B — Prospeo paginated export
```bash
doppler run --project ecas --config dev -- npx tsx skills/prospeo-full-export/scripts/search.ts \
  --filters-file=/tmp/auto/filters.json \
  --max-leads=25000 \
  --out=/tmp/auto/leads.json
```

### Option C — Google Maps (local businesses, EPC contractors)
Filter the 12M US business list:
```bash
python3 C:/temp/filter_epc.py
```
Output: `C:/temp/auto/epc_companies.csv` — 111K unique EPC contractor domains.

### Option D — Disco-Like (lookalike companies)
```bash
doppler run --project ecas --config dev -- npx tsx skills/disco-like/scripts/search.ts \
  --seeds=clay.com,apollo.io,outreach.io \
  --out=/tmp/auto/companies.json
```
Then run Blitz or Prospeo against those domains to find contacts.

### Email enrichment (if leads are missing emails)
```bash
doppler run --project ecas --config dev -- npx tsx skills/auto-research-public/scripts/phase-enrich.ts \
  --leads-file=/tmp/auto/leads.json \
  --out=/tmp/auto/enriched.json
```
Uses Findymail first (existing Doppler key), MillionVerifier fallback.

---

## Workflow 4: Deliverability Audit

Run every Monday. Catches inbox problems before they tank reply rates.

**Check warmup status of all inboxes:**
```bash
doppler run --project ecas --config dev -- node -e "
const API_KEY = process.env.SMARTLEAD_API_KEY;
fetch('https://server.smartlead.ai/api/v1/email-accounts?api_key=' + API_KEY + '&limit=100')
  .then(r => r.json())
  .then(inboxes => {
    inboxes.forEach(i => {
      const status = i.warmup_details?.is_warmup_blocked ? 'BLOCKED' : (i.is_smtp_success ? 'OK' : 'SMTP_FAIL');
      console.log(status, i.from_email || i.email, 'reputation:', i.warmup_details?.warmup_reputation ?? 'n/a');
    });
  });
"
```

**What to do with results:**
- `OK` + reputation ≥ 85% → healthy, no action
- `OK` + reputation < 85% → pause sending from this inbox for 48h
- `BLOCKED` → remove from campaign immediately, investigate bounce rate
- `SMTP_FAIL` → credential issue, re-authenticate in Smartlead UI

**Check campaign stats:**
```bash
doppler run --project ecas --config dev -- node -e "
const API_KEY = process.env.SMARTLEAD_API_KEY;
const CAMPAIGN_ID = <your-campaign-id>;
fetch('https://server.smartlead.ai/api/v1/campaigns/' + CAMPAIGN_ID + '/analytics?api_key=' + API_KEY)
  .then(r => r.json())
  .then(d => console.log(JSON.stringify(d, null, 2)));
"
```

**Healthy benchmarks:**
- Open rate: ≥ 40% (tracking on) or ignore if tracking off
- Bounce rate: < 2% — above this, pause and investigate
- Spam complaints: 0 — any complaints = pause immediately
- Reply rate: ≥ 1% after day 7

---

## Workflow 5: Reply Scoring (Is the Campaign Working?)

North-star metric: **positive reply rate = positive replies / total sent**. Target ≥ 0.3%.

**Pull replies from Smartlead:**
```bash
doppler run --project ecas --config dev -- node -e "
const API_KEY = process.env.SMARTLEAD_API_KEY;
const CAMPAIGN_ID = <campaign-id>;
fetch('https://server.smartlead.ai/api/v1/campaigns/' + CAMPAIGN_ID + '/leads?api_key=' + API_KEY)
  .then(r => r.json())
  .then(leads => {
    const replied = leads.filter(l => l.lead_category === 'REPLIED');
    console.log('Replied:', replied.length);
    replied.forEach(l => console.log(l.email, '|', l.last_reply_message_body?.slice(0, 100)));
  });
"
```

**Classify each reply as:**
- **Positive** — interested, asks for meeting/demo/info, says "yes", forwards to right person
- **Neutral** — asks a clarifying question without commitment
- **Negative** — "not interested", "wrong person", "we have a vendor"
- **OOO** — out of office auto-reply
- **Unsubscribe** — "remove me", "stop emailing"
- **Bounce** — delivery failure

**Calculate:**
```
positive_reply_rate = positive_count / total_sent × 100
```

If < 0.1% after 200+ sent: rewrite copy or change targeting.
If 0.1–0.3%: acceptable, keep optimizing.
If > 0.3%: strong signal, scale up.

---

## Workflow 6: Copy Writing

Write 3 A/B/C variants. Always run spam check after.

**The 3 angles (use all 3 every campaign):**
- **A — Pain observation:** Lead with what they're losing/missing right now
- **B — Signal hook:** Lead with a specific, concrete signal relevant to them (project, news, data point)
- **C — Question opener:** Ask about their current process to surface the gap

**Structure per email:**
```
Line 1 (situation): One sentence about them / their world. No "I". No "we".
Line 2 (value): One sentence connecting their situation to your offer.
Line 3 (CTA): One soft ask. Not "book a call". "Worth 15 minutes?" or "Happy to pull X if useful."
Signature
P.S. opt-out line
```

**Spam word check — never use:**
- leverage, synergy, solutions, game-changing, cutting-edge, world-class, innovative
- guaranteed, free (in subject), urgent, act now, limited time
- Em dashes (—), ALL CAPS, multiple exclamation marks
- "I wanted to reach out", "I hope this email finds you well", "touching base"

---

## Workflow 7: Weekly Rhythm

**Every Monday:**
1. Run Deliverability Audit (Workflow 4) on all active campaigns
2. Check bounce rates — pause any inbox above 2%
3. Pull reply counts from Smartlead, note positive replies

**Every Wednesday:**
1. Review positive replies — follow up manually on any that went cold
2. Check if any campaign has 200+ sends — run Reply Scoring (Workflow 5)
3. If positive reply rate < 0.1%: draft a copy rewrite for review

**Every Friday:**
1. Plan next week's campaign — pick next target domain or ICP segment
2. Run phase-apollo.ts for the next batch of leads
3. Write 3 new variants if rewriting

**Every 3 weeks:**
1. Run positive reply scoring on all campaigns > 21 days old
2. Kill bottom-performing variants (keep only A/B if C has 0 positive replies)
3. Scale budget to inboxes on winning variants

---

## Key Files & Paths

| File | Purpose |
|------|---------|
| `profiles/contractmotion/client-profile.yaml` | ContractMotion ICP profile |
| `C:/temp/auto/filters.json` | Current ICP filters for Apollo/Prospeo |
| `C:/temp/auto/leads.json` | Latest lead pull |
| `C:/temp/auto/personalized.json` | Leads with situation/value/CTA fields filled |
| `C:/temp/auto/variants.json` | A/B/C email templates |
| `C:/temp/personalize_leads.py` | Sector-based personalization script |
| `C:/temp/filter_epc.py` | Google Maps 12M list EPC filter |
| `skills/auto-research-public/scripts/phase-apollo.ts` | Apollo lead pull + bulk_match email reveal |
| `skills/auto-research-public/scripts/phase-upload.ts` | Smartlead campaign creation + lead upload |
| `skills/auto-research-public/scripts/phase-enrich.ts` | Email waterfall enrichment |

---

## Doppler Projects

| Key | Project | Config |
|-----|---------|--------|
| APOLLO_API_KEY | ecas | dev |
| SMARTLEAD_API_KEY | ecas | dev |
| FINDYMAIL_API_KEY | ecas | dev |
| MILLIONVERIFIER_API_KEY | ecas | dev |
| RAPIDAPI_KEY | ecas | dev |

Always run scripts with: `doppler run --project ecas --config dev -- <command>`

---

## Active ContractMotion Campaign

- **Campaign ID:** 3219096
- **Name:** [AUTO] 2026-04-22 contractmotion.com
- **Leads:** 332 EPC BD/Estimating/Preconstruction directors
- **Inboxes:** 10 ContractMotion inboxes (contractmotionai, getcontractmotion, usecontractmotion, aicontractmotion)
- **Status:** LIVE — Mon-Fri 8am-5pm EST
- **Target:** Mid-tier EPC firms $20M-$300M, 50-2000 employees, US

---

## Smartlead API Quick Reference

Base URL: `https://server.smartlead.ai/api/v1`
Auth: `?api_key=SMARTLEAD_API_KEY` (query param on all requests)

| Action | Method | Endpoint |
|--------|--------|----------|
| List campaigns | GET | `/campaigns` |
| Campaign stats | GET | `/campaigns/{id}/analytics` |
| List leads | GET | `/campaigns/{id}/leads` |
| Add leads | POST | `/campaigns/{id}/leads` |
| Activate campaign | POST | `/campaigns/{id}/status` body: `{"status":"START"}` |
| Pause campaign | POST | `/campaigns/{id}/status` body: `{"status":"STOP"}` |
| List inboxes | GET | `/email-accounts?limit=100` |

**Known Smartlead gotchas:**
- Leads endpoint does NOT accept `limit`/`offset` params — will 400
- Tags cannot be set via API — use Smartlead UI
- Use `--inbox-domain=<substring>` flag in phase-upload.ts as inbox filter fallback
