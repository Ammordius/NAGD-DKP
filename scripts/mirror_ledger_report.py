#!/usr/bin/env python3
"""Generate the public GitHub Pages dashboard from a mirror ledger diff model."""

from __future__ import annotations

import argparse
import json
import re
import sys
from html import escape
from pathlib import Path
from typing import Any

import mirror_ledger_diff as diff

SLUG_SAFE = re.compile(r"[^0-9A-Za-z._-]+")


def e(value: Any) -> str:
    return escape(str(value if value is not None else ""), quote=True)


def report_slug(model: dict[str, Any]) -> str:
    stamp = (
        model.get("after_captured_at")
        or model.get("generated_at")
        or "report"
    )
    stamp = stamp.replace(":", "").replace("+00:00", "Z")
    if stamp.endswith("Z") and "T" in stamp:
        pass
    return SLUG_SAFE.sub("-", stamp).strip("-") or "report"


def _summary_cards(summary: dict[str, Any], validation_ok: bool) -> str:
    status = "PASS" if validation_ok else "FAIL"
    status_class = "ok" if validation_ok else "bad"
    items = [
        ("Raids +/−", f"{summary.get('raids_added', 0)} / {summary.get('raids_removed', 0)}"),
        ("Tics +/−/~", f"{summary.get('tics_added', 0)} / {summary.get('tics_removed', 0)} / {summary.get('tics_modified', 0)}"),
        ("Attendance", str(summary.get("attendance_changes", 0))),
        ("Loot +/−/~", f"{summary.get('loot_added', 0)} / {summary.get('loot_removed', 0)} / {summary.get('loot_modified', 0)}"),
        ("Chars ΔDKP", str(summary.get("characters_with_dkp_changes", 0))),
        ("Accounts ΔDKP", str(summary.get("accounts_with_dkp_changes", 0))),
        ("Validation", status),
    ]
    cards = []
    for label, value in items:
        cls = status_class if label == "Validation" else ""
        cards.append(
            f'<div class="card {cls}"><div class="card-label">{e(label)}</div>'
            f'<div class="card-value">{e(value)}</div></div>'
        )
    return "\n".join(cards)


def _tic_table(tics: list[dict[str, Any]]) -> str:
    if not tics:
        return "<p class='muted'>No tics.</p>"
    rows = []
    for tic in tics:
        time = tic.get("event_time") or ""
        name = tic.get("event_name") or "(unnamed)"
        label = f"{name}" + (f" <span class='muted'>({e(time)})</span>" if time else "")
        rows.append(
            "<tr>"
            f"<td>{label}</td>"
            f"<td class='num'>{e(tic.get('dkp', '0'))}</td>"
            f"<td class='num'>{e(tic.get('attendees', '0'))}</td>"
            "</tr>"
        )
    return (
        "<table class='compact'><thead><tr><th>Tic</th><th>DKP</th><th>Attendees</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table>"
    )


def _raid_block(raid: dict[str, Any], sign: str) -> str:
    title = raid.get("raid_name") or raid.get("raid_id") or "(raid)"
    date = raid.get("date") or raid.get("date_iso") or ""
    return (
        f"<article class='raid {'added' if sign == '+' else 'removed'}'>"
        f"<h3>{e(sign)} {e(title)} — {e(date)}</h3>"
        f"<p class='meta'><a href='{e(raid.get('url', ''))}'>Open on mirror</a> · "
        f"{e(raid.get('tic_count', 0))} tics · potential DKP "
        f"<strong>{e(raid.get('potential_dkp', '0'))}</strong> "
        f"<span class='muted'>({e(raid.get('potential_dkp_note', 'Sum of distinct tic DKP values.'))})</span></p>"
        f"{_tic_table(raid.get('tics') or [])}"
        "</article>"
    )


def _dkp_table_json(rows: list[dict[str, Any]]) -> str:
    """Embed JSON in a script tag without breaking HTML parsing."""
    raw = json.dumps(rows, separators=(",", ":"), ensure_ascii=False)
    # Prevent </script> breakouts while keeping JSON.parse-compatible text.
    return raw.replace("<", "\\u003c").replace(">", "\\u003e")


