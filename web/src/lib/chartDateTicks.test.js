import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_X_TICKS,
  CHART_PLOT_WIDTH,
  MIN_TICK_LABEL_PX,
  adaptiveDateTicks,
  monthlyTicks,
  tickXsOnPlot,
} from './chartDateTicks.js'

function assertCleanTicks(ticks, minTs, maxTs) {
  assert.ok(ticks.length > 0)
  assert.ok(ticks.length <= MAX_X_TICKS, `expected ≤${MAX_X_TICKS} ticks, got ${ticks.length}`)
  const labels = ticks.map((t) => t.label)
  assert.equal(new Set(labels).size, labels.length, 'labels must be unique')
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i].ts > ticks[i - 1].ts, 'ticks must be strictly increasing')
  }
  const xs = tickXsOnPlot(ticks, minTs, maxTs)
  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i] - xs[i - 1]
    assert.ok(
      gap >= MIN_TICK_LABEL_PX,
      `tick gap ${gap.toFixed(1)}px < ${MIN_TICK_LABEL_PX}px (overlap on ${CHART_PLOT_WIDTH}px plot)`,
    )
  }
}

describe('adaptiveDateTicks', () => {
  it('returns [] for invalid ranges', () => {
    assert.deepEqual(adaptiveDateTicks(NaN, 1), [])
    assert.deepEqual(adaptiveDateTicks(100, 100), [])
    assert.deepEqual(adaptiveDateTicks(200, 100), [])
  })

  it('uses denser monthly ticks for ≤90 day spans', () => {
    const minTs = new Date(2025, 0, 1).getTime()
    const maxTs = new Date(2025, 2, 15).getTime() // ~73 days
    const ticks = adaptiveDateTicks(minTs, maxTs)
    assert.ok(ticks.length >= 2)
    assert.ok(ticks.length <= 6)
    assert.deepEqual(ticks, monthlyTicks(minTs, maxTs, 6))
  })

  it('keeps medium (≤2y) spans sparse enough', () => {
    const minTs = new Date(2024, 0, 1).getTime()
    const maxTs = new Date(2025, 5, 1).getTime() // ~17 months
    const ticks = adaptiveDateTicks(minTs, maxTs)
    assert.ok(ticks.length <= MAX_X_TICKS)
    assertCleanTicks(ticks, minTs, maxTs)
  })

  it('caps multi-year all-history (~2015–2026) so labels do not overlap', () => {
    const minTs = new Date(2015, 0, 15).getTime()
    const maxTs = new Date(2026, 9, 26).getTime()
    const ticks = adaptiveDateTicks(minTs, maxTs)
    assertCleanTicks(ticks, minTs, maxTs)
  })

  it('caps very long (~20y) spans at MAX_X_TICKS without overlap', () => {
    const minTs = new Date(2006, 2, 1).getTime()
    const maxTs = new Date(2026, 9, 26).getTime()
    const ticks = adaptiveDateTicks(minTs, maxTs)
    assertCleanTicks(ticks, minTs, maxTs)
  })
})
