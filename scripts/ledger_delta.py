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
# officer_audit_log included so ledger shows who-added-what audit deltas.
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
    "officer_audit_log",
]

# Columns to redact in HTML and JSON output (never display on the delta page).
REDACT_COLUMNS = frozenset({"email"})

# Rows per page for Added/Removed/Changed tables (client-side paging).
PAGE_SIZE = 50

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
    "officer_audit_log": ("id",),
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


def redact_value(col: str, value: str) -> str:
    """Return display value; redact PII columns."""
    if not value:
        return value
    if col in REDACT_COLUMNS:
        return "[redacted]"
    return value


def format_row_as_html(row: dict[str, str], columns: list[str]) -> str:
    return "".join(
        f"<td>{escape(redact_value(c, row.get(c, '')))}</td>" for c in columns
    )


def _append_pager(html_parts: list[str], total: int, container_id: str) -> None:
    """Append pager nav and data attrs for JS."""
    total_pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
    html_parts.append(
        f'<nav class="pager" data-container="{escape(container_id)}" data-total-pages="{total_pages}" data-total="{total}">'
        f'<span class="pager-label">Page <strong class="pager-current">1</strong> of {total_pages}</span> '
        f'<button type="button" class="pager-prev" aria-label="Previous page">Prev</button> '
        f'<button type="button" class="pager-next" aria-label="Next page">Next</button>'
        "</nav>"
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
        .pager { margin: 0.5rem 0 1rem; font-size: 0.9rem; }
        .pager button { margin: 0 0.25rem; padding: 0.25rem 0.5rem; cursor: pointer; background: var(--surface); color: var(--text); border: 1px solid var(--muted); border-radius: 4px; }
        .pager button:hover:not(:disabled) { background: var(--muted); }
        .pager button:disabled { opacity: 0.5; cursor: not-allowed; }
        .ledger-paged { margin-bottom: 1rem; }
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

        # Collect all columns used (exclude redacted so they are not displayed at all)
        all_cols_raw: list[str] = []
        for row in added + removed:
            for c in row:
                if c not in all_cols_raw:
                    all_cols_raw.append(c)
        for c in (changed or []):
            for k in c.get("old", {}).keys() | c.get("new", {}).keys():
                if k not in all_cols_raw:
                    all_cols_raw.append(k)
        if not all_cols_raw and changed:
            all_cols_raw = list(changed[0]["old"].keys()) if changed else []
        all_cols = [c for c in all_cols_raw if c not in REDACT_COLUMNS]

        table_id = escape(table).replace(" ", "_")
        if added:
            html_parts.append("<h3>Added</h3>")
            html_parts.append(f'<div class="ledger-paged" data-page-size="{PAGE_SIZE}" id="paged-{table_id}-added">')
            html_parts.append("<table><thead><tr>")
            html_parts.append("".join(f"<th>{escape(c)}</th>" for c in all_cols))
            html_parts.append("</tr></thead><tbody>")
            for i, row in enumerate(added):
                p = i // PAGE_SIZE
                html_parts.append(f"<tr class='added ledger-row' data-page='{p}'>{format_row_as_html(row, all_cols)}</tr>")
            html_parts.append("</tbody></table>")
            _append_pager(html_parts, len(added), f"paged-{table_id}-added")
            html_parts.append("</div>")

        if removed:
            html_parts.append("<h3>Removed</h3>")
            html_parts.append(f'<div class="ledger-paged" data-page-size="{PAGE_SIZE}" id="paged-{table_id}-removed">')
            html_parts.append("<table><thead><tr>")
            html_parts.append("".join(f"<th>{escape(c)}</th>" for c in all_cols))
            html_parts.append("</tr></thead><tbody>")
            for i, row in enumerate(removed):
                p = i // PAGE_SIZE
                html_parts.append(f"<tr class='removed ledger-row' data-page='{p}'>{format_row_as_html(row, all_cols)}</tr>")
            html_parts.append("</tbody></table>")
            _append_pager(html_parts, len(removed), f"paged-{table_id}-removed")
            html_parts.append("</div>")

        if changed:
            html_parts.append("<h3>Changed</h3>")
            html_parts.append(f'<div class="ledger-paged" data-page-size="{PAGE_SIZE}" id="paged-{table_id}-changed">')
            html_parts.append("<table><thead><tr><th>Field</th><th>Old</th><th>New</th></tr></thead><tbody>")
            for i, item in enumerate(changed):
                old_r, new_r = item["old"], item["new"]
                p = i // PAGE_SIZE
                for col in all_cols:
                    ov, nv = old_r.get(col, ""), new_r.get(col, "")
                    if ov != nv:
                        rov, rnv = redact_value(col, ov), redact_value(col, nv)
                        html_parts.append(
                            f"<tr class='changed-old ledger-row' data-item-index='{i}' data-page='{p}'><td>{escape(col)}</td><td>{escape(rov)}</td><td class='changed-new'>{escape(rnv)}</td></tr>"
                        )
            html_parts.append("</tbody></table>")
            _append_pager(html_parts, len(changed), f"paged-{table_id}-changed")
            html_parts.append("</div>")

    html_parts.append("""
<script>
(function() {
  var PAGE_SIZE = """ + str(PAGE_SIZE) + """;
  document.querySelectorAll('.ledger-paged').forEach(function(block) {
    var rows = block.querySelectorAll('.ledger-row');
    var nav = block.querySelector('.pager');
    if (!nav || !rows.length) return;
    var totalPages = parseInt(nav.dataset.totalPages, 10) || 1;
    var current = 0;
    var curEl = nav.querySelector('.pager-current');
    var prevBtn = nav.querySelector('.pager-prev');
    var nextBtn = nav.querySelector('.pager-next');
    function showPage(p) {
      current = Math.max(0, Math.min(p, totalPages - 1));
      rows.forEach(function(tr) {
        tr.style.display = parseInt(tr.dataset.page, 10) === current ? '' : 'none';
      });
      if (curEl) curEl.textContent = current + 1;
      if (prevBtn) prevBtn.disabled = current <= 0;
      if (nextBtn) nextBtn.disabled = current >= totalPages - 1;
    }
    if (prevBtn) prevBtn.addEventListener('click', function() { showPage(current - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function() { showPage(current + 1); });
    showPage(0);
  });
})();
</script>
</body></html>""")

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

    def _redact_row(row: dict) -> dict:
        return {c: "[redacted]" if c in REDACT_COLUMNS and row.get(c) else row.get(c, "") for c in row}

    def _serialize(d: dict) -> dict:
        out = {}
        for k, v in d.items():
            if not isinstance(v, dict):
                out[k] = v
                continue
            out[k] = {}
            for section, rows in v.items():
                if section == "changed":
                    out[k][section] = [
                        {"key": x["key"], "old": _redact_row(x["old"]), "new": _redact_row(x["new"])}
                        for x in rows
                    ]
                elif section in ("added", "removed") and isinstance(rows, list):
                    out[k][section] = [_redact_row(r) for r in rows]
                else:
                    out[k][section] = rows
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
