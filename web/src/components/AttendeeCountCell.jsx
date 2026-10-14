export default function AttendeeCountCell({ count, expanded, onToggle }) {
  return (
    <span className="attendee-count">
      {count}
      <button
        type="button"
        className="attendee-show-all"
        onClick={onToggle}
        aria-expanded={expanded}
        title={expanded ? 'Hide attendees' : 'Show attendees'}
      >
        {expanded ? '−hide' : '+show all'}
      </button>
    </span>
  )
}
