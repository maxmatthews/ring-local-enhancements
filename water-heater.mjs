/**
 * Decision logic for the Rheem heat pump water heater, driven by the heat
 * pump's away mode and return time.
 *
 * Pure and I/O-free like thermostat.mjs: index.mjs feeds it the clock, the
 * away state and the heater's reported state, and carries out what it
 * returns through econet.mjs. test-water-heater.mjs drives it directly.
 *
 *   - Away: fully off.
 *   - Back: on at 23:00 the night before you're back, in Energy Saver at
 *     140°F, so the tank is hot when you arrive; at the next 06:00 back to
 *     the everyday 120°F.
 *   - Away mode ended early ("I'm home"), or back the same day: on at 140°F
 *     right away if it's off-peak, else at 23:00 that day when off-peak
 *     starts -- never on at peak prices; down to 120°F at the next 06:00.
 *   - Home, nothing scheduled: left alone.
 *
 * The heater is on weak Wi-Fi and the cloud never acknowledges a command, so
 * nothing counts as done until the heater reports it: index.mjs re-sends
 * whatever diffWaterHeater() still finds different, on a retry schedule
 * (retryDelayMs), until the reported state matches.
 */

import { timeOnDay } from "./govee-lights.mjs";
import { offPeakWindow } from "./thermostat.mjs";

export const WH_DEFAULTS = {
  /** Back on at this time the night before you're back... */
  onTime: "23:00",
  /** ...and down to the everyday setpoint at the next one of these. */
  dropTime: "06:00",
  boostF: 140,
  normalF: 120,
  /** Energy Saver; the units call it "ENERGY SAVING" or "ENERGY SAVER". */
  mode: "ENERGY_SAVING",
  /** Waits between attempts at one change; the last repeats until it lands. */
  retryDelaysMs: [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000],
  /** Off-peak power (the heat pump's VTOU window): a late start waits for it. */
  windowStart: "23:00",
  windowEnd: "07:00",
};

/** The first `hhmm` strictly after `t`. */
function nextAt(t, hhmm) {
  const today = timeOnDay(t, hhmm);
  return today > t ? today : timeOnDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 12), hhmm);
}

/**
 * When the heater comes back on and when it drops to the everyday setpoint,
 * for a return at `returnAt` (a Date) seen from `now`.
 *
 * On at onTime the evening before the return's date. If that's already
 * passed (back the same day, or "I'm home" -- returnAt = now): on now if
 * it's off-peak, else at the next onTime -- 23:00 that day -- rather than
 * heating the tank at peak prices. Down at the first dropTime after it comes on.
 *
 * @returns {{onAt: Date, dropAt: Date}}
 */
export function waterHeaterSchedule(returnAt, now, opts = {}) {
  const o = { ...WH_DEFAULTS, ...opts };
  const dayBefore = new Date(returnAt.getFullYear(), returnAt.getMonth(), returnAt.getDate() - 1, 12);
  const nightBefore = timeOnDay(dayBefore, o.onTime);
  let onAt = nightBefore;
  if (nightBefore <= now) onAt = offPeakWindow(now, o.windowStart, o.windowEnd).inWindow ? now : nextAt(now, o.onTime);
  return { onAt, dropAt: nextAt(onAt, o.dropTime) };
}

/**
 * What the heater should be doing now, or null to leave it alone.
 *
 * `schedule` is the persisted { onAt, dropAt } (ISO strings or Dates) of a
 * return, kept until it has fully played out -- past the end of away mode,
 * since the 06:00 drop often comes after you're back.
 *
 * @returns {null | {enabled: false, reason: string} | {enabled: true, mode: string, setpointF: number, final: boolean, reason: string}}
 */
export function planWaterHeater({ now, away, schedule, opts = {} }) {
  const o = { ...WH_DEFAULTS, ...opts };
  if (schedule) {
    const onAt = new Date(schedule.onAt);
    const dropAt = new Date(schedule.dropAt);
    if (now >= dropAt) return { enabled: true, mode: o.mode, setpointF: o.normalF, final: true, reason: `${o.dropTime} after your return -- back to ${o.normalF}°F` };
    if (now >= onAt) return { enabled: true, mode: o.mode, setpointF: o.boostF, final: false, reason: `heating the tank for your return -- ${o.boostF}°F until ${o.dropTime}` };
  }
  if (away) return { enabled: false, reason: schedule ? `away -- off until ${fmt(new Date(schedule.onAt))}` : "away -- off" };
  return null;
}

const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// --- The heater's reported state ---------------------------------------------------

