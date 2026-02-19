#!/usr/bin/env python3
"""
Generate a JWT for the github_worker role. Use for direct Postgres or tooling only.
Do not use as SUPABASE_SERVICE_ROLE_KEY in CI: Supabase REST API accepts only the
built-in anon and service_role keys; custom JWTs always get 401.

Usage:
  pip install pyjwt
  export SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
  export JWT_SECRET=your-project-jwt-secret   # Dashboard -> Project Settings -> API -> JWT Secret
  python scripts/gen_github_worker_jwt.py
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

try:
    import jwt
except ImportError:
    print("Install PyJWT: pip install pyjwt", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    secret = (os.environ.get("JWT_SECRET") or os.environ.get("SUPABASE_JWT_SECRET") or "").strip()
    if not url or not secret:
        print("Set SUPABASE_URL and JWT_SECRET (or SUPABASE_JWT_SECRET).", file=sys.stderr)
        print("  JWT_SECRET = Dashboard -> Project Settings -> API -> JWT Secret", file=sys.stderr)
        return 1
    # iss must match what Supabase expects (project auth URL)
    iss = f"{url}/auth/v1" if not url.endswith("/auth/v1") else url
    now = int(datetime.now(timezone.utc).timestamp())
    payload = {
        "role": "github_worker",
        "iss": iss,
        "sub": "github-actions",
        "iat": now,
        "exp": now + (10 * 365 * 24 * 3600),  # 10 years
    }
    token = jwt.encode(payload, secret, algorithm="HS256")
    if hasattr(token, "decode"):
        token = token.decode("utf-8")
    print(token)
    return 0


if __name__ == "__main__":
    sys.exit(main())
