# Second bidder MVP (Python)

Proxy model for P(second bidder | item, context) with **no auction log** and **no future leakage** in rolling state.

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

Capability features include `recent_attendance` (placeholder `1.0` per spec); default weight is `0.0` so it does not change scores until you tune it.

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

Optional: pass `eligible_by_loot_id={loot_id: {"acc1", "acc2"}}` into `run_from_backup(...)` (forwarded to `prepare_second_bidder_events`).

## Modules

| Module | Role |
|--------|------|
| `prepare.py` | Normalize loot sales + attendance |
| `state.py` | Rolling knowledge (prior purchases only) |
| `candidates.py` | Hard-threshold pool |
| `features.py` | Capability / propensity / competitiveness (normalized within event) |
| `scoring.py` | Weighted sum → probabilities |
| `pipeline.py` | Sequential prediction loop |
| `debug.py` | Human-readable report |
| `evaluate.py` | Optional rank metrics when labels exist |
| `serialize.py` | JSON-safe rows for batch export |

## Sample CLI

```bash
PYTHONPATH=scripts python scripts/run_second_bidder_sample.py C:/path/to/backup --index -1 --debug
```

PowerShell:

```powershell
$env:PYTHONPATH = "scripts"
python scripts/run_second_bidder_sample.py "C:\TAKP\dkp\supabase-backup-2026-04-02" --index -1 --debug
```

Use the folder that contains `raids.csv` (sometimes `...\supabase-backup-YYYY-MM-DD\backup` after extract).

## Batch export (all sales, JSONL + resume)

Every positive-price sale with a resolved buyer becomes one JSON line (top candidates + counts). Progress prints to stderr; checkpoints let you restart after Ctrl+C or a crash.

```powershell
$env:PYTHONPATH = "scripts"
python scripts/run_second_bidder_batch.py "C:\TAKP\dkp\backup-2026-04-02\backup" `
  --out data/second_bidder.jsonl --progress-every 500 --checkpoint-every 200
```

Resume (append to the same `--out`, reuse checkpoint next to the file unless you passed `--checkpoint`):

```powershell
python scripts/run_second_bidder_batch.py "C:\TAKP\dkp\backup-2026-04-02\backup" `
  --out data/second_bidder.jsonl --resume
```

Full re-run from scratch: add `--fresh` (deletes the default `*.second_bidder_checkpoint.pkl` and overwrites the JSONL).

**Why resume needs a pickle:** The model’s “prior wins” state depends on **all** earlier sales in order. The checkpoint stores that rolling state plus the next `event_index`, so you do not have to re-score from row one unless you use `--fresh`.

For programmatic use, `iter_sequential_predictions(...)` yields `(event_index, prediction, knowledge_state)` after each event.

See `docs/SECOND_BIDDER_MVP_SPEC.md` for the full spec.
