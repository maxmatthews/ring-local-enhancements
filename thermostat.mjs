/**
 * Decision logic for the LG ThinQ "Central Air" thermostat.
 *
 * Pure and I/O-free, same as govee-lights.mjs: index.mjs feeds it the clock,
 * the unit's state, the outdoor temperature and the sample history, and
 * carries out what it returns. test-thermostat.mjs drives it directly.
 *
 * Two jobs:
 *
 *   Overnight preheat (VTOU). Power is cheap from the off-peak start (23:00)
 *   to the off-peak end (07:00). The house should reach the target (64°F) just
 *   before the end -- not hours early, which wastes heat leaking out of a warm
 *   house, and not late, which spills heating into the peak. The start time is
 *   worked back from how fast the house warms, learned from past heating runs
 *   at similar outdoor temperatures.
 *
 *   Away mode. Keeps the house above 48°F while buying as much of the heat as
 *   possible off-peak. Each night it banks heat: it works out how warm the
 *   house has to be at the end of off-peak to coast through the whole peak
 *   period above the floor -- from tomorrow's forecast and how fast the house
 *   loses heat, learned from the history -- and heats to that as late in the
 *   window as the warm-up rate allows. Through the peak the unit stays off,
 *   except for a floor guard that heats at any hour if the house gets close
 *   to 48. The unit's lowest heat setpoint is 60°F, so a bank target below
 *   that is reached by heating toward 60 and switching off on arrival.
 *
 * Temperatures are °F. Times are local.
 */

import { timeOnDay, localDateKey } from "./govee-lights.mjs";

const MS_PER_HOUR = 60 * 60 * 1000;

export const DEFAULTS = {
  targetF: 64,
  windowStart: "23:00",
  windowEnd: "07:00",
  /** Heat off at this time each morning (home mode). null = never. */
  heatOffTime: "07:00",
  /** A service that was down at heatOffTime still switches off if back within this. */
  heatOffGraceMinutes: 60,
  /**
   * Prior for a slow ducted heat pump, used until runs are learned: this rate
   * at refOutdoorF, falling by priorSlope °F/h for each °F colder outside.
   * Deliberately pessimistic, so the first nights start early, not late.
   */
  defaultRatePerHour: 1.0,
  refOutdoorF: 35,
  priorSlope: 0.03,
  /** Multiplier on the predicted warm-up time, then a fixed cushion on top. */
  safety: 1.2,
  marginMinutes: 15,
  minRatePerHour: 0.25,
  maxRatePerHour: 8,

  /** Away: the house never goes below this. */
  awayMinF: 48,
  /** Away: the bank aims to still be this far above the floor when peak ends. */
  awayMarginF: 2,
  /**
   * Away: never bank above this, however cold the forecast. The empty house
   * needs no comfort limit; what really bounds the bank is how far the heat
   * pump gets overnight, and the price check below.
   */
  awayMaxBankF: 70,
  /**
   * Away: electricity per unit of heat at night relative to the afternoon --
   * a heat pump is less efficient in the colder night air. Feeds the price
   * check on how far into the peak banked heat still pays.
   */
  awayCopRatio: 1.3,
  /**
   * Heat loss, Newton's law: dT/dt = -k (indoor - outdoor), k per hour. The
   * prior (a ~33-hour time constant) is used until cool-downs are learned; it
   * leans leaky, so early nights bank more, not less. coolingSafety scales k
   * up on top of that.
   */
  defaultCoolingK: 0.03,
  coolingSafety: 1.25,
  minCoolingK: 0.005,
  maxCoolingK: 0.2,

  /**
   * Indoor readings this far below the last trusted one are defrost blips,
   * not the house -- unless they last indoorConfirmMinutes. See trustedSamples().
   */
  maxIndoorDropF: 3,
  indoorConfirmMinutes: 30,

  /** A room sensor not heard from in this long is ignored for the unit's own reading. */
  roomSensorMaxAgeMinutes: 30,
};

// --- Room sensor -----------------------------------------------------------------

/**
 * Which reading a sample's indoorF came from: "room" (a Dirigera sensor) or
 * "unit" (the heat pump's own). Samples from before room sensors are "unit".
 * The two sit a degree or two apart, so a warm-up, cool-down or bad-reading
 * check never spans a switch between them.
 */
export const indoorSource = (s) => s.indoorSource || "unit";