def _loot_list(items: list[dict[str, Any]], kind: str) -> str:
    if not items:
        return ""
    lis = []
    for item in items:
        extra = ""
        if kind == "modified":
            extra = (
                f" · cost {e(item.get('old_cost'))} → {e(item.get('new_cost'))}"
                f" · buyer {e(item.get('old_character'))} → {e(item.get('new_character'))}"
            )
        lis.append(
            "<li>"
            f"<a href='{e(item.get('url', ''))}'>{e(item.get('raid_name') or item.get('raid_id'))}</a>: "
            f"<strong>{e(item.get('item_name') or '(item)')}</strong> → "
            f"{e(item.get('character') or '—')} @ {e(item.get('cost', '0'))}"
            f"{extra}"
            "</li>"
        )
    return f"<ul>{''.join(lis)}</ul>"


def _other_details(other: dict[str, Any]) -> str:
    parts = []
    for table, payload in other.items():
        added = len(payload.get("added") or [])
        removed = len(payload.get("removed") or [])
        changed = len(payload.get("changed") or [])
        if added + removed + changed == 0:
            continue
        lines = [
            f"<p><span class='badge add'>{added} added</span> "
            f"<span class='badge rem'>{removed} removed</span> "
            f"<span class='badge chg'>{changed} changed</span></p>"
        ]
        if added:
            lines.append("<h4>Added</h4><pre>" + e(json.dumps(payload["added"], indent=2)) + "</pre>")
        if removed:
            lines.append("<h4>Removed</h4><pre>" + e(json.dumps(payload["removed"], indent=2)) + "</pre>")
        if changed:
            slim = [
                {"key": c.get("key"), "fields": c.get("fields")}
                for c in payload["changed"]
            ]
            lines.append("<h4>Changed</h4><pre>" + e(json.dumps(slim, indent=2)) + "</pre>")
        parts.append(
            f"<details><summary>{e(table)} ({added + removed + changed})</summary>"
            f"{''.join(lines)}</details>"
        )
    if not parts:
        return "<p class='muted'>No secondary guild-data changes.</p>"
    return "\n".join(parts)


def _validation_block(validation: dict[str, Any]) -> str:
    rows = []
    for check in validation.get("checks") or []:
        mark = "PASS" if check.get("passed") else "FAIL"
        cls = "ok" if check.get("passed") else "bad"
        rows.append(
            f"<tr class='{cls}'><td>{e(mark)}</td><td>{e(check.get('name'))}</td>"
            f"<td>{e(check.get('detail'))}</td></tr>"
        )
    return (
        "<table class='compact'><thead><tr><th>Status</th><th>Check</th><th>Detail</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table>"
    )


def sanitize_model_for_json(model: dict[str, Any]) -> dict[str, Any]:
    """Drop private column names from a serializable report model."""
    private = diff.PRIVATE_COLUMNS

    def scrub(value: Any) -> Any:
        if isinstance(value, dict):
            return {k: scrub(v) for k, v in value.items() if k not in private}
        if isinstance(value, list):
            return [scrub(item) for item in value]
        return value

    return scrub(model)


