/** First YYYY-MM-DD in a raid date string. Matches raid_date_parsed. */
export function isoDay(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? '').trim())
  return match ? match[1] : null
}
