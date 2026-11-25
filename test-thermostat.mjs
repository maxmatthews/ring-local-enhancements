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
  extractCooldowns,
  fitCoolingModel,
  awayBankTarget,
  bankHorizonHours,
  trustedSamples,
  parseReturnAt,
  findRoomSensor,
  roomSensorF,
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

// --- Morning heat-off ---------------------------------------------------------

const heating = (indoorF = 64) => dev(indoorF, { power: true, targetF: 64 });

test("heat-off: at 07:00 a heating unit is switched off", () => {
  const p = planThermostat({ now: at(19, 7), device: heating(), ratePerHour: 1 });
  assert.equal(p.action, "heat-off");
  assert.equal(p.key, "2026-11-19");
});

test("heat-off: 06:59 is still the preheat's business", () => {
  assert.notEqual(planThermostat({ now: at(19, 6, 59), device: heating(), ratePerHour: 1 }).action, "heat-off");
});

test("heat-off: once a day -- turning the heat back on afterwards sticks", () => {
  const done = { heatOffKey: "2026-11-19" };
  assert.equal(planThermostat({ now: at(19, 7, 30), device: heating(), state: done, ratePerHour: 1 }).action, "idle");
  assert.equal(planThermostat({ now: at(20, 7), device: heating(), state: done, ratePerHour: 1 }).action, "heat-off", "next day fires again");
});

test("heat-off: a late restart catches up within the hour, not after", () => {
  assert.equal(planThermostat({ now: at(19, 7, 45), device: heating(), ratePerHour: 1 }).action, "heat-off");
  assert.equal(planThermostat({ now: at(19, 8), device: heating(), ratePerHour: 1 }).action, "idle");
  assert.equal(planThermostat({ now: at(19, 15), device: heating(), ratePerHour: 1 }).action, "idle");
});

test("heat-off: cooling and an already-off unit are left alone (and the day is marked done)", () => {
  assert.equal(planThermostat({ now: at(19, 7), device: dev(70, { power: true, mode: "COOL" }), ratePerHour: 1 }).action, "heat-off-skip");
  assert.equal(planThermostat({ now: at(19, 7), device: dev(64), ratePerHour: 1 }).action, "heat-off-skip");
});

test("heat-off: can be turned off, and away mode isn't affected", () => {
  assert.equal(planThermostat({ now: at(19, 7), device: heating(), ratePerHour: 1, opts: { heatOffTime: null } }).action, "idle");
  const awayP = planThermostat({ now: at(19, 7), device: heating(60), state: { away: true }, ratePerHour: 1 });
  assert.ok(!awayP.action.startsWith("heat-off"));
});

// --- Cooling model -----------------------------------------------------------

function cooling(start, k, { T0 = 64, tout = 30, hours = 6, extra = {} } = {}) {
  // Exact Newton's-law readings every 5 min, rounded like the unit's.
  return Array.from({ length: hours * 12 + 1 }, (_, i) => ({
    t: start.getTime() + i * 5 * 60 * 1000,
    power: false,
    mode: "HEAT",
    targetF: 64,
    outdoorF: tout,
    indoorF: Math.round(tout + (T0 - tout) * Math.exp(-k * (i / 12))),
    ...extra,
  }));
}

test("cooldowns: recovers k from an unheated stretch", () => {
  const runs = extractCooldowns(cooling(at(18, 8), 0.02));
  assert.equal(runs.length, 1);
  assert.ok(Math.abs(runs[0].k - 0.02) < 0.005, `k=${runs[0].k}`);
});

test("cooldowns: heating, short, warm-outside and gappy stretches don't count", () => {
  assert.equal(extractCooldowns(cooling(at(18, 8), 0.02, { extra: { power: true } })).length, 0);
  assert.equal(extractCooldowns(cooling(at(18, 8), 0.02, { hours: 2 })).length, 0, "under 3 hours");
  assert.equal(extractCooldowns(cooling(at(18, 8), 0.02, { tout: 60 })).length, 0, "outdoor too close to indoor");
  const gappy = cooling(at(18, 8), 0.02).filter((_, i) => i % 6 === 0); // 30-min spacing
  assert.equal(extractCooldowns(gappy).length, 0);
});

