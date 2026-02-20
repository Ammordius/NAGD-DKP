#!/usr/bin/env python3
"""Run end_restore_load() to clear restore flag and run full refresh (after apply if it timed out)."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
for p in (ROOT / ".env", ROOT / "web" / ".env", ROOT / "web" / ".env.local"):
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))
from supabase import create_client
c = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
c.rpc("end_restore_load").execute()
print("end_restore_load() completed.")