/**
 * The Dirigera environment sensor called `want`: by its name or its room's,
 * ignoring case, an exact match before a partial one. Only sensors that
 * report a temperature count (an air purifier's sensor may not).
 */
export function findRoomSensor(sensors, want) {
  const w = String(want || "").trim().toLowerCase();
  if (!w) return null;
  const withTemp = (sensors || []).filter((d) => Number.isFinite(d?.attributes?.currentTemperature));
  const names = (d) => [d.attributes.customName, d.room?.name].filter(Boolean).map((n) => n.toLowerCase());
  return withTemp.find((d) => names(d).includes(w)) || withTemp.find((d) => names(d).some((n) => n.includes(w))) || null;
}

/**
 * A room sensor's temperature in °F (to 0.1), or why it can't be used: not
 * reachable, no reading, or not heard from in maxAgeMinutes.
 *
 * @returns {{indoorF: number, at: string} | {error: string}}
 */
export function roomSensorF(sensor, now = new Date(), { maxAgeMinutes = DEFAULTS.roomSensorMaxAgeMinutes } = {}) {
  if (!sensor) return { error: "sensor not found" };
  const c = sensor.attributes?.currentTemperature;
  if (!Number.isFinite(c)) return { error: "no temperature reading" };
  if (sensor.isReachable === false) return { error: "not reachable" };
  const seen = Date.parse(sensor.lastSeen);
  if (!Number.isFinite(seen)) return { error: "no last-seen time" };
  const ageMin = (+now - seen) / 60000;
  if (ageMin > maxAgeMinutes) return { error: `last heard from ${Math.round(ageMin)} min ago` };
  return { indoorF: Math.round((c * 9) / 5 * 10 + 320) / 10, at: sensor.lastSeen };
}

// --- Off-peak window ---------------------------------------------------------

/**
 * The off-peak window `now` falls in, or the next one. The window may cross
 * midnight (23:00 -> 07:00). `key` is the local date the window ends on, which
 * names that night's preheat.
 */
export function offPeakWindow(now, windowStart = DEFAULTS.windowStart, windowEnd = DEFAULTS.windowEnd) {
  let end = timeOnDay(now, windowEnd);
  if (now >= end) end = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1, end.getHours(), end.getMinutes());
  let start = new Date(end.getFullYear(), end.getMonth(), end.getDate(), ...hm(windowStart));
  if (start >= end) start = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1, start.getHours(), start.getMinutes());
  return { start, end, key: localDateKey(end), inWindow: now >= start && now < end };
}

function hm(hhmm) {
  const d = timeOnDay(new Date(2000, 0, 1), hhmm); // validates the format
  return [d.getHours(), d.getMinutes()];
}

// --- Bad readings --------------------------------------------------------------

/**
 * Drop indoor readings that can't be real.
 *
 * While it heats in cold weather the unit now and then reports the house
 * 9-30°F colder for 5-10 minutes (36, 37, then 63; 64, 32, 57, then 64) --
 * most likely the sensor catching cold air during a defrost cycle. A house
 * can't lose heat that fast: the real drop right after a run stops is a degree
 * or two. So a reading more than maxDropF below the last trusted one is
 * dropped, unless the house is still reading that low confirmMs later (a door
 * left open in January), and then it's believed. Rises are always believed:
 * the air warms fast while the unit runs.
 *
 * A switch between the room sensor and the unit's own reading starts afresh.
 * Samples without a reading pass through unchanged. Returns a new array; the
 * history on disk keeps every raw reading.
 *
 * @param {Array<{t: string|number, indoorF: number}>} samples  oldest first
 */
export function trustedSamples(samples, { maxDropF = DEFAULTS.maxIndoorDropF, confirmMs = DEFAULTS.indoorConfirmMinutes * 60 * 1000 } = {}) {
  const out = [];
  let trusted = null;
  for (const s of samples) {
    if (!Number.isFinite(s.indoorF)) {
      out.push(s);
      continue;
    }
    if (trusted && indoorSource(trusted) === indoorSource(s) && trusted.indoorF - s.indoorF > maxDropF && time(s) - time(trusted) < confirmMs) continue;
    trusted = s;
    out.push(s);
  }
  return out;
}

// --- Learning the warm-up rate -----------------------------------------------

