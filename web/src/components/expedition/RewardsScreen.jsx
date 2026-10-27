/**
 * @param {{
 *   report: {
 *     victory: boolean,
 *     score: number,
 *     artifact: { id: string, name: string },
 *     assessment: string,
 *     encountersCleared: number,
 *     turns: number,
 *     knockouts: number,
 *     party: Array<{ name: string, class_name: string, fictional?: boolean }>,
 *   },
 *   personalBest: number,
 *   onPlayAgain: () => void,
 *   onLeave: () => void,
 * }} props
 */
export default function RewardsScreen({ report, personalBest, onPlayAgain, onLeave }) {
  if (!report) return null
  const isBest = report.score >= personalBest && report.score > 0

  return (
    <div className="exp-panel" style={{ textAlign: 'center' }}>
      <h2>{report.victory ? 'Expedition Cleared' : 'Total Party Wipe'}</h2>
      <p className="exp-narrator" style={{ textAlign: 'left' }}>
        <strong>DKP Inquisitor</strong>
        {report.assessment}
      </p>

      <div className="exp-comp" style={{ margin: '1rem 0' }}>
        <div>Encounters cleared: {report.encountersCleared}/6</div>
        <div>Turns taken: {report.turns}</div>
        <div>Knockouts: {report.knockouts}</div>
        <div>
          Final score: <strong>{report.score}</strong>
          {isBest ? ' · Personal best!' : personalBest > 0 ? ` · Best ${personalBest}` : ''}
        </div>
      </div>

      <div className="exp-party-preview" style={{ justifyContent: 'center' }}>
        {report.party.map((c) => (
          <span key={c.name + c.class_name} className="exp-party-chip">
            {c.name} ({c.class_name}{c.fictional ? ', fictional' : ''})
          </span>
        ))}
      </div>

      <div style={{ margin: '1.25rem 0' }}>
        <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{report.artifact.name}</div>
        <p className="exp-disclaimer" role="note">
          Expedition-only reward — does not affect your EverQuest character.
        </p>
      </div>

      <div className="exp-action-row" style={{ justifyContent: 'center' }}>
        <button type="button" className="exp-btn is-primary" onClick={onPlayAgain}>
          Play Again
        </button>
        <button type="button" className="exp-btn" onClick={onLeave}>
          Back to landing
        </button>
      </div>
    </div>
  )
}
