/**
 * Ring + Dirigera home automation glue.
 *
 *   1. Snoozes "Person Detected" notifications on a Ring camera when a
 *      designated door contact sensor opens (original behavior).
 *   2. Closes IKEA Dirigera blinds at sunset, but defers closing any blind
 *      whose mapped contact sensor reports open -- the blind closes
 *      POST_CLOSE_DELAY_SECONDS after the sensor transitions back to closed.
 *      Blinds with no mapping always close.
 *
 * The Dirigera hub has no native Ring integration; the sunset trigger lives
 * here. Disable the equivalent scene in the IKEA Home Smart app so the two
 * don't race.
 */

import { RingApi, RingDeviceType } from "ring-client-api";
import { createDirigeraClient } from "dirigera";
import { createSmartThingsClient } from "./smartthings-lock.mjs";
import { planLevelSync } from "./level-sync.mjs";
import SunCalc from "suncalc";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

function loadEnv() {
  const envPath = resolve(__dirname, ".env");
  if (!existsSync(envPath)) {
    console.error("No .env file found.");
    process.exit(1);
  }
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnv();

const REFRESH_TOKEN = process.env.RING_REFRESH_TOKEN;
const SENSOR_NAME = (process.env.DOOR_SENSOR_NAME || "Front Door").toLowerCase();
const CAMERA_NAME = (process.env.CAMERA_NAME || "Front Door").toLowerCase();
const SNOOZE_MINUTES = parseInt(process.env.SNOOZE_MINUTES || "30", 10);
const COOLDOWN_SECONDS = parseInt(process.env.COOLDOWN_SECONDS || "60", 10);

const DIRIGERA_HOST = process.env.DIRIGERA_HOST;
const DIRIGERA_TOKEN = process.env.DIRIGERA_TOKEN;
const LATITUDE = parseFloat(process.env.LATITUDE || "");
const LONGITUDE = parseFloat(process.env.LONGITUDE || "");
const BLIND_SENSOR_MAP_FILE = process.env.BLIND_SENSOR_MAP_FILE || "blind-sensor-map.json";
const POST_CLOSE_DELAY_SECONDS = parseInt(process.env.POST_CLOSE_DELAY_SECONDS || "60", 10);

// SmartThings smoke-triggered auto-unlock (Ultraloq lock linked into SmartThings).
const ST_CLIENT_ID = process.env.ST_CLIENT_ID;
const ST_CLIENT_SECRET = process.env.ST_CLIENT_SECRET;
const ST_REFRESH_TOKEN = process.env.ST_REFRESH_TOKEN;
const ST_LOCK_DEVICE_ID = process.env.ST_LOCK_DEVICE_ID;
const SMOKE_UNLOCK_COOLDOWN_SECONDS = parseInt(process.env.SMOKE_UNLOCK_COOLDOWN_SECONDS || "300", 10);
const BLIND_CLOSED_LEVEL = 100;
const BLIND_CLOSE_SPACING_MS = 10 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_RETRY_PASSES = 2;

// --- Level-sync retry (stragglers on a house-wide level command) ------------
// Some blinds intermittently miss a house-wide level command. We watch the
// Dirigera event stream, wait for the burst of commands to settle, then re-send
// the consensus level to any blind that didn't land on it.
const LEVEL_SYNC_ENABLED = (process.env.BLIND_LEVEL_SYNC_ENABLED || "true").toLowerCase() !== "false";
// Quiet period after the last observed target change before we evaluate.
const LEVEL_SYNC_SETTLE_MS = parseInt(process.env.BLIND_LEVEL_SYNC_SETTLE_MS || "20000", 10);
// Hard cap on how long one burst may keep extending the settle window.
const LEVEL_SYNC_MAX_BURST_MS = parseInt(process.env.BLIND_LEVEL_SYNC_MAX_BURST_MS || "120000", 10);
const LEVEL_SYNC_RETRY_DELAY_MS = parseInt(process.env.BLIND_LEVEL_SYNC_RETRY_DELAY_MS || "45000", 10);
const LEVEL_SYNC_MAX_RETRIES = parseInt(process.env.BLIND_LEVEL_SYNC_MAX_RETRIES || "3", 10);
// Minimum blinds that must move together before we treat it as a house-wide
// command. Nudging a single blind by hand must never trigger a sync.
const LEVEL_SYNC_MIN_BURST = parseInt(process.env.BLIND_LEVEL_SYNC_MIN_BURST || "3", 10);
// If more blinds than this disagree, assume a deliberate partial-house state
// rather than dropped commands, and stand down.
const LEVEL_SYNC_MAX_STRAGGLERS = parseInt(process.env.BLIND_LEVEL_SYNC_MAX_STRAGGLERS || "3", 10);
// Fraction of reachable blinds that must share a target level for it to count
// as the intended level.
const LEVEL_SYNC_CONSENSUS_RATIO = parseFloat(process.env.BLIND_LEVEL_SYNC_CONSENSUS_RATIO || "0.667");
// Blinds rarely land exactly on target; treat within this many points as "there".
const LEVEL_SYNC_TOLERANCE = parseInt(process.env.BLIND_LEVEL_SYNC_TOLERANCE || "2", 10);
const LEVEL_SYNC_SPACING_MS = 2 * 1000;
// How long after we issue a command to ignore the resulting echo events.
const SELF_COMMAND_ECHO_MS = 90 * 1000;

// --- Full-open nudge --------------------------------------------------------
// Dirigera levels run 0 = fully open .. 100 = fully closed. When the house is
// opened all the way we nudge the blinds down a few points instead of leaving
// them at 0.
const FULL_OPEN_NUDGE_ENABLED = (process.env.BLIND_FULL_OPEN_NUDGE || "true").toLowerCase() !== "false";
const FULL_OPEN_NUDGE_LEVEL = parseInt(process.env.BLIND_FULL_OPEN_NUDGE_LEVEL || "3", 10);

// Sunset close order. Blinds whose names don't match any entry here close last,
// in whatever order Dirigera returned them.
const CLOSE_ORDER = [
  "Office Left",
  "Office Right",
  "Living Room Left",
  "Living Room Center",
  "Dining Room Center",
  "Living Room Right",
  "Dining Room Left",
  "Dining Room Right",
  "Kitchen Left",
  "Kitchen Center",
  "Kitchen Right",
  "Back Door",
  "Family Room Left",
  "Family Room Right",
  "Bedroom Right",
  "Bedroom Center",
  "Bedroom Left",
  "Primary Bathroom",
];

if (!REFRESH_TOKEN) {
  console.error("RING_REFRESH_TOKEN is required.");
  process.exit(1);
}

const blindsEnabled = !!(DIRIGERA_HOST && DIRIGERA_TOKEN && Number.isFinite(LATITUDE) && Number.isFinite(LONGITUDE));
const smokeUnlockEnabled = !!(ST_CLIENT_ID && ST_CLIENT_SECRET && ST_REFRESH_TOKEN && ST_LOCK_DEVICE_ID);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function logError(msg, err) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, err?.message || err);
}

