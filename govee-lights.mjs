/**
 * Decision logic for the Govee permanent outdoor lights.
 *
 * Pure and I/O-free, same as level-sync.mjs and meeting-plug.mjs: index.mjs
 * feeds it the clock, tonight's sunset and the scene names the device offers,
 * and carries out what it returns. test-govee-lights.mjs drives it directly.
 *
 * Every night the lights come on at sunset and go off at a fixed time. Most
 * nights they show the default scene; in the run-up to a holiday they show a
 * scene picked at random from that holiday's list.
 *
 * All dates are the Pi's local calendar day.
 */

export const DEFAULT_SCENE = "Nebula";
/** A holiday's scenes run this many days before it, through the day itself. */
export const DEFAULT_LEAD_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// --- Holiday dates -----------------------------------------------------------

/** Local midnight of y-m-d (month 1-12). */
const day = (y, m, d) => new Date(y, m - 1, d);

/** The nth (1-based) given weekday (0 = Sunday) of a month. */
export function nthWeekday(year, month, weekday, n) {
  const first = day(year, month, 1).getDay();
  return day(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
}

/** The last given weekday (0 = Sunday) of a month. */
export function lastWeekday(year, month, weekday) {
  const last = day(year, month + 1, 0);
  return day(year, month, last.getDate() - ((last.getDay() - weekday + 7) % 7));
}

/** The Saturday-to-Monday weekend of a Monday holiday. */
const mondayWeekend = (monday) => [
  new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 2),
  monday,
];

/** Western (Gregorian) Easter Sunday -- the anonymous Gregorian algorithm. */
export function easter(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const date = ((h + l - 7 * m + 114) % 31) + 1;
  return day(year, month, date);
}

/**
 * The holidays, in priority order: where two windows overlap, the one listed
 * first wins. That is how Christmas keeps the whole of December even though
 * New Year's would otherwise claim the last week of it.
 *
 * `date(year)` gives the holiday itself. `window(year)` is optional and gives
 * an explicit inclusive [start, end]; without it the window is the lead days
 * before the date through the date. Christmas uses it for the whole of
 * December, and the Monday holidays for just their three-day weekend.
 *
 * Scene names must match the device's scene list exactly (case-insensitive).
 * Names the device doesn't offer are skipped, so the list can be generous.
 */
export const HOLIDAYS = [
  {
    name: "Christmas",
    date: (y) => day(y, 12, 25),
    window: (y) => [day(y, 12, 1), day(y, 12, 31)],
    scenes: [
      "Christmas",
      "Christmas Tree",
      "Christmas Wreath",
      "Christmas Gift",
      "Christmas Bell",
      "Christmas Eve",
      "Candy Cane",
      "Sled",
      "Winter Wonderland",
    ],
  },
  { name: "New Year's Day", date: (y) => day(y, 1, 1), scenes: ["New Years", "Fireworks", "Confetti"] },
  { name: "Valentine's Day", date: (y) => day(y, 2, 14), scenes: ["Valentine's Day", "Romantic"] },
  { name: "St. Patrick's Day", date: (y) => day(y, 3, 17), scenes: ["Saint Patrick's Day", "Leprechaun"] },
  { name: "Easter", date: easter, scenes: ["Easter", "Easter Egg"] },
  {
    name: "Memorial Day",
    date: (y) => lastWeekday(y, 5, 1),
    window: (y) => mondayWeekend(lastWeekday(y, 5, 1)),
    scenes: ["Fireworks"],
  },
  { name: "Independence Day", date: (y) => day(y, 7, 4), scenes: ["Fireworks"] },
  {
    name: "Labor Day",
    date: (y) => nthWeekday(y, 9, 1, 1),
    window: (y) => mondayWeekend(nthWeekday(y, 9, 1, 1)),
    scenes: ["Fireworks"],
  },
  {
    name: "Halloween",
    date: (y) => day(y, 10, 31),
    scenes: ["Halloween", "Halloween B", "Halloween C", "Halloween D"],
  },
  { name: "Thanksgiving", date: (y) => nthWeekday(y, 11, 4, 4), scenes: ["Thanksgiving"] },
];