test("cooling model: prior until two cool-downs, then their weighted mean", () => {
  assert.equal(fitCoolingModel([]).kind, "default");
  assert.equal(fitCoolingModel([{ start: 0, end: 4 * 3600000, k: 0.02 }]).kind, "default");
  const m = fitCoolingModel([{ start: 0, end: 4 * 3600000, k: 0.02 }, { start: 0, end: 4 * 3600000, k: 0.04 }]);
  assert.equal(m.kind, "learned");
  assert.ok(Math.abs(m.k - 0.03) < 1e-9);
});

test("bank target: backwards Newton's law through a flat forecast matches the closed form", () => {
  const hourly = Array.from({ length: 72 }, (_, h) => ({ time: +at(19, 0) + h * 3600000, tempF: 30 }));
  const T0 = awayBankTarget({ hourly, from: at(19, 7), to: at(19, 23), k: 0.02, endF: 50 });
  assert.ok(Math.abs(T0 - (30 + 20 * Math.exp(0.02 * 16))) < 1e-9);
});

test("bank target: colder forecast or leakier house needs more banked", () => {
  const flat = (f) => Array.from({ length: 72 }, (_, h) => ({ time: +at(19, 0) + h * 3600000, tempF: f }));
  const args = { from: at(19, 7), to: at(19, 23), endF: 50 };
  assert.ok(awayBankTarget({ ...args, hourly: flat(10), k: 0.02 }) > awayBankTarget({ ...args, hourly: flat(30), k: 0.02 }));
  assert.ok(awayBankTarget({ ...args, hourly: flat(30), k: 0.03 }) > awayBankTarget({ ...args, hourly: flat(30), k: 0.02 }));
  // A warm day needs nothing beyond the end temperature.
  assert.ok(awayBankTarget({ ...args, hourly: flat(55), k: 0.02 }) < 50);
  // No forecast -> the fallback outdoor temperature.
  assert.equal(
    awayBankTarget({ ...args, hourly: [], k: 0.02, fallbackOutdoorF: 30 }),
    awayBankTarget({ ...args, hourly: flat(30), k: 0.02 })
  );
});

// --- Away mode -----------------------------------------------------------------

// A mild forecast with a tight house: bank target lands mid-50s, well under the 62 cap.
const MILD = Array.from({ length: 96 }, (_, h) => ({ time: +at(18, 0) + h * 3600000, tempF: 40 }));
const awayPlan = (now, indoorF, extra = {}, state = {}, more = {}) =>
  planThermostat({
    now,
    device: dev(indoorF, extra),
    state: { away: true, ...state },
    ratePerHour: 1,
    coolingK: 0.01,
    hourly: MILD,
    outdoorF: 40,
    ...more,
  });

test("away: bank target is what coasting the peak needs, with margin", () => {
  const p = awayPlan(at(19, 1), 52);
  // 40 + (50 - 40) * e^(0.0125 * 16) = 52.2 -> 53
  assert.equal(p.bankF, 53);
  assert.ok(Math.abs(p.requiredF - (40 + 10 * Math.exp(0.0125 * 16))) < 1e-9);
});

test("horizon: how far into the peak banked heat pays", () => {
  // Today's SC1V: 5.9c off, 20.2c on; prior k x safety = 0.0375.
  const h = bankHorizonHours({ prices: { offPeak: 0.059, onPeak: 0.2021 }, k: 0.0375, copRatio: 1.3 });
  assert.ok(Math.abs(h - Math.log(0.2021 / (0.059 * 1.3)) / 0.0375) < 1e-9);
  assert.ok(h > 16, "pays for the whole peak at today's prices");
  // A leaky house: banked heat is gone before it's needed late in the day.
  assert.ok(bankHorizonHours({ prices: { offPeak: 0.059, onPeak: 0.2021 }, k: 0.15 }) < 7);
  // No price gap -> nothing worth banking; no prices -> no limit.
  assert.equal(bankHorizonHours({ prices: { offPeak: 0.2, onPeak: 0.2 }, k: 0.03 }), 0);
  assert.equal(bankHorizonHours({ prices: null, k: 0.03 }), Infinity);
});

test("away: at today's prices it banks for the whole peak", () => {
  const prices = { offPeak: 0.059, onPeak: 0.2021 };
  const withPrices = awayPlan(at(19, 1), 52, {}, {}, { prices });
  const without = awayPlan(at(19, 1), 52);
  assert.equal(withPrices.bankF, without.bankF);
  assert.equal(withPrices.worthF, withPrices.requiredF);
});

