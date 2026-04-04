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

See `docs/SECOND_BIDDER_MVP_SPEC.md` for the full spec.
