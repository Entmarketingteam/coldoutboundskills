---
name: domain-setup-dynadot-zapmail
description: "End-to-end cold email domain setup: generate short domain names, check availability, purchase on Dynadot, switch nameservers, set up on Zapmail, create inboxes, and export to your email sending platform. Requires your own Dynadot and Zapmail API keys."
---

# Cold Email Domain Setup: Dynadot + Zapmail

Complete workflow to generate short domain names, purchase them on Dynadot, and set them up on Zapmail with inboxes ready for cold email sending.

---

## First-Time Setup (Onboarding)

Before running anything, you need two API keys stored as environment variables.

### 1. Get Your Dynadot API Key
1. Log into [dynadot.com](https://www.dynadot.com)
2. Go to **Tools > API** in the left sidebar
3. Enable API access and copy your API key
4. Whitelist your IP address (required by Dynadot)

### 2. Get Your Zapmail API Key
1. Log into [zapmail.ai](https://zapmail.ai)
2. Go to **Settings > API**
3. Copy your API key

### 3. Store Your Keys
Add these to a `.env` file in your project root (or export them in your shell):

```bash
# .env — NEVER commit this file
DYNADOT_API_KEY=your_dynadot_key_here
ZAPMAIL_API_KEY=your_zapmail_key_here
```

Load them in your script:
```python
import os
from dotenv import load_dotenv
load_dotenv()

DYNADOT_API_KEY = os.environ["DYNADOT_API_KEY"]
ZAPMAIL_API_KEY = os.environ["ZAPMAIL_API_KEY"]
```

### 4. Verify Access
Test both APIs before doing anything:

**Dynadot — check wallet balance:**
```
GET https://api.dynadot.com/api3.json?key=<YOUR_KEY>&command=account_info
```
Response includes `AccountBalance` (e.g., `"$106.20"`).

**Zapmail — list domains:**
```
GET https://api.zapmail.ai/api/v2/domains/assignable?limit=10&page=1
Header: x-auth-zapmail: <YOUR_KEY>
```

If both return 200, you're ready.

---

## Full Workflow Overview

```
Step 1: Generate domain name candidates         ~instant
Step 2: Check availability on Dynadot            ~1 min per 500 domains
Step 3: Purchase available domains               ~1 min per 100 domains
   | (domains now registered on Dynadot)
Step 4: Switch nameservers to Zapmail            ~1 min per 500 domains
   | WAIT 15-20 minutes for DNS propagation
Step 5: Connect domains on Zapmail               ~2 min per 500 domains
   | WAIT 10-30 minutes for domains to become assignable
Step 6: Create inboxes on Zapmail                ~3 min per 500 domains
   | WAIT 4-6 HOURS for inbox provisioning
Step 7: Export to your email sending platform    ~instant
```

---

## Step 1: Generate Short Domain Names

The goal is **short, clean domains** that look like real brands. Shorter = better deliverability and more professional appearance.

### Domain Name Strategy

Use a **brand keyword** (your company name or a variation) combined with short prefixes/suffixes:

**Tier 1 — Prefix + Brand** (shortest, try these first):
```
go{brand}.info       try{brand}.info      get{brand}.info
my{brand}.info       the{brand}.info      hey{brand}.info
use{brand}.info      run{brand}.info      one{brand}.info
```

**Tier 2 — Brand + Suffix** (still short):
```
{brand}hq.info       {brand}hub.info      {brand}now.info
{brand}app.info      {brand}pro.info      {brand}lab.info
{brand}ai.info       {brand}co.info       {brand}go.info
```

**Tier 3 — Prefix + Brand + Suffix** (use only if tiers 1-2 don't yield enough):
```
go{brand}hq.info     try{brand}hub.info   get{brand}pro.info
```

### Full Prefix List (36 options)
```
go, get, try, join, find, search, explore, reach, access, boost,
team, send, email, connect, launch, start, build, discover, meet,
use, hello, hey, my, the, top, best, run, open, live, grow,
with, via, one, all, new, pro
```

### Full Suffix List (40 options)
```
hub, hq, online, today, direct, teams, projects, outreach, works,
signal, scope, flow, edge, radar, desk, global, core, base, systems,
engine, link, next, source, circle, stack, zone, path, spot, wave,
grid, point, shift, field, net, way, pulse, vault, peak, sync, lab
```

### Filtering Rules
- **Max SLD length:** 40 characters (shorter is always better — aim for under 20)
- **Banned substrings:** mega, ultra, grp (look spammy)
- **Awkward substring check:** Screen for unintended words (e.g., "therapist" = "the+rapist", profanity, slurs). Run each candidate through a blocklist.
- **Deduplicate globally:** Never use the same domain for two different senders/clients

### Recommended TLD
- `.info` — cheapest (~$3.00 on Dynadot), good deliverability for cold email
- `.co` — slightly more expensive (~$8-12), looks more professional
- Avoid `.xyz`, `.click`, `.top` — spam-associated TLDs

### Example: Generating for brand "acme"
```
Tier 1: goacme.info, tryacme.info, getacme.info, myacme.info ...
Tier 2: acmehq.info, acmehub.info, acmepro.info, acmeflow.info ...
Tier 3: goacmehq.info, tryacmehub.info (only if needed)
```

For 1 brand keyword, tiers 1+2 produce ~76 candidates. Most brands need 10-30 domains.

---

## Step 2: Check Domain Availability

### Dynadot Search API (batch up to 100 per request)
```
GET https://api.dynadot.com/api3.json
  ?key=<DYNADOT_API_KEY>
  &command=search
  &show_price=1
  &currency=USD
  &domain0=goacme.info
  &domain1=tryacme.info
  &domain2=getacme.info
  ...up to &domain99=...
```

**Response:**
```json
{
  "SearchResponse": {
    "SearchResults": [
      {"DomainName": "goacme.info", "Available": "yes", "Price": "2.99"},
      {"DomainName": "tryacme.info", "Available": "no"},
      ...
    ]
  }
}
```

**Important:**
- Max 100 domains per request
- Add 1 second pause between batches to avoid rate limiting
- Set a max price cap (recommended: $3.50 for `.info`)
- Filter out unavailable domains before proceeding

---

## Step 3: Purchase Domains

### Check Wallet Balance First
```
GET https://api.dynadot.com/api3.json
  ?key=<DYNADOT_API_KEY>
  &command=account_info
```

Calculate: `number_of_domains × price_per_domain`. Make sure your balance covers it.

### Register Domains (one per API call)
```
GET https://api.dynadot.com/api3.json
  ?key=<DYNADOT_API_KEY>
  &command=register
  &domain=goacme.info
  &duration=1
```

**Important:**
- One domain per API call (Dynadot doesn't support batch registration)
- Add 0.5 second pause between registrations
- Always verify wallet balance before starting
- `duration=1` = 1 year registration

---

## Step 4: Switch Nameservers to Zapmail

After purchase, point each domain's nameservers to Zapmail's DNS.

### Zapmail Nameservers
```
pns61.cloudns.net
pns62.cloudns.com
pns63.cloudns.net
pns64.cloudns.uk
```

### Dynadot NS Switch API (batch up to 100 domains)
```
GET https://api.dynadot.com/api3.json
  ?key=<DYNADOT_API_KEY>
  &command=set_ns
  &domain=goacme.info,tryacme.info,getacme.info
  &ns0=pns61.cloudns.net
  &ns1=pns62.cloudns.com
  &ns2=pns63.cloudns.net
  &ns3=pns64.cloudns.uk
```

**CRITICAL: Comma encoding bug.** When building the URL in Python, default `urllib.parse.urlencode()` encodes commas as `%2C`, which breaks the batch request. Fix:
```python
import urllib.parse
params = {
    "key": DYNADOT_API_KEY,
    "command": "set_ns",
    "domain": "goacme.info,tryacme.info,getacme.info",
    "ns0": "pns61.cloudns.net",
    "ns1": "pns62.cloudns.com",
    "ns2": "pns63.cloudns.net",
    "ns3": "pns64.cloudns.uk",
}
url = f"https://api.dynadot.com/api3.json?{urllib.parse.urlencode(params, safe=',')}"
```

**Response:**
```json
{"SetNsResponse": {"ResponseCode": 0, "Status": "success"}}
```

### After NS Switch: WAIT 15-20 Minutes
DNS propagation takes time. Don't proceed to Step 5 until at least 15 minutes have passed. 20 minutes is the safe default.

---

## Step 5: Connect Domains on Zapmail

### Zapmail Connect API
```
POST https://api.zapmail.ai/api/v2/domains/connect-domain
Header: x-auth-zapmail: <ZAPMAIL_API_KEY>
Content-Type: application/json

Body: {"domainNames": ["goacme.info", "tryacme.info", "getacme.info"]}
```

**Important:**
- Max 50 domains per request
- Add 3 second pause between batches
- Domains go through verification stages: `CHECKING_BLACKLISTED_STATUS` -> `CHECKING_IF_DOMAIN_IS_REGISTERED` -> assignable

### After Connect: Wait for Domains to Become Assignable

Poll the assignable endpoint to know when you can create inboxes:

```
GET https://api.zapmail.ai/api/v2/domains/assignable?limit=100&page=1
Header: x-auth-zapmail: <ZAPMAIL_API_KEY>
```

**Typical timeline:**
- 10 minutes: ~8% assignable
- 20 minutes: ~50-80% assignable
- 30 minutes: ~99% assignable

**Strategy:** Poll every 5 minutes. Proceed to inbox creation when >95% of your domains are assignable. The stragglers can be retried later.

---

## Step 6: Create Inboxes

### Get Domain UUIDs
First, get the UUIDs for your assignable domains:
```
GET https://api.zapmail.ai/api/v2/domains/assignable?limit=100&page=1
Header: x-auth-zapmail: <ZAPMAIL_API_KEY>
```

Match your domain names against the response to get their UUIDs.

### Create Mailboxes
```
POST https://api.zapmail.ai/api/v2/mailboxes
Header: x-auth-zapmail: <ZAPMAIL_API_KEY>
Content-Type: application/json

Body: {
  "<domain-uuid-1>": [
    {"firstName": "Sarah", "lastName": "Chen", "mailboxUsername": "sarah", "domainName": "goacme.info"},
    {"firstName": "Sarah", "lastName": "Chen", "mailboxUsername": "sarahchen", "domainName": "goacme.info"}
  ],
  "<domain-uuid-2>": [
    {"firstName": "Sarah", "lastName": "Chen", "mailboxUsername": "sarah", "domainName": "tryacme.info"},
    {"firstName": "Sarah", "lastName": "Chen", "mailboxUsername": "sarahchen", "domainName": "tryacme.info"}
  ]
}
```

### Inbox Naming Convention
Create 2 inboxes per domain for sending variety:
- `{firstname}@domain` (e.g., `sarah@goacme.info`)
- `{firstnamelastname}@domain` (e.g., `sarahchen@goacme.info`)

### Important Notes
- Max 25 domains per request
- Add 3 second pause between batches
- Response returns UUID strings, NOT mailbox objects
- **If ANY mailbox in a batch already exists, the ENTIRE batch fails with 400.** Handle this by retrying failed domains one at a time.

### After Inbox Creation: WAIT 4-6 HOURS
Zapmail returns 200 immediately, but inboxes show "In Progress" status. Full provisioning takes 4-6 hours. Do NOT attempt export until inboxes are ACTIVE.

---

## Step 7: Export to Email Sending Platform

### Zapmail Export API
```
POST https://api.zapmail.ai/api/v2/exports/mailboxes
Header: x-auth-zapmail: <ZAPMAIL_API_KEY>
Content-Type: application/json

Body: {
  "apps": ["SMARTLEAD"],
  "ids": [],
  "excludeIds": [],
  "tagIds": [],
  "contains": "sarah",
  "status": "ACTIVE"
}
```

### Supported Platforms
`SMARTLEAD`, `INSTANTLY`, `REACHINBOX`, `REPLY_IO`, `QUICKMAIL`, `EMELIA`, `FIRSTQUADRANT`, `WARMY`, `SUPERAGI`, `LEMLIST`, `PIPL`, `LUELLA`, `MASTER_INBOX`, `SAILE`, `SNOV`, `EMAILBISON`

### Important
- **Always filter by `status: "ACTIVE"`** — exporting "In Progress" inboxes fails silently
- Use `contains` to filter by sender name if you have multiple senders
- Your sending platform account must be linked first via Zapmail's dashboard or API:
  ```
  POST https://api.zapmail.ai/api/v2/exports/accounts/third-party
  Body: {"email": "your-platform-login@example.com", "password": "your-platform-password", "app": "SMARTLEAD"}
  ```

---

## Automation: Running End-to-End Unattended

For a fully automated run, chain the steps with appropriate waits:

```python
# 1. Generate & check availability
available_domains = generate_and_check(brand="acme", tld="info", count=30)

# 2. Purchase
purchase_domains(available_domains)

# 3. NS switch
switch_nameservers(available_domains)

# 4. Wait for DNS propagation
time.sleep(20 * 60)  # 20 minutes

# 5. Connect on Zapmail
connect_domains(available_domains)

# 6. Poll until assignable (up to 30 min)
wait_until_assignable(available_domains, timeout_minutes=30, poll_interval=300)

# 7. Create inboxes
create_inboxes(available_domains, first_name="Sarah", last_name="Chen")

# 8. Wait for provisioning
time.sleep(6 * 3600)  # 6 hours

# 9. Export to sending platform
export_to_platform(contains="sarah", app="SMARTLEAD")
```

**Tips for long runs:**
- On macOS, use `caffeinate -i` to prevent sleep during the 6-hour wait
- Log each step's results to a file for debugging
- Send yourself a notification when complete:
  ```bash
  osascript -e 'display notification "All inboxes are live!" with title "Domain Setup Complete"'
  ```

---

## Common Gotchas

1. **Dynadot comma encoding** — `urllib.parse.urlencode()` encodes commas as `%2C`, breaking batch NS requests. Always use `safe=','`.

2. **Batch inbox failures** — If even 1 mailbox in a Zapmail batch already exists, the entire batch returns 400. Retry failed domains individually.

3. **Export requires ACTIVE status** — Exporting "In Progress" mailboxes fails silently. Always wait the full 4-6 hours or poll for ACTIVE status.

4. **DNS propagation varies** — Most domains propagate in 15 min, but some take 30+. Poll the assignable endpoint rather than using a fixed sleep.

5. **Dynadot IP whitelist** — API calls will fail if your IP isn't whitelisted in Dynadot's API settings.

6. **Zapmail rate limits** — Add pauses between batches (3s for Zapmail, 1s for Dynadot search, 0.5s for Dynadot register). Going too fast gets you temporarily blocked.

7. **Domain length matters** — Shorter domains = better deliverability. Prioritize tier 1 (prefix+brand) over tier 3 (prefix+brand+suffix).

---

## Quick Reference: API Endpoints

| Action | Method | URL |
|---|---|---|
| Dynadot wallet balance | GET | `https://api.dynadot.com/api3.json?key=KEY&command=account_info` |
| Dynadot search (batch 100) | GET | `https://api.dynadot.com/api3.json?key=KEY&command=search&show_price=1&domain0=...` |
| Dynadot register | GET | `https://api.dynadot.com/api3.json?key=KEY&command=register&domain=X&duration=1` |
| Dynadot NS switch (batch 100) | GET | `https://api.dynadot.com/api3.json?key=KEY&command=set_ns&domain=X,Y&ns0=...` |
| Zapmail connect (batch 50) | POST | `https://api.zapmail.ai/api/v2/domains/connect-domain` |
| Zapmail assignable check | GET | `https://api.zapmail.ai/api/v2/domains/assignable?limit=100&page=N` |
| Zapmail create inboxes (batch 25) | POST | `https://api.zapmail.ai/api/v2/mailboxes` |
| Zapmail export | POST | `https://api.zapmail.ai/api/v2/exports/mailboxes` |
| Zapmail link platform | POST | `https://api.zapmail.ai/api/v2/exports/accounts/third-party` |
