/**
 * Tests for the thermostat decision logic. Run: npm test
 */

import {
  offPeakWindow,
  extractWarmups,
  fitWarmupModel,
  preheatStart,
  planThermostat,
  meanForecast,
  DEFAULTS,
} from "./thermostat.mjs";
import { summarizeAcState } from "./thinq.mjs";
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
const hhmm = (date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const dev = (indoorF, extra = {}) => ({ power: false, mode: "HEAT", indoorF, targetF: 64, ...extra });

// --- Off-peak window -------------------------------------------------------

test("window: 23:30 is in tonight's window, which ends tomorrow 07:00", () => {
  const w = offPeakWindow(at(18, 23, 30));
  assert.equal(w.inWindow, true);
  assert.equal(+w.start, +at(18, 23));
  assert.equal(+w.end, +at(19, 7));
  assert.equal(w.key, "2026-11-19");
});

test("window: 03:00 belongs to the window that started last night", () => {
  const w = offPeakWindow(at(19, 3));
  assert.equal(w.inWindow, true);
  assert.equal(+w.start, +at(18, 23));
  assert.equal(w.key, "2026-11-19");
});

test("window: 07:00 sharp and the afternoon are outside", () => {
  assert.equal(offPeakWindow(at(19, 7)).inWindow, false);
  const w = offPeakWindow(at(19, 14));
  assert.equal(w.inWindow, false);
  assert.equal(+w.start, +at(19, 23));
});

test("window: a window that doesn't cross midnight", () => {
  const w = offPeakWindow(at(19, 13), "12:00", "16:00");
  assert.equal(w.inWindow, true);
  assert.equal(+w.start, +at(19, 12));
});

test("window: survives the DST fall-back night", () => {
  const w = offPeakWindow(new Date(2026, 10, 1, 3));
  assert.equal(w.inWindow, true);
  assert.equal(w.start.getHours(), 23);
  assert.equal(w.end.getHours(), 7);
});

// --- Warm-up extraction ----------------------------------------------------

// Samples every 5 min from `start`, given indoor readings.
function series(start, readings, extra = {}) {
  return readings.map((indoorF, i) => ({
    t: start.getTime() + i * 5 * 60 * 1000,
    power: true,
    mode: "HEAT",
    targetF: 64,
    outdoorF: 30,
    indoorF,
    ...extra,
  }));
}

test("warmups: a run that reaches the setpoint gives its rate", () => {
  // 60 -> 64 over 4 hours (49 samples, 48 gaps).
  const readings = Array.from({ length: 49 }, (_, i) => 60 + Math.floor(i / 12));
  const runs = extractWarmups(series(at(18, 2), readings));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].startF, 60);
  assert.equal(runs[0].endF, 64);
  assert.ok(Math.abs(runs[0].ratePerHour - 1) < 1e-9);
  assert.equal(runs[0].outdoorF, 30);
});

test("warmups: the run ends at the first sample at setpoint; the rest is ignored", () => {
  const runs = extractWarmups(series(at(18, 2), [60, 61, 61, 62, 62, 63, 63, 64, 64, 64, 64]));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].end, at(18, 2, 35).getTime());
});

test("warmups: switching off ends a run, and a long-enough partial run still counts", () => {
  const s = series(at(18, 2), Array(10).fill(60).map((v, i) => v + Math.floor(i / 4)));
  s.push({ ...s[s.length - 1], t: s[s.length - 1].t + 300000, power: false });
  const runs = extractWarmups(s);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].endF, 62);
});

test("warmups: short runs, small lifts, gaps and setpoint changes are dropped or split", () => {
  assert.equal(extractWarmups(series(at(18, 2), [60, 61, 62, 63])).length, 0, "15 minutes is too short");
  assert.equal(extractWarmups(series(at(18, 2), Array(12).fill(63))).length, 0, "1°F lift is too small");
  const gap = [...series(at(18, 2), Array(4).fill(60)), ...series(at(18, 4), Array(4).fill(61))];
  assert.equal(extractWarmups(gap).length, 0, "a gap splits it into two short runs");
  const retarget = [...series(at(18, 2), Array(4).fill(60)), ...series(at(18, 2, 20), Array(4).fill(60), { targetF: 66 })];
  assert.equal(extractWarmups(retarget).length, 0);
});

test("warmups: cooling, fan and off samples never start a run", () => {
  assert.equal(extractWarmups(series(at(18, 2), Array(20).fill(60), { mode: "COOL" })).length, 0);
  assert.equal(extractWarmups(series(at(18, 2), Array(20).fill(60), { power: false })).length, 0);
});

test("warmups: a run still in progress at the end of history is left out", () => {
  assert.equal(extractWarmups(series(at(18, 2), Array(20).fill(60))).length, 0);
});

// --- Model -----------------------------------------------------------------

const run = (outdoorF, ratePerHour, hours = 3) => ({ start: 0, end: hours * 3600000, outdoorF, ratePerHour });

