# Second bidder MVP (Python)

Proxy model for P(second bidder | item, context) with **no auction log** and **no future leakage** in rolling state.

**Character-aware revision:** scores combine **account DKP posture** with **per-character** revealed spend (from **known prior purchases** in rolling state, union attendance `char_id`s when present), lane share, dormancy, and (prior-only) item-family fit; see [`docs/SECOND_BIDDER_CHARACTER_AWARE_SPEC.md`](../../docs/SECOND_BIDDER_CHARACTER_AWARE_SPEC.md).

## Run tests

From repo root:

```bash
PYTHONPATH=scripts python -m unittest discover -s scripts/second_bidder_model/tests -p "test*.py" -v
```

PowerShell (Windows):

```powershell
$env:PYTHONPATH = "scripts"
python -m unittest discover -s scripts/second_bidder_model/tests -p "test*.py" -v
```

Capability includes `wealth_utilization`, soft pool/ratio caps (`capability_pool_cap`, `capability_dkp_ratio_cap`), and `recent_attendance` (placeholder `1.0`; default weight `0.0`). Propensity includes `win_rate_over_attended_loot_sales` from rolling `KnowledgeState.account_loot_events_attended`.

## Use from a CSV backup

```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path("scripts").resolve()))

from second_bidder_model import (
    SecondBidderConfig,
    run_from_backup,
    format_event_report,
)

preds = run_from_backup(r"C:/path/to/backup", debug_first_n=1)
print(format_event_report(preds[0]))
```

Optional: pass into `prepare_second_bidder_events` / `run_from_backup(...)`:

- `item_eligibility_bundle=try_load_item_eligibility_bundle(repo_root)` — class/level gates from `data/item_stats.json` + mob loot name map + `characters.csv` (default in batch/sample when files exist).
- `eligible_by_loot_id={loot_id: {"acc1", "acc2"}}` — account-level “could use” filter.
- `eligible_chars_by_loot_id={loot_id: {("acc1", "char_uuid"), ...}}` — per-character eligibility (Magelo); **intersected** with derived pairs when both are set.

Tune lane thresholds and aggregation on `SecondBidderConfig` (`min_active_char_lifetime_spend`, `min_char_share_of_account_spend`, `character_aggregation`, `w_character`, …). Propensity includes `prior_same_item_wins` (same exact `item_name` in prior `char_win_history`).

## Modules

| Module | Role |
|--------|------|
| `prepare.py` | Normalize loot sales + attendance |
| `state.py` | Rolling knowledge (prior purchases only) |
| `candidates.py` | Hard-threshold pool |
| `features.py` | Capability / propensity / competitiveness / character (normalized within event) |
| `character_plausibility.py` | Attending-character gates, item fit, aggregation |
| `scoring.py` | Weighted sum → probabilities |
| `pipeline.py` | Sequential prediction loop |
| `debug.py` | Human-readable report |
| `evaluate.py` | Optional rank metrics when labels exist |
| `serialize.py` | JSON-safe rows for batch export |
| `eligibility_io.py` | Optional Magelo JSON maps |
| `item_stats_eligibility.py` | CSV class/level + `item_stats.json` → pairs |

## Sample CLI

```bash
PYTHONPATH=scripts python scripts/run_second_bidder_sample.py C:/path/to/backup --index -1 --debug
```

PowerShell:

```powershell
$env:PYTHONPATH = "scripts"
python scripts/run_second_bidder_sample.py "C:\TAKP\dkp\supabase-backup-2026-04-02" --index -1 --debug
```

Add `--no-character-detail` to shorten the text report. Per-character rows are always attached on `ScoredCandidate` for programmatic use (`seen_on_attendance` vs `prior_revealed_lane` flags).

Use the folder that contains `raids.csv` (sometimes `...\supabase-backup-YYYY-MM-DD\backup` after extract).

## Batch export (all sales, JSONL + resume)

Every positive-price sale with a resolved buyer becomes one JSON line (top candidates + counts). Progress prints to stderr; checkpoints let you restart after Ctrl+C or a crash.

```powershell
$env:PYTHONPATH = "scripts"
python scripts/run_second_bidder_batch.py "C:\TAKP\dkp\backup-2026-04-02\backup" `
  --out data/second_bidder.jsonl --progress-every 500 --checkpoint-every 200
```

Add `--include-character-debug` to JSONL lines if you want `character_debug` / `player_debug` on each ranked candidate (larger files).

By default the batch runner loads repo `data/item_stats.json` + `data/dkp_mob_loot.json` for class/level eligibility (stderr note if missing). Use `--no-item-stats` to skip, or `--item-stats` / `--mob-loot-json` / `--raid-sources-json` to override paths.

Optional `--eligibility-json path.json` loads `eligible_by_loot_id` / `eligible_chars_by_loot_id` (see [`docs/HANDOFF_SECOND_BIDDER_MVP.md`](../../docs/HANDOFF_SECOND_BIDDER_MVP.md)); character pairs are **intersected** with derived stats-based pairs when both apply.

Resume (append to the same `--out`, reuse checkpoint next to the file unless you passed `--checkpoint`):

```powershell
python scripts/run_second_bidder_batch.py "C:\TAKP\dkp\backup-2026-04-02\backup" `
  --out data/second_bidder.jsonl --resume
```

Full re-run from scratch: add `--fresh` (deletes the default `*.second_bidder_checkpoint.pkl` and overwrites the JSONL).

**Why resume needs a pickle:** The model’s “prior wins” state depends on **all** earlier sales in order. The checkpoint stores that rolling state plus the next `event_index`, so you do not have to re-score from row one unless you use `--fresh`.

For programmatic use, `iter_sequential_predictions(...)` yields `(event_index, prediction, knowledge_state)` after each event.

See `docs/SECOND_BIDDER_MVP_SPEC.md` for the full spec.
