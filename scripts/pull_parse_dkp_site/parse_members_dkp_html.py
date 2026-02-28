#!/usr/bin/env python3
"""
Parse the Gamer Launch DKP HTML into a canonical snapshot and audit against Supabase.
The HTML is already one row per ACCOUNT (aggregated earned/spent). We parse and compare at account level.

Usage:
  # Download the page first (requires cookies.txt):
  python scripts/pull_parse_dkp_site/pull_members_dkp.py -o data/members_dkp.html

  # Parse HTML -> save canonical JSON (one row per account).
  python parse_members_dkp_html.py parse "Current Member DKP - ... .html" -o data/members_dkp_snapshot.json

  # Audit: compare snapshot to DB (account-level; DB sums dkp_summary by account).
  python parse_members_dkp_html.py audit data/members_dkp_snapshot.json
  python parse_members_dkp_html.py audit "Current Member DKP - ... .html"
  python parse_members_dkp_html.py audit data/members_dkp_snapshot.json --json-out audit_result.json

  # Emit SQL to run in Supabase SQL Editor for instant account-level audit:
  python parse_members_dkp_html.py parse "Current Member DKP - ... .html" -o data/snapshot.json --emit-sql docs/audit_dkp_snapshot_vs_db.sql

Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) for audit.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Repo root (dkp/) for resolving relative paths and .env
SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent

# Optional deps
try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None  # type: ignore

try:
    from dotenv import load_dotenv as _load_dotenv
except ImportError:
    _load_dotenv = None  # type: ignore


def load_dotenv() -> None:
    """Load .env from repo root and web/.env so SUPABASE_* is found when run from any cwd."""
    for env_path in (ROOT / ".env", ROOT / "web" / ".env", ROOT / "web" / ".env.local"):
        if env_path.exists():
            try:
                text = env_path.read_text(encoding="utf-8")
            except Exception:
                continue
            for line in text.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip("'\"")
                    if k and k not in os.environ:
                        os.environ[k] = v
            for vite, plain in (
                ("VITE_SUPABASE_URL", "SUPABASE_URL"),
                ("VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"),
                ("VITE_SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
            ):
                if not os.environ.get(plain) and os.environ.get(vite):
                    os.environ[plain] = os.environ[vite]
    if _load_dotenv:
        _load_dotenv(ROOT / ".env")
        _load_dotenv(ROOT / "web" / ".env")


def _resolve_path(p: Path) -> Path:
    """If p is relative, resolve against repo root so paths work from any cwd."""
    if not p.is_absolute():
        return (ROOT / p).resolve()
    return p.resolve()


def _find_members_html(path: Path) -> Path | None:
    """Return path if it exists; else if looking for members_dkp.html, try browser default name."""
    resolved = _resolve_path(path) if path else None
    if resolved and resolved.exists():
        return resolved
    # Fallback: browser default save name (anywhere under repo root or data/)
    for base in (ROOT, ROOT / "data"):
        if not base.exists():
            continue
        for f in base.glob("Current Member DKP*.html"):
            return f.resolve()
    return resolved  # return resolved so caller sees the intended path in errors


def _log(msg: str) -> None:
    """Print a timestamped line for instrumentation/automation."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {msg}")


def _norm(s: str | None) -> str:
    if s is None:
        return ""
    return str(s).strip()


def _int_from_dkp_span(text: str) -> int:
    """Parse '5,002' or '1,233' -> int."""
    if not text:
        return 0
    cleaned = re.sub(r"[,\s]", "", _norm(text))
    try:
        return int(cleaned)
    except ValueError:
        return 0


