# Clay workflow build: Recent Social Post

Read [`../clay-playbooks/clay-cli-harness.md`](../clay-playbooks/clay-cli-harness.md) first.

⚠️ **Status: specification. Never built or published.**

A workflow handles the **async 3-call scrape pattern** properly, which a table cannot — and that
pattern is mandatory here, because the synchronous alternative held a client past 120s on a 25-second
run.

Relevant action:

```bash
clay workflows actions schema ea91b0b8-6c78-4d32-a978-345e923bdc93 apify-run-actor | jq '.inputParameters'
```

## Graph

```
[1 trigger: profile_url  (company OR person)]
   -> [2 tool: START the scrape run]
   -> [3 tool: POLL until finished]
   -> [4 tool: READ the dataset]
   -> [5 code: normalize + order posts newest-first]
   -> [6a/6b/6c agents: skip filter, one per post]
   -> [7 code: choose the first clearing post, FAIL CLOSED]
   -> [8 agent: write the line]      OPT-IN, skip by default
   -> [9 code: output contract]
```

⚠️ **Nodes 2, 3 and 4 are three separate calls on purpose.** A synchronous run-and-fetch endpoint is
the one shape to avoid.

## Node 2 — start the run

Body: `targetUrls` (up to ~100), `maxPosts: 3`, a 3-month window, `includeReposts: false`,
`includeQuotePosts: true`. Reaction and comment scraping **off** — you are not building an engagement
list.

⚠️ **Batch the URLs.** Each run start bills separately, so **a batch of 8 costs the same start fee as
a batch of 1.** A per-row workflow that starts one run per profile throws away most of the saving —
pass an array here and fan out in node 5 if your orchestration allows it.

`automapInputs: false`. Body as `{"type":"map",...}`, never a JSON string.

## Node 5 — normalize, and the join key that bites

```python
def run(items):
    posts = []
    for it in (items or []):
        a = it.get("author") or {}
        # THE TRAP: on PERSON items the company-style identifier is null and the
        # slug lives in publicIdentifier. Grouping on universalName alone makes
        # every person row silently vanish -- no error, just nothing.
        key = a.get("universalName") or a.get("publicIdentifier") or ""
        posts.append({
            "profile_key":  key.lower(),
            "author_type":  a.get("type", "company"),
            "text":         (it.get("content") or "").strip(),
            "url":          it.get("url", ""),
            "days_ago":     it.get("daysAgo"),
            "posted_at":    it.get("postedAt", ""),
        })
    # Newest first. The filter walks this order and keeps the FIRST post that clears.
    posts.sort(key=lambda p: p.get("posted_at") or "", reverse=True)
    return {"posts": posts[:3], "has_posts": bool(posts)}
```

## Nodes 6a-c — the skip filter

One agent per post, same prompt, JSON out `{"skip": true|false, "category": "...", "reason": "..."}`.

Skip categories: `personal`, `political`, `bereavement`, `charged` (religious or geopolitical
flashpoints). **Ordinary business content passes** — memes, polls, job ads, volunteering, work
anniversaries, regulation commentary.

⚠️ **Low reasoning effort is load-bearing.** At default effort this filter **hung past 180 seconds.**
`finish_reason=length` with empty content means **retry with double the cap, never an abstain.**

Fan-in to node 7 is safe: a node with several incoming edges fires on first arrival, and pins from
branches that did not run resolve as absent.

## Node 7 — choose, failing closed

```python
def run(posts, verdicts):
    for i, p in enumerate(posts.get("posts", [])):
        v = (verdicts or [])[i] if i < len(verdicts or []) else None
        # FAIL CLOSED: an error, a bad parse, or a missing "skip" key all mean SKIP.
        # Only a literal False keeps the post. A filter that fails OPEN will one day
        # put a bereavement post into a cold email.
        if isinstance(v, dict) and v.get("skip") is False:
            return {"chosen": p, "skipped": i}
        # A SKIP TAKES THE NEXT POST. It is not an abstain -- treating it as one
        # discards rows where post 2 or 3 was perfectly usable.
    return {"chosen": None, "skipped": len(posts.get("posts", []))}
```

## Node 9 — contract

```python
def run(chosen, ai=None, want_line=False):
    c = (chosen or {}).get("chosen")
    if not c:
        # Blank, never invented. No guess, no "N/A", and NO sequencer-side
        # fallback value -- a fallback is how a generic sentence gets attributed
        # to a post that does not exist.
        return {"social_post_text": "", "social_post_url": "",
                "social_post_days_ago": "", "social_post_author_type": "",
                "social_post_line": ""}
    out = {
        "social_post_text":        c["text"],       # THE PRODUCT
        "social_post_url":         c["url"],
        "social_post_days_ago":    c.get("days_ago", ""),
        "social_post_author_type": c.get("author_type", ""),
    }
    if want_line:
        out["social_post_line"] = (ai or {}).get("line", "")
    return out
```

## Fan-out rule

**Company posts fan out to every contact at that company. Person posts never fan out.**

Mixing those is how ten people at one company all receive "noticed you posted about X" about a post
their CEO wrote.

## Build and run

```bash
WF=$(clay workflows create --name "Playbook: recent social post" | jq -r '.id')
# create the 9 nodes; pin inputSchema and set outputSchema in SEPARATE update calls
clay workflows publish "$WF"

RT=$(clay routines create workflow "$WF" --name "social-post" | jq -r '.id')
clay routines runs start "$RT" --input '{"items":[
  {"profile_url":"https://www.linkedin.com/company/example"},
  {"profile_url":"https://www.linkedin.com/in/example-founder"}
]}'
```

**Dedupe to unique profile URLs before this runs**, and fan the result back out afterwards. Costing
per contact instead of per profile overstates spend by your contacts-per-company ratio.

## Before you upload

**Split the list on a non-empty line**, with segment B's clause removed and rewritten — that segment
is your honest A/B control.

**Never gate with spintax**, which picks at random, renders `Noticed .`, and discards personalization
you paid for. QC the rendered preview to zero occurrences.

## Smoke test

| What you see | What it means |
|---|---|
| The client times out on a fast run | you collapsed nodes 2-4 into a synchronous call |
| Every person row empty | node 5 is grouping on the company-style key only |
| A post you would never send got through | node 7 is failing open |
| Rows abstain where post 2 was fine | a skip is being treated as an abstain |
| The filter hangs | reasoning effort is not low |
| Cost scales with contacts, not profiles | dedupe before, fan out after |
| Lines reference posts the account did not write | reposts were included |