test("away: when late-peak heat isn't worth banking, it banks less and leaves the rest to the guard", () => {
  // Leaky house, 40°F out: coasting the whole peak would need ~150°F (capped at
  // 70); heat needed after ~6.5h isn't worth banking, so it banks ~67°F.
  const cool = Array.from({ length: 96 }, (_, h) => ({ time: +at(18, 0) + h * 3600000, tempF: 40 }));
  const prices = { offPeak: 0.059, onPeak: 0.2021 };
  const leaky = { hourly: cool, coolingK: 0.12, outdoorF: 40 };
  const full = awayPlan(at(19, 1), 52, {}, {}, leaky);
  const priced = awayPlan(at(19, 1), 52, {}, {}, { ...leaky, prices });
  assert.ok(priced.horizonHours < 16);
  assert.ok(priced.worthF < priced.requiredF);
  assert.ok(priced.bankF < full.bankF, `${priced.bankF} vs ${full.bankF}`);
  // Never below the guard's off point even when nothing is worth banking.
  const flat = awayPlan(at(19, 1), 52, {}, {}, { ...leaky, prices: { offPeak: 0.2, onPeak: 0.2 } });
  assert.equal(flat.bankF, DEFAULTS.awayMinF + 3);
});

test("away: bank is capped, and never below the guard's off point", () => {
  const cold = Array.from({ length: 96 }, (_, h) => ({ time: +at(18, 0) + h * 3600000, tempF: 0 }));
  assert.equal(awayPlan(at(19, 1), 55, {}, {}, { hourly: cold, coolingK: 0.05 }).bankF, DEFAULTS.awayMaxBankF);
  const warm = Array.from({ length: 96 }, (_, h) => ({ time: +at(18, 0) + h * 3600000, tempF: 60 }));
  assert.equal(awayPlan(at(19, 1), 55, {}, {}, { hourly: warm }).bankF, DEFAULTS.awayMinF + 3);
});

test("away: banks off-peak from the start time, as late as the warm-up allows", () => {
  // Bank 53, from 50 at 1°F/h: 3h * 1.2 + 15min = 231 min before 07:00 -> 03:09.
  const before = awayPlan(at(19, 3), 50);
  assert.equal(before.action, "idle");
  assert.equal(hhmm(before.startAt), "03:09");
  const go = awayPlan(at(19, 3, 10), 50);
  assert.equal(go.action, "away-heat-on");
  assert.equal(go.run, "bank");
  assert.equal(go.setpointF, 60, "below the unit's 60°F floor -> heat toward 60, cut at the bank");
});

test("away: a bank above 60 uses the bank as the setpoint", () => {
  const cold = Array.from({ length: 96 }, (_, h) => ({ time: +at(18, 0) + h * 3600000, tempF: 20 }));
  const p = awayPlan(at(19, 6), 55, {}, {}, { hourly: cold, coolingK: 0.02 });
  assert.equal(p.action, "away-heat-on");
  assert.equal(p.setpointF, p.bankF);
  assert.ok(p.bankF > 60);
});

test("away: switches off once banked, holds the bank with 1°F hysteresis", () => {
  assert.equal(awayPlan(at(19, 5), 53, { power: true }, { awayHeating: true, awayRun: "bank" }).action, "away-heat-off");
  assert.equal(awayPlan(at(19, 5), 52, { power: true }, { awayHeating: true, awayRun: "bank" }).action, "idle", "still banking");
  // Dropped a degree after banking: top up, again as late as possible (1°F -> 05:33).
  assert.equal(awayPlan(at(19, 5), 52).action, "idle");
  assert.equal(awayPlan(at(19, 5, 35), 52).action, "away-heat-on");
  assert.equal(awayPlan(at(19, 6, 30), 53).action, "idle", "at the bank, off");
});

test("away: coasts through peak -- a bank run is cut at 07:00", () => {
  assert.equal(awayPlan(at(19, 7), 52, { power: true }, { awayHeating: true, awayRun: "bank" }).action, "away-heat-off");
  assert.equal(awayPlan(at(19, 14), 52).action, "idle");
  assert.equal(awayPlan(at(19, 14), 52, { power: true, mode: "COOL" }).action, "away-heat-off", "nothing else may run");
});

