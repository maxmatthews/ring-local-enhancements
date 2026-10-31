/**
 * Dates on which particular blinds stay open instead of closing at sunset.
 *
 * Pure and I/O-free: index.mjs asks it about each blind at sunset and before
 * level-sync drives a straggler, and test-blind-holds.mjs exercises it directly.
 *
 * Dates are matched against the Pi's local calendar day, every year.
 */

// month is 1-12. Blind names match the same way CLOSE_ORDER does: a
// case-insensitive substring of the blind's customName.
export const BLIND_HOLDS = [
  {
    reason: "Halloween",
    month: 10,
    day: 31,
    blinds: ["Living Room Center", "Living Room Right"],
  },
];

/**
 * @param {string} blindName  the blind's customName (or id)
 * @param {Date}   now
 * @param {Array}  holds      defaults to BLIND_HOLDS
 * @returns {string|null}     the hold's reason, or null if the blind may close
 */
export function holdOpenReason(blindName, now, holds = BLIND_HOLDS) {
  const lower = blindName.toLowerCase();
  for (const hold of holds) {
    if (now.getMonth() + 1 !== hold.month || now.getDate() !== hold.day) continue;
    if (hold.blinds.some((entry) => lower.includes(entry.toLowerCase()))) return hold.reason;
  }
  return null;
}