/** "ENERGY SAVER" / "Energy Saving" / "HEAT PUMP" -> pyeconet-style names. */
export function normalizeMode(text) {
  const t = String(text || "").trim().replace(/[ /]+/g, "_").toUpperCase();
  const alias = { ENERGY_SAVER: "ENERGY_SAVING", ELECTRIC: "ELECTRIC_MODE", HEAT_PUMP: "HEAT_PUMP_ONLY" };
  return alias[t] || t;
}

/**
 * Summarize one water heater from getUserDataForApp: on/off, mode name and
 * index, setpoint and its limits, and whether it's online.
 *
 * Mode: the unit's own list of names (@MODE.constraints.enumText) indexed by
 * @MODE.value -- except that @MODE.status, when present, wins: some units
 * report a value that disagrees with it. On/off: @ENABLED where the unit has
 * it (it keeps the last heating mode in @MODE while off), else an OFF mode.
 */
export function summarizeWaterHeater(equip) {
  const modes = equip["@MODE"]?.constraints?.enumText ?? [];
  let modeIndex = equip["@MODE"]?.value ?? null;
  // The status comes padded ("Energy Saver  "), so match names, not strings.
  const status = equip["@MODE"]?.status;
  const byStatus = status ? modes.findIndex((m) => normalizeMode(m) === normalizeMode(status)) : -1;
  if (byStatus >= 0) modeIndex = byStatus;
  const mode = modeIndex != null && modes[modeIndex] != null ? normalizeMode(modes[modeIndex]) : null;
  const hasEnabled = equip["@ENABLED"] != null;
  const enabled = hasEnabled ? equip["@ENABLED"].value === 1 : mode != null ? mode !== "OFF" : null;
  const sp = equip["@SETPOINT"];
  return {
    deviceId: equip.device_name,
    serial: equip.serial_number,
    name: equip["@NAME"]?.value ?? null,
    type: equip["@TYPE"] ?? null,
    connected: equip["@CONNECTED"] !== false,
    enabled,
    hasEnabled,
    mode,
    modes: modes.map(normalizeMode),
    setpointF: typeof sp === "object" ? sp?.value ?? null : sp ?? null,
    setpointMinF: sp?.constraints?.lowerLimit ?? null,
    setpointMaxF: sp?.constraints?.upperLimit ?? null,
    running: equip["@RUNNING"] ?? null,
  };
}

/**
 * The commands still needed to get from `state` (summarizeWaterHeater) to
 * `desired` (planWaterHeater), in the order to send them -- on and mode
 * before the setpoint, since a heater that's off may ignore a setpoint.
 * Empty when it's already there.
 *
 * @returns {{payloads: object[], problems: string[]}}  problems = things it
 *   can't do on this unit (no such mode, setpoint out of range)
 */
export function diffWaterHeater(state, desired) {
  const payloads = [];
  const problems = [];
  if (!desired) return { payloads, problems };

  if (!desired.enabled) {
    if (state.enabled === false) return { payloads, problems };
    // Units with both (heatpumpWaterHeaterGen5 does) get both, as pyeconet sends them.
    const off = {};
    if (state.hasEnabled) off["@ENABLED"] = 0;
    if (state.modes.includes("OFF")) off["@MODE"] = state.modes.indexOf("OFF");
    if (Object.keys(off).length) payloads.push(off);
    else problems.push("can't be switched off: no @ENABLED and no OFF mode");
    return { payloads, problems };
  }

  const onPayload = {};
  if (state.enabled !== true && state.hasEnabled) onPayload["@ENABLED"] = 1;
  if (state.mode !== desired.mode) {
    const i = state.modes.indexOf(desired.mode);
    if (i >= 0) onPayload["@MODE"] = i;
    else problems.push(`no ${desired.mode} mode (has ${state.modes.join(", ") || "none"})`);
  }
  if (Object.keys(onPayload).length) payloads.push(onPayload);

  if (state.setpointF !== desired.setpointF) {
    const lo = state.setpointMinF ?? -Infinity;
    const hi = state.setpointMaxF ?? Infinity;
    if (desired.setpointF < lo || desired.setpointF > hi) problems.push(`${desired.setpointF}°F is outside the heater's ${lo}–${hi}°F`);
    else payloads.push({ "@SETPOINT": desired.setpointF });
  }
  return { payloads, problems };
}

/** How long to wait after the n-th attempt (0-based) at the same change. */
export function retryDelayMs(attempt, opts = {}) {
  const d = { ...WH_DEFAULTS, ...opts }.retryDelaysMs;
  return d[Math.min(attempt, d.length - 1)];
}