/**
 * Pull heating runs out of the sample history.
 *
 * A run is a stretch of consecutive samples with the unit on in HEAT, starting
 * below its setpoint. It ends at the first sample at or above the setpoint, or
 * where the unit is switched off, changes mode or setpoint, the indoor reading
 * switches sensor, or the samples have a gap. Short runs and runs that barely needed to lift are dropped: readings
 * are whole degrees, so they say little.
 *
 * Every heating run counts, not just our preheats -- a run you started by hand
 * on a cold afternoon is just as good a measurement.
 *
 * @param {Array<{t: string|number, indoorF: number, targetF: number, power: boolean, mode: string, outdoorF?: number}>} samples  oldest first
 * @returns {Array<{start: number, end: number, startF: number, endF: number, outdoorF: number|null, ratePerHour: number}>}
 */
export function extractWarmups(samples, { maxGapMs = 20 * 60 * 1000, minMinutes = 30, minLiftF = 2 } = {}) {
  const runs = [];
  let run = null;

  const close = (last) => {
    if (!run || !last) return;
    const hours = (time(last) - time(run.first)) / MS_PER_HOUR;
    if (hours * 60 >= minMinutes && run.first.targetF - run.first.indoorF >= minLiftF) {
      const outs = run.samples.map((s) => s.outdoorF).filter(Number.isFinite);
      runs.push({
        start: time(run.first),
        end: time(last),
        startF: run.first.indoorF,
        endF: last.indoorF,
        outdoorF: outs.length ? outs.reduce((a, b) => a + b, 0) / outs.length : null,
        ratePerHour: (last.indoorF - run.first.indoorF) / hours,
      });
    }
    run = null;
  };

  const heating = (s) => s.power && s.mode === "HEAT" && Number.isFinite(s.indoorF) && Number.isFinite(s.targetF);

  for (const s of samples) {
    if (run) {
      const prev = run.samples[run.samples.length - 1];
      if (!heating(s) || s.targetF !== run.first.targetF || indoorSource(s) !== indoorSource(run.first) || time(s) - time(prev) > maxGapMs) {
        close(prev);
      } else {
        run.samples.push(s);
        if (s.indoorF >= s.targetF) close(s);
        continue;
      }
    }
    if (heating(s) && s.indoorF < s.targetF) run = { first: s, samples: [s] };
  }
  // A run still in progress is left out; it is counted once it finishes.
  return runs;
}

const time = (s) => (typeof s.t === "number" ? s.t : Date.parse(s.t));

/**
 * Fit warm-up rate (°F/hour) against outdoor temperature.
 *
 * A heat pump's warm-up depends heavily on the outdoor temperature, so every
 * model here slopes with it:
 *
 *   - linear: enough runs spread over a range of outdoor temperatures -- a
 *     duration-weighted least-squares line.
 *   - mean:   a few runs, or all at similar temperatures -- their weighted mean
 *     rate, slid along the prior slope to tonight's outdoor temperature. Runs
 *     learned at 40°F say little about a 10°F night on their own.
 *   - default: no runs yet -- the prior.
 *
 * Predictions are clamped to a sane range.
 *
 * @returns {{kind: "default"|"mean"|"linear", n: number, rateAt: (outdoorF: number|null) => number, describe: string}}
 */
