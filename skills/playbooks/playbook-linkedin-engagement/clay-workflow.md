# Clay workflow build: LinkedIn Engagement

Read [`../clay-playbooks/clay-cli-harness.md`](../clay-playbooks/clay-cli-harness.md) first.

⚠️ **Status: specification. Never built or published.**

**A workflow suits this playbook better than a table**, because the harvest is one-to-many and a
workflow can fan a source URL into hundreds of engager records inside a single run.

Relevant actions:

```bash
clay workflows actions list | jq -r '.. | objects | select(.actionKey) | "\(.packageId)\t\(.actionKey)"' \
  | grep -iE 'social-posts|apify-run-actor'
# b210a16b...  social-posts-get-post-activity-reactions
# b210a16b...  social-posts-get-post-activity-comments
# b210a16b...  social-posts-get-post-interaction-comments
# ea91b0b8...  apify-run-actor
```

## Graph

```
[1 trigger: source URLs + client ICP + client domain]
   -> [2 code: PRECONDITIONS -- resolve sources, refuse on failure]
   -> [3 tool: company posts, windowed]
   -> [4 code: shortlist posts by engagement count]
   -> [5 tool: reactions]  +  [6 tool: comments]
   -> [7 code: merge, dedupe engagers]
   -> [8 code: SOURCE-COMPANY DROP (half a)]
   -> [9 tool: company enrichment]        survivors only
   -> [10 code: ICP gate + final contract]
```

Half (b) — the DNC push — happens **once per harvest**, outside the per-engager path.

## Node 2 — preconditions, and why it refuses

```python
def run(source_urls, source_domains, client_domain, icp):
    # An unresolved source URL produces an EMPTY source set, which silently
    # disables BOTH halves of the source-company rule -- and the run then looks
    # like it worked while shipping the competitor's own staff to the client.
    unresolved = [u for u in (source_urls or []) if u not in (source_domains or {})]
    if unresolved:
        raise ValueError("unresolved source accounts, refusing to harvest: %s" % unresolved)

    # If the CLIENT's own domain is in the source set, the list is wrong. Stop.
    if client_domain and client_domain in set((source_domains or {}).values()):
        raise ValueError("client domain present in source set; the source list is wrong")

    # Never infer an ICP. Ask.
    for k in ("headcount_min", "headcount_max", "countries", "titles"):
        if not (icp or {}).get(k):
            raise ValueError("ICP field %s missing; ask the operator, do not infer it" % k)

    return {"ok": True, "source_domains": list((source_domains or {}).values())}
```

Raising is the point. **A silent skip here is indistinguishable from a clean run**, and the failure
only surfaces when the client recognises names on the list.

## Node 4 — shortlist before you scrape

```python
def run(posts, max_posts=3, min_engagement=15):
    scored = [p for p in (posts or [])
              if (p.get("reactions", 0) + p.get("comments", 0)) >= min_engagement]
    scored.sort(key=lambda p: p.get("reactions", 0) + p.get("comments", 0), reverse=True)
    # This playbook is expensive per engager and only ~1 in 10 survives the gate.
    # Shortlisting posts is the cheapest lever there is: it cuts spend before any
    # per-person call, rather than after.
    return {"posts": scored[:max_posts], "dropped": max(0, len(posts or []) - len(scored))}
```

**Log what you dropped.** A silent top-N reads as "we covered everything" when it did not.

## Node 8 — the source-company drop

```python
def _squash(s):
    return "".join(c for c in (s or "").lower() if c.isalnum())

def run(engagers, source_domains, source_urls, source_names):
    doms  = {d.lower() for d in (source_domains or [])}
    urls  = [u.lower() for u in (source_urls or [])]
    names = {_squash(n) for n in (source_names or [])}

    kept, dropped = [], 0
    for e in (engagers or []):
        emp_dom  = (e.get("employer_domain") or "").lower()
        mail_dom = (e.get("email") or "").split("@")[-1].lower()
        emp_url  = (e.get("employer_linkedin") or "").lower()
        emp_name = _squash(e.get("employer_name"))

        # FOUR match paths, in this order. Name matching alone lets through
        # everyone whose employer string is spelled differently from your source
        # list -- which on scraped data is most of them.
        if (emp_dom in doms or mail_dom in doms
                or any(u in emp_url for u in urls)
                or emp_name in names):
            dropped += 1
            continue
        kept.append(e)

    return {"engagers": kept, "source_dropped": dropped}
```

Return `source_dropped` explicitly. **If it is zero on a competitor lane, the rule is not working** —
a competitor's own staff always engage with their own posts.

## Node 10 — ICP gate and contract

Gate on headcount, country and title from the enrichment, then emit one row per surviving engager
with the post evidence attached: engager identity, employer, post URL, and which source account they
came from.

**Keep the source account on the row.** It is what lets someone audit a list months later, and it is
what the DNC push is built from.

## Build and run

```bash
WF=$(clay workflows create --name "Playbook: linkedin engagement" | jq -r '.id')
# create the 10 nodes; pin inputSchema and set outputSchema in SEPARATE update calls
clay workflows publish "$WF"

RT=$(clay routines create workflow "$WF" --name "engagement-harvest" | jq -r '.id')
# ONE post first. Read the output before scaling.
clay routines runs start "$RT" --input '{"items":[{
  "source_urls": ["https://www.linkedin.com/company/example"],
  "source_domains": {"https://www.linkedin.com/company/example": "example.com"},
  "client_domain": "our-client.com",
  "icp": {"headcount_min": 50, "headcount_max": 2000,
          "countries": ["United States"], "titles": ["Head of Sales"]}
}]}'
```

## Do not forget half (b)

After the harvest, **push every source company onto the client's do-not-contact list.** The workflow
implements half (a) only, and a run that stops there will keep re-surfacing the same people through
every future lane.

## Smoke test

| What you see | What it means |
|---|---|
| `source_dropped: 0` on a competitor lane | the drop is matching on one path only |
| The client's own employees in the output | the source list is wrong. **Stop** |
| The run harvested with an unresolved source | node 2 is not raising |
| Survival far above ~10% | the ICP gate is not applied |
| Enrichment ran on dropped engagers | node 9 is not routed after node 8 |
| Employer is wrong for many people | you read the first experience entry instead of the current one |