// Upsert a single KEY=value line in .env (replace if present, else append).
function persistEnvVar(key, value) {
  const envPath = resolve(__dirname, ".env");
  let content = readFileSync(envPath, "utf-8");
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) content = content.replace(re, `${key}=${value}`);
  else content = content.replace(/\n?$/, `\n${key}=${value}\n`);
  writeFileSync(envPath, content);
}

// ---------------------------------------------------------------------------
// Blind <-> sensor mapping
// ---------------------------------------------------------------------------

function loadBlindSensorMap() {
  const mapPath = resolve(__dirname, BLIND_SENSOR_MAP_FILE);
  if (!existsSync(mapPath)) {
    log(`No mapping file at ${mapPath} -- all blinds will close unconditionally at sunset.`);
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(mapPath, "utf-8"));
    const cleaned = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("_")) continue;
      if (typeof v === "string") cleaned[k] = [v];
      else if (Array.isArray(v) && v.every((x) => typeof x === "string")) cleaned[k] = v;
    }
    return cleaned;
  } catch (err) {
    logError(`Failed to read ${BLIND_SENSOR_MAP_FILE}, treating as empty`, err);
    return {};
  }
}

const blindMap = blindsEnabled ? loadBlindSensorMap() : {};

function nameMatches(realName, partialKey) {
  return realName.toLowerCase().includes(partialKey.toLowerCase());
}