/** Whole local calendar days from a to b, immune to DST shifts. */
function daysBetween(a, b) {
  const utc = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((utc(b) - utc(a)) / MS_PER_DAY);
}

function windowFor(holiday, year, leadDays) {
  if (holiday.window) return holiday.window(year);
  const date = holiday.date(year);
  return [new Date(date.getFullYear(), date.getMonth(), date.getDate() - leadDays), date];
}

/**
 * The holiday whose window covers `now`, or null on an ordinary night.
 * Next year's occurrence is checked too, so New Year's lead-in can start in
 * the old year.
 */
export function holidayFor(now, { holidays = HOLIDAYS, leadDays = DEFAULT_LEAD_DAYS } = {}) {
  const year = now.getFullYear();
  for (const holiday of holidays) {
    for (const y of [year, year + 1]) {
      const [start, end] = windowFor(holiday, y, leadDays);
      if (daysBetween(start, now) >= 0 && daysBetween(now, end) >= 0) return holiday;
    }
  }
  return null;
}

// --- Scene choice ------------------------------------------------------------

/**
 * Pick tonight's scene.
 *
 * `available` is the device's scene names. `previous` is the scene shown last
 * time, so a holiday with several scenes doesn't repeat itself two nights
 * running. `random` is injectable for the tests.
 *
 * @returns {{scene: string, holiday: string|null, candidates: string[], reason: string}}
 */
export function pickScene({
  now,
  available,
  previous = null,
  random = Math.random,
  holidays = HOLIDAYS,
  leadDays = DEFAULT_LEAD_DAYS,
  defaultScene = DEFAULT_SCENE,
}) {
  const offered = new Map(available.map((name) => [name.toLowerCase(), name]));
  const holiday = holidayFor(now, { holidays, leadDays });

  if (holiday) {
    const candidates = [...new Set(holiday.scenes.map((s) => offered.get(s.toLowerCase())).filter(Boolean))];
    if (candidates.length) {
      const fresh = candidates.length > 1 ? candidates.filter((s) => s !== previous) : candidates;
      const scene = fresh[Math.floor(random() * fresh.length)];
      return { scene, holiday: holiday.name, candidates, reason: `${holiday.name} scene` };
    }
    return {
      scene: defaultScene,
      holiday: holiday.name,
      candidates: [],
      reason: `${holiday.name}, but the device offers none of its scenes -- using the default`,
    };
  }
  return { scene: defaultScene, holiday: null, candidates: [], reason: "ordinary night" };
}

// --- On/off schedule ---------------------------------------------------------

/** "YYYY-MM-DD" of the local calendar day. */
export function localDateKey(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse "HH:MM" (24h) into today's local Date. */
export function timeOnDay(now, hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!match || +match[1] > 23 || +match[2] > 59) throw new Error(`Bad time "${hhmm}" (want HH:MM, 24h)`);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), +match[1], +match[2]);
}

/**
 * Decide what the periodic tick should do.
 *
 * Works on edges, not levels: each of "on" and "off" fires once per calendar
 * day, recorded in `state` ({ onDate, offDate }). So switching the lights off
 * from the Govee app at 9pm sticks, and a restart mid-evening doesn't re-pick
 * the scene. A failed command isn't recorded, so the next tick retries it.
 *
 * A service that was down at sunset and comes back before the off time still
 * switches on; one that comes back after the off time still sends the off.
 *
 * @param {Date} now
 * @param {Date} onAt   tonight's switch-on time (sunset)
 * @param {Date} offAt  tonight's switch-off time
 * @param {{onDate?: string, offDate?: string}} state
 * @returns {{action: "idle"|"on"|"off"}}
 */
export function planLights({ now, onAt, offAt, state }) {
  const today = localDateKey(now);
  if (now >= offAt) return { action: state?.offDate === today ? "idle" : "off" };
  if (now >= onAt) return { action: state?.onDate === today ? "idle" : "on" };
  return { action: "idle" };
}