def parse_members_dkp_html(html_path: Path) -> list[dict[str, Any]]:
    """Parse the DKP table from saved Gamer Launch HTML. Each row = one ACCOUNT (aggregated).
    Returns list of account rows: account_name (display/main name), earned, spent, total."""
    if BeautifulSoup is None:
        raise RuntimeError("pip install beautifulsoup4")
    html = html_path.read_text(encoding="utf-8", errors="replace")
    soup = BeautifulSoup(html, "lxml")

    # Table: class="data-table forumline hover_highlight", tbody class="data_table"
    tbody = soup.find("tbody", class_=re.compile(r"data_table"))
    if not tbody:
        for t in soup.find_all("table"):
            if t.find("th", string=re.compile(r"Earned", re.I)):
                tbody = t.find("tbody") or t
                break
        if not tbody:
            raise ValueError("Could not find member DKP table in HTML")

    rows: list[dict[str, Any]] = []
    for tr in tbody.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 8:
            continue
        checkbox = tr.find("input", {"name": "compare_char_id[]"})
        char_id = _norm(checkbox.get("value", "")) if checkbox else ""
        name_td = tds[1]
        name_link = name_td.find("a", href=re.compile(r"character_dkp\.php\?char="))
        account_name = _norm(name_link.get_text()) if name_link else ""

        earned_span = tr.find("span", class_="dkp_earned")
        spent_span = tr.find("span", class_="dkp_spent")
        current_span = tr.find("span", class_="dkp_current")
        earned = _int_from_dkp_span(earned_span.get_text() if earned_span else "")
        spent = _int_from_dkp_span(spent_span.get_text() if spent_span else "")
        total = _int_from_dkp_span(current_span.get_text() if current_span else "")

        if not account_name:
            continue
        rows.append({
            "account_name": account_name,
            "char_id": char_id,  # optional hint (e.g. main toon) for linking to account
            "earned": earned,
            "spent": spent,
            "total": total,
        })
    return rows


def build_name_to_account_id(
    accounts: list[dict[str, Any]],
    character_account: list[dict[str, Any]],
    characters: list[dict[str, Any]],
) -> dict[str, str]:
    """Map any name (display_name or character name) -> account_id for matching HTML rows to DB."""
    char_id_to_name: dict[str, str] = {}
    for r in characters:
        cid = _norm(r.get("char_id", ""))
        if cid:
            char_id_to_name[cid] = _norm(r.get("name", ""))
    name_to_aid: dict[str, str] = {}
    for r in accounts:
        aid = _norm(r.get("account_id", ""))
        if not aid:
            continue
        dn = _norm(r.get("display_name", ""))
        if dn:
            name_to_aid[dn] = aid
        for part in (_norm(r.get("toon_names", "")) or "").split(","):
            n = part.strip()
            if n:
                name_to_aid[n] = aid
    for r in character_account:
        cid = _norm(r.get("char_id", ""))
        aid = _norm(r.get("account_id", ""))
        if cid and aid:
            name = char_id_to_name.get(cid, "")
            if name:
                name_to_aid[name] = aid
    return name_to_aid


def emit_audit_sql(rows: list[dict[str, Any]], out_sql: Path) -> None:
    """Write SQL that compares account-level snapshot to DB (dkp_summary summed by account)."""
    values_lines = []
    for r in rows:
        name = _norm(r.get("account_name", ""))
        if not name:
            continue
        name_esc = name.replace("'", "''")
        values_lines.append(f"  ('{name_esc}', {int(r.get('earned', 0))}, {int(r.get('spent', 0))})")
    values_sql = ",\n".join(values_lines)
    sql = f"""-- Audit DKP: snapshot (per-account from HTML) vs DB account totals. Run in Supabase SQL Editor.
-- Snapshot rows are already aggregated per account; we sum dkp_summary by account_id and compare.

WITH snapshot AS (
  SELECT * FROM (VALUES
{values_sql}
  ) AS t(account_name, earned, spent)
),
-- Match snapshot account_name to account_id (display_name or any linked character name); one row per snapshot
account_match AS (
  SELECT DISTINCT ON (u.account_name) u.account_name, u.earned, u.spent, u.account_id
  FROM (
    SELECT s.account_name, s.earned, s.spent, a.account_id FROM snapshot s JOIN accounts a ON trim(a.display_name) = s.account_name
    UNION
    SELECT s.account_name, s.earned, s.spent, ca.account_id FROM snapshot s JOIN character_account ca ON true JOIN characters c ON c.char_id = ca.char_id AND trim(c.name) = s.account_name
  ) u
  ORDER BY u.account_name, u.account_id
),
-- Sum dkp_summary by account (character_key can be char_id or character_name)
db_by_account AS (
  SELECT account_id, sum(db_earned)::bigint AS db_earned, sum(db_spent)::bigint AS db_spent
  FROM (
    SELECT ca.account_id, (d.earned)::numeric AS db_earned, d.spent::bigint AS db_spent
    FROM character_account ca
    JOIN dkp_summary d ON d.character_key = ca.char_id
    UNION ALL
    SELECT ca.account_id, (d.earned)::numeric, d.spent::bigint
    FROM character_account ca
    JOIN characters c ON c.char_id = ca.char_id
    JOIN dkp_summary d ON d.character_key = trim(c.name)
  ) sub
  GROUP BY account_id
)
SELECT
  m.account_name,
  m.account_id,
  m.earned   AS snapshot_earned,
  m.spent    AS snapshot_spent,
  d.db_earned,
  d.db_spent,
  (m.earned - COALESCE(d.db_earned, 0))::bigint AS delta_earned,
  (m.spent  - COALESCE(d.db_spent, 0))::bigint  AS delta_spent,
  CASE
    WHEN d.account_id IS NULL THEN 'missing_in_db'
    WHEN m.earned <> COALESCE(d.db_earned, 0) OR m.spent <> COALESCE(d.db_spent, 0) THEN 'mismatch'
    ELSE 'ok'
  END AS status
FROM account_match m
LEFT JOIN db_by_account d ON d.account_id = m.account_id
ORDER BY (CASE WHEN d.account_id IS NULL THEN 2 WHEN m.earned <> COALESCE(d.db_earned, 0) OR m.spent <> COALESCE(d.db_spent, 0) THEN 1 ELSE 0 END) DESC, (m.earned - COALESCE(d.db_earned, 0)) DESC NULLS LAST;
"""
    out_sql.parent.mkdir(parents=True, exist_ok=True)
    out_sql.write_text(sql, encoding="utf-8")
    print(f"Wrote {out_sql} (run in Supabase SQL Editor for instant audit)")


