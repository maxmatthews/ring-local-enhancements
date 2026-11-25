/**
 * Tests for the water heater schedule and reconciliation logic. Run: npm test
 */

import { waterHeaterSchedule, planWaterHeater, summarizeWaterHeater, diffWaterHeater, normalizeMode, retryDelayMs } from "./water-heater.mjs";
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

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m); // November 2026, local
const plan = (now, away, schedule) => planWaterHeater({ now, away, schedule });

// --- Schedule ----------------------------------------------------------------

test("schedule: on at 23:00 the night before, 120°F from the 06:00 after", () => {
  const s = waterHeaterSchedule(at(29, 17), at(24, 18)); // back Sunday 5 PM, set Tuesday
  assert.equal(+s.onAt, +at(28, 23));
  assert.equal(+s.dropAt, +at(29, 6));
});

test("schedule: back in the small hours -- still the night before, still 06:00", () => {
  const s = waterHeaterSchedule(at(25, 5), at(24, 18));
  assert.equal(+s.onAt, +at(24, 23));
  assert.equal(+s.dropAt, +at(25, 6));
});

test("schedule: set after the night-before time, off-peak -> on now, 120°F at 06:00", () => {
  const late = waterHeaterSchedule(at(25, 5), at(24, 23, 30));
  assert.equal(+late.onAt, +at(24, 23, 30));
  assert.equal(+late.dropAt, +at(25, 6));
  // "I'm home" at 05:30: on now, down at 06:00 the same morning.
  const early = waterHeaterSchedule(at(25, 5, 30), at(25, 5, 30));
  assert.equal(+early.onAt, +at(25, 5, 30));
  assert.equal(+early.dropAt, +at(25, 6));
});

test("schedule: back the same day during peak hours -> waits for 23:00 that day", () => {
  // Set Wednesday 10:00 for a 17:00 return: the night before (Tue 23:00) is gone.
  const s = waterHeaterSchedule(at(25, 17), at(25, 10));
  assert.equal(+s.onAt, +at(25, 23));
  assert.equal(+s.dropAt, +at(26, 6));
});

test("schedule: \"I'm home\" during peak hours -> 23:00 that day, 120°F the next 06:00", () => {
  for (const [h, m] of [[7, 0], [17, 0], [22, 59]]) {
    const s = waterHeaterSchedule(at(24, h, m), at(24, h, m));
    assert.equal(+s.onAt, +at(24, 23), `home at ${h}:${m}`);
    assert.equal(+s.dropAt, +at(25, 6));
  }
});

test("schedule: home in the evening, while waiting for 23:00 -> left off", () => {
  const s = waterHeaterSchedule(at(24, 17), at(24, 17));
  const sch = { onAt: s.onAt.toISOString(), dropAt: s.dropAt.toISOString() };
  assert.equal(plan(at(24, 18), false, sch), null, "home: not switched on early, nothing forced off either");
  assert.equal(plan(at(24, 23), false, sch).setpointF, 140);
});

test("schedule: a return across the end of the month", () => {
  const s = waterHeaterSchedule(new Date(2026, 11, 1, 9), at(24, 12));
  assert.equal(+s.onAt, +at(30, 23));
  assert.equal(+s.dropAt, +new Date(2026, 11, 1, 6));
});

// --- Plan --------------------------------------------------------------------

const sch = { onAt: at(28, 23).toISOString(), dropAt: at(29, 6).toISOString() };

test("plan: away -> off, until the night before you're back", () => {
  assert.equal(plan(at(25, 12), true, null).enabled, false);
  const p = plan(at(28, 22, 59), true, sch);
  assert.equal(p.enabled, false);
  assert.match(p.reason, /off until 11\/28 23:00/);
});

test("plan: from 23:00 the night before, Energy Saver at 140°F", () => {
  const p = plan(at(28, 23), true, sch);
  assert.deepEqual([p.enabled, p.mode, p.setpointF, p.final], [true, "ENERGY_SAVING", 140, false]);
  assert.equal(plan(at(29, 5, 59), true, sch).setpointF, 140);
});

