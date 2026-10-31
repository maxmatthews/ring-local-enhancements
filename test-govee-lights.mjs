/**
 * Tests for the Govee outdoor-lights decision logic. Run: npm test
 */

import {
  easter,
  nthWeekday,
  lastWeekday,
  holidayFor,
  pickScene,
  planLights,
  localDateKey,
  timeOnDay,
  HOLIDAYS,
} from "./govee-lights.mjs";
import assert from "node:assert/strict";

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

// Local evening of y-m-d, the time the scene is actually picked.
const at = (y, m, d, h = 18) => new Date(y, m - 1, d, h, 0);
const holidayOn = (y, m, d) => holidayFor(at(y, m, d))?.name ?? null;

// Every name in HOLIDAYS, as the device reports them, plus some it doesn't use.
const ALL_SCENES = [...new Set(HOLIDAYS.flatMap((h) => h.scenes)), "Nebula", "Sunset", "Aurora"];

// --- Holiday dates ---------------------------------------------------------

test("Easter lands on the right Sunday", () => {
  assert.equal(localDateKey(easter(2026)), "2026-04-05");
  assert.equal(localDateKey(easter(2027)), "2027-03-28");
  assert.equal(localDateKey(easter(2030)), "2030-04-21");
});

test("floating holidays resolve to the right weekday", () => {
  assert.equal(localDateKey(nthWeekday(2026, 11, 4, 4)), "2026-11-26"); // Thanksgiving
  assert.equal(localDateKey(nthWeekday(2026, 9, 1, 1)), "2026-09-07"); // Labor Day
  assert.equal(localDateKey(nthWeekday(2027, 9, 1, 1)), "2027-09-06");
  assert.equal(localDateKey(lastWeekday(2026, 5, 1)), "2026-05-25"); // Memorial Day
  assert.equal(localDateKey(lastWeekday(2027, 5, 1)), "2027-05-31"); // May 31 is itself a Monday
});

// --- Windows ---------------------------------------------------------------

test("an ordinary night is no holiday", () => {
  assert.equal(holidayOn(2026, 8, 12), null);
  assert.equal(holidayOn(2026, 10, 23), null);
});

test("a holiday runs the seven days before through the day itself", () => {
  assert.equal(holidayOn(2026, 10, 24), "Halloween");
  assert.equal(holidayOn(2026, 10, 31), "Halloween");
  assert.equal(holidayOn(2026, 11, 1), null);
});

test("Thanksgiving follows its Thursday, not a fixed date", () => {
  assert.equal(holidayOn(2026, 11, 18), null);
  assert.equal(holidayOn(2026, 11, 19), "Thanksgiving");
  assert.equal(holidayOn(2026, 11, 26), "Thanksgiving");
  assert.equal(holidayOn(2026, 11, 27), null);
});

test("Christmas has the whole of December, including New Year's lead-in", () => {
  assert.equal(holidayOn(2026, 11, 30), null);
  assert.equal(holidayOn(2026, 12, 1), "Christmas");
  assert.equal(holidayOn(2026, 12, 26), "Christmas");
  assert.equal(holidayOn(2026, 12, 31), "Christmas");
});

test("Memorial Day runs its Saturday-to-Monday weekend only", () => {
  assert.equal(holidayOn(2027, 5, 28), null); // Friday
  assert.equal(holidayOn(2027, 5, 29), "Memorial Day");
  assert.equal(holidayOn(2027, 5, 31), "Memorial Day");
  assert.equal(holidayOn(2027, 6, 1), null);
});

test("Labor Day runs its Saturday-to-Monday weekend only, ignoring leadDays", () => {
  assert.equal(holidayOn(2027, 9, 3), null); // Friday
  assert.equal(holidayOn(2027, 9, 4), "Labor Day");
  assert.equal(holidayOn(2027, 9, 6), "Labor Day");
  assert.equal(holidayOn(2027, 9, 7), null);
  assert.equal(holidayFor(at(2027, 9, 1), { leadDays: 30 })?.name, undefined);
});

test("Mother's Day and Father's Day are ordinary nights", () => {
  assert.equal(holidayOn(2027, 5, 9), null);
  assert.equal(holidayOn(2027, 6, 20), null);
});

test("New Year's Day still gets its own night", () => {
  assert.equal(holidayOn(2027, 1, 1), "New Year's Day");
  assert.equal(holidayOn(2027, 1, 2), null);
});

test("New Year's lead-in reaches back into the old year when nothing outranks it", () => {
  const onlyNewYear = HOLIDAYS.filter((h) => h.name === "New Year's Day");
  assert.equal(holidayFor(at(2026, 12, 27), { holidays: onlyNewYear })?.name, "New Year's Day");
  assert.equal(holidayFor(at(2026, 12, 24), { holidays: onlyNewYear }), null);
});

