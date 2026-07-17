#!/usr/bin/env tsx
/**
 * Bulk add/remove tags on Smartlead inboxes.
 *
 * Usage:
 *   export SMARTLEAD_API_KEY=xxx
 *   npx tsx scripts/tag-inboxes.ts --tag=new --add-tag=insurance
 *   npx tsx scripts/tag-inboxes.ts --tag=insurance --remove-tag=insurance --add-tag=active
 *   npx tsx scripts/tag-inboxes.ts --ids=1,2,3 --add-tag=active
 *
 * Selector flags: --all, --ids=..., --domain=..., --tag=..., --ids-from-csv=path
 * Actions (can combine): --add-tag=name[:color], --remove-tag=name
 *
 * Note: Smartlead tag endpoint replaces the entire tag list. This script
 *       reads existing tags, applies add/remove, and POSTs the new list.
 */

import { API_BASE, API_KEY, parseFlag, selectInboxes, runWithConcurrency, fetchJson, confirmProceed } from "./_lib.js";

async function main() {
  const args = process.argv.slice(2);
  const addTagArg = parseFlag(args, "--add-tag");
  const removeTagArg = parseFlag(args, "--remove-tag");
  if (!addTagArg && !removeTagArg) {
    console.error("Provide --add-tag=name[:color] and/or --remove-tag=name");
    process.exit(1);
  }

  let addName: string | undefined;
  let addColor = "#0d9488";
  if (addTagArg) {
    const [name, color] = addTagArg.split(":");
    addName = name;
    if (color) addColor = color.startsWith("#") ? color : `#${color}`;
  }

  console.error(`Selecting inboxes...`);
  const inboxes = await selectInboxes(args);
  console.error(`Matched ${inboxes.length} inboxes`);
  if (!inboxes.length) return;

  console.error(`Actions: add=${addName ?? "-"} (${addColor})  remove=${removeTagArg ?? "-"}`);
  await confirmProceed(args, `Updating tags on ${inboxes.length} inboxes`, 3);

  let ok = 0;
  let fail = 0;
  const failedIds: number[] = [];
  await runWithConcurrency(inboxes, 5, async (inbox, i) => {
    const existing = inbox.tags ?? [];
    let newTags: { id?: number; name: string; color?: string }[] = existing
      .filter((t) => t.name !== removeTagArg)
      .map((t) => ({ id: t.id, name: t.name, color: t.color }));
    if (addName && !newTags.some((t) => t.name === addName)) {
      newTags.push({ name: addName, color: addColor });
    }
    const url = `${API_BASE}/email-accounts/tag?api_key=${API_KEY}`;
    const body = {
      email_account_ids: [inbox.id],
      tags: newTags,
    };
    try {
      await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      ok++;
      if ((i + 1) % 20 === 0) console.error(`  ${i + 1}/${inboxes.length} processed`);
    } catch (err) {
      fail++;
      failedIds.push(inbox.id);
      console.error(`  [${inbox.id}]: ${String(err).slice(0, 200)}`);
    }
  });

  console.error(`\nDone. ${ok} updated, ${fail} failed.`);
  if (fail > 0) {
    console.error(`Failed ids (retry with --ids=...): ${failedIds.join(",")}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
