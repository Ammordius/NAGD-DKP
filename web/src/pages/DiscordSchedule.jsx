import DiscordScheduleTool from '../components/DiscordScheduleTool'

export default function DiscordSchedule() {
  return (
    <div className="container">
      <h1>Discord raid schedule</h1>
      <p style={{ color: '#a1a1aa' }}>
        Build a two-week Discord post with localized timestamps. Times are Eastern (America/New_York).
      </p>
      <DiscordScheduleTool />
    </div>
  )
}
