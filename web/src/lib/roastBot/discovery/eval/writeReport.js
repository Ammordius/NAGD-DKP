/**
 * Write machine-readable JSON + concise Markdown discovery eval reports.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPORT_DIR = path.join(__dirname, 'reports')

/**
 * @param {object} summary
 */
export function writeEvalReports(summary) {
  fs.mkdirSync(REPORT_DIR, { recursive: true })
  const jsonPath = path.join(REPORT_DIR, 'latest.json')
  const mdPath = path.join(REPORT_DIR, 'latest.md')

  const serializable = JSON.parse(
    JSON.stringify(summary, (_k, v) => (v instanceof RegExp ? v.toString() : v)),
  )
  fs.writeFileSync(jsonPath, JSON.stringify(serializable, null, 2), 'utf8')

  const lines = [
    '# Discovery eval report',
    '',
    `- Generated: ${summary.generatedAt}`,
    `- Total cases: ${summary.total}`,
    `- Passed: ${summary.passed}`,
    `- Failed: ${summary.failed}`,
    `- Correct interpretation rate (in-scope unambiguous): ${pct(summary.interpretationRate)}`,
    `- Correct retrieval/result rate (fixture-backed): ${pct(summary.retrievalRate)}`,
    `- Clarification success rate: ${pct(summary.clarificationRate)}`,
    `- Wrong-entity answer count: ${summary.wrongEntityCount}`,
    `- Stale-result reuse count: ${summary.staleReuseCount}`,
    `- Unsupported-but-recognized count: ${summary.unsupportedRecognizedCount}`,
    '',
    '## Failures by category',
    '',
  ]

  for (const [cat, count] of Object.entries(summary.failuresByCategory || {})) {
    lines.push(`- ${cat}: ${count}`)
  }

  lines.push('', '## Representative failures', '')
  for (const f of (summary.sampleFailures || []).slice(0, 25)) {
    lines.push(`### ${f.id}`)
    lines.push(`- Input: \`${f.input}\``)
    lines.push(`- Failures: ${f.failures.join('; ')}`)
    if (f.actual) {
      lines.push(`- Actual: \`${JSON.stringify(f.actual)}\``)
    }
    lines.push('')
  }

  lines.push('## Acceptance gates', '')
  for (const [name, ok] of Object.entries(summary.gates || {})) {
    lines.push(`- ${ok ? 'PASS' : 'FAIL'}: ${name}`)
  }
  lines.push('')

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8')
  return { jsonPath, mdPath }
}

function pct(rate) {
  if (rate == null || Number.isNaN(rate)) return 'n/a'
  return `${(rate * 100).toFixed(1)}%`
}