def render_html(model: dict[str, Any], *, include_history: bool = False) -> str:
    del include_history  # retained for call-site compatibility; history is Actions-only
    summary = model.get("summary") or {}
    provenance = model.get("provenance") or {}
    raids = model.get("raids") or {}
    loot = model.get("loot") or {}
    adjustments = model.get("adjustments") or {}
    validation = model.get("validation") or {}
    validation_ok = bool(validation.get("ok"))
    balance_source = provenance.get("balance_source") or model.get("balance_source") or ""
    warnings = list(model.get("warnings") or provenance.get("warnings") or [])

    added_raid_html = "\n".join(_raid_block(r, "+") for r in raids.get("added_raids") or []) or (
        "<p class='muted'>No new raids.</p>"
    )
    removed_raid_html = "\n".join(_raid_block(r, "−") for r in raids.get("removed_raids") or []) or (
        "<p class='muted'>No removed raids.</p>"
    )

    edited = raids.get("edited_raids") or []
    edited_html = (
        "<ul>"
        + "".join(
            f"<li><a href='{e(r.get('url'))}'>{e(r.get('raid_name') or r.get('raid_id'))}</a>: "
            + ", ".join(
                f"{e(f['field'])} {e(f['old'])} → {e(f['new'])}" for f in (r.get("fields") or [])
            )
            + "</li>"
            for r in edited
        )
        + "</ul>"
        if edited
        else "<p class='muted'>No edited raid metadata.</p>"
    )

    def tic_change_list(items: list[dict[str, Any]], kind: str) -> str:
        if not items:
            return f"<p class='muted'>No {kind} tics.</p>"
        lis = []
        for item in items:
            if kind == "modified":
                detail = (
                    f"DKP {e(item.get('old_dkp'))} → {e(item.get('new_dkp'))}; "
                    f"time {e(item.get('old_time') or '—')} → {e(item.get('new_time') or '—')}"
                )
            else:
                detail = f"DKP {e(item.get('dkp'))}"
            lis.append(
                "<li>"
                f"<a href='{e(item.get('url'))}'>{e(item.get('raid_name') or item.get('raid_id'))}</a> · "
                f"{e(item.get('event_name') or item.get('event_id'))} — {detail}"
                "</li>"
            )
        return f"<ul>{''.join(lis)}</ul>"

    att = raids.get("attendance_changes") or []
    att_preview = att[:20]
    att_html = (
        "<ul>"
        + "".join(
            f"<li><span class='badge { 'add' if a.get('action')=='added' else 'rem' }'>{e(a.get('action'))}</span> "
            f"<a href='{e(a.get('url'))}'>{e(a.get('raid_name') or a.get('raid_id'))}</a> · "
            f"event {e(a.get('event_id'))} · {e(a.get('character'))}</li>"
            for a in att_preview
        )
        + "</ul>"
        if att_preview
        else "<p class='muted'>No attendance row changes on existing raids.</p>"
    )
    if len(att) > 20:
        att_html += (
            f"<details><summary>All {len(att)} attendance changes</summary><ul>"
            + "".join(
                f"<li>{e(a.get('action'))}: {e(a.get('raid_id'))}/{e(a.get('event_id'))} {e(a.get('character'))}</li>"
                for a in att
            )
            + "</ul></details>"
        )

    count_changes = raids.get("attendee_count_changes") or []
    if count_changes:
        count_items = []
        for c in count_changes:
            delta = int(c.get("delta", 0))
            delta_text = f"+{delta}" if delta > 0 else str(delta)
            count_items.append(
                "<li>"
                f"<a href='{e(c.get('url'))}'>{e(c.get('raid_name') or c.get('raid_id'))}</a> · "
                f"{e(c.get('event_name') or c.get('event_id'))}: "
                f"{e(c.get('old_count'))} → {e(c.get('new_count'))} ({e(delta_text)})"
                "</li>"
            )
        count_html = "<ul>" + "".join(count_items) + "</ul>"
    else:
        count_html = "<p class='muted'>No attendee-count changes.</p>"


    adj_html = ""
    if adjustments.get("added") or adjustments.get("removed") or adjustments.get("changed"):
        adj_html = (
            f"<p><span class='badge add'>{len(adjustments.get('added') or [])} added</span> "
            f"<span class='badge rem'>{len(adjustments.get('removed') or [])} removed</span> "
            f"<span class='badge chg'>{len(adjustments.get('changed') or [])} changed</span></p>"
            f"<pre>{e(json.dumps({k: adjustments.get(k) for k in ('added','removed','changed')}, indent=2))}</pre>"
        )
    else:
        adj_html = "<p class='muted'>No manual adjustment changes.</p>"

    actions_url = provenance.get("actions_run_url") or provenance.get("mirror_run_url") or ""
    restore_url = provenance.get("restore_run_url") or ""
    source_repo = provenance.get("source_repository") or ""
    artifact_id = provenance.get("source_artifact_id") or ""
    old_repo = provenance.get("old_repository") or ""
    new_repo = provenance.get("new_repository") or ""
    old_art = provenance.get("old_artifact_id") or ""
    new_art = provenance.get("new_artifact_id") or ""

    balance_note = ""
    if balance_source == "reconstructed_from_portable_backup":
        balance_note = (
            "<p class='muted'><strong>Balance source:</strong> independently reconstructed "
            "base earned/spent from portable guild tables (same rules as "
            "<code>expected_account_totals</code> / character attendance+loot). "
            "Manual adjustments are listed separately and are <em>not</em> folded into these balances. "
            "Displayed website leaderboard totals that apply adjustments may differ.</p>"
        )
    elif balance_source == "live_dkp_summary_tables":
        balance_note = (
            "<p class='muted'><strong>Balance source:</strong> live mirror "
            "<code>dkp_summary</code> / <code>account_dkp_summary</code> tables "
            "(rebuilt by restore). Adjustments are listed separately.</p>"
        )

    warning_html = ""
    if warnings:
        warning_html = (
            "<div class='banner' style='border-color: var(--yellow); margin-top: 0.75rem;'>"
            + "".join(f"<p><strong>Warning:</strong> {e(w)}</p>" for w in warnings)
            + "</div>"
        )

    compare_meta = ""
    if old_repo or new_repo:
        compare_meta = (
            f"Old: <strong>{e(old_repo or '—')}</strong> artifact <strong>{e(old_art or '—')}</strong><br>"
            f"New: <strong>{e(new_repo or '—')}</strong> artifact <strong>{e(new_art or '—')}</strong><br>"
        )

    css = """
:root {
  --bg: #0f1419; --surface: #1a2332; --surface2: #243044; --text: #e6edf3;
  --muted: #8b949e; --green: #3fb950; --red: #f85149; --yellow: #d29922; --link: #58a6ff;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 1.25rem; font-family: ui-sans-serif, system-ui, sans-serif;
  background: radial-gradient(1200px 600px at 10% -10%, #1b2838 0%, var(--bg) 55%);
  color: var(--text); line-height: 1.5;
}
a { color: var(--link); }
h1 { font-size: clamp(1.35rem, 2.5vw, 1.85rem); margin: 0 0 0.35rem; }
h2 { font-size: 1.15rem; margin-top: 2rem; border-bottom: 1px solid var(--surface2); padding-bottom: 0.35rem; }
h3 { font-size: 1.05rem; margin: 1rem 0 0.35rem; }
.meta, .muted { color: var(--muted); }
.wrap { max-width: 1100px; margin: 0 auto; }
.banner { background: var(--surface); border: 1px solid var(--surface2); border-radius: 10px; padding: 1rem 1.15rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin: 1rem 0; }
.card { background: var(--surface); border: 1px solid var(--surface2); border-radius: 8px; padding: 0.75rem; }
.card-label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
.card-value { font-size: 1.15rem; font-weight: 600; margin-top: 0.2rem; }
.card.ok .card-value { color: var(--green); }
.card.bad .card-value { color: var(--red); }
.badge { display: inline-block; padding: 0.1rem 0.45rem; border-radius: 4px; font-size: 0.75rem; margin-right: 0.25rem; }
.badge.add { background: rgba(63,185,80,.2); color: var(--green); }
.badge.rem { background: rgba(248,81,73,.2); color: var(--red); }
.badge.chg { background: rgba(210,153,34,.2); color: var(--yellow); }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { border: 1px solid var(--surface2); padding: 0.4rem 0.5rem; text-align: left; vertical-align: top; }
th { background: var(--surface); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.ok td:first-child { color: var(--green); }
tr.bad td:first-child { color: var(--red); }
.raid { background: var(--surface); border-radius: 8px; padding: 0.85rem 1rem; margin: 0.75rem 0; border: 1px solid var(--surface2); }
.raid.added { border-left: 3px solid var(--green); }
.raid.removed { border-left: 3px solid var(--red); }
.controls { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin: 0.75rem 0; }
.controls input, .controls select, .controls button {
  background: var(--surface); color: var(--text); border: 1px solid var(--surface2);
  border-radius: 6px; padding: 0.4rem 0.6rem;
}
details { background: var(--surface); border: 1px solid var(--surface2); border-radius: 8px; padding: 0.5rem 0.75rem; margin: 0.5rem 0; }
summary { cursor: pointer; }
pre { overflow: auto; background: #0b1016; padding: 0.75rem; border-radius: 6px; font-size: 0.8rem; }
.delta-pos { color: var(--green); }
.delta-neg { color: var(--red); }
.row-added { background: rgba(63,185,80,.08); }
.row-removed { background: rgba(248,81,73,.08); }
.footer { margin: 2.5rem 0 1rem; color: var(--muted); font-size: 0.85rem; }
@media (max-width: 640px) {
  body { padding: 0.75rem; }
  table.dkp { font-size: 0.8rem; }
}
"""

    js = """
(function() {
  function bindTable(prefix) {
    var dataEl = document.getElementById(prefix + '-data');
    if (!dataEl) return;
    var rows = [];
    try { rows = JSON.parse(dataEl.textContent || '[]'); } catch (err) { rows = []; }
    var tbody = document.querySelector('#' + prefix + '-table tbody');
    var search = document.getElementById(prefix + '-search');
    var sort = document.getElementById(prefix + '-sort');
    var showAll = document.getElementById(prefix + '-show-all');
    var count = document.getElementById(prefix + '-count');
    function render() {
      var q = (search && search.value || '').trim().toLowerCase();
      var all = !!(showAll && showAll.checked);
      var mode = (sort && sort.value) || 'delta_desc';
      var filtered = rows.filter(function(r) {
        if (!all && !r.changed) return false;
        if (!q) return true;
        return String(r.name || '').toLowerCase().indexOf(q) >= 0 ||
               String(r.key || '').toLowerCase().indexOf(q) >= 0;
      });
      filtered.sort(function(a, b) {
        var da = Number(a.delta_balance); var db = Number(b.delta_balance);
        if (mode === 'delta_asc') return da - db;
        if (mode === 'name') return String(a.name).localeCompare(String(b.name));
        return db - da;
      });
      if (count) count.textContent = filtered.length + ' shown / ' + rows.length + ' total';
      if (!tbody) return;
      tbody.innerHTML = filtered.map(function(r) {
        var cls = r.status === 'added' ? 'row-added' : (r.status === 'removed' ? 'row-removed' : '');
        var dcls = Number(r.delta_balance) > 0 ? 'delta-pos' : (Number(r.delta_balance) < 0 ? 'delta-neg' : '');
        var status = r.status !== 'unchanged' && r.status !== 'changed' ? ' [' + r.status + ']' : '';
        return '<tr class="' + cls + '"><td>' + escapeHtml(r.name) + escapeHtml(status) +
          '</td><td class="num">' + escapeHtml(r.old_balance) +
          '</td><td class="num">' + escapeHtml(r.new_balance) +
          '</td><td class="num ' + dcls + '">' + escapeHtml(r.delta_balance_signed) +
          '</td><td class="num">' + escapeHtml(r.delta_earned_signed) +
          '</td><td class="num">' + escapeHtml(r.delta_spent_signed) + '</td></tr>';
      }).join('');
    }
    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    if (search) search.addEventListener('input', render);
    if (sort) sort.addEventListener('change', render);
    if (showAll) showAll.addEventListener('change', render);
    render();
  }
  bindTable('char');
  bindTable('acct');
})();
"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(model.get('title') or 'NAGD DKP Mirror — Daily Change Report')}</title>
<style>{css}</style>
</head>
<body>
<div class="wrap">
  <header class="banner">
    <h1>{e(model.get('title') or 'NAGD DKP Mirror — Daily Change Report')}</h1>
    <p class="meta">
      Snapshot interval: <strong>{e(model.get('before_captured_at') or '—')}</strong>
      → <strong>{e(model.get('after_captured_at') or '—')}</strong><br>
      {compare_meta}
      {f"Source: <strong>{e(source_repo)}</strong> · artifact <strong>{e(artifact_id)}</strong><br>" if source_repo or artifact_id else ""}
      <a href="{e(model.get('mirror_site') or diff.MIRROR_SITE)}/">Mirror website</a>
      {f' · <a href="{e(actions_url)}">Actions run</a>' if actions_url else ''}
      {f' · <a href="{e(restore_url)}">Restore run</a>' if restore_url else ''}
    </p>
    <p class="muted">{e(model.get('disclaimer') or '')}</p>
    {balance_note}
    {warning_html}
  </header>

  <section>
    <h2>Summary</h2>
    <div class="grid">{_summary_cards(summary, validation_ok)}</div>
  </section>

  <section>
    <h2>1. Raid and tic changes</h2>
    <h3>New raids</h3>
    {added_raid_html}
    <h3>Removed raids</h3>
    {removed_raid_html}
    <h3>Edited raids</h3>
    {edited_html}
    <h3>Tics added on existing raids</h3>
    {tic_change_list(raids.get('added_tics') or [], 'added')}
    <h3>Tics removed from existing raids</h3>
    {tic_change_list(raids.get('removed_tics') or [], 'removed')}
    <h3>Tics modified</h3>
    {tic_change_list(raids.get('modified_tics') or [], 'modified')}
    <details>
      <summary>Attendance changes ({len(att)})</summary>
      {att_html}
      <h4>Attendee counts</h4>
      {count_html}
    </details>
  </section>

  <section>
    <h2>2. Loot and adjustments</h2>
    <h3>Loot added</h3>
    {_loot_list(loot.get('added') or [], 'added') or "<p class='muted'>None.</p>"}
    <h3>Loot removed</h3>
    {_loot_list(loot.get('removed') or [], 'removed') or "<p class='muted'>None.</p>"}
    <h3>Loot modified</h3>
    {_loot_list(loot.get('modified') or [], 'modified') or "<p class='muted'>None.</p>"}
    <h3>Manual adjustments</h3>
    {adj_html}
  </section>

  <section>
    <h2>3. Character DKP deltas</h2>
    <p class="muted">Character balances (earned − spent). Adjustments are listed separately and are not folded into these totals.</p>
    <div class="controls">
      <input id="char-search" type="search" placeholder="Search character…" aria-label="Search characters">
      <label><input id="char-show-all" type="checkbox"> Show unchanged</label>
      <select id="char-sort" aria-label="Sort characters">
        <option value="delta_desc">Largest +Δ balance</option>
        <option value="delta_asc">Largest −Δ balance</option>
        <option value="name">Name</option>
      </select>
      <span id="char-count" class="muted"></span>
    </div>
    <script type="application/json" id="char-data">{_dkp_table_json(model.get('character_dkp') or [])}</script>
    <table class="dkp compact" id="char-table">
      <thead><tr>
        <th>Character</th><th class="num">Old balance</th><th class="num">New balance</th>
        <th class="num">Δ Balance</th><th class="num">Δ Earned</th><th class="num">Δ Spent</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <section>
    <h2>4. Account DKP deltas</h2>
    <p class="muted">Account balances using guild account accounting (not a sum of character balances). Adjustments are separate.</p>
    <div class="controls">
      <input id="acct-search" type="search" placeholder="Search account…" aria-label="Search accounts">
      <label><input id="acct-show-all" type="checkbox"> Show unchanged</label>
      <select id="acct-sort" aria-label="Sort accounts">
        <option value="delta_desc">Largest +Δ balance</option>
        <option value="delta_asc">Largest −Δ balance</option>
        <option value="name">Name</option>
      </select>
      <span id="acct-count" class="muted"></span>
    </div>
    <script type="application/json" id="acct-data">{_dkp_table_json(model.get('account_dkp') or [])}</script>
    <table class="dkp compact" id="acct-table">
      <thead><tr>
        <th>Account</th><th class="num">Old balance</th><th class="num">New balance</th>
        <th class="num">Δ Balance</th><th class="num">Δ Earned</th><th class="num">Δ Spent</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <section>
    <h2>5. Other changes and technical details</h2>
    {_other_details(model.get('other') or {})}
    <h3>Validation</h3>
    {_validation_block(validation)}
    <p class="muted">Prior mirror reports are retained as GitHub Actions artifacts (see workflow run), not on this Pages site.</p>
  </section>

  <footer class="footer">
    Generated {e(model.get('generated_at') or '')}. Public page contains only sanitized guild DKP data.
  </footer>
</div>
<script>{js}</script>
</body>
</html>
"""


