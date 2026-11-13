/**
 * Standalone monotonicity check for the Fritsch–Carlson (PCHIP) curve used by
 * dsh-usage-ledger/client.js. fcTangents/fcCurvePath below are VERBATIM copies
 * of the functions in client.js (single browser artifact cannot export; keep
 * them in sync). Run: node dsh-usage-ledger/src/client/fc.check.mjs
 *
 * Assertion: for every segment, the cubic Hermite defined by the limited
 * tangents stays within [min(y_i, y_{i+1}), max(y_i, y_{i+1})] — i.e. the
 * curve is monotone wherever the data is monotone and never overshoots,
 * which is the property the old Catmull-Rom implementation violated.
 */
import assert from 'node:assert/strict'

// ── verbatim copy from client.js ─────────────────────────────────────────
function fcTangents(xs, ys) {
  const n = xs.length
  const d = []
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]))
  const m = new Array(n).fill(0)
  m[0] = d[0]
  m[n - 1] = d[n - 2]
  for (let i = 1; i < n - 1; i++) {
    m[i] = (d[i - 1] === 0 || d[i] === 0 || Math.sign(d[i - 1]) !== Math.sign(d[i]))
      ? 0
      : (d[i - 1] + d[i]) / 2
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const s = a * a + b * b
    if (s > 9) {
      const tau = 3 / Math.sqrt(s)
      m[i] = tau * a * d[i]
      m[i + 1] = tau * b * d[i]
    }
  }
  return m
}

const rnd = (v) => Math.round(v * 100) / 100

/** points: [{x,y}] with strictly increasing x → SVG path string (M + C segments). */
function fcCurvePath(points) {
  const n = points.length
  if (n === 0) return ''
  if (n === 1) return `M${rnd(points[0].x)},${rnd(points[0].y)}`
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  if (n === 2) return `M${rnd(xs[0])},${rnd(ys[0])}L${rnd(xs[1])},${rnd(ys[1])}`
  const m = fcTangents(xs, ys)
  let d = `M${rnd(xs[0])},${rnd(ys[0])}`
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i]
    d += `C${rnd(xs[i] + dx / 3)},${rnd(ys[i] + (m[i] * dx) / 3)} ${rnd(xs[i + 1] - dx / 3)},${rnd(ys[i + 1] - (m[i + 1] * dx) / 3)} ${rnd(xs[i + 1])},${rnd(ys[i + 1])}`
  }
  return d
}
// ── end verbatim copy ────────────────────────────────────────────────────

/** Evaluate the cubic Hermite of segment i at u∈[0,1] (same math the C segment renders). */
function hermite(xs, ys, m, i, u) {
  const dx = xs[i + 1] - xs[i]
  const u2 = u * u
  const u3 = u2 * u
  return (2 * u3 - 3 * u2 + 1) * ys[i]
    + (u3 - 2 * u2 + u) * dx * m[i]
    + (-2 * u3 + 3 * u2) * ys[i + 1]
    + (u3 - u2) * dx * m[i + 1]
}

function checkMonotone(name, ys) {
  const xs = ys.map((_, i) => i) // uniform categorical x, as the chart uses
  const m = fcTangents(xs, ys)
  for (let i = 0; i < xs.length - 1; i++) {
    const lo = Math.min(ys[i], ys[i + 1]) - 1e-9
    const hi = Math.max(ys[i], ys[i + 1]) + 1e-9
    for (let k = 0; k <= 100; k++) {
      const v = hermite(xs, ys, m, i, k / 100)
      assert.ok(v >= lo && v <= hi, `${name}: segment ${i} overshoots at u=${k / 100}: ${v} ∉ [${lo}, ${hi}]`)
    }
  }
  // smoke: path string parses into the expected command sequence
  const path = fcCurvePath(xs.map((x, i) => ({ x, y: ys[i] })))
  assert.match(path, /^M-?\d/)
  assert.equal((path.match(/C/g) || []).length, xs.length - 1)
  console.log(`ok ${name}: ${JSON.stringify(ys)} → ${path.slice(0, 60)}…`)
}

checkMonotone('steady growth', [1, 2, 4, 8])
checkMonotone('spike then flat', [0, 0, 10, 0, 0])
checkMonotone('monotone up-down', [1, 3, 6, 5, 2])
checkMonotone('flat zeros', [0, 0, 0, 0])
checkMonotone('single nonzero', [0, 0, 7, 0])
checkMonotone('steep then gentle', [0, 100, 101, 102])
checkMonotone('30-day-ish wiggle', [3, 0, 0, 12, 4, 9, 0, 1, 1, 30, 2, 2, 8, 0])
console.log('fc.check: all monotonicity assertions passed (no overshoot).')
