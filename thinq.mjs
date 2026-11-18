/**
 * LG ThinQ Connect API client (the official cloud API behind the ThinQ app).
 *
 * Covers what the thermostat feature needs: list devices, read a device's
 * state, and send control commands.
 *
 *   - Devices:  GET  {base}/devices
 *   - Profile:  GET  {base}/devices/{id}/profile   (what each property accepts)
 *   - State:    GET  {base}/devices/{id}/state
 *   - Control:  POST {base}/devices/{id}/control   (one property group per call)
 *
 * Auth is a Personal Access Token from https://connect-pat.lgthinq.com. The
 * other headers are what LG's own SDK (thinq-connect/pythinqconnect) sends:
 * x-api-key is the fixed key published in that SDK, not a secret of ours, and
 * x-client-id is any id that stays stable for this installation.
 *
 * The device refuses most writes while it is powered off ("Command not
 * supported in POWER OFF"), so power it on before setting mode or temperature.
 */

import { randomUUID } from "crypto";

const API_KEY = "v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3";
const REQUEST_TIMEOUT_MS = 20000;

/** Region host by ThinQ region: AIC = Americas, EIC = Europe/Middle East/Africa, KIC = Asia/Pacific. */
export const regionBase = (region = "AIC") => `https://api-${region.toLowerCase()}.lgthinq.com`;

/** 22-character URL-safe message id, the format LG's SDK uses. */
function messageId() {
  return Buffer.from(randomUUID().replace(/-/g, ""), "hex").toString("base64url").slice(0, 22);
}

export function createThinqClient({ token, clientId, country = "US", region = "AIC" }) {
  const base = regionBase(region);

  async function call(method, path, body, extraHeaders = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "x-country": country,
        "x-message-id": messageId(),
        "x-client-id": clientId,
        "x-api-key": API_KEY,
        "x-service-phase": "OP",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.error) {
      const e = json?.error;
      throw new Error(`ThinQ ${method} ${path} ${res.status}: ${e ? `${e.message} (${e.code})` : "no body"}`);
    }
    return json?.response;
  }

  return {
    /** [{ deviceId, deviceInfo: { deviceType, modelName, alias } }] */
    listDevices() {
      return call("GET", "/devices");
    },
    getProfile(deviceId) {
      return call("GET", `/devices/${deviceId}/profile`);
    },
    getState(deviceId) {
      return call("GET", `/devices/${deviceId}/state`);
    },
    /** `payload` is one property group, e.g. { operation: { airConOperationMode: "POWER_ON" } }. */
    control(deviceId, payload) {
      return call("POST", `/devices/${deviceId}/control`, payload, { "x-conditional-control": "true" });
    },
  };
}

// --- Air-conditioner helpers (the ducted "Central Air" reports as one) -------

/**
 * Flatten an air-conditioner state into what the thermostat logic uses, in °F.
 * The °F block of temperatureInUnits is preferred: its readings are whole
 * degrees F, finer than the whole degrees C of the top-level block.
 */
export function summarizeAcState(state) {
  const f = (state?.temperatureInUnits || []).find((t) => t.unit === "F");
  const c = state?.temperature;
  const toF = (v) => (Number.isFinite(v) ? Math.round((v * 9) / 5 + 32) : null);
  return {
    power: state?.operation?.airConOperationMode === "POWER_ON",
    mode: state?.airConJobMode?.currentJobMode ?? null,
    indoorF: f?.currentTemperature ?? toF(c?.currentTemperature),
    targetF: f?.targetTemperature ?? toF(c?.targetTemperature),
    minTargetF: f?.minTargetTemperature ?? toF(c?.minTargetTemperature),
    runState: state?.runState?.currentState ?? null,
  };
}

export const acCommands = {
  power: (on) => ({ operation: { airConOperationMode: on ? "POWER_ON" : "POWER_OFF" } }),
  mode: (mode) => ({ airConJobMode: { currentJobMode: mode } }),
  heatTargetF: (f) => ({ temperatureInUnits: { heatTargetTemperature: f, unit: "F" } }),
};