export function fitWarmupModel(runs, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const clamp = (r) => Math.min(o.maxRatePerHour, Math.max(o.minRatePerHour, r));
  const usable = runs.filter((r) => Number.isFinite(r.ratePerHour)).slice(-(o.maxRuns ?? 60));
  // Along the prior slope from a known (outdoor, rate) point. No forecast = the point itself.
  const slide = (rate, atF) => (out) => clamp(Number.isFinite(out) && Number.isFinite(atF) ? rate + o.priorSlope * (out - atF) : rate);

  if (!usable.length) {
    return {
      kind: "default",
      n: 0,
      rateAt: slide(o.defaultRatePerHour, o.refOutdoorF),
      describe: `prior ${o.defaultRatePerHour}°F/h at ${o.refOutdoorF}°F outside, ${o.priorSlope}°F/h per °F`,
    };
  }

  const weight = (r) => (r.end - r.start) / MS_PER_HOUR;
  const totalW = usable.reduce((a, r) => a + weight(r), 0);
  const mean = usable.reduce((a, r) => a + r.ratePerHour * weight(r), 0) / totalW;
  const outW = usable.filter((r) => Number.isFinite(r.outdoorF));
  const meanOut = outW.length
    ? outW.reduce((a, r) => a + r.outdoorF * weight(r), 0) / outW.reduce((a, r) => a + weight(r), 0)
    : null;

  const withOut = usable.filter((r) => Number.isFinite(r.outdoorF));
  if (withOut.length >= (o.minRunsForLinear ?? 4)) {
    const xs = withOut.map((r) => r.outdoorF);
    const spread = Math.max(...xs) - Math.min(...xs);
    if (spread >= (o.minOutdoorSpreadF ?? 8)) {
      const w = withOut.map(weight);
      const sw = w.reduce((a, b) => a + b, 0);
      const mx = withOut.reduce((a, r, i) => a + w[i] * r.outdoorF, 0) / sw;
      const my = withOut.reduce((a, r, i) => a + w[i] * r.ratePerHour, 0) / sw;
      const sxx = withOut.reduce((a, r, i) => a + w[i] * (r.outdoorF - mx) ** 2, 0);
      const sxy = withOut.reduce((a, r, i) => a + w[i] * (r.outdoorF - mx) * (r.ratePerHour - my), 0);
      const slope = sxy / sxx;
      // A negative slope (warms faster when colder) is noise, not physics.
      if (slope > 0) {
        const icpt = my - slope * mx;
        return {
          kind: "linear",
          n: withOut.length,
          rateAt: (out) => clamp(Number.isFinite(out) ? icpt + slope * out : my),
          describe: `${icpt.toFixed(2)} + ${slope.toFixed(3)}×outdoor °F/h from ${withOut.length} runs`,
        };
      }
    }
  }
  return {
    kind: "mean",
    n: usable.length,
    rateAt: slide(mean, meanOut),
    describe: `mean ${mean.toFixed(2)}°F/h${meanOut != null ? ` at ${meanOut.toFixed(0)}°F outside` : ""} from ${usable.length} runs`,
  };
}

// --- Learning how fast the house cools ----------------------------------------

/**
 * Pull cool-downs out of the sample history: stretches of 3+ hours with the
 * unit off, the outdoor temperature known and well below indoor, and a drop of
 * at least 2°F (readings are whole degrees). Each gives a Newton's-law k:
 *
 *   k = ln((T0 - Tout) / (T1 - Tout)) / hours,  Tout = mean outdoor
 *
 * Daytime stretches include some solar gain, which reads as a slower loss.
 * That errs toward banking too little, which the floor guard covers.
 */
export function extractCooldowns(samples, { maxGapMs = 20 * 60 * 1000, minMinutes = 180, minDropF = 2, minDeltaF = 8 } = {}) {
  const runs = [];
  let seg = [];
  const usable = (s) => !s.power && Number.isFinite(s.indoorF) && Number.isFinite(s.outdoorF) && s.indoorF - s.outdoorF >= minDeltaF;

  const close = () => {
    if (seg.length >= 2) {
      const a = seg[0];
      const b = seg[seg.length - 1];
      const hours = (time(b) - time(a)) / MS_PER_HOUR;
      const tout = seg.reduce((acc, s) => acc + s.outdoorF, 0) / seg.length;
      if (hours * 60 >= minMinutes && a.indoorF - b.indoorF >= minDropF && b.indoorF - tout > 1) {
        runs.push({ start: time(a), end: time(b), startF: a.indoorF, endF: b.indoorF, outdoorF: tout, k: Math.log((a.indoorF - tout) / (b.indoorF - tout)) / hours });
      }
    }
    seg = [];
  };

  for (const s of samples) {
    const prev = seg[seg.length - 1];
    if (!usable(s) || (prev && (time(s) - time(prev) > maxGapMs || indoorSource(s) !== indoorSource(prev)))) close();
    if (usable(s)) seg.push(s);
  }
  close();
  return runs;
}

