"""Ensure scripts/ is on sys.path for bid_portfolio_local imports."""
from __future__ import annotations
import sys
from pathlib import Path
_SCRIPTS = Path(__file__).resolve().parent.parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
