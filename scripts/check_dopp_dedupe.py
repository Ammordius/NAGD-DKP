#!/usr/bin/env python3
"""Check Dopp raid_attendance_dkp list for duplicate raid_ids and sum dkp_earned."""
import json, sys
from collections import Counter

# Paste path or pass JSON path
path = sys.argv[1] if len(sys.argv) > 1 else None
if path:
    with open(path) as f:
        data = json.load(f)
else:
    data = json.load(sys.stdin)

raid_ids = [r["raid_id"] for r in data]
counts = Counter(raid_ids)
dupes = {rid: c for rid, c in counts.items() if c > 1}
total = sum(float(r["dkp_earned"]) for r in data)

print("Rows:", len(data))
print("Unique raid_ids:", len(counts))
print("Sum dkp_earned:", total)
if dupes:
    print("DUPLICATE raid_ids (same raid counted more than once):")
    for rid, c in sorted(dupes.items()):
        print(f"  {rid}: {c} rows")
else:
    print("No duplicate raid_ids in this list (no dedupe issue in raid_attendance_dkp).")
print("Character keys seen:", set(r["character_key"] for r in data))