test("model: no runs -> the prior, slower when colder", () => {
  const m = fitWarmupModel([]);
  assert.equal(m.kind, "default");
  assert.equal(m.rateAt(DEFAULTS.refOutdoorF), DEFAULTS.defaultRatePerHour);
  assert.ok(m.rateAt(10) < m.rateAt(35));
  assert.equal(m.rateAt(-40), DEFAULTS.minRatePerHour, "clamped, never zero or negative");
  assert.equal(m.rateAt(null), DEFAULTS.defaultRatePerHour);
});

test("model: a few runs -> their mean, slid along the prior slope", () => {
  const m = fitWarmupModel([run(40, 2), run(42, 2), run(38, 2)]);
  assert.equal(m.kind, "mean");
  assert.ok(Math.abs(m.rateAt(40) - 2) < 1e-9);
  assert.ok(Math.abs(m.rateAt(10) - (2 - 30 * DEFAULTS.priorSlope)) < 1e-9);
});

test("model: runs spread over outdoor temperatures -> a fitted line", () => {
  // rate = 0.2 + 0.04 * outdoor
  const runs = [10, 20, 30, 40, 50].map((o) => run(o, 0.2 + 0.04 * o));
  const m = fitWarmupModel(runs);
  assert.equal(m.kind, "linear");
  assert.ok(Math.abs(m.rateAt(25) - 1.2) < 1e-9);
});

test("model: a backwards slope is noise -> falls back to the mean", () => {
  const runs = [10, 20, 30, 40, 50].map((o) => run(o, 3 - 0.04 * o));
  assert.equal(fitWarmupModel(runs).kind, "mean");
});

test("model: all runs at similar outdoor temps aren't enough for a line", () => {
  const runs = [40, 41, 42, 43, 44].map((o) => run(o, 1.5));
  assert.equal(fitWarmupModel(runs).kind, "mean");
});

// --- Preheat start -----------------------------------------------------------

const night = offPeakWindow(at(18, 23, 30));

test("preheat: works back from 07:00 with safety and margin", () => {
  // 4°F at 1°F/h = 240 min * 1.2 + 15 = 303 min -> 01:57
  const { startAt, minutesNeeded, clamped } = preheatStart({ indoorF: 60, ratePerHour: 1, window: night });
  assert.equal(minutesNeeded, 303);
  assert.equal(hhmm(startAt), "01:57");
  assert.equal(clamped, false);
});

test("preheat: never starts before 23:00, even when it can't make it in time", () => {
  const { startAt, clamped } = preheatStart({ indoorF: 55, ratePerHour: 0.5, window: night });
  assert.equal(+startAt, +at(18, 23));
  assert.equal(clamped, true);
});

test("preheat: latestStart caps a late prediction, but never delays an early one", () => {
  // Predicted 06:45 (already warm) -> capped to 03:00.
  const late = preheatStart({ indoorF: 66, ratePerHour: 1, window: night, latestStart: "03:00" });
  assert.equal(hhmm(late.startAt), "03:00");
  assert.equal(late.capped, true);
  // Predicted 01:57 -> stays.
  const early = preheatStart({ indoorF: 60, ratePerHour: 1, window: night, latestStart: "03:00" });
  assert.equal(hhmm(early.startAt), "01:57");
  assert.equal(early.capped, false);
  // A cap before midnight lands on the evening the window starts.
  assert.equal(+preheatStart({ indoorF: 66, ratePerHour: 1, window: night, latestStart: "23:30" }).startAt, +at(18, 23, 30));
  // A cap outside the window is ignored.
  assert.equal(hhmm(preheatStart({ indoorF: 66, ratePerHour: 1, window: night, latestStart: "12:00" }).startAt), "06:45");
});

test("tick: with the cap, a warm-ish house still starts at 03:00", () => {
  const opts = { latestStart: "03:00" };
  assert.equal(planThermostat({ now: at(19, 2, 55), device: dev(63), ratePerHour: 1, opts }).action, "idle");
  const p = planThermostat({ now: at(19, 3), device: dev(63), ratePerHour: 1, opts });
  assert.equal(p.action, "preheat");
  assert.match(p.reason, /03:00 cap/);
});

test("preheat: already warm needs only the margin", () => {
  assert.equal(hhmm(preheatStart({ indoorF: 66, ratePerHour: 1, window: night }).startAt), "06:45");
});

// --- Tick decisions ----------------------------------------------------------

test("tick: idle outside the window", () => {
  assert.equal(planThermostat({ now: at(18, 15), device: dev(58), ratePerHour: 1 }).action, "idle");
});

test("tick: waits in the window until the start time, then preheats", () => {
  assert.equal(planThermostat({ now: at(19, 1), device: dev(60), ratePerHour: 1 }).action, "idle");
  const p = planThermostat({ now: at(19, 2), device: dev(60), ratePerHour: 1 });
  assert.equal(p.action, "preheat");
  assert.equal(p.key, "2026-11-19");
});

