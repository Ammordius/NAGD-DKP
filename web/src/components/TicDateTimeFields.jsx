export default function TicDateTimeFields({
  date,
  time,
  onDateChange,
  onTimeChange,
  idPrefix = 'tic',
  labelled = true,
  dateLabel = 'Date',
  timeLabel = 'Time',
}) {
  const dateId = `${idPrefix}-date`
  const timeId = `${idPrefix}-time`
  return (
    <span className="tic-datetime-fields">
      {labelled && <label htmlFor={dateId}>{dateLabel}</label>}
      <input
        id={dateId}
        type="date"
        value={date}
        aria-label={dateLabel}
        onChange={(event) => onDateChange(event.target.value)}
      />
      {labelled && <label htmlFor={timeId}>{timeLabel}</label>}
      <input
        id={timeId}
        type="time"
        step="1"
        value={time}
        aria-label={timeLabel}
        onChange={(event) => onTimeChange(event.target.value)}
      />
    </span>
  )
}