test("away: floor guard heats at 49 at any hour, until 51", () => {
  const p = awayPlan(at(19, 14), 49);
  assert.equal(p.action, "away-heat-on");
  assert.equal(p.run, "guard");
  assert.equal(p.setpointF, 60);
  assert.equal(awayPlan(at(19, 14), 50, { power: true }, { awayHeating: true, awayRun: "guard" }).action, "idle", "keeps going");
  assert.equal(awayPlan(at(19, 14), 51, { power: true }, { awayHeating: true, awayRun: "guard" }).action, "away-heat-off");
  assert.equal(awayPlan(at(19, 14), 50).action, "idle", "50 alone doesn't start one");
});

test("away: a guard run during the bank is taken over by the bank", () => {
  const p = awayPlan(at(19, 4, 30), 51, { power: true }, { awayHeating: true, awayRun: "guard" });
  assert.equal(p.action, "away-heat-on");
  assert.equal(p.run, "bank");
});

test("away: replaces a non-heat mode when the floor needs heat", () => {
  assert.equal(awayPlan(at(19, 14), 48, { power: true, mode: "COOL" }, { awayHeating: true }).action, "away-heat-on");
});

test("away: suppresses the overnight preheat, and no reading -> nothing", () => {
  assert.notEqual(awayPlan(at(19, 3), 60).action, "preheat");
  assert.equal(awayPlan(at(19, 3), null).action, "idle");
});

// --- Away: return time -------------------------------------------------------------

test("return: warms the house to 64 to arrive just as you do", () => {
  const back = { returnAt: at(19, 17).toISOString() };
  // From 60 at 1°F/h: 4h x 1.2 + 15min = 303 min before 17:00 -> 11:57.
  const before = awayPlan(at(19, 11, 55), 60, {}, back);
  assert.equal(before.action, "idle");
  assert.equal(hhmm(before.returnStartAt), "11:57");
  const go = awayPlan(at(19, 11, 57), 60, {}, back);
  assert.equal(go.action, "away-heat-on");
  assert.equal(go.run, "return");
  assert.equal(go.setpointF, 64);
});

test("return: a warm-up under way keeps going, and holds 64 once there", () => {
  const running = { returnAt: at(19, 17).toISOString(), awayHeating: true, awayRun: "return" };
  assert.equal(awayPlan(at(19, 13), 62, { power: true }, running).action, "idle", "start time moved later -- still warming");
  assert.equal(awayPlan(at(19, 16), 64, { power: true }, running).action, "idle", "at 64 -- the unit holds it");
  // Even at the floor, it isn't swapped for a guard run.
  assert.equal(awayPlan(at(19, 13), 49, { power: true }, running).action, "idle");
});

test("return: a due warm-up takes over a guard run, or starts from the floor", () => {
  const back = { returnAt: at(19, 17).toISOString() };
  const fromGuard = awayPlan(at(19, 14), 50, { power: true }, { ...back, awayHeating: true, awayRun: "guard" });
  assert.equal(fromGuard.run, "return");
  assert.equal(fromGuard.setpointF, 64);
  assert.equal(awayPlan(at(19, 14), 49, {}, back).run, "return");
});

test("return: at the return time, away mode ends", () => {
  const back = { returnAt: at(19, 17).toISOString() };
  assert.equal(awayPlan(at(19, 17), 64, { power: true }, back).action, "away-end");
  assert.equal(awayPlan(at(20, 3), null, {}, back).action, "away-end", "even with no reading, and late");
});

test("return: back in the coming peak -> bank enough to still be at 64 then", () => {
  const none = awayPlan(at(19, 1), 52);
  const back = awayPlan(at(19, 1), 52, {}, { returnAt: at(19, 17).toISOString() });
  // 40 + 24 x e^(0.0125 x 10) = 67.2 -> 68
  assert.ok(Math.abs(back.returnF - (40 + 24 * Math.exp(0.0125 * 10))) < 1e-9);
  assert.equal(back.bankF, 68);
  assert.ok(back.bankF > none.bankF);
  // 16°F at 1°F/h needs all night: it starts now, with 68 as the setpoint.
  assert.equal(none.action, "idle");
  assert.equal(back.action, "away-heat-on");
  assert.equal(back.run, "bank");
  assert.equal(back.setpointF, 68);
});

