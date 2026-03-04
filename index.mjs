/**
 * Ring Door Sensor -> Camera Smart Alert Snooze
 *
 * Temporarily disables "Person Detected" push notifications 
 * when a door is opened, while keeping video recording active.
 */

import { RingApi, RingDeviceType } from "ring-client-api";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Env Setup
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

if (!REFRESH_TOKEN) {
  console.error("RING_REFRESH_TOKEN is required.");
  process.exit(1);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function logError(msg, err) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, err?.message || err);
}

// ---------------------------------------------------------------------------
// Smart Alert Toggle Logic
// ---------------------------------------------------------------------------

// Keep track of timers so we don't overlap if the door opens multiple times
const activeReenableTimers = {};

async function snoozeCamera(ringApi, camera, minutes) {
  const deviceUrl = `https://api.ring.com/devices/v1/devices/${camera.id}/settings`;

  log(`>>> Disabling Person notifications on "${camera.name}" for ${minutes} min...`);

  try {
    // 1. Turn OFF the human notification
    await ringApi.restClient.request({
      url: deviceUrl,
      method: "PATCH",
      json: {
        cv_settings: {
          detection_types: {
            human: {
              enabled: true,
              mode: "edge",
              notification: false // <-- The magic toggle
            }
          }
        }
      },
    });
    log(">>> Person notification DISABLED (Recording is still active).");

    // Clear any existing timer for this specific camera
    if (activeReenableTimers[camera.id]) {
      clearTimeout(activeReenableTimers[camera.id]);
    }

    // 2. Schedule re-enable
    activeReenableTimers[camera.id] = setTimeout(async () => {
      log(`>>> ${minutes} min passed. Re-enabling Person notifications for "${camera.name}"...`);
      try {
        await ringApi.restClient.request({
          url: deviceUrl,
          method: "PATCH",
          json: {
            cv_settings: {
              detection_types: {
                human: {
                  enabled: true,
                  mode: "edge",
                  notification: true // <-- Turn it back on
                }
              }
            }
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

// ---------------------------------------------------------------------------
// Main Logic
// ---------------------------------------------------------------------------

async function main() {
  log("Ring Door Sensor -> Camera Smart Alert Snooze");
  log(`  Sensor: "${SENSOR_NAME}" | Camera: "${CAMERA_NAME}"`);
  log(`  Snooze: ${SNOOZE_MINUTES}min | Cooldown: ${COOLDOWN_SECONDS}s`);

  const ringApi = new RingApi({
    refreshToken: REFRESH_TOKEN,
    cameraStatusPollingSeconds: 20,
    debug: false, // Turned off debug so it doesn't flood your logs once working
  });

  ringApi.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    log("Refresh token updated -- saving to .env");
    const envPath = resolve(__dirname, ".env");
    let content = readFileSync(envPath, "utf-8");
    content = content.replace(
      /RING_REFRESH_TOKEN=.*/,
      `RING_REFRESH_TOKEN=${newRefreshToken}`
    );
    writeFileSync(envPath, content);
  });

  const locations = await ringApi.getLocations();
  const location = locations[0];
  if (!location) {
    logError("No locations found.");
    process.exit(1);
  }
  log(`Location: "${location.name}" (id: ${location.id})`);

  // Find camera
  const targetCamera = location.cameras.find((c) =>
    c.name.toLowerCase().includes(CAMERA_NAME)
  );
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

  log("\nAttempting to connect to alarm hub WebSocket...");

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
      log(`Connected! Got ${devices.length} devices.`);
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

  const contactSensors = devices.filter(
    (d) =>
      d.data.deviceType === RingDeviceType.ContactSensor &&
      d.name.toLowerCase().includes(SENSOR_NAME)
  );

  if (contactSensors.length === 0) {
    logError(`No contact sensor matching "${SENSOR_NAME}"`);
    process.exit(1);
  }

  let lastSnoozeTime = 0;

  for (const sensor of contactSensors) {
    log(`Watching: "${sensor.name}" (faulted=${sensor.data.faulted})`);

    sensor.onData.subscribe((data) => {
      if (data.faulted) {
        const now = Date.now();
        const elapsed = (now - lastSnoozeTime) / 1000;

        if (elapsed < COOLDOWN_SECONDS) {
          log(`Door opened -- cooldown active (${Math.round(elapsed)}s/${COOLDOWN_SECONDS}s)`);
          return;
        }

        log(`\n>>> DOOR OPENED -- Triggering automation...`);
        lastSnoozeTime = now;

        snoozeCamera(ringApi, targetCamera, SNOOZE_MINUTES);
      } else {
        log("Door CLOSED");
      }
    });
  }

  log("\nAutomation active! Listening for door events...");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

process.on("SIGINT", () => {
  log("Shutting down (SIGINT)...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  log("Shutting down (SIGTERM)...");
  process.exit(0);
});
process.on("unhandledRejection", (err) => logError("Unhandled rejection", err));

main().catch((err) => {
  logError("Fatal error", err);
  process.exit(1);
});