test("plan: 120°F from 06:00, whether or not away mode has ended yet", () => {
  for (const away of [true, false]) {
    const p = plan(at(29, 6), away, sch);
    assert.deepEqual([p.enabled, p.setpointF, p.final], [true, 120, true]);
  }
});

test("plan: home with nothing scheduled -> left alone", () => {
  assert.equal(plan(at(25, 12), false, null), null);
});

// --- Reported state ------------------------------------------------------------

// Shaped like getUserDataForApp's water heater entries (as pyeconet reads them).
const heater = (over = {}) => ({
  device_name: "AB12CD34",
  serial_number: "SN-1",
  device_type: "WH",
  "@NAME": { value: "Water Heater" },
  "@TYPE": "heatpumpWaterHeaterGen5",
  "@CONNECTED": true,
  "@ENABLED": { value: 1 },
  "@MODE": { value: 1, status: "ENERGY SAVER", constraints: { enumText: ["OFF", "ENERGY SAVER", "HEAT PUMP", "HIGH DEMAND", "ELECTRIC", "VACATION"] } },
  "@SETPOINT": { value: 120, constraints: { lowerLimit: 110, upperLimit: 140 } },
  ...over,
});

test("state: on/off from @ENABLED, mode by name, setpoint and its limits", () => {
  const s = summarizeWaterHeater(heater());
  assert.deepEqual(
    [s.enabled, s.mode, s.setpointF, s.setpointMinF, s.setpointMaxF, s.connected],
    [true, "ENERGY_SAVING", 120, 110, 140, true]
  );
  assert.equal(summarizeWaterHeater(heater({ "@ENABLED": { value: 0 } })).enabled, false, "off, though @MODE still says Energy Saver");
  assert.equal(summarizeWaterHeater(heater({ "@CONNECTED": false })).connected, false);
});

test("state: @MODE.status wins over a value that disagrees", () => {
  const s = summarizeWaterHeater(heater({ "@MODE": { value: 3, status: "HEAT PUMP", constraints: { enumText: ["OFF", "ENERGY SAVER", "HEAT PUMP", "HIGH DEMAND"] } } }));
  assert.equal(s.mode, "HEAT_PUMP_ONLY");
});

test("state: a unit without @ENABLED is off in its OFF mode", () => {
  const h = heater({ "@MODE": { value: 0, constraints: { enumText: ["OFF", "ENERGY SAVING"] } } });
  delete h["@ENABLED"];
  const s = summarizeWaterHeater(h);
  assert.equal(s.enabled, false);
  assert.equal(s.hasEnabled, false);
});

test("modes: the names units use for the same thing", () => {
  assert.equal(normalizeMode("Energy Saver"), "ENERGY_SAVING");
  assert.equal(normalizeMode("ENERGY SAVING"), "ENERGY_SAVING");
  assert.equal(normalizeMode("HEAT PUMP"), "HEAT_PUMP_ONLY");
  assert.equal(normalizeMode("ELECTRIC/GAS"), "ELECTRIC_GAS");
});

// --- What to send ----------------------------------------------------------------

const boost = { enabled: true, mode: "ENERGY_SAVING", setpointF: 140 };
const diff = (over, desired) => diffWaterHeater(summarizeWaterHeater(heater(over)), desired);

// As the real heater reported it (heatpumpWaterHeaterGen5), switched off.
const realOff = {
  "@ENABLED": { constraints: { enumText: ["Disabled", "Enabled "], lowerLimit: 0, upperLimit: 1 }, status: "Disabled", value: 0 },
  "@MODE": { constraints: { enumText: ["Off", "Energy Saver", "Heat Pump", "High Demand", "Electric/Gas", "Vacation"], lowerLimit: 0, upperLimit: 5 }, status: "Off", value: 0 },
  "@SETPOINT": { constraints: { error: [], formatDecimal: 0, isConversion: true, lowerLimit: 110, units: "deg F", upperLimit: 140 }, value: 120 },
};

