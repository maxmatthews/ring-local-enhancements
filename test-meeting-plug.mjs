/**
 * Tests for the meeting-plug decision logic. Run: npm test
 */

import { planMeetingStart, planTick, resolveDuration } from "./meeting-plug.mjs";
import assert from "node:assert/strict";

const NOW = Date.parse("2026-09-08T14:00:00Z");
const MIN = 60 * 1000;

const CFG = {
  defaultMinutes: 60,
  minMinutes: 5,
  maxMinutes: 240,
  respectExisting: true,
};

const start = (request, extra = {}) =>
  planMeetingStart({ request, now: NOW, session: null, plugAlreadyOn: false, cfg: CFG, ...extra });

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

// --- duration resolution ---------------------------------------------------

test("a real end date sets the off time to the end of the meeting", () => {
  const plan = start({ endsAt: NOW + 30 * MIN });
  assert.equal(plan.minutes, 30);
  assert.equal(plan.source, "meeting-end");
  assert.equal(plan.offAt, NOW + 30 * MIN);
});

test("no meeting length at all falls back to an hour", () => {
  const plan = start({});
  assert.equal(plan.minutes, 60);
  assert.match(plan.source, /^default/);
  assert.equal(plan.offAt, NOW + 60 * MIN);
});

test("an undefined request falls back to an hour", () => {
  const plan = start(undefined);
  assert.equal(plan.minutes, 60);
  assert.match(plan.source, /^default/);
});

test("an end date in the past falls back to an hour rather than switching off at once", () => {
  const plan = start({ endsAt: NOW - 10 * MIN });
  assert.equal(plan.minutes, 60);
  assert.match(plan.source, /already passed/);
});

test("an explicit duration is used when no end date is given", () => {
  const plan = start({ minutes: 45 });
  assert.equal(plan.minutes, 45);
  assert.equal(plan.source, "requested-duration");
});

test("an end date wins over an explicit duration", () => {
  const plan = start({ endsAt: NOW + 25 * MIN, minutes: 45 });
  assert.equal(plan.minutes, 25);
  assert.equal(plan.source, "meeting-end");
});

test("an all-day event is capped rather than leaving the plug on for a day", () => {
  const plan = start({ endsAt: NOW + 18 * 60 * MIN });
  assert.equal(plan.minutes, 240);
  assert.equal(plan.clamped, true);
});

test("a meeting ending in seconds is floored to the minimum", () => {
  const plan = start({ endsAt: NOW + 30 * 1000 });
  assert.equal(plan.minutes, 5);
  assert.equal(plan.clamped, true);
});

test("a duration inside the bounds is not marked clamped", () => {
  assert.equal(resolveDuration({ endsAt: NOW + 30 * MIN }, NOW, CFG).clamped, false);
});

// --- overlapping meetings --------------------------------------------------

test("a later meeting extends the off time", () => {
  const session = { offAt: NOW + 10 * MIN, owned: true };
  const plan = planMeetingStart({
    request: { endsAt: NOW + 40 * MIN },
    now: NOW,
    session,
    plugAlreadyOn: true,
    cfg: CFG,
  });
  assert.equal(plan.offAt, NOW + 40 * MIN);
  assert.equal(plan.extended, true);
});

test("a shorter overlapping meeting never cuts the running one short", () => {
  const session = { offAt: NOW + 90 * MIN, owned: true };
  const plan = planMeetingStart({
    request: { endsAt: NOW + 20 * MIN },
    now: NOW,
    session,
    plugAlreadyOn: true,
    cfg: CFG,
  });
  assert.equal(plan.offAt, NOW + 90 * MIN);
  assert.equal(plan.extended, false);
});

test("extending keeps the original ownership, so a borrowed plug stays borrowed", () => {
  const session = { offAt: NOW + 10 * MIN, owned: false };
  const plan = planMeetingStart({
    request: { endsAt: NOW + 40 * MIN },
    now: NOW,
    session,
    plugAlreadyOn: true,
    cfg: CFG,
  });
  assert.equal(plan.owned, false);
});

// --- ownership -------------------------------------------------------------

test("a plug that was off is ours to switch off again", () => {
  assert.equal(start({}, { plugAlreadyOn: false }).owned, true);
});

test("a plug already on before the meeting is left alone at the end", () => {
  const plan = start({}, { plugAlreadyOn: true });
  assert.equal(plan.owned, false);
  assert.equal(plan.turnOn, true);
});

test("an unreadable plug state is still treated as ours", () => {
  assert.equal(start({}, { plugAlreadyOn: null }).owned, true);
});

test("respectExisting=false takes ownership of an already-on plug", () => {
  const plan = start({}, { plugAlreadyOn: true, cfg: { ...CFG, respectExisting: false } });
  assert.equal(plan.owned, true);
});

// --- the tick --------------------------------------------------------------

test("no session means nothing to do", () => {
  assert.equal(planTick({ now: NOW, session: null }).action, "idle");
});

test("before the off time the tick waits", () => {
  const plan = planTick({ now: NOW, session: { offAt: NOW + 5 * MIN, owned: true } });
  assert.equal(plan.action, "wait");
  assert.equal(plan.msRemaining, 5 * MIN);
});

test("at the off time an owned plug is switched off", () => {
  assert.equal(planTick({ now: NOW, session: { offAt: NOW, owned: true } }).action, "off");
});

test("an off time missed while the service was down still switches off", () => {
  const plan = planTick({ now: NOW, session: { offAt: NOW - 3 * 60 * MIN, owned: true } });
  assert.equal(plan.action, "off");
});

test("a plug we never owned is released, not switched off", () => {
  assert.equal(planTick({ now: NOW, session: { offAt: NOW, owned: false } }).action, "release");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
