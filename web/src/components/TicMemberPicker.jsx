function MemberList({ label, rows, highlight, emptyText, onRowClick, onRowDoubleClick, className }) {
  const highlighted = new Set(highlight)
  return (
    <div className={className ? `officer-member-list ${className}` : 'officer-member-list'} role="listbox" aria-label={label} aria-multiselectable="true">
      {rows.length === 0 ? (
        <p className="officer-member-empty">{emptyText}</p>
      ) : (
        rows.map((row, index) => (
          <button
            key={row.char_id}
            type="button"
            role="option"
            aria-selected={highlighted.has(row.char_id)}
            className={highlighted.has(row.char_id) ? 'is-highlighted' : undefined}
            title={row.label}
            onClick={(e) => onRowClick(row.char_id, index, e.shiftKey)}
            onDoubleClick={() => onRowDoubleClick(row.char_id)}
          >
            {row.label}
          </button>
        ))
      )}
    </div>
  )
}

export default function TicMemberPicker({
  memberQuery,
  onMemberQueryChange,
  availableMembers,
  attendingMembers,
  availableHighlight,
  attendingHighlight,
  onAvailableClick,
  onAttendingClick,
  onMoveToAttending,
  onMoveToAvailable,
  charactersLoading,
}) {
  return (
    <div className="officer-member-picker">
      <p className="officer-member-picker-label officer-member-avail-label">Available Members</p>
      <p className="officer-member-picker-label officer-member-attend-label">Attending</p>
      <input
        className="officer-member-filter"
        type="search"
        value={memberQuery}
        onChange={(e) => onMemberQueryChange(e.target.value)}
        placeholder="Filter members"
        aria-label="Filter available members"
        autoComplete="off"
      />
      <MemberList
        className="officer-member-avail-list"
        label="Available Members"
        rows={availableMembers}
        highlight={availableHighlight}
        emptyText={charactersLoading ? 'Loading characters…' : (memberQuery.trim() ? 'No matching characters' : 'No characters')}
        onRowClick={onAvailableClick}
        onRowDoubleClick={(id) => onMoveToAttending([id])}
      />
      <div className="officer-member-moves">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onMoveToAttending(availableHighlight)}
          disabled={availableHighlight.length === 0}
          aria-label="Add selected members to attending"
        >
          &gt;&gt;
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onMoveToAvailable(attendingHighlight)}
          disabled={attendingHighlight.length === 0}
          aria-label="Remove selected members from attending"
        >
          &lt;&lt;
        </button>
      </div>
      <MemberList
        className="officer-member-attend-list"
        label="Attending"
        rows={attendingMembers}
        highlight={attendingHighlight}
        emptyText="None selected"
        onRowClick={onAttendingClick}
        onRowDoubleClick={(id) => onMoveToAvailable([id])}
      />
    </div>
  )
}
