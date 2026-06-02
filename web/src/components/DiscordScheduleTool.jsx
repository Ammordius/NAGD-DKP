import { useMemo, useState } from 'react'
import { usePersistedState } from '../lib/usePersistedState'
import {
  addDays,
  buildScheduleOutput,
  createDefaultRows,
  createRowId,
  DEFAULT_TIME,
  getNextNextWednesdayNy,
  getNyTzSuffix,
  getTodayNyDate,
  parseSchedulePaste,
  parseSchedulePasteRaw,
  projectParsedRowsToUpcoming,
  slotFromDateIso,
  snapToWednesdayNy,
  TIME_OPTIONS,
  timeOptionKey,
} from '../lib/discordSchedule'

function formatTimeOptionLabel(dateIso, hour24, minute) {
  const h12 = hour24 % 12 || 12
  const ampm = hour24 < 12 ? 'AM' : 'PM'
  const minStr = minute === 0 ? '00' : String(minute).padStart(2, '0')
  const tz = getNyTzSuffix(dateIso, hour24, minute).toUpperCase()
  return `${h12}:${minStr} ${ampm} ${tz}`
}

function normalizeRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return createDefaultRows()
  return rows.map((row) => ({
    id: row.id || createRowId(),
    week: row.week === 2 ? 2 : 1,
    dateIso: row.dateIso,
    eventName: row.eventName ?? '',
    time: row.time ?? { ...DEFAULT_TIME },
  }))
}

function ScheduleRow({
  row,
  rowIndex,
  weekRowCount,
  onUpdate,
  onMove,
  onRemove,
}) {
  const slot = slotFromDateIso(row.dateIso, row.week)
  const timeKey = timeOptionKey(row.time)

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr minmax(160px, 180px) minmax(150px, 170px)',
        gap: '0.75rem',
        alignItems: 'center',
        marginBottom: '0.75rem',
      }}
    >
      <div style={{ display: 'flex', gap: '0.25rem' }}>
        <button
          type="button"
          className="btn btn-ghost"
          title="Move up"
          disabled={rowIndex === 0}
          onClick={() => onMove(row.id, -1)}
          style={{ padding: '0.25rem 0.5rem', minWidth: '2rem' }}
        >
          ↑
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          title="Move down"
          disabled={rowIndex >= weekRowCount - 1}
          onClick={() => onMove(row.id, 1)}
          style={{ padding: '0.25rem 0.5rem', minWidth: '2rem' }}
        >
          ↓
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          title="Remove row"
          onClick={() => onRemove(row.id)}
          style={{ padding: '0.25rem 0.5rem', minWidth: '2rem', color: '#f87171' }}
        >
          ×
        </button>
      </div>
      <input
        type="text"
        value={row.eventName}
        onChange={(e) => onUpdate(row.id, { eventName: e.target.value })}
        placeholder="Memory Farm Running Through 06/07"
        style={{ maxWidth: 'none', width: '100%' }}
      />
      <select
        className="filter-select"
        value={timeKey}
        onChange={(e) => {
          const [h, m] = e.target.value.split(':').map(Number)
          onUpdate(row.id, { time: { hour24: h, minute: m } })
        }}
        style={{ width: '100%', maxWidth: 'none' }}
      >
        {TIME_OPTIONS.map((opt) => {
          const key = timeOptionKey(opt)
          return (
            <option key={key} value={key}>
              {formatTimeOptionLabel(row.dateIso, opt.hour24, opt.minute)}
            </option>
          )
        })}
      </select>
      <div>
        <input
          type="date"
          value={row.dateIso}
          onChange={(e) => onUpdate(row.id, { dateIso: e.target.value })}
          title={slot.dayLabel}
          style={{ maxWidth: 'none', width: '100%' }}
        />
        <div style={{ fontSize: '0.75rem', color: '#71717a', marginTop: '0.2rem' }}>
          {slot.dayLabel}
        </div>
      </div>
    </div>
  )
}