test("the window counts calendar days across a DST change", () => {
  // US clocks go back on 2026-11-01; Thanksgiving's window still opens on the 19th.
  assert.equal(holidayFor(new Date(2026, 10, 19, 0, 30))?.name, "Thanksgiving");
  // Easter 2026 is April 5; the March 8 spring-forward sits well outside, but
  // the 29th, seven days before, is still in.
  assert.equal(holidayOn(2026, 3, 29), "Easter");
  assert.equal(holidayOn(2026, 3, 28), null);
});

test("leadDays is configurable", () => {
  assert.equal(holidayFor(at(2026, 10, 28), { leadDays: 2 }), null);
  assert.equal(holidayFor(at(2026, 10, 29), { leadDays: 2 })?.name, "Halloween");
});

// --- Scene choice ----------------------------------------------------------

test("an ordinary night shows the default scene", () => {
  const pick = pickScene({ now: at(2026, 8, 12), available: ALL_SCENES });
  assert.equal(pick.scene, "Nebula");
  assert.equal(pick.holiday, null);
});

test("a holiday night picks one of that holiday's scenes at random", () => {
  const halloween = ["Halloween", "Halloween B", "Halloween C", "Halloween D"];
  assert.equal(pickScene({ now: at(2026, 10, 30), available: ALL_SCENES, random: () => 0 }).scene, "Halloween");
  assert.equal(pickScene({ now: at(2026, 10, 30), available: ALL_SCENES, random: () => 0.99 }).scene, "Halloween D");
  const pick = pickScene({ now: at(2026, 10, 30), available: ALL_SCENES });
  assert.ok(halloween.includes(pick.scene), pick.scene);
  assert.deepEqual(pick.candidates, halloween);
});

test("last night's scene is not repeated when there is a choice", () => {
  for (let i = 0; i < 50; i++) {
    const pick = pickScene({ now: at(2026, 10, 30), available: ALL_SCENES, previous: "Halloween C" });
    assert.notEqual(pick.scene, "Halloween C");
  }
});

test("a holiday with a single scene repeats it", () => {
  const pick = pickScene({ now: at(2026, 11, 25), available: ALL_SCENES, previous: "Thanksgiving" });
  assert.equal(pick.scene, "Thanksgiving");
});

test("scene names match the device case-insensitively and come back as the device spells them", () => {
  const pick = pickScene({ now: at(2026, 11, 25), available: ["THANKSGIVING", "Nebula"] });
  assert.equal(pick.scene, "THANKSGIVING");
});

test("a holiday whose scenes the device lacks falls back to the default", () => {
  const pick = pickScene({ now: at(2026, 10, 30), available: ["Nebula", "Aurora"] });
  assert.equal(pick.scene, "Nebula");
  assert.equal(pick.holiday, "Halloween");
  assert.match(pick.reason, /none of its scenes/);
});

test("the default scene is configurable", () => {
  assert.equal(pickScene({ now: at(2026, 8, 12), available: ALL_SCENES, defaultScene: "Aurora" }).scene, "Aurora");
});

// --- On/off schedule -------------------------------------------------------

const NIGHT = { onAt: new Date(2026, 9, 31, 18, 5), offAt: new Date(2026, 9, 31, 23, 15) };
const plan = (h, m, state = {}) => planLights({ now: new Date(2026, 9, 31, h, m), ...NIGHT, state }).action;

test("idle before sunset", () => {
  assert.equal(plan(12, 0), "idle");
  assert.equal(plan(18, 4), "idle");
});

test("on at sunset, once", () => {
  assert.equal(plan(18, 5), "on");
  assert.equal(plan(20, 0, { onDate: "2026-10-31" }), "idle");
});

test("yesterday's on doesn't count for tonight", () => {
  assert.equal(plan(18, 6, { onDate: "2026-10-30", offDate: "2026-10-30" }), "on");
});

test("a restart mid-evening still switches on if tonight's on never happened", () => {
  assert.equal(plan(21, 30, { onDate: "2026-10-30" }), "on");
});

test("off at the off time, once", () => {
  assert.equal(plan(23, 14, { onDate: "2026-10-31" }), "idle");
  assert.equal(plan(23, 15, { onDate: "2026-10-31" }), "off");
  assert.equal(plan(23, 50, { onDate: "2026-10-31", offDate: "2026-10-31" }), "idle");
});

test("coming back after the off time sends the off rather than switching on", () => {
  assert.equal(plan(23, 40, {}), "off");
});

test("after midnight is the new day's afternoon, not last night's evening", () => {
  const now = new Date(2026, 10, 1, 0, 30);
  const night = { onAt: new Date(2026, 10, 1, 17, 5), offAt: new Date(2026, 10, 1, 23, 15) };
  const state = { onDate: "2026-10-31", offDate: "2026-10-31" };
  assert.equal(planLights({ now, ...night, state }).action, "idle");
});

test("off times parse as local HH:MM", () => {
  const off = timeOnDay(new Date(2026, 9, 31, 9, 0), "23:15");
  assert.equal(off.getHours(), 23);
  assert.equal(off.getMinutes(), 15);
  assert.equal(localDateKey(off), "2026-10-31");
  assert.throws(() => timeOnDay(new Date(), "11:15pm"));
  assert.throws(() => timeOnDay(new Date(), "24:00"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
