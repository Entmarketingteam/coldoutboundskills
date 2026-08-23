# Clay table build: LinkedIn Engagement

Read [`../clay-playbooks/clay-table-harness.md`](../clay-playbooks/clay-table-harness.md) first.

⚠️ **Status: specification.**

## What belongs in Clay here, and what does not

**The harvest does not belong in a table.** Post discovery, reaction pulls and comment pulls are
**one-to-many** — one source URL produces hundreds of engager rows — and a Clay column is
one-row-in, one-value-out. There is nowhere to put the rows.

So: **harvest outside, import the engager rows, and use Clay for the gate and the enrichment.**

That split is not a workaround; it is the natural shape. The expensive part (scraping) is a batch
job, and the per-row part (does this person survive) is exactly what columns are for.

## Where the columns go

A person-level intake table, **before** email finding. **The whole point is to drop 9 of every 10
rows before you spend anything on them.**

## Columns

| # | Column | Type | Input | Run condition | Notes |
|---|---|---|---|---|---|
| 1 | Engager Employer Domain | Formula / action | the imported employer | none | **resolve to a bare domain.** Name matching alone is not enough |
| 2 | **Source Company Drop** | Formula | 1, plus the source-company list | none | **half (a) of the rule. Build this first** |
| 3 | Company Enrich | action | `{{f_EmployerDomain}}` | `{{f_SourceDrop}} === false` | **gated on the drop**, so you never enrich a row you are about to delete |
| 4 | ICP Gate | Formula | headcount, country, industry from 3 | `!!{{f_CompanyEnrich}}` | |
| 5 | Suppression Lookup | Lookup Object | `{{f_EmployerDomain}}`, email | `{{f_ICPGate}} === true` | client DNC, existing TAM, live campaigns |
| 6 | Survives | Formula | `!{{f_SourceDrop}} && {{f_ICPGate}} && !{{f_Suppressed}}` | none | **~10% of rows** |
| 7 | Email Finder | action | | `{{f_Survives}} === true` | **the expensive column. It runs on survivors only** |
| 8 | engagement_line | AI | opt-in | `{{f_Survives}} === true && brief asked` | **do not build this unless the brief asked for a line** |

## Column 2: the source-company drop

```js
(() => {
  // Half (a): drop every engager employed by ANY source company, not just the
  // author of the post they engaged with.
  const SOURCE_DOMAINS = ["competitor-one.com", "customer-two.com"];       // resolved, bare
  const SOURCE_URLS    = ["linkedin.com/company/competitor-one"];
  const SOURCE_NAMES   = ["competitorone", "customertwo"];                 // squashed
  const CLIENT_DOMAIN  = "our-client.com";

  const squash = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const dom  = String({{f_EmployerDomain}} || "").toLowerCase();
  const url  = String({{f_EmployerLinkedin}} || "").toLowerCase();
  const name = squash({{f_EmployerName}});
  const mail = String({{f_Email}} || "").split("@")[1] || "";

  // If the CLIENT's own domain shows up in the source set, the list is wrong.
  // Stop and fix the source list -- do not silently filter around it.
  if (SOURCE_DOMAINS.includes(CLIENT_DOMAIN)) return "CONFIG ERROR: client domain in source set";

  return SOURCE_DOMAINS.includes(dom)
      || SOURCE_DOMAINS.includes(mail)                       // resolved EMAIL domain too
      || SOURCE_URLS.some(u => url.includes(u))
      || SOURCE_NAMES.includes(name);
})()
```

**Four match paths, in that order.** Name matching alone lets through everyone whose employer string
is spelled differently from your source list, which on a scraped dataset is most of them.

## Half (b) is not a column

**Push every source company onto the client's do-not-contact list**, once per harvest, outside this
table.

Row drops fix **this run**. The block list runs **at send time**, which is what stops the same people
arriving through a different lane next month. **A table alone only ever implements half the rule.**

## Credit gate

Everything paid is gated on `Survives`. At the measured ~10% survival rate that is the difference
between paying for 1,000 engagers and paying for 100.

⚠️ **Add rows LAST.** Clay auto-runs columns on insert, and importing a 10,000-row engager harvest
into an ungated table starts enriching all of it immediately.

## Smoke test

Import 100 engager rows from a single post.

- Anyone employed by a source company survives → column 2 is matching on one path only.
- The client's own employees appear → **stop. The source list is wrong.**
- Survival is far above ~10% → your ICP gate is not doing anything. Check it against a row you know
  should fail.
- Enrichment ran on dropped rows → column 3 is not gated on column 2.