export default function DiscordScheduleTool() {
  const defaultPeriodStart = useMemo(
    () => getNextNextWednesdayNy(getTodayNyDate()),
    []
  )
  const [periodStart, setPeriodStart] = usePersistedState(
    '/tools/discord-schedule:periodStart',
    null
  )
  const effectivePeriodStart = periodStart || defaultPeriodStart
  const periodStartSlot = slotFromDateIso(effectivePeriodStart)

  const [rows, setRows] = usePersistedState('/tools/discord-schedule:rows', null)
  const [paste, setPaste] = usePersistedState('/tools/discord-schedule:paste', '')
  const [parseError, setParseError] = useState('')
  const [copyStatus, setCopyStatus] = useState('')

  const effectiveRows = useMemo(() => normalizeRows(rows), [rows])
  const week1Rows = effectiveRows.filter((r) => r.week === 1)
  const week2Rows = effectiveRows.filter((r) => r.week === 2)

  const output = useMemo(() => buildScheduleOutput(effectiveRows), [effectiveRows])

  function updateRows(updater) {
    setRows((prev) => {
      const base = normalizeRows(prev)
      return updater(base)
    })
  }

  function handleUpdateRow(id, patch) {
    updateRows((list) =>
      list.map((row) => (row.id === id ? { ...row, ...patch } : row))
    )
  }

  function handleMoveRow(id, direction) {
    updateRows((list) => {
      const week = list.find((r) => r.id === id)?.week
      if (!week) return list
      const weekRows = list.filter((r) => r.week === week)
      const idx = weekRows.findIndex((r) => r.id === id)
      const targetIdx = idx + direction
      if (idx < 0 || targetIdx < 0 || targetIdx >= weekRows.length) return list

      const swapped = [...weekRows]
      ;[swapped[idx], swapped[targetIdx]] = [swapped[targetIdx], swapped[idx]]
      const otherWeek = list.filter((r) => r.week !== week)
      return week === 1 ? [...swapped, ...otherWeek] : [...otherWeek, ...swapped]
    })
  }

  function handleRemoveRow(id) {
    updateRows((list) => list.filter((row) => row.id !== id))
  }

  function handleAddRow(week) {
    updateRows((list) => {
      const weekRows = list.filter((r) => r.week === week)
      const lastDate = weekRows.length
        ? weekRows[weekRows.length - 1].dateIso
        : getTodayNyDate()
      const newRow = {
        id: createRowId(),
        week,
        dateIso: addDays(lastDate, weekRows.length ? 1 : 0),
        eventName: '',
        time: { ...DEFAULT_TIME },
      }
      if (week === 1) {
        const w2 = list.filter((r) => r.week === 2)
        return [...weekRows, newRow, ...w2]
      }
      return [...list.filter((r) => r.week === 1), ...weekRows, newRow]
    })
  }

  function handleParsePaste() {
    setParseError('')
    const parsed = parseSchedulePaste(paste, { periodStart: effectivePeriodStart })
    if (!parsed.length) {
      setParseError('No raid lines found. Paste a schedule with lines like "Thursday 4/23 9pm edt: ..."')
      return
    }
    setRows(parsed)
  }

  function handleReprojectRows() {
    setParseError('')
    const base = normalizeRows(rows)
    if (!base.length) return
    const { rows: projected, periodStart: snapped } = projectParsedRowsToUpcoming(base, {
      periodStart: effectivePeriodStart,
    })
    setPeriodStart(snapped)
    setRows(projected)
  }

  function handlePeriodStartChange(value) {
    if (!value) return
    setPeriodStart(snapToWednesdayNy(value))
  }

  function handleResetPeriodStart() {
    setPeriodStart(getNextNextWednesdayNy(getTodayNyDate()))
  }

  function handleResetUpcoming() {
    setParseError('')
    setPeriodStart(getNextNextWednesdayNy(getTodayNyDate()))
    setRows(createDefaultRows())
  }

  async function handleCopy() {
    if (!output.trim()) {
      setCopyStatus('Nothing to copy.')
      return
    }
    try {
      await navigator.clipboard.writeText(output)
      setCopyStatus('Copied to clipboard.')
    } catch {
      setCopyStatus('Clipboard write failed in this browser.')
    }
  }

  function renderWeekSection(week, weekRows) {
    return (
      <section className="card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
          <h2 style={{ marginTop: 0, marginBottom: 0 }}>Week {week}</h2>
          <button type="button" className="btn btn-ghost" onClick={() => handleAddRow(week)}>
            + Add row
          </button>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr minmax(160px, 180px) minmax(150px, 170px)',
            gap: '0.75rem',
            marginTop: '0.75rem',
            marginBottom: '0.5rem',
            fontSize: '0.8rem',
            color: '#71717a',
          }}
        >
          <span />
          <span>Event name</span>
          <span>Time (Eastern)</span>
          <span>Date</span>
        </div>
        {weekRows.map((row, idx) => (
          <ScheduleRow
            key={row.id}
            row={row}
            rowIndex={idx}
            weekRowCount={weekRows.length}
            onUpdate={handleUpdateRow}
            onMove={handleMoveRow}
            onRemove={handleRemoveRow}
          />
        ))}
        {!weekRows.length && (
          <p style={{ color: '#71717a', fontSize: '0.9rem', marginBottom: 0 }}>
            No rows yet. Add one or parse a pasted schedule below.
          </p>
        )}
      </section>
    )
  }

  return (
    <>
      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Import from previous schedule</h2>
        <p style={{ color: '#71717a', fontSize: '0.9rem', marginTop: 0 }}>
          Paste an old Discord raid schedule to pre-fill event names, times, and weekday order. Dates are
          projected onto a two-week window (Wed–Tue × 2) from the start Wednesday you choose below.
        </p>
        <div
          className="form-group"
          style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-end', marginBottom: '1rem' }}
        >
          <div>
            <label htmlFor="period-start">Period start (Wednesday)</label>
            <input
              id="period-start"
              type="date"
              value={effectivePeriodStart}
              onChange={(e) => handlePeriodStartChange(e.target.value)}
              style={{ maxWidth: '200px' }}
            />
            <div style={{ fontSize: '0.75rem', color: '#71717a', marginTop: '0.2rem' }}>
              {periodStartSlot.dayLabel} · Week 1 Wed–Tue, then Week 2 Wed–Tue
            </div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={handleResetPeriodStart}>
            Default (Wed after next)
          </button>
          {effectiveRows.length > 0 && (
            <button type="button" className="btn btn-ghost" onClick={handleReprojectRows}>
              Re-project row dates
            </button>
          )}
        </div>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={8}
          placeholder={'Paste a previous schedule block here…\nThursday 4/23 9pm edt: Fire Minis + Seru/Praes - April 23, 2026 8:00 PM'}
          style={{
            width: '100%',
            maxWidth: '800px',
            fontFamily: 'monospace',
            padding: '0.5rem',
            marginBottom: '0.75rem',
          }}
        />
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn" onClick={handleParsePaste} disabled={!paste.trim()}>
            Parse schedule
          </button>
          <button type="button" className="btn btn-ghost" onClick={handleResetUpcoming}>
            Reset to upcoming defaults
          </button>
          {parseError && <span className="error">{parseError}</span>}
        </div>
      </section>

      {renderWeekSection(1, week1Rows)}
      {renderWeekSection(2, week2Rows)}

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Discord output</h2>
        <p style={{ color: '#71717a', fontSize: '0.9rem', marginTop: 0 }}>
          Copy this block into Discord. Timestamps render in each player&apos;s local timezone.
        </p>
        <textarea
          readOnly
          value={output}
          rows={16}
          style={{
            width: '100%',
            maxWidth: '800px',
            fontFamily: 'monospace',
            padding: '0.5rem',
            marginBottom: '0.75rem',
          }}
        />
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={handleCopy}>
            Copy to Clipboard
          </button>
          {copyStatus && (
            <span style={{ color: '#a1a1aa', fontSize: '0.9rem' }}>{copyStatus}</span>
          )}
        </div>
      </section>
    </>
  )
}