function findSensorKeysForBlind(blindName) {
  for (const [blindKey, sensorKeys] of Object.entries(blindMap)) {
    if (nameMatches(blindName, blindKey)) return sensorKeys;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sensor state + pending blind closes
// ---------------------------------------------------------------------------

// sensorId -> { name, isOpen }
const sensorState = new Map();

// blindId -> { blindName, sensorIds: Set<string>, sensorNames: string[], timer }
const pendingCloses = new Map();

function isSensorOpen(sensorId) {
  return !!sensorState.get(sensorId)?.isOpen;
}

function findSensorByKey(sensors, partialKey) {
  return sensors.find((s) => nameMatches(s.name, partialKey));
}

// ---------------------------------------------------------------------------
// Camera snooze (original feature)
// ---------------------------------------------------------------------------

const activeReenableTimers = {};
let lastSnoozeTime = 0;

async function snoozeCamera(ringApi, camera, minutes) {
  const deviceUrl = `https://api.ring.com/devices/v1/devices/${camera.id}/settings`;

  log(`>>> Disabling Person notifications on "${camera.name}" for ${minutes} min...`);

  try {
    await ringApi.restClient.request({
      url: deviceUrl,
      method: "PATCH",
      json: {
        cv_settings: {
          detection_types: {
            human: { enabled: true, mode: "edge", notification: false },
          },
        },
      },
    });
    log(">>> Person notification DISABLED (Recording is still active).");

    if (activeReenableTimers[camera.id]) clearTimeout(activeReenableTimers[camera.id]);

    activeReenableTimers[camera.id] = setTimeout(async () => {
      log(`>>> ${minutes} min passed. Re-enabling Person notifications for "${camera.name}"...`);
      try {
        await ringApi.restClient.request({
          url: deviceUrl,
          method: "PATCH",
          json: {
            cv_settings: {
              detection_types: {
                human: { enabled: true, mode: "edge", notification: true },
              },
            },
          },
        });
        log(">>> Person notifications RE-ENABLED.");
      } catch (err) {
        logError("Failed to re-enable Person notifications", err);
      } finally {
        delete activeReenableTimers[camera.id];
      }
    }, minutes * 60 * 1000);
  } catch (err) {
    logError("Failed to disable Person notifications", err);
  }
}

function maybeSnooze(ringApi, targetCamera) {
  const now = Date.now();
  const elapsed = (now - lastSnoozeTime) / 1000;
  if (elapsed < COOLDOWN_SECONDS) {
    log(`Snooze trigger -- cooldown active (${Math.round(elapsed)}s/${COOLDOWN_SECONDS}s)`);
    return;
  }
  log(`>>> DOOR OPENED -- snoozing camera`);
  lastSnoozeTime = now;
  snoozeCamera(ringApi, targetCamera, SNOOZE_MINUTES);
}

// ---------------------------------------------------------------------------
// Dirigera blind control
// ---------------------------------------------------------------------------

let dirigera = null;

// True from the first sunset close until the last retry pass finishes. The
// level-sync watcher stays out of the way for the duration: that sequence
// spaces its commands out and runs its own retries, so the two would fight.
let sunsetSequenceActive = false;

async function connectDirigera() {
  log(`Connecting to Dirigera hub at ${DIRIGERA_HOST}...`);
  dirigera = await createDirigeraClient({
    accessToken: DIRIGERA_TOKEN,
    gatewayIP: DIRIGERA_HOST,
  });
  const blinds = await dirigera.blinds.list();
  log(`Dirigera connected. ${blinds.length} blind(s): ${blinds.map((b) => b.attributes?.customName || b.id).join(", ")}`);
  return blinds;
}

// blindId -> timestamp until which target changes are assumed to be echoes of
// our own writes. Keeps the level-sync watcher from reacting to itself.
const selfCommanded = new Map();

function markSelfCommanded(blindId) {
  selfCommanded.set(blindId, Date.now() + SELF_COMMAND_ECHO_MS);
}

function isSelfCommanded(blindId) {
  const until = selfCommanded.get(blindId);
  if (until === undefined) return false;
  if (Date.now() > until) {
    selfCommanded.delete(blindId);
    return false;
  }
  return true;
}

async function setBlindLevel(blindId, blindName, level) {
  markSelfCommanded(blindId);
  try {
    await dirigera.blinds.setTargetLevel({ id: blindId, blindsTargetLevel: level });
    return true;
  } catch (err) {
    logError(`Failed to set blind "${blindName}" to level ${level}`, err);
    return false;
  }
}

async function closeBlind(blindId, blindName) {
  if (await setBlindLevel(blindId, blindName, BLIND_CLOSED_LEVEL)) {
    log(`Closed blind "${blindName}"`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function closeOrderIndex(blindName) {
  const lower = blindName.toLowerCase();
  const idx = CLOSE_ORDER.findIndex((entry) => lower.includes(entry.toLowerCase()));
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

async function closeBlindsSequentially(targets) {
  for (let i = 0; i < targets.length; i++) {
    await closeBlind(targets[i].id, targets[i].name);
    if (i < targets.length - 1) await sleep(BLIND_CLOSE_SPACING_MS);
  }
}

async function retryStillOpen(targets, pass) {
  if (pass > MAX_RETRY_PASSES) return;
  log(`Sunset retry ${pass}/${MAX_RETRY_PASSES}: waiting ${RETRY_DELAY_MS / 60000}min before re-checking blind levels`);
  await sleep(RETRY_DELAY_MS);

  let current;
  try {
    current = await dirigera.blinds.list();
  } catch (err) {
    logError(`Retry ${pass}: failed to list blinds, skipping pass`, err);
    return retryStillOpen(targets, pass + 1);
  }
  const byId = new Map(current.map((b) => [b.id, b]));

  const stillOpen = [];
  for (const t of targets) {
    const b = byId.get(t.id);
    const level = b?.attributes?.blindsCurrentLevel;
    if (typeof level !== "number") {
      log(`Retry ${pass}: "${t.name}" has no current-level reading, skipping`);
      continue;
    }
    if (level < BLIND_CLOSED_LEVEL) stillOpen.push(t);
  }

  if (stillOpen.length === 0) {
    log(`Retry ${pass}: all ${targets.length} blind(s) reporting closed.`);
    return;
  }
  log(`Retry ${pass}: re-closing ${stillOpen.length} blind(s) still open: ${stillOpen.map((b) => b.name).join(", ")}`);
  await closeBlindsSequentially(stillOpen);
  await retryStillOpen(targets, pass + 1);
}

async function onSunset(sensors) {
  log(">>> SUNSET -- evaluating blinds");

  // Stale pending closes from a previous evening get cleared; we re-evaluate fresh.
  for (const pending of pendingCloses.values()) {
    if (pending.timer) clearTimeout(pending.timer);
  }
  pendingCloses.clear();

  let blinds;
  try {
    blinds = await dirigera.blinds.list();
  } catch (err) {
    logError("Failed to list blinds from Dirigera", err);
    return;
  }

  const toClose = [];

  for (const blind of blinds) {
    const blindName = blind.attributes?.customName || blind.id;
    const sensorKeys = findSensorKeysForBlind(blindName);

    if (!sensorKeys) {
      log(`"${blindName}": no sensor mapping, queued for sunset close`);
      toClose.push({ id: blind.id, name: blindName });
      continue;
    }

    const mappedSensors = sensorKeys
      .map((k) => findSensorByKey(sensors, k))
      .filter(Boolean);
    if (mappedSensors.length === 0) {
      log(`WARN: none of mapped sensors [${sensorKeys.join(", ")}] found for "${blindName}", queued for sunset close`);
      toClose.push({ id: blind.id, name: blindName });
      continue;
    }

    const openSensors = mappedSensors.filter((s) => isSensorOpen(s.id));
    if (openSensors.length > 0) {
      log(`Deferring "${blindName}" -- open sensor(s): ${openSensors.map((s) => s.name).join(", ")}`);
      pendingCloses.set(blind.id, {
        blindName,
        sensorIds: new Set(mappedSensors.map((s) => s.id)),
        sensorNames: mappedSensors.map((s) => s.name),
        timer: null,
      });
    } else {
      log(`"${blindName}": all sensor(s) closed (${mappedSensors.map((s) => s.name).join(", ")}), queued for sunset close`);
      toClose.push({ id: blind.id, name: blindName });
    }
  }

  toClose.sort((a, b) => closeOrderIndex(a.name) - closeOrderIndex(b.name));
  if (toClose.length === 0) {
    log("Sunset: no blinds to close (all deferred or none mapped).");
    return;
  }
  log(`Sunset: closing ${toClose.length} blind(s), ${BLIND_CLOSE_SPACING_MS / 1000}s between each: ${toClose.map((b) => b.name).join(" -> ")}`);
  sunsetSequenceActive = true;
  try {
    await closeBlindsSequentially(toClose);
  } catch (err) {
    logError("Sunset close sequence failed", err);
  }
  retryStillOpen(toClose, 1)
    .catch((err) => logError("Sunset retry pass failed", err))
    .finally(() => {
      sunsetSequenceActive = false;
    });
}

// ---------------------------------------------------------------------------
// Level-sync retry
//
// A house-wide level command (IKEA app, remote, scene) occasionally fails to
// reach a few blinds. We watch the Dirigera event stream for a burst of target
// changes, wait for it to settle, then compare every blind against the level
// the majority landed on and re-send it to the ones that didn't get there.
//
// Two distinct failure modes, both caught:
//   - the blind got the command but never moved (target == consensus, but
//     current level is somewhere else)
//   - the blind never got the command at all (target and current both stale)
//
// A blind you deliberately set to a different level during the same burst is
// left alone: it emitted its own target-change event, so it's distinguishable
// from one that simply missed the command.
// ---------------------------------------------------------------------------

// blindId -> target level explicitly commanded during the current burst.
const burstTargets = new Map();
let burstSettleTimer = null;
let burstStartedAt = 0;
// Promise for the sync currently running, so a newer burst can wait for it to
// stand down instead of being dropped.
let levelSyncPromise = null;
// Bumped whenever a new externally-driven burst begins. An in-flight sync
// checks it and aborts, so a fresh command from the app always wins over
// retries still chasing the previous level.
let burstGeneration = 0;

// Names of this blind's mapped Ring sensors that are currently open.
function openSensorsForBlind(blindName) {
  const sensorKeys = findSensorKeysForBlind(blindName);
  if (!sensorKeys) return [];
  const open = [];
  for (const state of sensorState.values()) {
    if (!state.isOpen) continue;
    if (sensorKeys.some((k) => nameMatches(state.name, k))) open.push(state.name);
  }
  return open;
}

function levelSyncConfig() {
  return {
    tolerance: LEVEL_SYNC_TOLERANCE,
    consensusRatio: LEVEL_SYNC_CONSENSUS_RATIO,
    maxStragglers: LEVEL_SYNC_MAX_STRAGGLERS,
    minBurst: LEVEL_SYNC_MIN_BURST,
    fullOpenNudgeEnabled: FULL_OPEN_NUDGE_ENABLED,
    fullOpenNudgeLevel: FULL_OPEN_NUDGE_LEVEL,
    isPendingClose: (id) => pendingCloses.has(id),
    openSensorsFor: openSensorsForBlind,
  };
}

// Re-check the fences between retry passes -- a door may have opened since.
function stillEligible(straggler, burst, consensus) {
  const burstTarget = burst.get(straggler.id);
  if (burstTarget !== undefined && burstTarget !== consensus) {
    return `deliberately set to ${burstTarget}`;
  }
  if (pendingCloses.has(straggler.id)) return "deferred sunset close pending";
  const open = openSensorsForBlind(straggler.name);
  if (open.length > 0) return `open sensor(s): ${open.join(", ")}`;
  return null;
}

function atLevel(level, target) {
  return Math.abs(level - target) <= LEVEL_SYNC_TOLERANCE;
}

// Sleep in slices so a newer command doesn't have to wait out the full delay
// before the current sync notices it has been superseded.
async function sleepUnlessSuperseded(ms, generation) {
  const step = 2000;
  for (let waited = 0; waited < ms; waited += step) {
    if (generation !== burstGeneration) return false;
    await sleep(Math.min(step, ms - waited));
  }
  return generation === burstGeneration;
}

// `target` is the level to drive to, `commanded` the level the house was
// actually told to go to (they differ when the full-open nudge applies).
async function syncStragglers(target, stragglers, burst, commanded, generation) {
  let remaining = stragglers;

  for (let pass = 1; pass <= LEVEL_SYNC_MAX_RETRIES; pass++) {
    if (generation !== burstGeneration) {
      log(`Level sync: superseded by a newer command -- abandoning retries for level ${target}`);
      return;
    }

    log(
      `Level sync attempt ${pass}/${LEVEL_SYNC_MAX_RETRIES}: sending level ${target} to ${remaining.length} blind(s): ${remaining.map((b) => b.name).join(", ")}`
    );
    for (let i = 0; i < remaining.length; i++) {
      await setBlindLevel(remaining[i].id, remaining[i].name, target);
      if (i < remaining.length - 1) await sleep(LEVEL_SYNC_SPACING_MS);
    }

    if (!(await sleepUnlessSuperseded(LEVEL_SYNC_RETRY_DELAY_MS, generation))) {
      log(`Level sync: superseded by a newer command -- abandoning retries for level ${target}`);
      return;
    }

    let current;
    try {
      current = await dirigera.blinds.list();
    } catch (err) {
      logError(`Level sync attempt ${pass}: failed to list blinds, retrying same set`, err);
      continue;
    }
    const byId = new Map(current.map((b) => [b.id, b]));

    const stillOff = [];
    for (const s of remaining) {
      const blind = byId.get(s.id);
      const level = blind?.attributes?.blindsCurrentLevel;
      if (typeof level !== "number") {
        log(`Level sync: "${s.name}" has no current-level reading, dropping from this sync`);
        continue;
      }
      if (atLevel(level, target)) continue;
      const skip = stillEligible(s, burst, commanded);
      if (skip) {
        log(`Level sync: dropping "${s.name}" -- ${skip}`);
        continue;
      }
      stillOff.push(s);
    }

    if (stillOff.length === 0) {
      log(`Level sync: all blinds reached level ${target} after attempt ${pass}.`);
      return;
    }
    remaining = stillOff;
  }

  log(
    `Level sync: gave up after ${LEVEL_SYNC_MAX_RETRIES} attempt(s); still off level ${target}: ${remaining.map((b) => b.name).join(", ")}`
  );
}

async function evaluateBurst() {
  burstSettleTimer = null;
  const burst = new Map(burstTargets);
  burstTargets.clear();
  burstStartedAt = 0;

  // Cheap rejections first, before spending a hub round-trip.
  if (burst.size < LEVEL_SYNC_MIN_BURST) {
    log(`Level sync: only ${burst.size} blind(s) commanded, not a house-wide change -- ignoring`);
    return;
  }
  if (sunsetSequenceActive) {
    log("Level sync: sunset close sequence in progress -- standing down");
    return;
  }

  // A sync for an older command is still winding down. Its generation check has
  // already been tripped, so wait for it rather than dropping this burst.
  if (levelSyncPromise) {
    log("Level sync: waiting for the superseded sync to stand down...");
    try {
      await levelSyncPromise;
    } catch (err) {
      logError("Level sync: previous sync ended badly", err);
    }
  }

  let blinds;
  try {
    blinds = await dirigera.blinds.list();
  } catch (err) {
    logError("Level sync: failed to list blinds", err);
    return;
  }

  const plan = planLevelSync(blinds, burst, levelSyncConfig());

  if (plan.skipped?.length) {
    log(`Level sync: leaving alone -- ${plan.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`);
  }
  if (plan.action === "ignore") {
    log(`Level sync: ${plan.reason} -- ignoring`);
    return;
  }

  const { consensus, target, nudging, agreeing, candidateCount, stragglers } = plan;
  if (nudging) {
    log(`Level sync: house opened fully (level 0) -- nudging to level ${target} (${100 - target}% open)`);
  }
  log(
    `Level sync: house consensus is level ${consensus} (${agreeing}/${candidateCount}); driving ${stragglers.length} blind(s) to level ${target}: ` +
      stragglers.map((b) => `${b.name} [at ${b.level}, ${b.mode}]`).join(", ")
  );

  const generation = burstGeneration;
  levelSyncPromise = syncStragglers(target, stragglers, burst, consensus, generation);
  try {
    await levelSyncPromise;
  } finally {
    levelSyncPromise = null;
  }
}

function noteBlindTargetChange(blindId, target) {
  const now = Date.now();
  if (burstTargets.size === 0) {
    burstStartedAt = now;
    // New external command: any sync still retrying the old level stands down.
    burstGeneration++;
  }
  burstTargets.set(blindId, target);

  // Debounce until the commands stop arriving, but never defer past the cap --
  // otherwise a slow trickle of changes could postpone evaluation forever.
  if (burstSettleTimer) clearTimeout(burstSettleTimer);
  const remainingBudget = LEVEL_SYNC_MAX_BURST_MS - (now - burstStartedAt);
  const wait = Math.max(0, Math.min(LEVEL_SYNC_SETTLE_MS, remainingBudget));
  burstSettleTimer = setTimeout(() => {
    evaluateBurst().catch((err) => logError("Level sync evaluation failed", err));
  }, wait);
}

function onDirigeraEvent(event) {
  if (event?.type === "termination") {
    log(`Dirigera event stream termination signal: ${event.data?.signal} (client will reconnect)`);
    return;
  }
  if (event?.type !== "deviceStateChanged") return;
  if (event.data?.deviceType !== "blinds") return;

  const target = event.data.attributes?.blindsTargetLevel;
  if (typeof target !== "number") return;
  if (isSelfCommanded(event.data.id)) return;

  noteBlindTargetChange(event.data.id, target);
}

function startLevelSyncWatch() {
  dirigera.startListeningForUpdates((event) => {
    try {
      onDirigeraEvent(event);
    } catch (err) {
      logError("Dirigera event handler failed", err);
    }
  });
  log(
    `Level-sync retry active: ${LEVEL_SYNC_MAX_RETRIES} attempt(s), ${LEVEL_SYNC_RETRY_DELAY_MS / 1000}s apart, ` +
      `settle ${LEVEL_SYNC_SETTLE_MS / 1000}s, min burst ${LEVEL_SYNC_MIN_BURST}, max ${LEVEL_SYNC_MAX_STRAGGLERS} straggler(s)`
  );
}

// ---------------------------------------------------------------------------
// Sunset scheduling
// ---------------------------------------------------------------------------

function computeNextSunset() {
  const now = new Date();
  const today = SunCalc.getTimes(now, LATITUDE, LONGITUDE).sunset;
  if (today > now) return today;
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return SunCalc.getTimes(tomorrow, LATITUDE, LONGITUDE).sunset;
}

function scheduleSunset(sensors) {
  const next = computeNextSunset();
  const delayMs = next.getTime() - Date.now();
  log(`Next sunset: ${next.toISOString()} (in ${Math.round(delayMs / 60000)}min)`);
  setTimeout(async () => {
    try {
      await onSunset(sensors);
    } catch (err) {
      logError("Sunset handler failed", err);
    }
    scheduleSunset(sensors);
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Sensor subscription + transition dispatch
// ---------------------------------------------------------------------------

function inNightWindow() {
  const now = new Date();
  const today = SunCalc.getTimes(now, LATITUDE, LONGITUDE);
  return now >= today.sunset || now < today.sunrise;
}

function onSensorTransition(sensor, nowOpen) {
  if (nowOpen) {
    // If any mapped sensor reopens during the grace window, cancel the close.
    for (const pending of pendingCloses.values()) {
      if (pending.sensorIds.has(sensor.id) && pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
        log(`"${sensor.name}" reopened -- cancelling close timer for "${pending.blindName}"`);
      }
    }
    return;
  }

  // A mapped sensor just closed. Start the grace timer only if ALL mapped sensors are closed.
  for (const [blindId, pending] of pendingCloses) {
    if (!pending.sensorIds.has(sensor.id) || pending.timer) continue;
    const stillOpen = [...pending.sensorIds].filter((id) => isSensorOpen(id));
    if (stillOpen.length > 0) {
      const names = stillOpen.map((id) => sensorState.get(id)?.name || id);
      log(`"${sensor.name}" closed -- "${pending.blindName}" still waiting on: ${names.join(", ")}`);
      continue;
    }
    log(`All sensors closed for "${pending.blindName}" -- closing in ${POST_CLOSE_DELAY_SECONDS}s`);
    pending.timer = setTimeout(async () => {
      if (!inNightWindow()) {
        log(`Skipping deferred close for "${pending.blindName}" -- now past sunrise`);
        pendingCloses.delete(blindId);
        return;
      }
      await closeBlind(blindId, pending.blindName);
      pendingCloses.delete(blindId);
    }, POST_CLOSE_DELAY_SECONDS * 1000);
  }
}

function subscribeSensors(sensors, ringApi, targetCamera) {
  for (const sensor of sensors) {
    sensorState.set(sensor.id, { name: sensor.name, isOpen: !!sensor.data.faulted });
    log(`Watching: "${sensor.name}" (open=${!!sensor.data.faulted})`);

    sensor.onData.subscribe((data) => {
      const prev = sensorState.get(sensor.id);
      const nowOpen = !!data.faulted;
      sensorState.set(sensor.id, { name: sensor.name, isOpen: nowOpen });

      if (prev?.isOpen === nowOpen) return;

      log(`Sensor "${sensor.name}" -> ${nowOpen ? "OPEN" : "CLOSED"}`);

      if (nowOpen && nameMatches(sensor.name, SENSOR_NAME)) {
        maybeSnooze(ringApi, targetCamera);
      }

      onSensorTransition(sensor, nowOpen);
    });
  }
}

// ---------------------------------------------------------------------------
// Smoke/CO -> SmartThings lock auto-unlock
// ---------------------------------------------------------------------------
//
// Life-safety automation: when a Ring smoke/CO device reports an ACTIVE alarm,
// send the unlock command to the Ultraloq lock via SmartThings. Unlock only --
// we never re-lock during an alarm; you relock manually once it's clear.
// Cloud-dependent, but so is the Ring smoke trigger itself (the hub event
// arrives over Ring's cloud), so a local unlock would gain nothing here. Treat
// it as a supplement to, not a replacement for, normal egress.

// Known smoke/CO device types (undefined enum members dropped). We also match
// by pattern below so a dedicated alarm isn't missed if the enum name drifts.
const SMOKE_CO_TYPES = new Set(
  [RingDeviceType.SmokeAlarm, RingDeviceType.CoAlarm, RingDeviceType.SmokeCoListener].filter(Boolean)
);

// True for smoke/CO alarms and listeners. The pattern catches types like
// "alarm.smoke", "sensor.co", "listener.smoke-co" without matching unrelated
// devices (e.g. "sensor.contact" -- "co" there isn't token-bounded).
function isSmokeCoDevice(device) {
  const type = String(device?.data?.deviceType || "");
  if (SMOKE_CO_TYPES.has(type)) return true;
  if (/smoke|(^|[.\-])co([.\-]|$)/i.test(type)) return true;
  // Safety net: match by name too, for a detector whose type we don't
  // recognize. Watching a mislabeled device is harmless -- an unlock still
  // requires an actually-active alarm status (isAlarmActive), which a
  // non-alarm device never reports.
  const name = String(device?.name || "");
  return /smoke|carbon monoxide/i.test(name);
}

// Ring exposes alarm state differently across smoke/CO device types: a
// top-level alarmStatus on dedicated alarms, and nested smoke/co blocks on the
// combined listener. Any "active" among them counts as an alarm.
function isAlarmActive(data) {
  if (!data || typeof data !== "object") return false;
  const statuses = [data.alarmStatus, data.smoke?.alarmStatus, data.co?.alarmStatus];
  // Ring "Bluejay" smoke/CO detectors (comp.bluejay.sensor_bluejay_sc) don't use
  // the listener's top-level smoke/co fields; they nest alarm state under
  // components["alarm.smoke"] / ["alarm.co"] (plus a low-level-CO status).
  // Confirmed by watching a live device's data. We deliberately ignore
  // components["alarm.end-of-life"] -- that's a device-replacement warning,
  // not a fire -- and pushToTest, which is the self-test button, not an alarm.
  const comp = data.components || {};
  for (const key of ["alarm.smoke", "alarm.co"]) {
    const c = comp[key];
    if (c) statuses.push(c.alarmStatus, c.lowLevelAlarmStatus);
  }
  return statuses.some((s) => s === "active");
}

// The canonical "there is an active fire/CO alarm" signal in Ring Alarm lives on
// the security panel's alarmInfo.state -- individual smoke/CO detectors don't
// reliably flip their own alarmStatus in the data shadow (confirmed on real
// hardware). Watching the panel catches ANY smoke/CO detector at once.
const FIRE_CO_ALARM_STATES = new Set([
  "fire-alarm",
  "co-alarm",
  "user-verified-co-or-fire-alarm",
  "fire-accelerated-alarm",
]);

function panelFireCoState(data) {
  const state = data?.alarmInfo?.state;
  return state && FIRE_CO_ALARM_STATES.has(state) ? state : null;
}

const UNLOCK_MAX_ATTEMPTS = 5;
const UNLOCK_RETRY_DELAY_MS = 3000;

// Cooldown timer starts only after a SUCCESSFUL unlock. `unlockInProgress`
// guards against overlapping attempts so concurrent triggers (panel + a
// device firing at once) can never send two commands mid-retry.
let lastUnlockSuccessTime = 0;
let unlockInProgress = false;

async function triggerSmokeUnlock(stClient, sourceName) {
  const elapsed = (Date.now() - lastUnlockSuccessTime) / 1000;
  if (lastUnlockSuccessTime && elapsed < SMOKE_UNLOCK_COOLDOWN_SECONDS) {
    log(`SMOKE/CO ALARM (${sourceName}) -- already unlocked ${Math.round(elapsed)}s ago (cooldown ${SMOKE_UNLOCK_COOLDOWN_SECONDS}s), skipping`);
    return;
  }
  if (unlockInProgress) {
    log(`SMOKE/CO ALARM (${sourceName}) -- unlock already in progress, skipping duplicate trigger`);
    return;
  }
  unlockInProgress = true;
  log(`>>> SMOKE/CO ALARM ACTIVE (${sourceName}) -- UNLOCKING SmartThings lock ${ST_LOCK_DEVICE_ID}`);
  try {
    for (let attempt = 1; attempt <= UNLOCK_MAX_ATTEMPTS; attempt++) {
      try {
        await stClient.unlockLock(ST_LOCK_DEVICE_ID);
        lastUnlockSuccessTime = Date.now(); // cooldown starts only on success
        log(`>>> Unlock command sent to SmartThings (attempt ${attempt}).`);
        return;
      } catch (err) {
        logError(`Unlock attempt ${attempt}/${UNLOCK_MAX_ATTEMPTS} failed`, err);
        if (attempt < UNLOCK_MAX_ATTEMPTS) await sleep(UNLOCK_RETRY_DELAY_MS);
      }
    }
    // No cooldown set on total failure -- the next alarm update re-triggers,
    // so an active alarm keeps retrying in bursts until it gets through.
    logError(`Unlock failed after ${UNLOCK_MAX_ATTEMPTS} attempts -- will retry on the next alarm update`);
  } finally {
    unlockInProgress = false;
  }
}

function setupSmokeUnlock(devices, stClient) {
  const smokeDevices = devices.filter(isSmokeCoDevice);
  if (smokeDevices.length === 0) {
    log("WARN: smoke-unlock enabled but no smoke/CO devices found on the hub.");
    return;
  }
  for (const dev of smokeDevices) {
    const active = isAlarmActive(dev.data);
    // Log the raw data shape so we can confirm isAlarmActive reads the right
    // fields for each device model (types differ between listener and detector).
    log(`Watching smoke/CO device: "${dev.name}" (${dev.data.deviceType}, alarmActive=${active})`);
    if (active) triggerSmokeUnlock(stClient, dev.name);

    dev.onData.subscribe((data) => {
      if (isAlarmActive(data)) {
        log(`Smoke/CO device "${dev.name}" reports ALARM ACTIVE`);
        triggerSmokeUnlock(stClient, dev.name);
      }
    });
  }
}

// Watch the Ring Alarm security panel's alarmInfo for a fire/CO alarm -- the
// primary, device-agnostic detection path.
function setupPanelAlarmWatch(devices, stClient) {
  const panel =
    devices.find((d) => d.data.deviceType === RingDeviceType.SecurityPanel) ||
    devices.find((d) => String(d.data.deviceType).includes("security-panel"));
  if (!panel) {
    log("WARN: no security panel found -- panel-based fire/CO detection disabled.");
    return;
  }
  log(`Watching security panel "${panel.name}" for fire/CO alarm (alarmInfo.state=${panel.data?.alarmInfo?.state || "none"})`);
  const initial = panelFireCoState(panel.data);
  if (initial) triggerSmokeUnlock(stClient, `panel:${initial}`);

  let lastPanelState = panel.data?.alarmInfo?.state;
  panel.onData.subscribe((data) => {
    // Log any alarm-state transition -- quiet normally, an audit trail during
    // any alarm, and confirms the panel is delivering alarmInfo.
    const s = data?.alarmInfo?.state;
    if (s !== lastPanelState) {
      log(`Security panel alarmInfo.state: ${lastPanelState || "none"} -> ${s || "none"}`);
      lastPanelState = s;
    }
    const state = panelFireCoState(data);
    if (state) {
      log(`>>> Security panel reports FIRE/CO ALARM: ${state}`);
      triggerSmokeUnlock(stClient, `panel:${state}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("Ring local enhancements (camera snooze + Dirigera sunset gate)");
  log(`  Snooze sensor: "${SENSOR_NAME}" -> camera: "${CAMERA_NAME}" (${SNOOZE_MINUTES}min, ${COOLDOWN_SECONDS}s cooldown)`);
  if (blindsEnabled) {
    log(`  Dirigera: ${DIRIGERA_HOST} | lat,lon: ${LATITUDE},${LONGITUDE} | post-close delay: ${POST_CLOSE_DELAY_SECONDS}s`);
    log(`  Blind mapping: ${Object.keys(blindMap).length ? JSON.stringify(blindMap) : "(none)"}`);
  } else {
    log("  Dirigera disabled (missing DIRIGERA_HOST / DIRIGERA_TOKEN / LATITUDE / LONGITUDE)");
  }
  if (smokeUnlockEnabled) {
    log(`  Smoke-unlock: armed -> SmartThings lock ${ST_LOCK_DEVICE_ID} (cooldown ${SMOKE_UNLOCK_COOLDOWN_SECONDS}s)`);
  } else {
    log("  Smoke-unlock disabled (missing ST_CLIENT_ID / ST_CLIENT_SECRET / ST_REFRESH_TOKEN / ST_LOCK_DEVICE_ID)");
  }

  const ringApi = new RingApi({
    refreshToken: REFRESH_TOKEN,
    cameraStatusPollingSeconds: 20,
    debug: false,
  });

  ringApi.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    log("Refresh token updated -- saving to .env");
    const envPath = resolve(__dirname, ".env");
    let content = readFileSync(envPath, "utf-8");
    content = content.replace(/RING_REFRESH_TOKEN=.*/, `RING_REFRESH_TOKEN=${newRefreshToken}`);
    writeFileSync(envPath, content);
  });

  const locations = await ringApi.getLocations();
  const location = locations[0];
  if (!location) {
    logError("No locations found.");
    process.exit(1);
  }
  log(`Location: "${location.name}" (id: ${location.id})`);

  const targetCamera = location.cameras.find((c) => nameMatches(c.name, CAMERA_NAME));
  if (!targetCamera) {
    logError(`No camera matching "${CAMERA_NAME}"`);
    log(`Available: ${location.cameras.map((c) => c.name).join(", ")}`);
    process.exit(1);
  }
  log(`Target camera: "${targetCamera.name}"`);

  if (!location.hasHubs) {
    logError("No alarm hub at this location");
    process.exit(1);
  }

  log("Connecting to alarm hub WebSocket...");

  const MAX_ATTEMPTS = 3;
  const TIMEOUT_MS = 30000;
  let devices = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      devices = await Promise.race([
        location.getDevices(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
        ),
      ]);
      log(`Connected. Got ${devices.length} devices.`);
      break;
    } catch (err) {
      logError(`Hub connection attempt ${attempt}/${MAX_ATTEMPTS} failed`, err);
      if (attempt < MAX_ATTEMPTS) {
        try { location.disconnect(); } catch (_) {}
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }

  if (!devices) {
    logError("Could not connect to alarm hub after all attempts.");
    process.exit(1);
  }

  // Pick every contact sensor we care about: the snooze sensor + every sensor
  // referenced by the blind mapping.
  const allContact = devices.filter((d) => d.data.deviceType === RingDeviceType.ContactSensor);
  const mappedSensorKeys = Object.values(blindMap).flat();
  const wanted = new Set([SENSOR_NAME, ...mappedSensorKeys.map((s) => s.toLowerCase())]);
  const sensors = allContact.filter((d) =>
    [...wanted].some((k) => nameMatches(d.name, k))
  );

  if (sensors.length === 0) {
    logError(`No contact sensors matched any of: ${[...wanted].join(", ")}`);
    log(`Available: ${allContact.map((d) => d.name).join(", ")}`);
    process.exit(1);
  }

  // Warn about mapping entries that don't resolve to a real sensor.
  for (const sensorKey of mappedSensorKeys) {
    if (!findSensorByKey(sensors, sensorKey)) {
      log(`WARN: mapping references sensor "${sensorKey}" but no contact sensor matches.`);
    }
  }

  subscribeSensors(sensors, ringApi, targetCamera);

  if (smokeUnlockEnabled) {
    try {
      const stClient = createSmartThingsClient({
        clientId: ST_CLIENT_ID,
        clientSecret: ST_CLIENT_SECRET,
        refreshToken: ST_REFRESH_TOKEN,
        onRefreshToken: (t) => {
          log("SmartThings refresh token rotated -- saving to .env");
          persistEnvVar("ST_REFRESH_TOKEN", t);
        },
      });
      setupSmokeUnlock(devices, stClient);
      setupPanelAlarmWatch(devices, stClient);

      // Keep the token warm. Two reasons this matters for a life-safety path:
      //  1. An unlock never has to wait on (or fail from) a cold refresh mid-alarm.
      //  2. SmartThings refresh tokens expire in ~30 days and rotate on use, so
      //     without periodic refreshes a month of quiet would silently expire the
      //     token. Refreshing well inside that window keeps it alive and rotating.
      const keepTokenFresh = async () => {
        try {
          await stClient.ensureAccessToken();
        } catch (err) {
          logError("SmartThings token keepalive failed -- unlock may not work until fixed", err);
        }
      };
      await keepTokenFresh(); // validate creds now, surfacing problems at startup
      setInterval(keepTokenFresh, 12 * 60 * 60 * 1000).unref();
    } catch (err) {
      logError("SmartThings setup failed -- smoke-unlock disabled this run", err);
    }
  }

  if (blindsEnabled) {
    try {
      await connectDirigera();
      scheduleSunset(sensors);
      if (LEVEL_SYNC_ENABLED) startLevelSyncWatch();
      else log("Level-sync retry disabled (BLIND_LEVEL_SYNC_ENABLED=false)");
    } catch (err) {
      logError("Dirigera setup failed -- blind automation disabled this run", err);
    }
  }

  log("Automation active.");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function shutdown(signal) {
  log(`Shutting down (${signal})...`);
  try { dirigera?.stopListeningForUpdates(); } catch (_) {}
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => logError("Unhandled rejection", err));

main().catch((err) => {
  logError("Fatal error", err);
  process.exit(1);
});
