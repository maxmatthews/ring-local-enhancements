/**
 * Decision logic for the meeting-triggered smart plug.
 *
 * Pure and I/O-free on purpose, same as level-sync.mjs: index.mjs feeds it the
 * current session plus whatever MeetingBar reported, and executes the plan it
 * returns. Everything time-dependent is passed in as `now` so the tests can
 * drive it without waiting.
 *
 * The plug is driven from a Mac running MeetingBar. MeetingBar hands the join
 * script the event's real end date, but that end date is not trustworthy input:
 * it can be missing (older MeetingBar builds pass no parameters at all), in the
 * past (you join a meeting that already ended), or absurdly far away (an
 * all-day event). Hence the default, the floor and the ceiling.
 */

/** Used when the meeting length can't be worked out. */
export const DEFAULT_MEETING_MINUTES = 60;
/** Never schedule an off closer than this -- a too-short meeting is a no-op. */
export const MIN_MEETING_MINUTES = 5;
/** Ceiling, so one bad end date can't leave the plug on for a week. */
export const MAX_MEETING_MINUTES = 240;

const MS_PER_MINUTE = 60 * 1000;

/**
 * Work out how long to keep the plug on for a newly started meeting.
 *
 * @param {object} req
 * @param {number} [req.endsAt]   epoch ms of the meeting's scheduled end
 * @param {number} [req.minutes]  explicit duration, used when endsAt is absent
 * @param {number} now            epoch ms
 * @param {object} cfg            { defaultMinutes, minMinutes, maxMinutes }
 * @returns {{minutes: number, source: string, clamped: boolean}}
 */
export function resolveDuration(req, now, cfg) {
  const {
    defaultMinutes = DEFAULT_MEETING_MINUTES,
    minMinutes = MIN_MEETING_MINUTES,
    maxMinutes = MAX_MEETING_MINUTES,
  } = cfg || {};

  let minutes;
  let source;

  if (Number.isFinite(req?.endsAt) && req.endsAt > now) {
    minutes = (req.endsAt - now) / MS_PER_MINUTE;
    source = "meeting-end";
  } else if (Number.isFinite(req?.endsAt)) {
    // End date already passed: joining the tail of a meeting, or a stale event.
    minutes = defaultMinutes;
    source = "default (meeting end already passed)";
  } else if (Number.isFinite(req?.minutes) && req.minutes > 0) {
    minutes = req.minutes;
    source = "requested-duration";
  } else {
    minutes = defaultMinutes;
    source = "default (no meeting length given)";
  }

  const bounded = Math.min(Math.max(minutes, minMinutes), maxMinutes);
  return { minutes: bounded, source, clamped: bounded !== minutes };
}

/**
 * Decide what to do when a meeting starts.
 *
 * `session` is the currently tracked meeting ({ offAt, owned }) or null. Back
 * to back meetings overlap rather than replace: the later off time wins, so a
 * short meeting starting inside a long one can never cut the long one short.
 *
 * `plugAlreadyOn` is the plug's state read just before this call (null when it
 * couldn't be read). With `respectExisting`, a plug that was already on when
 * the first meeting started is left alone at the end -- we didn't turn it on,
 * so we don't turn it off, and a desk lamp you switched on yourself doesn't
 * die when a meeting ends.
 *
 * @returns {{offAt: number, turnOn: boolean, owned: boolean, extended: boolean,
 *            minutes: number, source: string, clamped: boolean, reason: string}}
 */
export function planMeetingStart({ request, now, session, plugAlreadyOn, cfg }) {
  const { respectExisting = true } = cfg || {};
  const duration = resolveDuration(request, now, cfg);
  const candidateOffAt = now + duration.minutes * MS_PER_MINUTE;

  if (session) {
    // Already mid-meeting: extend, never retract.
    const offAt = Math.max(session.offAt, candidateOffAt);
    return {
      offAt,
      turnOn: true,
      owned: session.owned,
      extended: offAt > session.offAt,
      minutes: duration.minutes,
      source: duration.source,
      clamped: duration.clamped,
      reason:
        offAt > session.offAt
          ? "extended the running meeting session"
          : "kept the running meeting session (this meeting ends sooner)",
    };
  }

  const owned = !(respectExisting && plugAlreadyOn === true);
  return {
    offAt: candidateOffAt,
    turnOn: true,
    owned,
    extended: false,
    minutes: duration.minutes,
    source: duration.source,
    clamped: duration.clamped,
    reason: owned
      ? "new meeting session"
      : "new meeting session, but the plug was already on -- leaving it on at the end",
  };
}

/**
 * Decide what the periodic tick should do.
 *
 * A tick against an absolute timestamp is used rather than a long setTimeout so
 * that a restart (deploy, pm2 reload) can restore the session from disk and
 * still switch off on time -- including catching up on an off time that fell
 * while the service was down.
 *
 * @returns {{action: "idle"|"wait"|"off"|"release", msRemaining?: number}}
 */
export function planTick({ now, session }) {
  if (!session) return { action: "idle" };
  if (now < session.offAt) return { action: "wait", msRemaining: session.offAt - now };
  return { action: session.owned ? "off" : "release" };
}
