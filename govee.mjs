/**
 * Govee cloud API client (Developer API v2, "router" endpoints).
 *
 * Covers what this project needs: list devices, list a device's light scenes,
 * switch power, and set a scene.
 *
 *   - Devices:  GET  https://openapi.api.govee.com/router/api/v1/user/devices
 *   - Scenes:   POST https://openapi.api.govee.com/router/api/v1/device/scenes
 *   - Control:  POST https://openapi.api.govee.com/router/api/v1/device/control
 *
 * Auth is a static API key in the Govee-API-Key header (request one in the
 * Govee Home app: Profile -> Settings -> Apply for API Key). The account is
 * rate limited to 10,000 requests a day, which a few commands a night is
 * nowhere near.
 */

import { randomUUID } from "crypto";

export const API_BASE = "https://openapi.api.govee.com/router/api/v1";
const REQUEST_TIMEOUT_MS = 15000;

export function createGoveeClient({ apiKey }) {
  async function call(method, path, payload) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { "Govee-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: payload ? JSON.stringify({ requestId: randomUUID(), payload }) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    // Govee reports failures in the body's `code` as well as the HTTP status.
    if (!res.ok || json?.code !== 200) {
      throw new Error(`Govee ${method} ${path} ${res.status}: ${json?.msg || json?.message || "no body"}`);
    }
    return json;
  }

  const control = (device, type, instance, value) =>
    call("POST", "/device/control", { sku: device.sku, device: device.device, capability: { type, instance, value } });

  return {
    /** [{ sku, device, deviceName, type, capabilities }] */
    async listDevices() {
      return (await call("GET", "/user/devices")).data || [];
    },

    /** The device's built-in light scenes: [{ name, value }]. */
    async listScenes(device) {
      const json = await call("POST", "/device/scenes", { sku: device.sku, device: device.device });
      const cap = (json.payload?.capabilities || []).find((c) => c.instance === "lightScene");
      return cap?.parameters?.options || [];
    },

    setPower(device, on) {
      return control(device, "devices.capabilities.on_off", "powerSwitch", on ? 1 : 0);
    },

    /** `value` is a scene's opaque { paramId, id } from listScenes. */
    setScene(device, value) {
      return control(device, "devices.capabilities.dynamic_scene", "lightScene", value);
    },
  };
}
