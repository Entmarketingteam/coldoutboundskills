#!/usr/bin/env python3
"""Drop rows that were never actually tested so a fresh worker can retry them.

A provider punt ("unknown" billed 0), a transport error, or an inconclusive
domain probe is NOT a miss — the contact was never really checked. Keeping them
recorded would bank them as failures; clearing them lets the next shift retry.

Only ever call this for production yield runs. For measurement runs, keep the
rows (CLEAR=0), or the reported hit rate is biased upward by repeatedly
re-rolling only the contacts that refuse to resolve.
"""
import json
import os
import sys

UNTESTED = {"inconclusive_provider_punt", "domain_unverifiable", "transport_error"}

path = sys.argv[1]
if not os.path.exists(path):
    raise SystemExit

keep, dropped = [], 0
with open(path) as fh:
    for line in fh:
        if not line.strip():
            continue
        row = json.loads(line)
        if not row.get("email") and row.get("source") in UNTESTED:
            dropped += 1
            continue
        keep.append(line.rstrip("\n"))

with open(path, "w") as fh:
    fh.write("\n".join(keep) + ("\n" if keep else ""))

print(f"[sup] kept {len(keep)} verdicts, cleared {dropped} untested for the next shift")