/** Duration-weighted mean k of the learned cool-downs, or the prior until there are two. */
export function fitCoolingModel(runs, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const clamp = (k) => Math.min(o.maxCoolingK, Math.max(o.minCoolingK, k));
  const usable = runs.filter((r) => Number.isFinite(r.k) && r.k > 0).slice(-(o.maxRuns ?? 60));
  if (usable.length < 2) {
    return { kind: "default", n: usable.length, k: clamp(o.defaultCoolingK), describe: `prior k=${o.defaultCoolingK}/h (~${Math.round(1 / o.defaultCoolingK)}h time constant)` };
  }
  const w = (r) => (r.end - r.start) / MS_PER_HOUR;
  const k = clamp(usable.reduce((a, r) => a + r.k * w(r), 0) / usable.reduce((a, r) => a + w(r), 0));
  return { kind: "learned", n: usable.length, k, describe: `k=${k.toFixed(3)}/h (~${Math.round(1 / k)}h time constant) from ${usable.length} cool-downs` };
}

/** Forecast temperature at time t: the nearest hour, else the fallback. */
function outdoorAt(hourly, t, fallbackF) {
  if (!hourly?.length) return fallbackF;
  let best = null;
  for (const h of hourly) {
    if (!Number.isFinite(h.tempF)) continue;
    if (!best || Math.abs(+new Date(h.time) - t) < Math.abs(+new Date(best.time) - t)) best = h;
  }
  // A forecast that doesn't reach this far is no forecast for it.
  return best && Math.abs(+new Date(best.time) - t) <= 3 * MS_PER_HOUR ? best.tempF : fallbackF;
}

/**
 * How many hours into the peak banked heat still pays.
 *
 * A degree banked at the end of off-peak costs offPeak x copRatio (night heat
 * takes more electricity per degree). If it's needed h hours into the peak,
 * only e^(-k h) of it is still in the house -- the rest leaked out -- and that
 * remainder saves the guard buying it at onPeak. So banking for hour h pays
 * while e^(-k h) x onPeak > offPeak x copRatio:
 *
 *   h* = ln(onPeak / (offPeak x copRatio)) / k
 *
 * Infinity without prices (then the whole peak is banked for, as before);
 * 0 when off-peak heat is no cheaper at all.
 */
export function bankHorizonHours({ prices, k, copRatio = DEFAULTS.awayCopRatio }) {
  if (!prices || !(prices.offPeak > 0) || !(prices.onPeak > 0) || !(k > 0)) return Infinity;
  return Math.max(0, Math.log(prices.onPeak / (prices.offPeak * copRatio)) / k);
}

/**
 * How warm the house must be at `from` to still be `endF` at `to` with the
 * unit off: Newton's law run backwards, an hour at a time, through the hourly
 * forecast. Hours the forecast doesn't cover use fallbackOutdoorF.
 */
export function awayBankTarget({ hourly, from, to, k, endF, fallbackOutdoorF = DEFAULTS.refOutdoorF }) {
  let T = endF;
  for (let t = +to; t > +from; ) {
    const step = Math.min(MS_PER_HOUR, t - +from);
    const tout = outdoorAt(hourly, t - step / 2, fallbackOutdoorF);
    T = tout + (T - tout) * Math.exp((k * step) / MS_PER_HOUR);
    t -= step;
  }
  return T;
}

// --- Preheat -----------------------------------------------------------------

/**
 * When tonight's preheat should start.
 *
 * Uses the house's temperature now. As the house keeps cooling the answer moves
 * earlier, and since the tick re-asks every few minutes and starts as soon as
 * now >= startAt, that drift is self-correcting. Never earlier than the window
 * start: heat before then is peak-priced.
 *
 * `latestStart` ("HH:MM") caps how late it may start. index.mjs passes it only
 * while nothing has been learned yet, so the first nights start no later than
 * the hand-picked time that's known to work; after that the model decides.
 */
export function preheatStart({
  indoorF,
  ratePerHour,
  window,
  targetF = DEFAULTS.targetF,
  safety = DEFAULTS.safety,
  marginMinutes = DEFAULTS.marginMinutes,
  latestStart = null,
}) {
  const lift = Math.max(0, targetF - indoorF);
  const minutesNeeded = (lift / ratePerHour) * 60 * safety + marginMinutes;
  let startAt = new Date(window.end.getTime() - minutesNeeded * 60 * 1000);
  let capped = false;
  if (latestStart) {
    // The cap's occurrence inside this window: on the end's day, or the start's day for a pre-midnight time.
    let cap = new Date(window.end.getFullYear(), window.end.getMonth(), window.end.getDate(), ...hm(latestStart));
    if (cap >= window.end) cap = new Date(window.start.getFullYear(), window.start.getMonth(), window.start.getDate(), ...hm(latestStart));
    if (cap >= window.start && cap < window.end && cap < startAt) {
      startAt = cap;
      capped = true;
    }
  }
  const clamped = startAt < window.start;
  return { startAt: clamped ? window.start : startAt, minutesNeeded, clamped, capped };
}

