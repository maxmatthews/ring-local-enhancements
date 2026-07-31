/**
 * Tests for the level-sync decision logic. Run: npm test
 */

import { planLevelSync } from "./level-sync.mjs";
import assert from "node:assert/strict";

const DEFAULTS = {
  tolerance: 2,
  consensusRatio: 0.667,
  maxStragglers: 3,
  minBurst: 3,
  fullOpenNudgeEnabled: true,
  fullOpenNudgeLevel: 3,
};

// Build a blind. `target` defaults to `level` (the blind is where it was told).
function blind(name, level, target = level, extra = {}) {
  return {
    id: `id-${name.replace(/\s+/g, "-").toLowerCase()}`,
    isReachable: true,
    isHidden: false,
    attributes: { customName: name, blindsCurrentLevel: level, blindsTargetLevel: target },
    ...extra,
  };
}

const id = (name) => `id-${name.replace(/\s+/g, "-").toLowerCase()}`;

// A burst covering every named blind, all commanded to `level`.
function burstOf(names, level) {
  return new Map(names.map((n) => [id(n), level]));
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split("\n").join("\n      ")}`);
  }
}

const NAMES = [
  "Office Left", "Office Right", "Living Room Left", "Living Room Center",
  "Living Room Right", "Dining Room Left", "Dining Room Center", "Dining Room Right",
  "Kitchen Left", "Kitchen Center", "Kitchen Right", "Family Room Left",
  "Family Room Right", "Bedroom Left", "Bedroom Center", "Bedroom Right",
  "Back Door", "Primary Bathroom",
];

console.log("\nlevel-sync decision logic\n");

// --- The reported scenario -------------------------------------------------

test("two blinds miss an open-to-40 command -> both retried", () => {
  const stuck = ["Kitchen Right", "Bedroom Left"];
  const blinds = NAMES.map((n) => (stuck.includes(n) ? blind(n, 100) : blind(n, 40)));
  const plan = planLevelSync(blinds, burstOf(NAMES, 40), DEFAULTS);

  assert.equal(plan.action, "sync");
  assert.equal(plan.consensus, 40);
  assert.equal(plan.target, 40);
  assert.deepEqual(plan.stragglers.map((s) => s.name).sort(), [...stuck].sort());
});

test("straggler that got the command but never moved is flagged did-not-move", () => {
  // target already 40, but the motor never ran
  const blinds = NAMES.map((n) => (n === "Kitchen Right" ? blind(n, 100, 40) : blind(n, 40)));
  const plan = planLevelSync(blinds, burstOf(NAMES, 40), DEFAULTS);

  assert.equal(plan.action, "sync");
  assert.equal(plan.stragglers.length, 1);
  assert.equal(plan.stragglers[0].mode, "did-not-move");
});

test("straggler that never received the command is flagged missed-command", () => {
  const blinds = NAMES.map((n) => (n === "Kitchen Right" ? blind(n, 100, 100) : blind(n, 40)));
  // the stuck blind emitted no event, so it is absent from the burst
  const plan = planLevelSync(blinds, burstOf(NAMES.filter((n) => n !== "Kitchen Right"), 40), DEFAULTS);

  assert.equal(plan.action, "sync");
  assert.equal(plan.stragglers.length, 1);
  assert.equal(plan.stragglers[0].mode, "missed-command");
});

// --- The ambiguous case the design has to get right ------------------------

test("a blind deliberately set apart in the same burst is left alone", () => {
  const stuck = ["Kitchen Right", "Bedroom Left"];
  const blinds = NAMES.map((n) => {
    if (stuck.includes(n)) return blind(n, 100);
    if (n === "Primary Bathroom") return blind(n, 100); // deliberately kept shut
    return blind(n, 40);
  });
  const burst = burstOf(NAMES.filter((n) => n !== "Primary Bathroom"), 40);
  burst.set(id("Primary Bathroom"), 100); // its own explicit command

  const plan = planLevelSync(blinds, burst, DEFAULTS);

  assert.equal(plan.action, "sync");
  assert.deepEqual(plan.stragglers.map((s) => s.name).sort(), [...stuck].sort());
  assert.ok(plan.skipped.some((s) => s.name === "Primary Bathroom" && /deliberately/.test(s.reason)));
});

// --- Safety valves ---------------------------------------------------------

test("too many disagreeing blinds -> stands down", () => {
  const stuck = ["Kitchen Right", "Bedroom Left", "Office Left", "Back Door"]; // 4 > maxStragglers
  const blinds = NAMES.map((n) => (stuck.includes(n) ? blind(n, 100) : blind(n, 40)));
  const plan = planLevelSync(blinds, burstOf(NAMES, 40), DEFAULTS);

  assert.equal(plan.action, "ignore");
  assert.match(plan.reason, /more than the 3 expected/);
});

test("nudging a single blind by hand never triggers a sync", () => {
  const blinds = NAMES.map((n) => (n === "Kitchen Right" ? blind(n, 40) : blind(n, 100)));
  const plan = planLevelSync(blinds, burstOf(["Kitchen Right"], 40), DEFAULTS);

  assert.equal(plan.action, "ignore");
  assert.match(plan.reason, /below the 3 needed/);
});

test("no clear majority -> stands down", () => {
  // half at 40, half at 100
  const blinds = NAMES.map((n, i) => blind(n, i % 2 === 0 ? 40 : 100));
  const plan = planLevelSync(blinds, burstOf(NAMES, 40), DEFAULTS);

  assert.equal(plan.action, "ignore");
  assert.match(plan.reason, /no consensus level/);
});

test("blind held open by a door sensor is never dragged to consensus", () => {
  const blinds = NAMES.map((n) => (n === "Back Door" ? blind(n, 0) : blind(n, 100)));
  const plan = planLevelSync(blinds, burstOf(NAMES, 100), {
    ...DEFAULTS,
    openSensorsFor: (name) => (name === "Back Door" ? ["Back Door Window"] : []),
  });

  assert.equal(plan.action, "ignore");
  assert.match(plan.reason, /already at level 100/);
  assert.ok(plan.skipped.some((s) => s.name === "Back Door" && /open sensor/.test(s.reason)));
});

test("blind with a pending deferred close is left to the sunset logic", () => {
  const blinds = NAMES.map((n) => (n === "Back Door" ? blind(n, 0) : blind(n, 100)));
  const plan = planLevelSync(blinds, burstOf(NAMES, 100), {
    ...DEFAULTS,
    isPendingClose: (blindId) => blindId === id("Back Door"),
  });

  assert.ok(plan.skipped.some((s) => s.name === "Back Door" && /deferred sunset close/.test(s.reason)));
  assert.equal(plan.stragglers.length, 0);
});

test("unreachable blinds are excluded from consensus and never commanded", () => {
  const blinds = NAMES.map((n) =>
    n === "Primary Bathroom" ? blind(n, 100, 100, { isReachable: false }) : blind(n, 40)
  );
  const plan = planLevelSync(blinds, burstOf(NAMES, 40), DEFAULTS);

  assert.equal(plan.action, "ignore"); // everything reachable is already at 40
  assert.equal(plan.candidateCount, NAMES.length - 1);
  assert.deepEqual(plan.unreachable, ["Primary Bathroom"]);
});

test("levels within tolerance count as arrived", () => {
  const blinds = NAMES.map((n) => (n === "Kitchen Right" ? blind(n, 41) : blind(n, 40)));
  const plan = planLevelSync(blinds, burstOf(NAMES, 40), DEFAULTS);

  assert.equal(plan.action, "ignore");
  assert.match(plan.reason, /already at level 40/);
});

// --- Full-open nudge -------------------------------------------------------

test("full open (0) nudges the whole house to 3", () => {
  const blinds = NAMES.map((n) => blind(n, 0));
  const plan = planLevelSync(blinds, burstOf(NAMES, 0), DEFAULTS);

  assert.equal(plan.action, "sync");
  assert.equal(plan.consensus, 0);
  assert.equal(plan.target, 3);
  assert.equal(plan.nudging, true);
  // every blind moves -- the straggler cap must not block this
  assert.equal(plan.stragglers.length, NAMES.length);
});

test("full-open nudge is not blocked by the straggler cap", () => {
  const blinds = NAMES.map((n) => blind(n, 0));
  const plan = planLevelSync(blinds, burstOf(NAMES, 0), { ...DEFAULTS, maxStragglers: 3 });
  assert.equal(plan.action, "sync");
});

test("once nudged to 3, a re-run is a no-op (no oscillation)", () => {
  const blinds = NAMES.map((n) => blind(n, 3, 3));
  const plan = planLevelSync(blinds, burstOf(NAMES, 3), DEFAULTS);

  assert.equal(plan.action, "ignore");
  assert.equal(plan.nudging, false);
  assert.match(plan.reason, /already at level 3/);
});

test("stragglers on a full-open command are driven to 3, not 0", () => {
  const stuck = ["Kitchen Right", "Bedroom Left"];
  const blinds = NAMES.map((n) => (stuck.includes(n) ? blind(n, 100) : blind(n, 3, 0)));
  const plan = planLevelSync(blinds, burstOf(NAMES, 0), DEFAULTS);

  assert.equal(plan.action, "sync");
  assert.equal(plan.target, 3);
  assert.deepEqual(plan.stragglers.map((s) => s.name).sort(), [...stuck].sort());
});

test("nudge disabled -> full open stays at 0", () => {
  const stuck = ["Kitchen Right"];
  const blinds = NAMES.map((n) => (stuck.includes(n) ? blind(n, 100) : blind(n, 0)));
  const plan = planLevelSync(blinds, burstOf(NAMES, 0), { ...DEFAULTS, fullOpenNudgeEnabled: false });

  assert.equal(plan.action, "sync");
  assert.equal(plan.target, 0);
  assert.equal(plan.nudging, false);
  assert.deepEqual(plan.stragglers.map((s) => s.name), stuck);
});

test("a full close (100) is not treated as a full-open nudge", () => {
  const stuck = ["Kitchen Right"];
  const blinds = NAMES.map((n) => (stuck.includes(n) ? blind(n, 40) : blind(n, 100)));
  const plan = planLevelSync(blinds, burstOf(NAMES, 100), DEFAULTS);

  assert.equal(plan.action, "sync");
  assert.equal(plan.target, 100);
  assert.equal(plan.nudging, false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