def write_report_bundle(
    model: dict[str, Any],
    out_dir: Path,
    *,
    balance_source: str = "live_dkp_summary_tables",
) -> dict[str, str]:
    """Write standalone index.html + delta.json + manifest.json (no git history)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = report_slug(model)
    provenance = dict(model.get("provenance") or {})
    if balance_source and not provenance.get("balance_source"):
        provenance["balance_source"] = balance_source
        model = dict(model)
        model["provenance"] = provenance
        model["balance_source"] = balance_source

    html = render_html(model)
    (out_dir / "index.html").write_text(html, encoding="utf-8", newline="\n")
    sanitized = sanitize_model_for_json(model)
    (out_dir / "delta.json").write_text(
        json.dumps(sanitized, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    manifest = {
        "format": "mirror-ledger-report-v1",
        "slug": slug,
        "generated_at": model.get("generated_at"),
        "before_captured_at": model.get("before_captured_at"),
        "after_captured_at": model.get("after_captured_at"),
        "validation_ok": bool((model.get("validation") or {}).get("ok")),
        "balance_source": provenance.get("balance_source", balance_source),
        "provenance": provenance,
        "summary": model.get("summary"),
        "warnings": model.get("warnings") or [],
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    (out_dir / "latest.json").write_text(
        json.dumps(
            {
                "slug": slug,
                "report": "index.html",
                "summary": model.get("summary"),
                "validation_ok": manifest["validation_ok"],
                "provenance": provenance,
                "generated_at": model.get("generated_at"),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return {"slug": slug, "report": "index.html", "index": "index.html"}


# Back-compat alias used by older call sites / tests.
def write_site(
    model: dict[str, Any],
    site_dir: Path,
    *,
    history: list[dict[str, str]] | None = None,
) -> dict[str, str]:
    del history  # history accumulation removed; Actions artifacts retain dated reports
    return write_report_bundle(model, site_dir)


def build_from_snapshots(
    old_dir: Path,
    new_dir: Path,
    site_dir: Path,
    *,
    provenance: dict[str, Any] | None = None,
    require_manifest: bool = True,
    fail_on_validation: bool = True,
    balance_source: str = "live_dkp_summary_tables",
) -> tuple[dict[str, Any], dict[str, str]]:
    model = diff.compare_snapshots(
        old_dir,
        new_dir,
        provenance=provenance,
        require_manifest=require_manifest,
    )
    paths = write_report_bundle(model, site_dir, balance_source=balance_source)
    if fail_on_validation and not model["validation"]["ok"]:
        raise SystemExit(
            "Validation failed; refusing to treat report as publishable. "
            f"See {site_dir / 'index.html'}"
        )
    return model, paths


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build a standalone ledger report from before/after snapshots."
    )
    parser.add_argument("--old", type=Path, required=True)
    parser.add_argument("--new", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="Output directory")
    parser.add_argument("--source-repository", default="")
    parser.add_argument("--source-artifact-id", default="")
    parser.add_argument("--mirror-run-url", default="")
    parser.add_argument("--restore-run-url", default="")
    parser.add_argument("--actions-run-url", default="")
    parser.add_argument(
        "--balance-source",
        default="live_dkp_summary_tables",
        choices=("live_dkp_summary_tables", "reconstructed_from_portable_backup"),
    )
    parser.add_argument("--allow-missing-manifest", action="store_true")
    parser.add_argument(
        "--allow-validation-failure",
        action="store_true",
        help="Write HTML even when validation fails (still exit 2).",
    )
    args = parser.parse_args(argv)

    provenance = {
        "source_repository": args.source_repository,
        "source_artifact_id": args.source_artifact_id,
        "mirror_run_url": args.mirror_run_url,
        "restore_run_url": args.restore_run_url,
        "actions_run_url": args.actions_run_url or args.mirror_run_url,
        "balance_source": args.balance_source,
    }
    try:
        model, paths = build_from_snapshots(
            args.old,
            args.new,
            args.out,
            provenance=provenance,
            require_manifest=not args.allow_missing_manifest,
            fail_on_validation=False,
            balance_source=args.balance_source,
        )
    except diff.DiffError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(f"Wrote site {args.out} slug={paths['slug']} validation_ok={model['validation']['ok']}")
    if not model["validation"]["ok"] and not args.allow_validation_failure:
        print("Validation failed; not publishable.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