test("tick: a house that cooled further pulls the start earlier", () => {
  assert.equal(planThermostat({ now: at(19, 0, 30), device: dev(60), ratePerHour: 1 }).action, "idle");
  assert.equal(planThermostat({ now: at(19, 0, 30), device: dev(58), ratePerHour: 1 }).action, "preheat");
});

test("tick: fires once per night", () => {
  const p = planThermostat({ now: at(19, 3), device: dev(60), state: { preheatKey: "2026-11-19" }, ratePerHour: 1 });
  assert.equal(p.action, "idle");
  // ...but the next night is a new key.
  const next = planThermostat({ now: at(20, 3), device: dev(60), state: { preheatKey: "2026-11-19" }, ratePerHour: 1 });
  assert.equal(next.action, "preheat");
});

test("tick: a restart after the start time catches up at once", () => {
  assert.equal(planThermostat({ now: at(19, 6, 50), device: dev(60), ratePerHour: 1 }).action, "preheat");
});

test("tick: skips (once) when already warm or already heating high enough", () => {
  assert.equal(planThermostat({ now: at(19, 6, 50), device: dev(65), ratePerHour: 1 }).action, "preheat-skip");
  const on = dev(60, { power: true, targetF: 66 });
  assert.equal(planThermostat({ now: at(19, 3), device: on, ratePerHour: 1 }).action, "preheat-skip");
  // On but set lower than the target still gets preheated.
  const low = dev(60, { power: true, targetF: 62 });
  assert.equal(planThermostat({ now: at(19, 3), device: low, ratePerHour: 1 }).action, "preheat");
});

test("tick: no indoor reading -> do nothing", () => {
  assert.equal(planThermostat({ now: at(19, 3), device: dev(null), ratePerHour: 1 }).action, "idle");
});

// --- Away mode -----------------------------------------------------------------

const away = (indoorF, extra = {}, state = {}) =>
  planThermostat({ now: at(19, 3), device: dev(indoorF, extra), state: { away: true, ...state }, ratePerHour: 1 }).action;

test("away: heats below 47, stops above 49", () => {
  assert.equal(away(47), "away-heat-on");
  assert.equal(away(46, { power: true }, { awayHeating: true }), "idle");
  assert.equal(away(49, { power: true }, { awayHeating: true }), "away-heat-off");
  assert.equal(away(55), "idle", "already off");
});

test("away: inside the band keeps an away heat run going (hysteresis)", () => {
  assert.equal(away(48, { power: true }, { awayHeating: true }), "idle");
  assert.equal(away(48), "idle");
});

test("away: switches off anything it didn't start", () => {
  assert.equal(away(48, { power: true }), "away-heat-off", "a heat run left on from before");
  assert.equal(away(48, { power: true, mode: "COOL" }, { awayHeating: true }), "away-heat-off");
  assert.equal(away(60, { power: true, mode: "COOL" }), "away-heat-off");
});

test("away: below the band, a non-heat mode is replaced by heat", () => {
  assert.equal(away(45, { power: true, mode: "COOL" }, { awayHeating: true }), "away-heat-on");
});

test("away: suppresses the overnight preheat", () => {
  assert.equal(away(55), "idle");
});

test("away: no reading -> do nothing", () => {
  assert.equal(away(null), "idle");
});

// --- Forecast + state parsing ----------------------------------------------------

test("forecast: mean over the range, nearest hour when the range is empty", () => {
  const hourly = [0, 1, 2, 3].map((h) => ({ time: at(19, h), tempF: 30 + h }));
  assert.equal(meanForecast(hourly, at(19, 1), at(19, 3)), 32);
  assert.equal(meanForecast(hourly, at(19, 1, 10), at(19, 1, 20)), 31);
  assert.equal(meanForecast([], at(19, 1), at(19, 2)), null);
});

test("state: summarizes a live Central Air reading in °F", () => {
  const s = summarizeAcState({
    runState: { currentState: "NORMAL" },
    airConJobMode: { currentJobMode: "HEAT" },
    operation: { airConOperationMode: "POWER_ON" },
    temperature: { currentTemperature: 16, targetTemperature: 18, unit: "C" },
    temperatureInUnits: [
      { currentTemperature: 16, targetTemperature: 18, minTargetTemperature: 16, unit: "C" },
      { currentTemperature: 60, targetTemperature: 64, minTargetTemperature: 60, unit: "F" },
    ],
  });
  assert.deepEqual(s, { power: true, mode: "HEAT", indoorF: 60, targetF: 64, minTargetF: 60, runState: "NORMAL" });
});

test("state: falls back to converting °C when there's no °F block", () => {
  const s = summarizeAcState({ operation: { airConOperationMode: "POWER_OFF" }, temperature: { currentTemperature: 10 } });
  assert.equal(s.indoorF, 50);
  assert.equal(s.power, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