test("real heater: reads as off at 120, and comes back as Energy Saver at 140", () => {
  const s = summarizeWaterHeater(heater(realOff));
  assert.deepEqual([s.enabled, s.mode, s.setpointF, s.setpointMaxF], [false, "OFF", 120, 140]);
  assert.deepEqual(s.modes, ["OFF", "ENERGY_SAVING", "HEAT_PUMP_ONLY", "HIGH_DEMAND", "ELECTRIC_GAS", "VACATION"]);
  assert.deepEqual(diffWaterHeater(s, boost).payloads, [{ "@ENABLED": 1, "@MODE": 1 }, { "@SETPOINT": 140 }]);
  assert.deepEqual(diffWaterHeater(s, { enabled: false }).payloads, []);
});

test("real heater: switched off by @ENABLED it keeps a padded Energy Saver mode -- still off", () => {
  const s = summarizeWaterHeater(heater({ ...realOff, "@MODE": { ...realOff["@MODE"], status: "Energy Saver  ", value: 1 } }));
  assert.deepEqual([s.enabled, s.mode], [false, "ENERGY_SAVING"]);
  assert.deepEqual(diffWaterHeater(s, { enabled: false }).payloads, [], "nothing to send");
  assert.deepEqual(diffWaterHeater(s, boost).payloads, [{ "@ENABLED": 1 }, { "@SETPOINT": 140 }], "on needs only the switch");
  // A padded status beats a stale value.
  assert.equal(summarizeWaterHeater(heater({ "@MODE": { ...realOff["@MODE"], status: "Heat Pump ", value: 1 } })).mode, "HEAT_PUMP_ONLY");
});

test("diff: off is one command (switch and Off mode together), and none once it's off", () => {
  assert.deepEqual(diff({}, { enabled: false }).payloads, [{ "@ENABLED": 0, "@MODE": 0 }]);
  assert.deepEqual(diff({ "@ENABLED": { value: 0 } }, { enabled: false }).payloads, []);
});

test("diff: back on -- on and mode first, then the setpoint", () => {
  const off = { "@ENABLED": { value: 0 }, "@MODE": { value: 2, constraints: { enumText: ["OFF", "ENERGY SAVER", "HEAT PUMP"] } } };
  assert.deepEqual(diff(off, boost).payloads, [{ "@ENABLED": 1, "@MODE": 1 }, { "@SETPOINT": 140 }]);
});

test("diff: only what's still different is re-sent", () => {
  assert.deepEqual(diff({ "@SETPOINT": { value: 120, constraints: { lowerLimit: 110, upperLimit: 140 } } }, boost).payloads, [{ "@SETPOINT": 140 }]);
  assert.deepEqual(diff({ "@SETPOINT": { value: 140, constraints: { lowerLimit: 110, upperLimit: 140 } } }, boost).payloads, []);
});

test("diff: a unit without @ENABLED is switched with its OFF mode", () => {
  const h = heater({ "@MODE": { value: 1, constraints: { enumText: ["OFF", "ENERGY SAVING"] } } });
  delete h["@ENABLED"];
  const s = summarizeWaterHeater(h);
  assert.deepEqual(diffWaterHeater(s, { enabled: false }).payloads, [{ "@MODE": 0 }]);
});

test("diff: what this unit can't do is reported, not sent", () => {
  const low = diff({ "@SETPOINT": { value: 120, constraints: { lowerLimit: 110, upperLimit: 135 } } }, boost);
  assert.deepEqual(low.payloads, []);
  assert.match(low.problems[0], /140°F is outside the heater's 110–135°F/);
  const noMode = diff({ "@MODE": { value: 0, constraints: { enumText: ["HEAT PUMP", "ELECTRIC"] } } }, boost);
  assert.match(noMode.problems[0], /no ENERGY_SAVING mode/);
});

test("retries: 30s, 1m, 2m, 5m, then every 10m", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map((n) => retryDelayMs(n) / 1000), [30, 60, 120, 300, 600, 600, 600]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