test("return: a bank for the return is capped like any other", () => {
  const cold = Array.from({ length: 96 }, (_, h) => ({ time: +at(18, 0) + h * 3600000, tempF: 0 }));
  const p = awayPlan(at(19, 1), 52, {}, { returnAt: at(19, 22).toISOString() }, { hourly: cold, coolingK: 0.03 });
  assert.equal(p.bankF, DEFAULTS.awayMaxBankF);
});

test("return: when it isn't worth banking that far ahead, the warm-up does it on the day", () => {
  // Leaky house: heat banked at 07:00 is mostly gone by 21:00.
  const leaky = { coolingK: 0.12, prices: { offPeak: 0.059, onPeak: 0.2021 } };
  const late = awayPlan(at(19, 1), 52, {}, { returnAt: at(19, 21).toISOString() }, leaky);
  assert.ok(late.horizonHours < 14);
  assert.ok(late.bankF < Math.ceil(late.returnF), `${late.bankF} vs ${late.returnF}`);
});

test("return: back during tonight's off-peak -> no bank, just the warm-up", () => {
  const p = awayPlan(at(19, 0, 30), 52, {}, { returnAt: at(19, 5).toISOString() });
  assert.equal(p.bankF, null);
  assert.equal(p.action, "away-heat-on", "12°F at 1°F/h needs well over 4.5h -- start now");
  assert.equal(p.run, "return");
  const later = awayPlan(at(18, 14), 60, {}, { returnAt: at(18, 22).toISOString() });
  assert.equal(later.bankF, null, "back this evening, before tonight's window");
  assert.equal(later.action, "idle");
  assert.match(later.reason, /warm-up for your return/);
});

test("return: days away -> tonight's bank is the usual one", () => {
  const none = awayPlan(at(19, 1), 52);
  const far = awayPlan(at(19, 1), 52, {}, { returnAt: at(23, 17).toISOString() });
  assert.equal(far.bankF, none.bankF);
  assert.equal(far.requiredF, none.requiredF);
  assert.equal(far.action, none.action);
});

test("return: the time must be real, in the future, and within 90 days", () => {
  const now = at(19, 12);
  assert.equal(+parseReturnAt(at(20, 17).toISOString(), now), +at(20, 17));
  assert.throws(() => parseReturnAt("next tuesday", now), /date and time/);
  assert.throws(() => parseReturnAt(null, now), /date and time/);
  assert.throws(() => parseReturnAt(at(19, 11).toISOString(), now), /future/);
  assert.throws(() => parseReturnAt(new Date(+now + 91 * 86400000).toISOString(), now), /90 days/);
});

// --- Bad readings ------------------------------------------------------------------

// Readings 5 minutes apart starting 02:06 on the 19th, as the unit reported them.
const seq = (temps, extra = {}) => temps.map((indoorF, i) => ({ t: +at(19, 2, 6) + i * 5 * 60000, power: true, mode: "HEAT", indoorF, targetF: 64, ...extra }));
const kept = (samples) => trustedSamples(samples).map((s) => s.indoorF);

test("readings: the defrost blips seen on the Pi are dropped", () => {
  assert.deepEqual(kept(seq([64, 64, 64, 36, 37, 63, 64])), [64, 64, 64, 63, 64]);
  assert.deepEqual(kept(seq([65, 65, 64, 32, 57, 64, 65])), [65, 65, 64, 64, 65], "the half-recovered 57 too");
  assert.deepEqual(kept(seq([55, 55, 56, 47, 56, 56, 57])), [55, 55, 56, 56, 56, 57]);
});

test("readings: the real drop after a run stops, and rises, are kept", () => {
  assert.deepEqual(kept(seq([57, 56, 55, 56, 55], { power: false })), [57, 56, 55, 56, 55]);
  assert.deepEqual(kept(seq([50, 55, 60])), [50, 55, 60]);
});

test("readings: a drop that lasts half an hour is believed", () => {
  const s = seq([60, 52, 52, 52, 52, 52, 52, 52, 52], { power: false });
  // 52 at +5..+30 min after the trusted 60: dropped until it's 30 min on.
  assert.deepEqual(kept(s), [60, 52, 52, 52]);
  // ...and after a gap of half an hour (a restart), the first reading counts.
  const gap = [{ t: +at(19, 1), indoorF: 60 }, { t: +at(19, 2), indoorF: 52 }];
  assert.deepEqual(kept(gap), [60, 52]);
});

