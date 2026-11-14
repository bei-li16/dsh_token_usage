// heatgeo.check.mjs — node assertions for the heatmap geometry core
// (verbatim mirrors of heatGeometry/heatRowOf/heatMonthLabels in client.js).
// Covers: full-rectangle coverage & uniqueness, gutter/step fit at several
// container widths, and month-label bounds. Run: node heatgeo.check.mjs

import assert from 'node:assert/strict'

const HEAT_GUTTER = 26
const HEAT_GAP = 3
const HEAT_LABEL_H = 16
const HEAT_DAY_MS = 86400000
const heatRowOf = (ms) => (new Date(ms).getDay() + 6) % 7
const heatDayMs = (k) => new Date(`${k}T00:00:00`).getTime()
function heatGeometry(firstDay, todayDay, availW) {
  const firstMs = heatDayMs(firstDay)
  const todayMs = heatDayMs(todayDay)
  const weekStartMs = firstMs - heatRowOf(firstMs) * HEAT_DAY_MS
  const weekEndMs = todayMs + (6 - heatRowOf(todayMs)) * HEAT_DAY_MS
  const totalDays = Math.round((weekEndMs - weekStartMs) / HEAT_DAY_MS) + 1
  const cols = Math.ceil(totalDays / 7)
  // Fractional step: the grid fills the measured width EXACTLY.
  const step = Math.max(6, availW / cols)
  const cell = Math.max(4, step - HEAT_GAP)
  const width = HEAT_GUTTER + cols * step
  const height = 7 * step + HEAT_LABEL_H
  return { weekStartMs, weekEndMs, cols, step, cell, width, height }
}
function heatMonthLabels(geo) {
  const labels = []
  let prevMonth = -1; let lastX = -Infinity
  for (let col = 0; col < geo.cols; col++) {
    const dt = new Date(geo.weekStartMs + col * 7 * HEAT_DAY_MS)
    const m = dt.getMonth()
    if (m === prevMonth) continue
    prevMonth = m
    const x = HEAT_GUTTER + col * geo.step
    if ((col !== 0 && x - lastX < 30) || x > geo.width - 24) continue
    lastX = x
    labels.push({ x, text: dt.toLocaleDateString(undefined, { month: 'short' }) })
  }
  return labels
}

let passed = 0
function check(name, fn) { fn(); passed++; console.log(`ok   - ${name}`) }

const RANGES = [
  ['2025-11-14', '2026-11-14'],
  ['2025-12-25', '2026-11-14'],
  ['2026-10-15', '2026-11-14'],
  ['2026-11-14', '2026-11-14'],
  ['2026-11-09', '2026-11-14'],
]

for (const [first, today] of RANGES) {
  check(`full-rect coverage & uniqueness ${first}..${today}`, () => {
    const geo = heatGeometry(first, today, 1000)
    // rectangle spans exactly cols*7 consecutive days
    assert.equal(Math.round((geo.weekEndMs - geo.weekStartMs) / HEAT_DAY_MS) + 1, geo.cols * 7)
    // every (col,row) unique and inside bounds
    const seen = new Set()
    for (let col = 0; col < geo.cols; col++) {
      for (let row = 0; row < 7; row++) {
        const k = `${col}:${row}`
        assert.ok(!seen.has(k)); seen.add(k)
        const ms = geo.weekStartMs + (col * 7 + row) * HEAT_DAY_MS
        assert.ok(ms >= geo.weekStartMs && ms <= geo.weekEndMs)
        assert.equal(col, Math.floor((ms - geo.weekStartMs) / HEAT_DAY_MS / 7))
        assert.equal(row, heatRowOf(ms))
      }
    }
    // first/today land inside the rectangle
    assert.ok(heatDayMs(first) >= geo.weekStartMs && heatDayMs(first) <= geo.weekEndMs)
    assert.ok(heatDayMs(today) >= geo.weekStartMs && heatDayMs(today) <= geo.weekEndMs)
  })
}

for (const wrapW of [600, 795, 1080, 1400]) {
  check(`fit squares at container ${wrapW}px (52-week range)`, () => {
    const geo = heatGeometry('2025-11-14', '2026-11-14', wrapW - HEAT_GUTTER)
    assert.ok(geo.step >= 6, `step ${geo.step} >= 6`)
    assert.ok(geo.cell >= 4, `cell ${geo.cell} >= 4`)
    // exact fill: width == container (within float epsilon)
    assert.ok(Math.abs(geo.width - wrapW) < 1e-9, `width ${geo.width} fills ${wrapW}`)
    assert.equal(geo.cell, geo.step - HEAT_GAP, 'cells stay square')
  })
}

check('unmeasured (availW=0) degrades to minimum step', () => {
  const geo = heatGeometry('2025-11-14', '2026-11-14', 0)
  assert.equal(geo.step, 6)
  assert.ok(geo.width > 0)
})

check('month labels inside bounds and spaced (52-week range)', () => {
  const geo = heatGeometry('2025-11-14', '2026-11-14', 1054)
  const labels = heatMonthLabels(geo)
  assert.ok(labels.length >= 11, `>= 11 month labels, got ${labels.length}`)
  let prevX = -Infinity
  for (const [i, l] of labels.entries()) {
    assert.ok(l.x >= HEAT_GUTTER && l.x <= geo.width - 24, `label ${l.text} x=${l.x} in bounds`)
    if (i > 0) assert.ok(l.x - prevX >= 30, 'labels spaced >= 30px')
    prevX = l.x
  }
})

console.log(`heatgeo.check: ${passed} checks passed`)