def run_parse(html_path: Path, out_json: Path | None, out_csv: Path | None, out_sql: Path | None) -> list[dict[str, Any]]:
    html_path = _find_members_html(html_path) or _resolve_path(html_path)
    if not html_path.exists():
        print(f"Not found: {html_path}", file=sys.stderr)
        print("Save the Gamer Launch members DKP page as 'Current Member DKP - Rapid Raid... .html' in the repo root or data/.", file=sys.stderr)
        raise SystemExit(1)
    rows = parse_members_dkp_html(html_path)
    print(f"Parsed {len(rows)} accounts from {html_path.name}")

    if out_json:
        out_json = _resolve_path(out_json)
        out_json.parent.mkdir(parents=True, exist_ok=True)
        payload = {"source": html_path.name, "accounts": rows}
        out_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"Wrote {out_json}")

    if out_csv:
        out_csv = _resolve_path(out_csv)
        out_csv.parent.mkdir(parents=True, exist_ok=True)
        import csv
        with open(out_csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["account_name", "char_id", "earned", "spent", "total"])
            w.writeheader()
            w.writerows(rows)
        print(f"Wrote {out_csv}")

    if out_sql:
        out_sql = _resolve_path(out_sql)
        emit_audit_sql(rows, out_sql)

    return rows


def fetch_all(client: Any, table: str, columns: str) -> list[dict[str, Any]]:
    """Paginate through a Supabase table."""
    out: list[dict[str, Any]] = []
    page_size = 1000
    offset = 0
    while True:
        r = client.table(table).select(columns).range(offset, offset + page_size - 1).execute()
        data = r.data if hasattr(r, "data") else (r.json() or {}).get("data", [])
        if not data:
            break
        out.extend(data)
        if len(data) < page_size:
            break
        offset += page_size
    return out