/**
 * Decide what the periodic tick should do.
 *
 * `device` is summarizeAcState()'s output. `state` is the persisted
 * { preheatKey, away, awayHeating, awayRun }. `coolingK`, `hourly` (the
 * forecast), `outdoorF` and `prices` ({offPeak, onPeak} $/kWh) only matter in
 * away mode.
 *
 * Preheat fires once per night (state.preheatKey = that night's window key),
 * so changing the thermostat by hand after it starts sticks, and a restart
 * mid-preheat doesn't re-send anything.
 *
 * Heat-off fires once a day too (state.heatOffKey = that day's date).
 *
 * In away mode `state.returnAt` (ISO) is when you'll be back; see planAway().
 *
 * @returns {{action: "idle"|"preheat"|"preheat-skip"|"heat-off"|"heat-off-skip"|"away-heat-on"|"away-heat-off"|"away-end", reason: string,
 *   startAt?: Date, minutesNeeded?: number, key?: string, run?: "bank"|"guard"|"return", setpointF?: number, bankF?: number|null,
 *   requiredF?: number, returnAt?: Date|null, returnStartAt?: Date|null, returnF?: number|null}}
 */
export function planThermostat({
  now,
  device,
  state = {},
  ratePerHour,
  coolingK = DEFAULTS.defaultCoolingK,
  hourly = [],
  outdoorF = null,
  prices = null,
  opts = {},
}) {
  const o = { ...DEFAULTS, ...opts };

  if (state.away) return planAway({ now, device, state, ratePerHour, coolingK, hourly, outdoorF, prices, o });

  // Morning heat-off: once a day at heatOffTime, peak power starts. Only heat --
  // cooling is left alone -- and only within the grace period, so a restart in
  // the afternoon never switches off heat you turned on yourself.
  if (o.heatOffTime) {
    const offAt = timeOnDay(now, o.heatOffTime);
    const key = localDateKey(now);
    if (now >= offAt && +now - +offAt < o.heatOffGraceMinutes * 60 * 1000 && state.heatOffKey !== key) {
      if (device?.power && device.mode === "HEAT") {
        return { action: "heat-off", key, reason: `${o.heatOffTime} -- peak power starts, heat off (${device.indoorF ?? "?"}°F)` };
      }
      return { action: "heat-off-skip", key, reason: `${o.heatOffTime} -- ${device?.power ? `unit is in ${device.mode}, left alone` : "already off"}` };
    }
  }

  const window = offPeakWindow(now, o.windowStart, o.windowEnd);
  if (!window.inWindow) return { action: "idle", reason: "outside the off-peak window" };
  if (state.preheatKey === window.key) return { action: "idle", reason: "tonight's preheat already handled" };
  if (!Number.isFinite(device?.indoorF)) return { action: "idle", reason: "no indoor reading" };

  const { startAt, minutesNeeded, capped } = preheatStart({ indoorF: device.indoorF, ratePerHour, window, ...o });
  if (now < startAt) return { action: "idle", reason: "waiting for the preheat start", startAt, minutesNeeded, key: window.key };

  const alreadyHeating = device.power && device.mode === "HEAT" && device.targetF >= o.targetF;
  if (device.indoorF >= o.targetF || alreadyHeating) {
    return {
      action: "preheat-skip",
      reason: alreadyHeating ? `already heating to ${device.targetF}°F` : `already ${device.indoorF}°F`,
      startAt,
      minutesNeeded,
      key: window.key,
    };
  }
  return {
    action: "preheat",
    reason: `${device.indoorF}°F -> ${o.targetF}°F by ${o.windowEnd}${capped ? ` (starting at the ${o.latestStart} cap until warm-ups are learned)` : ""}`,
    startAt,
    minutesNeeded,
    key: window.key,
  };
}

