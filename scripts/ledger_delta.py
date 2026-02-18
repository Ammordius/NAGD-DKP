#!/usr/bin/env python3
"""
Public SQL Ledger: compare two Supabase backup dirs (CSV per table) and generate
a daily-delta HTML report. Excludes raid_loot (loot assignment to character);
all other tables from the schema are included.

Usage:
  python scripts/ledger_delta.py --old backup_old --new backup_new --out ledger/report.html
  # Or with dates for the report title:
  python scripts/ledger_delta.py --old backup_old --new backup_new --out report.html --old-date 2026-02-15 --new-date 2026-02-18
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import os
import sys
from pathlib import Path

# Tables we diff (export_supabase_public_tables.py list minus raid_loot).
# officer_audit_log is in schema but not exported by default; include if present.
LEDGER_TABLES = [
    "profiles",
    "characters",
    "accounts",
    "character_account",
    "raids",
    "raid_events",
    "raid_attendance",
    "raid_event_attendance",
    "raid_dkp_totals",
    "raid_attendance_dkp",
    "raid_classifications",
    "dkp_adjustments",
    "dkp_summary",
    "dkp_period_totals",
    "active_raiders",
]

# Primary key column(s) per table for row identity (composite = tuple).
TABLE_KEYS: dict[str, tuple[str, ...]] = {
    "profiles": ("id",),
    "characters": ("char_id",),
    "accounts": ("account_id",),
    "character_account": ("char_id", "account_id"),
    "raids": ("raid_id",),
    "raid_events": ("id",),
    "raid_attendance": ("id",),
    "raid_event_attendance": ("id",),
    "raid_dkp_totals": ("raid_id",),
    "raid_attendance_dkp": ("raid_id", "character_key"),
    "raid_classifications": ("raid_id", "mob"),
    "dkp_adjustments": ("character_name",),
    "dkp_summary": ("character_key",),
    "dkp_period_totals": ("period",),
    "active_raiders": ("character_key",),
}


def load_csv(path: Path) -> list[dict[str, str]]:
    """Load a CSV into list of dicts (all values strings)."""
    if not path.exists():
        return []
    with open(path, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        return [row for row in reader]


def row_key(row: dict[str, str], key_cols: tuple[str, ...]) -> str:
    """Produce a stable key for a row (composite keys joined by \\0)."""
    return "\0".join(row.get(c, "") for c in key_cols)


def diff_tables(
    old_dir: Path,
    new_dir: Path,
) -> dict[str, dict]:
    """
    For each table in LEDGER_TABLES (that exists in both dirs), compute
    added / removed / changed. Returns { table_name: { added: [...], removed: [...], changed: [ {key, old, new} ] } }.
    """
    result: dict[str, dict] = {}
    for table in LEDGER_TABLES:
        key_cols = TABLE_KEYS.get(table)
        if not key_cols:
            continue
        old_path = old_dir / f"{table}.csv"
        new_path = new_dir / f"{table}.csv"
        if not new_path.exists():
            continue
        old_rows = load_csv(old_path)
        new_rows = load_csv(new_path)
        old_by_key = {row_key(r, key_cols): r for r in old_rows}
        new_by_key = {row_key(r, key_cols): r for r in new_rows}
        added = [new_by_key[k] for k in new_by_key if k not in old_by_key]
        removed = [old_by_key[k] for k in old_by_key if k not in new_by_key]
        changed = []
        for k in old_by_key:
            if k in new_by_key:
                o, n = old_by_key[k], new_by_key[k]
                if o != n:
                    changed.append({"key": k, "old": o, "new": n})
        result[table] = {"added": added, "removed": removed, "changed": changed}
    return result


def escape(s: str) -> str:
    return html.escape(str(s))


def format_row_as_html(row: dict[str, str], columns: list[str]) -> str:
    return "".join(
        f"<td>{escape(row.get(c, ''))}</td>" for c in columns
    )


def render_html(
    delta: dict[str, dict],
    old_date: str,
    new_date: str,
    out_path: Path,
) -> None:
    """Write a single HTML file with the delta report."""
    out_path.parent.mkdir(parents=True, exist_ok=True)

    tables_with_changes = [
        t for t in LEDGER_TABLES
        if t in delta and (
            delta[t]["added"] or delta[t]["removed"] or delta[t]["changed"]
        )
    ]
    no_changes = [t for t in LEDGER_TABLES if t in delta and t not in tables_with_changes]

    html_parts = [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        "<meta name='viewport' content='width=device-width, initial-scale=1'>",
        f"<title>SQL Ledger Delta — {old_date} → {new_date}</title>",
        "<style>",
        """
        :root { --bg: #0f1419; --surface: #1a2332; --text: #e6edf3; --muted: #8b949e; --green: #3fb950; --red: #f85149; --yellow: #d29922; }
        * { box-sizing: border-box; }
        body { font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; margin: 0; padding: 1.5rem; }
        a { color: #58a6ff; }
        h1 { font-size: 1.5rem; margin-top: 0; }
        h2 { font-size: 1.15rem; margin-top: 1.5rem; border-bottom: 1px solid var(--surface); padding-bottom: 0.25rem; }
        .meta { color: var(--muted); margin-bottom: 1.5rem; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; font-size: 0.875rem; }
        th, td { border: 1px solid var(--surface); padding: 0.35rem 0.5rem; text-align: left; }
        th { background: var(--surface); }
        .added td { background: rgba(63, 185, 80, 0.12); }
        .removed td { background: rgba(248, 81, 73, 0.12); }
        .changed-old td { background: rgba(248, 81, 73, 0.08); }
        .changed-new td { background: rgba(63, 185, 80, 0.08); }
        .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; }
        .badge-add { background: var(--green); color: var(--bg); }
        .badge-rem { background: var(--red); color: #fff; }
        .badge-chg { background: var(--yellow); color: var(--bg); }
        .no-change { color: var(--muted); font-size: 0.9rem; }
        .back { margin-bottom: 1rem; }
        summary { cursor: pointer; }
        """,
        "</style>",
        "</head>",
        "<body>",
        '<p class="back"><a href="index.html">← Back to SQL Ledger index</a></p>',
        f"<h1>Public SQL Ledger — Daily Delta</h1>",
        f'<p class="meta">Comparing <strong>{escape(old_date)}</strong> (older) → <strong>{escape(new_date)}</strong> (newer). Loot assignments (raid_loot) are excluded from this audit.</p>',
    ]

    if no_changes:
        html_parts.append("<p class='no-change'>No changes in: " + ", ".join(no_changes) + ".</p>")

    for table in tables_with_changes:
        d = delta[table]
        added, removed, changed = d["added"], d["removed"], d["changed"]
        total = len(added) + len(removed) + len(changed)
        html_parts.append(f"<h2>{escape(table)}</h2>")
        html_parts.append(
            f"<p><span class='badge badge-add'>{len(added)} added</span> "
            f"<span class='badge badge-rem'>{len(removed)} removed</span> "
            f"<span class='badge badge-chg'>{len(changed)} changed</span></p>"
        )

        # Collect all columns used
        all_cols: list[str] = []
        for row in added + removed:
            for c in row:
                if c not in all_cols:
                    all_cols.append(c)
        for c in (changed or []):
            for k in c.get("old", {}).keys() | c.get("new", {}).keys():
                if k not in all_cols:
                    all_cols.append(k)
        if not all_cols and changed:
            all_cols = list(changed[0]["old"].keys()) if changed else []

        if added:
            html_parts.append("<h3>Added</h3>")
            html_parts.append("<table><thead><tr>")
            html_parts.append("".join(f"<th>{escape(c)}</th>" for c in all_cols))
            html_parts.append("</tr></thead><tbody>")
            for row in added[:200]:  # cap for huge tables
                html_parts.append(f"<tr class='added'>{format_row_as_html(row, all_cols)}</tr>")
            if len(added) > 200:
                html_parts.append(f"<tr><td colspan='{len(all_cols)}' class='no-change'>… and {len(added) - 200} more</td></tr>")
            html_parts.append("</tbody></table>")

        if removed:
            html_parts.append("<h3>Removed</h3>")
            html_parts.append("<table><thead><tr>")
            html_parts.append("".join(f"<th>{escape(c)}</th>" for c in all_cols))
            html_parts.append("</tr></thead><tbody>")
            for row in removed[:200]:
                html_parts.append(f"<tr class='removed'>{format_row_as_html(row, all_cols)}</tr>")
            if len(removed) > 200:
                html_parts.append(f"<tr><td colspan='{len(all_cols)}' class='no-change'>… and {len(removed) - 200} more</td></tr>")
            html_parts.append("</tbody></table>")

        if changed:
            html_parts.append("<h3>Changed</h3>")
            html_parts.append("<table><thead><tr><th>Field</th><th>Old</th><th>New</th></tr></thead><tbody>")
            for item in changed[:100]:
                old_r, new_r = item["old"], item["new"]
                for col in all_cols:
                    ov, nv = old_r.get(col, ""), new_r.get(col, "")
                    if ov != nv:
                        html_parts.append(
                            f"<tr class='changed-old'><td>{escape(col)}</td><td>{escape(ov)}</td><td class='changed-new'>{escape(nv)}</td></tr>"
                        )
            if len(changed) > 100:
                html_parts.append(f"<tr><td colspan='3'>… and {len(changed) - 100} more changed rows</td></tr>")
            html_parts.append("</tbody></table>")

    html_parts.append("</body></html>")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(html_parts))


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Compare two backup dirs and generate SQL Ledger delta HTML (excludes raid_loot)."
    )
    ap.add_argument("--old", type=Path, required=True, help="Directory with older backup CSVs")
    ap.add_argument("--new", type=Path, required=True, help="Directory with newer backup CSVs")
    ap.add_argument("--out", type=Path, required=True, help="Output HTML path")
    ap.add_argument("--old-date", default="", help="Older backup date label (e.g. 2026-02-15)")
    ap.add_argument("--new-date", default="", help="Newer backup date label (e.g. 2026-02-18)")
    ap.add_argument("--json", action="store_true", help="Also write delta as JSON next to --out")
    args = ap.parse_args()

    if not args.old.is_dir():
        print(f"Not a directory: {args.old}", file=sys.stderr)
        return 1
    if not args.new.is_dir():
        print(f"Not a directory: {args.new}", file=sys.stderr)
        return 1

    old_date = args.old_date or args.old.name
    new_date = args.new_date or args.new.name

    delta = diff_tables(args.old, args.new)

    # JSON: make serializable (no dicts with non-string keys in lists)
    def _serialize(d: dict) -> dict:
        out = {}
        for k, v in d.items():
            if isinstance(v, list):
                out[k] = v
            elif isinstance(v, dict):
                out[k] = _serialize(v)
            else:
                out[k] = v
        return out

    if args.json:
        json_path = args.out.with_suffix(args.out.suffix + ".json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(_serialize(delta), f, indent=2)
        print(f"Wrote {json_path}")

    render_html(delta, old_date, new_date, args.out)
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
