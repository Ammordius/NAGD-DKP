import { useMemo, useState } from 'react'
import { usePersistedState } from '../lib/usePersistedState'
import {
  buildScheduleOutput,
  computeUpcomingSlots,
  DEFAULT_TIME,
  getNyTzSuffix,
  getTodayNyDate,
  TIME_OPTIONS,
  timeOptionKey,
} from '../lib/discordSchedule'

const EMPTY_NAMES = ['', '', '', '', '', '']

const DEFAULT_TIMES = Array(6).fill(null).map(() => ({ ...DEFAULT_TIME }))

function formatTimeOptionLabel(dateIso, hour24, minute) {
  const h12 = hour24 % 12 || 12
  const ampm = hour24 < 12 ? 'AM' : 'PM'
  const minStr = minute === 0 ? '00' : String(minute).padStart(2, '0')
  const tz = getNyTzSuffix(dateIso, hour24, minute).toUpperCase()
  return `${h12}:${minStr} ${ampm} ${tz}`
}

function ScheduleRow({ slotIndex, slot, eventName, time, onNameChange, onTimeChange }) {
  const timeKey = timeOptionKey(time)
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(140px, 160px) 1fr minmax(160px, 180px)',
        gap: '0.75rem',
        alignItems: 'center',
        marginBottom: '0.75rem',
      }}
    >
      <div style={{ fontWeight: 600, color: '#e4e4e7', whiteSpace: 'nowrap' }}>
        {slot.dayLabel}
      </div>
      <input
        type="text"
        value={eventName}
        onChange={(e) => onNameChange(slotIndex, e.target.value)}
        placeholder="Memory Farm Running Through 06/07"
        style={{ maxWidth: 'none', width: '100%' }}
      />
      <select
        className="filter-select"
        value={timeKey}
        onChange={(e) => onTimeChange(slotIndex, e.target.value)}
        style={{ width: '100%', maxWidth: 'none' }}
      >
        {TIME_OPTIONS.map((opt) => {
          const key = timeOptionKey(opt)
          return (
            <option key={key} value={key}>
              {formatTimeOptionLabel(slot.dateIso, opt.hour24, opt.minute)}
            </option>
          )
        })}
      </select>
    </div>
  )
}

export default function DiscordScheduleTool() {
  const slots = useMemo(() => computeUpcomingSlots(getTodayNyDate()), [])
  const [eventNames, setEventNames] = usePersistedState('/tools/discord-schedule:names', EMPTY_NAMES)
  const [times, setTimes] = usePersistedState('/tools/discord-schedule:times', DEFAULT_TIMES)
  const [copyStatus, setCopyStatus] = useState('')

  const week1Slots = slots.filter((s) => s.week === 1)
  const week2Slots = slots.filter((s) => s.week === 2)

  const output = useMemo(
    () => buildScheduleOutput(slots, eventNames, times),
    [slots, eventNames, times]
  )

  function handleNameChange(index, value) {
    setEventNames((prev) => {
      const next = [...(prev.length === 6 ? prev : EMPTY_NAMES)]
      next[index] = value
      return next
    })
  }

  function handleTimeChange(index, key) {
    const [h, m] = key.split(':').map(Number)
    setTimes((prev) => {
      const next = [...(prev.length === 6 ? prev : DEFAULT_TIMES)]
      next[index] = { hour24: h, minute: m }
      return next
    })
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

  function renderWeekRows(weekSlots) {
    return weekSlots.map((slot) => {
      const slotIndex = slots.indexOf(slot)
      return (
        <ScheduleRow
          key={slot.dateIso}
          slotIndex={slotIndex}
          slot={slot}
          eventName={eventNames[slotIndex] ?? ''}
          time={times[slotIndex] ?? DEFAULT_TIME}
          onNameChange={handleNameChange}
          onTimeChange={handleTimeChange}
        />
      )
    })
  }

  return (
    <>
      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Week 1</h2>
        {renderWeekRows(week1Slots)}
      </section>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Week 2</h2>
        {renderWeekRows(week2Slots)}
      </section>

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