/**
 * Away mode, in priority order:
 *
 *   1. Floor guard (any hour): at awayMinF + 1 or below, heat until
 *      awayMinF + 3. Readings are whole degrees, so this is what keeps the
 *      house from going under awayMinF.
 *   2. Bank (off-peak, from the start time): heat to bankF and hold it there
 *      until off-peak ends. bankF is enough to coast through the coming peak
 *      and end it awayMarginF above the floor -- or, when prices say heat
 *      needed late in the peak isn't worth buying early (bankHorizonHours),
 *      enough to coast that far; the guard covers the rest. Capped at
 *      awayMaxBankF.
 *   3. Coast (peak, and off-peak before the start time): the unit stays off.
 *      Anything running that isn't an unfinished guard run is switched off.
 *
 * With a return time (state.returnAt) set:
 *
 *   - Warm-up for your return comes first: the house is heated to targetF
 *     (64°F) to arrive just as you do, timed like the preheat, and held there.
 *   - The bank also aims to have the house at targetF when you get back, if
 *     that's in the coming peak and banking that far still pays -- so
 *     the warm-up before you arrive is a top-up, not a peak-priced climb
 *     from the floor. Back during or before tonight's off-peak, no bank.
 *   - At the return time away mode ends ("away-end"), leaving the heat on at
 *     targetF. Home mode takes over from there.
 *
 * It owns the unit while away. With no reading it does nothing rather than guess.
 */
function planAway({ now, device, state, ratePerHour, coolingK, hourly, outdoorF, prices, o }) {
  const back = state.returnAt && Number.isFinite(Date.parse(state.returnAt)) ? new Date(state.returnAt) : null;
  if (back && now >= back) {
    return { action: "away-end", returnAt: back, reason: `away: back as of ${fmtLocal(back)} -- away mode off, heat on at ${o.targetF}°F` };
  }

  const T = device?.indoorF;
  if (!Number.isFinite(T)) return { action: "idle", returnAt: back, reason: "away: no indoor reading" };

  const heatingNow = device.power && device.mode === "HEAT";
  const ours = heatingNow && !!state.awayHeating;
  const run = ours ? state.awayRun || "guard" : null;
  const guardOn = o.awayMinF + 1;
  const guardOff = o.awayMinF + 3;
  const setpoint = (f) => Math.min(86, Math.max(device.minTargetF ?? 60, Math.ceil(f)));

  // The window we're in, or the next one; the peak it has to carry the house through follows it.
  const window = offPeakWindow(now, o.windowStart, o.windowEnd);
  const peakEnd = offPeakWindow(window.end, o.windowStart, o.windowEnd).start;
  const k = coolingK * o.coolingSafety;
  const coastTo = (to, endF) =>
    awayBankTarget({
      hourly,
      from: window.end,
      to,
      k,
      endF,
      fallbackOutdoorF: Number.isFinite(outdoorF) ? outdoorF : o.refOutdoorF,
    });
  // Back during the coming peak: the house only has to stay above the floor until then.
  const backInPeak = back && back > window.end && back <= peakEnd;
  const floorTo = backInPeak ? back : peakEnd;
  // What coasting the peak takes, and what's worth banking at these prices.
  const floorEndF = o.awayMinF + o.awayMarginF;
  let requiredF = coastTo(floorTo, floorEndF);
  const horizonHours = bankHorizonHours({ prices, k, copRatio: o.awayCopRatio });
  const horizonEnd = Math.min(+floorTo, +window.end + horizonHours * MS_PER_HOUR);
  let worthF = horizonEnd < +floorTo ? coastTo(new Date(horizonEnd), floorEndF) : requiredF;
  // ...and what it takes to still be at targetF when you walk in, if that pays.
  let returnF = null;
  if (backInPeak) {
    returnF = coastTo(back, o.targetF);
    requiredF = Math.max(requiredF, returnF);
    if (+back <= +window.end + horizonHours * MS_PER_HOUR) worthF = Math.max(worthF, returnF);
  }
  // Back by the end of tonight's off-peak: the warm-up for your return does it all.
  const bankF = back && back <= window.end ? null : Math.min(o.awayMaxBankF, Math.max(guardOff, Math.ceil(worthF)));
  const { startAt, minutesNeeded } =
    bankF == null
      ? {}
      : preheatStart({
          indoorF: T,
          ratePerHour,
          window,
          targetF: bankF,
          safety: o.safety,
          marginMinutes: o.marginMinutes,
          latestStart: o.latestStart,
        });
  // The warm-up for your return, worked back from when you're back like the preheat.
  const returnMinutes = back ? (Math.max(0, o.targetF - T) / ratePerHour) * 60 * o.safety + o.marginMinutes : null;
  const returnStartAt = back ? new Date(+back - returnMinutes * 60 * 1000) : null;
  const plan = {
    bankF,
    requiredF,
    worthF,
    returnF,
    horizonHours: Number.isFinite(horizonHours) ? horizonHours : null,
    startAt,
    minutesNeeded,
    returnAt: back,
    returnStartAt,
    returnMinutes,
    key: window.key,
  };
  const on = (runKind, target, reason) => ({ ...plan, action: "away-heat-on", run: runKind, setpointF: setpoint(target), reason });
  const off = (reason) => ({ ...plan, action: "away-heat-off", reason });
  const idle = (reason) => ({ ...plan, action: "idle", reason });

  // 0. Warm-up for your return. Like the bank, a run under way keeps going as
  // its start time moves later; at targetF the unit holds it on its own.
  if (back && (now >= returnStartAt || run === "return")) {
    if (run === "return") return idle(`away: warming up for your return at ${fmtLocal(back)} (${T}°F -> ${o.targetF}°F)`);
    return on("return", o.targetF, `away: back at ${fmtLocal(back)} -- warming ${T}°F -> ${o.targetF}°F`);
  }

  // 1. Floor guard.
  if (T <= guardOn) {
    if (ours) return idle(`away: ${run === "bank" ? "banking" : "guard heating"} (${T}°F)`);
    return on("guard", guardOff, `away: ${T}°F, at the ${o.awayMinF}°F floor guard -- heating now`);
  }

  // 2. Bank. A bank run under way keeps going: its start time, re-worked from a
  // house it has already warmed, has moved later than now.
  if (bankF != null && window.inWindow && (now >= startAt || run === "bank")) {
    if (T >= bankF) return device.power ? off(`away: banked ${T}°F (target ${bankF}°F)`) : idle(`away: banked (${T}°F)`);
    if (ours && run === "bank") return idle(`away: banking ${T}°F -> ${bankF}°F`);
    // Start the bank below it -- or take over a guard run so it goes on to the bank target.
    if (T <= bankF - 1 || ours) return on("bank", bankF, `away: banking ${T}°F -> ${bankF}°F by ${o.windowEnd}`);
    return idle(`away: holding the bank (${T}°F)`);
  }

  // 3. Coast.
  if (run === "guard" && T < guardOff) return idle(`away: guard heating (${T}°F -> ${guardOff}°F)`);
  if (device.power) return off(`away: coasting -- ${window.inWindow ? "bank starts later" : "peak hours"} (${T}°F)`);
  if (bankF == null) return idle(`away: coasting (${T}°F) until the warm-up for your return at ${fmtLocal(back)}`);
  return idle(`away: coasting (${T}°F, bank ${bankF}°F ${window.inWindow ? "from" : "after"} ${window.inWindow ? "the start time" : o.windowStart})`);
}

