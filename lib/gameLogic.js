
// lib/gameLogic.js
// Shared constants and helpers for the crossy-road chicken game.

// ── Multiplier ladder (8 steps) ───────────────────────────────────────────────
// Each entry = the cashout multiplier AFTER successfully crossing that lane.
// Step 0 = just placed bet (no crossing yet), cashout returns ~1x minus fee.
export const MULTIPLIERS = [
  1.00,  // step 0 — bet placed, not yet crossed
  1.25,  // crossed lane 1
  1.55,  // crossed lane 2
  1.90,  // crossed lane 3
  2.35,  // crossed lane 4
  2.85,  // crossed lane 5
  3.45,  // crossed lane 6
  4.15,  // crossed lane 7
  5.00,  // crossed lane 8 — max, auto cash out
]

export const MAX_STEPS   = 8       // number of road lanes
export const MIN_BET     = 100
export const MAX_BET     = 10_000_000
export const FEE_RATE    = 0.05    // 5% house fee on winnings only (not on returned stake)

// ── Per-step survival probability ────────────────────────────────────────────
// House edge is baked in here. The "fair" probability for each step given the
// multiplier jump would be prev/next, but we shade it slightly in the house's
// favour (~5% overall edge).
//
// Fair odds per step so EV = 1.0 would be:
//   P(survive step n) = MULTIPLIERS[n-1] / MULTIPLIERS[n]
//
// We apply a 5% reduction to that probability for house edge.
export function survivalProbability(step) {
  // step is 1-based (1 = crossing lane 1, etc.)
  const prev = MULTIPLIERS[step - 1]
  const next = MULTIPLIERS[step]
  const fair = prev / next
  return fair * (1 - FEE_RATE) // house edge applied
}

// ── Seed-based outcome generation ────────────────────────────────────────────
// Given a hex seed, deterministically generate 8 floats in [0,1).
// We use a simple LCG seeded from the first 8 bytes of the seed.
// This is NOT for crypto — just for reproducible game outcomes.
export function generateOutcomes(seed) {
  // Use pairs of hex chars as seed bytes
  const bytes = []
  for (let i = 0; i < Math.min(seed.length - 1, 16); i += 2) {
    bytes.push(parseInt(seed.slice(i, i + 2), 16))
  }
  // LCG parameters (Numerical Recipes)
  const m = 2 ** 32
  const a = 1664525
  const c = 1013904223

  let state = bytes.reduce((acc, b, i) => acc ^ (b << (i * 7 % 24)), 0) >>> 0

  const outcomes = []
  for (let i = 0; i < MAX_STEPS; i++) {
    state = (a * state + c) >>> 0
    outcomes.push(state / m)
  }
  return outcomes // outcomes[i] < survivalProbability(i+1) => SAFE
}

// ── Payout calculation ────────────────────────────────────────────────────────
export function calcPayout(betAmount, steps) {
  if (steps === 0) return { payout: 0n, fee: 0n, mult: 1.00 }
  const mult     = MULTIPLIERS[steps]
  const rawPay   = BigInt(Math.floor(Number(betAmount) * mult))
  // Fee only on profit
  const profit   = rawPay - betAmount
  const fee      = profit > 0n ? BigInt(Math.floor(Number(profit) * FEE_RATE)) : 0n
  const payout   = rawPay - fee
  return { payout, fee, mult }
}
