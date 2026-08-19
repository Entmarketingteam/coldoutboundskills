# Clay table build: Recent Social Post

Read [`../clay-playbooks/clay-table-harness.md`](../clay-playbooks/clay-table-harness.md) first.

⚠️ **Status: specification.**

## The shape problem, and the two recipes

The scrape is **async and batched**: you start a run over ~100 URLs, poll it, then read a dataset.
A Clay column is **synchronous and per row**. Those do not compose.

**Recipe A (recommended): scrape outside Clay, import the posts.** Dedupe your contacts to unique
profile URLs, run the batch, import `profile_url → post_text, post_url, days_ago, author_type`, and
let Clay do the fan-out, the filtering and the optional line.

**Recipe B (degraded): a per-row HTTP column against a synchronous endpoint.** It works, and it costs
you the batching discount — **each row pays its own run-start fee** — and it risks the client timeout
that made the async pattern mandatory in the first place. Use it only for small lists.

**Recipe A is not a workaround.** Batching is where most of the cost saving lives: a batch of 8 costs
the same start fee as a batch of 1.

## Where the columns go

Two tables, and keeping them separate is the whole cost story:

- **A profile table**, one row per unique company or person URL. **The scrape happens here.**
- **Your contact table**, which looks the post up by profile URL.

A 1,000-contact list covering 620 accounts costs about **$1.83 instead of $2.95** purely from this
split.

## Columns, profile table

| # | Column | Type | Input | Run condition | Notes |
|---|---|---|---|---|---|
| 1 | Profile URL | text | imported | none | company page **or** person. **Never guess a slug** |
| 2 | Posts Raw | imported (A) / HTTP (B) | 1 | `!!{{f_ProfileURL}}` | `maxPosts: 3`, 3-month window, **reposts off** |
| 3 | Post 1/2/3 Skip | AI ×3 | each post's text | that post exists | **the mandatory filter.** JSON out, `{"skip": bool, "reason": "..."}` |
| 4 | Chosen Post | Formula | 2, 3 | none | **newest-first, first post that clears** |
| 5 | social_post_text | Formula | 4 | none | **the deliverable** |
| 6 | social_post_url | Formula | 4 | none | |
| 7 | social_post_days_ago | Formula | 4 | none | |
| 8 | social_post_author_type | Formula | 2 | none | `company` or `profile` |
| 9 | social_post_line | AI | 5 | **opt-in only** | do not build unless the brief asked |

## Column 4: fail closed, and skip forward

```js
(() => {
  const posts = ({{f_PostsRaw}}?.posts || []).slice(0, 3);          // newest first
  const skips = [{{f_Post1Skip}}, {{f_Post2Skip}}, {{f_Post3Skip}}];
  for (let i = 0; i < posts.length; i++) {
    const s = skips[i];
    // FAIL CLOSED. An error, a bad parse, or a missing "skip" key all mean SKIP.
    // Only a literal false keeps the post. A filter that fails OPEN will one day
    // put a bereavement post into a cold email.
    if (s && s.skip === false) return posts[i];
    // A SKIP TAKES THE NEXT POST. It is not an abstain -- treating it as one
    // throws away rows where post 2 or 3 was perfectly usable.
  }
  return null;
})()
```

## Contact-table lookup

One column: look up the profile URL in the profile table and pull the post fields across.

⚠️ **Company posts fan out to every contact at that company. Person posts never fan out.** Mixing
those is how ten people at one company all receive "noticed you posted about X" about a post their
CEO wrote.

## The join key that will bite you

On **person** items the company-style identifier is **null** and the slug lives in a different field.
Normalize both sides before joining:

```js
String({{f_ProfileURL}} || "").toLowerCase()
  .replace(/^https?:\/\/(www\.)?linkedin\.com\//, "")
  .replace(/\/$/, "")
```

Join on the normalized string, not on the raw URL. Otherwise **every person row silently vanishes**
— no error, just an empty column.

## Push to your sequencer

Push `social_post_line` **only** when the brief asked for one.

⚠️ **Split the list before upload on `social_post_line != ""`.** Segment B has the clause **removed
and rewritten**, and it is your honest A/B control.

**Never gate it with spintax.** Spintax picks at random and cannot see an empty variable — it renders
`Noticed .` into inboxes *and* throws away personalization you paid for.

**QC before launch:** `grep -c "Noticed \." rendered_preview.csv` must be `0`.

## Smoke test

Run 20 profiles, mixed company and person.

- Every person row empty → the join key. Normalize both sides.
- A post you would never send got through → the filter failed open. Only `"skip": false` keeps.
- Rows abstain where post 2 was fine → a skip is being treated as an abstain.
- Fill near 71% on an SMB list → check you are not measuring high-frequency posters.
- Cost per contact instead of per profile → you skipped the two-table split.
