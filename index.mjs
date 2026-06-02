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
const BLIND_CLOSED_LEVEL = 100;
const BLIND_CLOSE_SPACING_MS = 10 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_RETRY_PASSES = 2;

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

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function logError(msg, err) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, err?.message || err);
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
      if (k.startsWith("_") || typeof v !== "string") continue;
      cleaned[k] = v;
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

function findSensorKeyForBlind(blindName) {
  for (const [blindKey, sensorKey] of Object.entries(blindMap)) {
    if (nameMatches(blindName, blindKey)) return sensorKey;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sensor state + pending blind closes
// ---------------------------------------------------------------------------

// sensorId -> { name, isOpen }
const sensorState = new Map();

// blindId -> { blindName, sensorId, sensorName, timer }
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

async function closeBlind(blindId, blindName) {
  try {
    await dirigera.blinds.setTargetLevel({ id: blindId, blindsTargetLevel: BLIND_CLOSED_LEVEL });
    log(`Closed blind "${blindName}"`);
  } catch (err) {
    logError(`Failed to close blind "${blindName}"`, err);
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
    const sensorKey = findSensorKeyForBlind(blindName);

    if (!sensorKey) {
      log(`"${blindName}": no sensor mapping, queued for sunset close`);
      toClose.push({ id: blind.id, name: blindName });
      continue;
    }

    const sensor = findSensorByKey(sensors, sensorKey);
    if (!sensor) {
      log(`WARN: mapped sensor "${sensorKey}" not found for blind "${blindName}", queued for sunset close`);
      toClose.push({ id: blind.id, name: blindName });
      continue;
    }

    if (isSensorOpen(sensor.id)) {
      log(`Deferring "${blindName}" -- sensor "${sensor.name}" is open`);
      pendingCloses.set(blind.id, {
        blindName,
        sensorId: sensor.id,
        sensorName: sensor.name,
        timer: null,
      });
    } else {
      log(`"${blindName}": sensor "${sensor.name}" is closed, queued for sunset close`);
      toClose.push({ id: blind.id, name: blindName });
    }
  }

  toClose.sort((a, b) => closeOrderIndex(a.name) - closeOrderIndex(b.name));
  if (toClose.length === 0) {
    log("Sunset: no blinds to close (all deferred or none mapped).");
    return;
  }
  log(`Sunset: closing ${toClose.length} blind(s), ${BLIND_CLOSE_SPACING_MS / 1000}s between each: ${toClose.map((b) => b.name).join(" -> ")}`);
  await closeBlindsSequentially(toClose);
  retryStillOpen(toClose, 1).catch((err) => logError("Sunset retry pass failed", err));
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

function onSensorTransition(sensor, nowOpen) {
  if (nowOpen) {
    // If the door reopens during the post-close grace window, cancel the close.
    for (const pending of pendingCloses.values()) {
      if (pending.sensorId === sensor.id && pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
        log(`"${sensor.name}" reopened -- cancelling close timer for "${pending.blindName}"`);
      }
    }
    return;
  }

  // Sensor just closed. Start the grace timer for any blinds waiting on it.
  for (const [blindId, pending] of pendingCloses) {
    if (pending.sensorId !== sensor.id || pending.timer) continue;
    log(`"${sensor.name}" closed -- closing "${pending.blindName}" in ${POST_CLOSE_DELAY_SECONDS}s`);
    pending.timer = setTimeout(async () => {
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
  const wanted = new Set([SENSOR_NAME, ...Object.values(blindMap).map((s) => s.toLowerCase())]);
  const sensors = allContact.filter((d) =>
    [...wanted].some((k) => nameMatches(d.name, k))
  );

  if (sensors.length === 0) {
    logError(`No contact sensors matched any of: ${[...wanted].join(", ")}`);
    log(`Available: ${allContact.map((d) => d.name).join(", ")}`);
    process.exit(1);
  }

  // Warn about mapping entries that don't resolve to a real sensor.
  for (const sensorKey of Object.values(blindMap)) {
    if (!findSensorByKey(sensors, sensorKey)) {
      log(`WARN: mapping references sensor "${sensorKey}" but no contact sensor matches.`);
    }
  }

  subscribeSensors(sensors, ringApi, targetCamera);

  if (blindsEnabled) {
    try {
      await connectDirigera();
      scheduleSunset(sensors);
    } catch (err) {
      logError("Dirigera setup failed -- blind automation disabled this run", err);
    }
  }

  log("Automation active.");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

process.on("SIGINT", () => { log("Shutting down (SIGINT)..."); process.exit(0); });
process.on("SIGTERM", () => { log("Shutting down (SIGTERM)..."); process.exit(0); });
process.on("unhandledRejection", (err) => logError("Unhandled rejection", err));

main().catch((err) => {
  logError("Fatal error", err);
  process.exit(1);
});