/** "2026-11-29 17:00", local. */
function fmtLocal(d) {
  return `${localDateKey(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Check a return time from the dashboard: a parseable time in the future, and
 * not absurdly far off. Returns the Date, or throws with a reason to show.
 */
export function parseReturnAt(value, now = new Date(), { maxDays = 90 } = {}) {
  const d = new Date(value);
  if (value == null || value === "" || !Number.isFinite(+d)) throw new Error("returnAt must be a date and time");
  if (d <= now) throw new Error("returnAt must be in the future");
  if (+d - +now > maxDays * 24 * MS_PER_HOUR) throw new Error(`returnAt must be within ${maxDays} days`);
  return d;
}

// --- Outdoor forecast --------------------------------------------------------

/**
 * Mean of hourly forecast temperatures over [from, to]. `hourly` is
 * [{ time: Date|number, tempF }]. Falls back to the nearest hour when the range
 * holds none.
 */
export function meanForecast(hourly, from, to) {
  if (!hourly?.length) return null;
  const t = (h) => +new Date(h.time);
  const inRange = hourly.filter((h) => t(h) >= +from && t(h) <= +to && Number.isFinite(h.tempF));
  if (inRange.length) return inRange.reduce((a, h) => a + h.tempF, 0) / inRange.length;
  const nearest = hourly.reduce((best, h) => (Math.abs(t(h) - +from) < Math.abs(t(best) - +from) ? h : best));
  return Number.isFinite(nearest.tempF) ? nearest.tempF : null;
}
