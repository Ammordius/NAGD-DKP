export default function TicDateTimeFields({
  date,
  time,
  onDateChange,
  onTimeChange,
  idPrefix = 'tic',
  labelled = true,
}) {
  const dateId = `${idPrefix}-date`
  const timeId = `${idPrefix}-time`
  return (
    <span className="tic-datetime-fields">
      {labelled && <label htmlFor={dateId}>Date (Eastern)</label>}
      <input
        id={dateId}
        type="date"
        value={date}
        aria-label="Tic date (Eastern)"
        onChange={(event) => onDateChange(event.target.value)}
      />
      {labelled && <label htmlFor={timeId}>Time (Eastern)</label>}
      <input
        id={timeId}
        type="time"
        step="1"
        value={time}
        aria-label="Tic time (Eastern)"
        onChange={(event) => onTimeChange(event.target.value)}
      />
    </span>
  )
}