test("readings: samples without a reading pass through", () => {
  assert.deepEqual(kept(seq([60, null, 59])), [60, null, 59]);
});

test("readings: a blip at the end of a warm-up doesn't spoil the learned rate", () => {
  // 53 -> 57 over an hour, then a defrost blip on the last sample before switch-off.
  const s = seq([53, 54, 54, 55, 55, 55, 56, 56, 56, 56, 57, 57, 47], { targetF: 60 });
  s.push({ ...s[s.length - 1], t: s[s.length - 1].t + 5 * 60000, power: false, indoorF: 57 });
  const raw = extractWarmups(s);
  const clean = extractWarmups(trustedSamples(s));
  assert.ok(raw[0].ratePerHour < 0, "the blip reads as the house cooling while heating");
  assert.ok(Math.abs(clean[0].ratePerHour - 4 / (55 / 60)) < 1e-9);
});

// --- Room sensor ---------------------------------------------------------------------

// As the hub lists them (trimmed): the bedroom ALPSTUGA, and the office one that dropped off.
const bedroom = { id: "52f9_1", deviceType: "environmentSensor", isReachable: true, lastSeen: "2026-11-24T23:49:44.000Z", room: { name: "Primary Bedroom" },
  attributes: { customName: "Primary bedroom Air Quali", model: "ALPSTUGA air quality monitor", currentTemperature: 11.550000190734863, currentRH: 44 } };
const office = { id: "1649_1", deviceType: "environmentSensor", isReachable: false, lastSeen: "2026-11-19T13:49:28.000Z", room: { name: "Office" },
  attributes: { customName: "Office Air Quality", currentTemperature: 17.58 } };
const noTemp = { id: "x", room: { name: "Primary Bedroom" }, attributes: { customName: "Bedroom purifier" } };

test("room sensor: found by room or by name, exact before partial, and only with a temperature", () => {
  assert.equal(findRoomSensor([noTemp, office, bedroom], "Primary Bedroom"), bedroom);
  assert.equal(findRoomSensor([office, bedroom], "primary bedroom air quali"), bedroom);
  assert.equal(findRoomSensor([office, bedroom], "office"), office);
  assert.equal(findRoomSensor([office, bedroom], "bedroom"), bedroom, "partial");
  assert.equal(findRoomSensor([office, bedroom], "Kitchen"), null);
  assert.equal(findRoomSensor([office, bedroom], ""), null);
});

test("room sensor: °C to °F to a tenth, while it's fresh and reachable", () => {
  const now = new Date("2026-11-24T23:52:00.000Z");
  assert.deepEqual(roomSensorF(bedroom, now), { indoorF: 52.8, at: bedroom.lastSeen });
  assert.match(roomSensorF(office, now).error, /not reachable/);
  assert.match(roomSensorF({ ...bedroom, lastSeen: "2026-11-24T23:00:00.000Z" }, now).error, /52 min ago/);
  assert.match(roomSensorF(noTemp, now).error, /no temperature/);
  assert.match(roomSensorF(null, now).error, /not found/);
});

test("room sensor: learning never mixes the two sensors", () => {
  // A warm-up whose reading switches from the unit's sensor to the room's halfway.
  // Ten minutes apart, so each half is long enough to count on its own.
  const s = seq([53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64], { targetF: 64 })
    .map((x, i) => ({ ...x, t: +at(19, 2) + i * 10 * 60000, ...(i >= 6 ? { indoorSource: "room" } : {}) }));
  assert.deepEqual(extractWarmups(s).map((r) => [r.startF, r.endF]), [[53, 58], [59, 64]], "two runs, not one 53 -> 64");
  // ...and a switch to a sensor reading 4°F lower isn't a bad reading.
  const switched = [{ t: +at(19, 1), indoorF: 56 }, { t: +at(19, 1, 5), indoorF: 52, indoorSource: "room" }];
  assert.deepEqual(kept(switched), [56, 52]);
  // Cool-downs split the same way.
  const cool = Array.from({ length: 48 }, (_, i) => ({ t: +at(19, 8) + i * 5 * 60000, power: false, indoorF: 60 - i * 0.1, outdoorF: 30, ...(i >= 24 ? { indoorSource: "room" } : {}) }));
  const cd = extractCooldowns(cool, { minDropF: 1, minMinutes: 60 });
  assert.equal(cd.length, 2);
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