def run_audit(
    snapshot_path: Path | None,
    html_path: Path | None,
    by_account: bool,
    json_out: Path | None = None,
) -> int:
    """Load snapshot (from JSON or by parsing HTML), query DB once for all dkp_summary, compare."""
    _log("audit_start")
    load_dotenv()
    if snapshot_path:
        snapshot_path = _resolve_path(snapshot_path)
    if html_path:
        html_path = _find_members_html(html_path) or _resolve_path(html_path)
    if json_out:
        json_out = _resolve_path(json_out)
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    )
    if not url or not key:
        _log("audit_error: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY")
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) for audit.", file=sys.stderr)
        return 1
    try:
        from supabase import create_client
    except ImportError:
        _log("audit_error: supabase package not installed")
        print("pip install supabase", file=sys.stderr)
        return 1

    # Load canonical list (each row = one account with aggregated earned/spent)
    if snapshot_path and snapshot_path.suffix.lower() == ".json" and snapshot_path.exists():
        data = json.loads(snapshot_path.read_text(encoding="utf-8"))
        accounts_snapshot = data.get("accounts", data.get("characters", []))
        if not isinstance(accounts_snapshot, list):
            accounts_snapshot = [accounts_snapshot]
        # Backward compat: old format had character_name
        for row in accounts_snapshot:
            if "account_name" not in row and "character_name" in row:
                row["account_name"] = row["character_name"]
        _log(f"loaded_snapshot path={snapshot_path} accounts={len(accounts_snapshot)}")
        print(f"Loaded {len(accounts_snapshot)} accounts from {snapshot_path}")
    elif html_path and html_path.exists():
        accounts_snapshot = parse_members_dkp_html(html_path)
        _log(f"parsed_html path={html_path} accounts={len(accounts_snapshot)}")
        print(f"Parsed {len(accounts_snapshot)} accounts from {html_path}")
    else:
        _log("audit_error: no snapshot or html path provided")
        print("Provide --snapshot (JSON) or --html path.", file=sys.stderr)
        return 1

    client = create_client(url, key)
    _log("supabase_connected")
    accounts = fetch_all(client, "accounts", "account_id, display_name, toon_names")
    ca_list = fetch_all(client, "character_account", "char_id, account_id")
    characters = fetch_all(client, "characters", "char_id, name")
    name_to_aid = build_name_to_account_id(accounts, ca_list, characters)

    # DB totals per account: prefer account_dkp_summary when present; else sum dkp_summary by character_account
    dkp_rows = fetch_all(client, "dkp_summary", "character_key, earned, spent")
    account_summary: list[dict[str, Any]] = []
    try:
        account_summary = fetch_all(client, "account_dkp_summary", "account_id, earned, spent")
    except Exception:
        pass
    db_earned_by_account = {}
    db_spent_by_account = {}
    if account_summary:
        for r in account_summary:
            aid = _norm(r.get("account_id", ""))
            if aid:
                db_earned_by_account[aid] = int(r.get("earned") or 0)
                db_spent_by_account[aid] = int(r.get("spent") or 0)
    else:
        key_to_aid: dict[str, str] = dict(name_to_aid)
        for r in ca_list:
            cid = _norm(r.get("char_id", ""))
            aid = _norm(r.get("account_id", ""))
            if cid and aid:
                key_to_aid[cid] = aid
        for r in dkp_rows:
            key = _norm(r.get("character_key", ""))
            aid = key_to_aid.get(key)
            if not aid:
                continue
            db_earned_by_account[aid] = db_earned_by_account.get(aid, 0) + int(r.get("earned") or 0)
            db_spent_by_account[aid] = db_spent_by_account.get(aid, 0) + int(r.get("spent") or 0)

    mismatches: list[dict[str, Any]] = []
    matched = 0
    missing_in_db: list[dict[str, Any]] = []

    # Per account_id: any snapshot row with HTML == DB means we've "found the main" (e.g. Frinop); skip reporting alts (Tunn, Scarf, etc.) as mismatches.
    account_ids_with_matching_row: set[str] = set()
    for row in accounts_snapshot:
        account_name = _norm(row.get("account_name", ""))
        html_earned = int(row.get("earned", 0))
        html_spent = int(row.get("spent", 0))
        account_id = name_to_aid.get(account_name)
        if not account_id:
            missing_in_db.append(row)
            continue
        db_earned = db_earned_by_account.get(account_id, 0)
        db_spent = db_spent_by_account.get(account_id, 0)
        if html_earned == db_earned and html_spent == db_spent:
            account_ids_with_matching_row.add(account_id)

    # Build mismatches: only for account_ids where no row matched; one entry per account (pick row with highest html_earned as "main").
    mismatches_by_account: dict[str, dict[str, Any]] = {}
    for row in accounts_snapshot:
        account_name = _norm(row.get("account_name", ""))
        html_earned = int(row.get("earned", 0))
        html_spent = int(row.get("spent", 0))
        account_id = name_to_aid.get(account_name)
        if not account_id or account_id in account_ids_with_matching_row:
            continue
        db_earned = db_earned_by_account.get(account_id, 0)
        db_spent = db_spent_by_account.get(account_id, 0)
        if html_earned != db_earned or html_spent != db_spent:
            existing = mismatches_by_account.get(account_id)
            if existing is None or html_earned > existing["html_earned"]:
                mismatches_by_account[account_id] = {
                    "account_name": account_name,
                    "account_id": account_id,
                    "html_earned": html_earned,
                    "html_spent": html_spent,
                    "db_earned": db_earned,
                    "db_spent": db_spent,
                    "delta_earned": html_earned - db_earned,
                    "delta_spent": html_spent - db_spent,
                }
    mismatches = list(mismatches_by_account.values())
    matched = len(account_ids_with_matching_row)

    print()
    print("=== Audit result (account-level) ===")
    print(f"Snapshot accounts: {len(accounts_snapshot)}")
    print(f"Matched in DB:     {matched}")
    print(f"Missing in DB:    {len(missing_in_db)}")
    print(f"Mismatches:       {len(mismatches)}")

    ok = not mismatches and not missing_in_db
    _log(f"audit_complete snapshot={len(accounts_snapshot)} matched={matched} missing={len(missing_in_db)} mismatches={len(mismatches)} ok={ok}")

    if json_out:
        json_out.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, Any] = {
            "ok": ok,
            "snapshot_accounts": len(accounts_snapshot),
            "matched": matched,
            "missing_in_db": len(missing_in_db),
            "mismatches_count": len(mismatches),
            "missing": [{"account_name": r.get("account_name"), "earned": r.get("earned"), "spent": r.get("spent")} for r in missing_in_db],
            "mismatches": mismatches,
        }
        json_out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        _log(f"wrote_json path={json_out}")
        print(f"Wrote audit result to {json_out}")

    if missing_in_db:
        print("\n--- Not in DB (name not matched to any account) ---")
        for r in missing_in_db[:30]:
            print(f"  {r.get('account_name')}  earned={r.get('earned')} spent={r.get('spent')}")
        if len(missing_in_db) > 30:
            print(f"  ... and {len(missing_in_db) - 30} more")

    if mismatches:
        print("\n--- Mismatches (HTML vs DB account totals) ---")
        for m in mismatches:
            print(f"  {m['account_name']} (account_id={m['account_id']})")
            print(f"    earned: HTML={m['html_earned']}  DB={m['db_earned']}  delta={m['delta_earned']}")
            print(f"    spent:  HTML={m['html_spent']}  DB={m['db_spent']}  delta={m['delta_spent']}")

    if by_account:
        print("\n--- All snapshot accounts (first 50) ---")
        for r in accounts_snapshot[:50]:
            aid = name_to_aid.get(_norm(r.get("account_name", "")))
            print(f"  {r.get('account_name')} -> account_id={aid}  earned={r.get('earned')} spent={r.get('spent')}")
        if len(accounts_snapshot) > 50:
            print(f"  ... and {len(accounts_snapshot) - 50} more")

    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    # parse: html_file -o snapshot.json [--csv out.csv] [--emit-sql out.sql]
    p_parse = sub.add_parser("parse", help="Parse HTML to canonical JSON (and optional CSV / audit SQL)")
    p_parse.add_argument("html", type=Path, help="Path to saved 'Current Member DKP' HTML file")
    p_parse.add_argument("-o", "--out", dest="out_json", type=Path, default=None, help="Output JSON path (e.g. data/members_dkp_snapshot.json)")
    p_parse.add_argument("--csv", dest="out_csv", type=Path, default=None, help="Optional CSV output")
    p_parse.add_argument("--emit-sql", dest="out_sql", type=Path, default=None, help="Emit SQL to run in Supabase SQL Editor for instant audit")

    # audit: snapshot.json | html_file [--by-account]
    p_audit = sub.add_parser("audit", help="Compare snapshot (or HTML) to Supabase dkp_summary in one query")
    p_audit.add_argument("input", type=Path, nargs="?", default=None, help="Snapshot JSON or HTML file")
    p_audit.add_argument("--snapshot", type=Path, dest="snapshot", default=None, help="Snapshot JSON (alternative to positional)")
    p_audit.add_argument("--html", type=Path, dest="html_path", default=None, help="HTML file (alternative to positional)")
    p_audit.add_argument("--by-account", action="store_true", help="Show per-account aggregated totals from snapshot")
    p_audit.add_argument("--json-out", type=Path, dest="json_out", default=None, help="Write machine-readable audit result JSON (ok, counts, missing, mismatches)")

    args = parser.parse_args()

    if args.command == "parse":
        if not args.out_json and not args.out_csv and not getattr(args, "out_sql", None):
            print("Specify -o/--out, --csv and/or --emit-sql for parse.", file=sys.stderr)
            return 1
        run_parse(args.html, args.out_json, args.out_csv, getattr(args, "out_sql", None))
        return 0

    if args.command == "audit":
        snapshot = args.snapshot
        html_path = args.html_path
        if args.input and args.input.exists():
            if args.input.suffix.lower() == ".json":
                snapshot = snapshot or args.input
            else:
                html_path = html_path or args.input
        return run_audit(snapshot, html_path, getattr(args, "by_account", False), getattr(args, "json_out", None))

    return 0


if __name__ == "__main__":
    sys.exit(main())
