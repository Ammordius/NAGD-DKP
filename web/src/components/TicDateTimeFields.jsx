import { minuteClock } from '../lib/ticDateTime'

export default function TicDateTimeFields({
  date,
  time,
  onDateChange,
  onTimeChange,
  idPrefix = 'tic',
  labelled = true,
  dateLabel = 'Date (Eastern)',
  timeLabel = 'Time (Eastern)',
  stacked = false,
  minutePrecision = false,
}) {
  const dateId = `${idPrefix}-date`
  const timeId = `${idPrefix}-time`
  const timeValue = minutePrecision ? minuteClock(time) : time
  return (
    <span className={stacked ? 'tic-datetime-fields tic-datetime-fields--stacked' : 'tic-datetime-fields'}>
      <span className="tic-datetime-line">
        {labelled && <label htmlFor={dateId}>{dateLabel}</label>}
        <input
          id={dateId}
          type="date"
          value={date}
          aria-label={dateLabel}
          onChange={(event) => onDateChange(event.target.value)}
        />
      </span>
      <span className="tic-datetime-line">
        {labelled && <label htmlFor={timeId}>{timeLabel}</label>}
        <input
          id={timeId}
          type="time"
          step={minutePrecision ? 60 : 1}
          value={timeValue}
          aria-label={timeLabel}
          onChange={(event) => onTimeChange(minutePrecision ? (minuteClock(event.target.value) || event.target.value) : event.target.value)}
        />
      </span>
    </span>
  )
}
