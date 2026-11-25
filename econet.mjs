/**
 * Rheem EcoNet client: the unofficial cloud API the EcoNet app uses.
 *
 * Rheem publishes no API and the heater has no local one. This follows
 * pyeconet (github.com/w1ll1am23/pyeconet, the library behind Home
 * Assistant's EcoNet integration), so it can break whenever Rheem changes
 * their app:
 *
 *   - REST (ClearBlade platform) at https://rheem.rheemconnect.com/api/v/1:
 *     POST user/auth {email, password} -> a user token and account id;
 *     POST code/<system key>/getUserDataForApp -> every location's equipment
 *     and its current state ("@ENABLED", "@MODE", "@SETPOINT", ...).
 *   - Commands are MQTT messages to user/<account id>/device/desired on
 *     rheem.rheemconnect.com:1884 (TLS), signed in with the user token. The
 *     cloud never acknowledges them -- the only confirmation is the heater's
 *     state changing, which is why water-heater.mjs reconciles rather than
 *     trusting a send.
 *
 * The system key and secret are the app's own, shipped in every copy of it.
 * The password is only ever sent to Rheem's sign-in.
 */

import mqtt from "mqtt";

const HOST = "rheem.rheemconnect.com";
const SYSTEM_KEY = "e2e699cb0bb0bbb88fc8858cb5a401";
const SYSTEM_SECRET = "E2E699CB0BE6C6FADDB1B0BC9A20";
const BASE_HEADERS = {
  "ClearBlade-SystemKey": SYSTEM_KEY,
  "ClearBlade-SystemSecret": SYSTEM_SECRET,
  "Content-Type": "application/json; charset=UTF-8",
};

export function createEconetClient({ email, password, host = HOST, timeoutMs = 20_000 }) {
  let token = null;
  let accountId = null;

  async function post(path, body, withToken) {
    const res = await fetch(`https://${host}/api/v/1${path}`, {
      method: "POST",
      headers: { ...BASE_HEADERS, ...(withToken ? { "ClearBlade-UserToken": token } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`EcoNet ${path.split("/").pop()} ${res.status}`), { status: res.status });
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error(`EcoNet ${path.split("/").pop()}: not JSON`);
    }
  }

  async function login() {
    const j = await post("/user/auth", { email, password }, false);
    if (!j?.options?.success) throw new Error(`EcoNet sign-in rejected: ${j?.options?.message || "no reason given"}`);
    token = j.user_token;
    accountId = j.options.account_id;
  }

  // Tokens expire; one fresh sign-in on a rejection, then give up for this call.
  async function authed(path, body) {
    if (!token) await login();
    try {
      return await post(path, body, true);
    } catch (err) {
      if (!(err.status >= 400 && err.status < 500)) throw err;
      token = null;
      await login();
      return post(path, body, true);
    }
  }

  return {
    /** Every water heater on the account, as getUserDataForApp reports it. */
    async listWaterHeaters() {
      const j = await authed(`/code/${SYSTEM_KEY}/getUserDataForApp`, { resource: "friedrich" });
      if (!j?.success) throw new Error("EcoNet equipment list: unexpected response");
      // ("equiptments" is their spelling.)
      return (j.results?.locations ?? []).flatMap((l) => (l.equiptments ?? []).filter((e) => !e.error && e.device_type === "WH"));
    },

    /**
     * Send one command, e.g. {"@SETPOINT": 120}. Connects, publishes and
     * disconnects: commands are rare, and a held connection is one more thing
     * to go stale on the heater's flaky link. Resolves once the broker has it,
     * which says nothing about the heater -- check its state afterwards.
     */
    async publish(equip, payload) {
      if (!token) await login();
      const client = await mqtt.connectAsync(`mqtts://${host}:1884`, {
        username: token,
        password: SYSTEM_KEY,
        clientId: `${email}${String(Date.now()).slice(0, 13)}_android`,
        protocolVersion: 4,
        clean: true,
        connectTimeout: timeoutMs,
        reconnectPeriod: 0,
      });
      try {
        const now = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const transactionId = `ANDROID_${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
        const message = { transactionId, device_name: equip.device_name, serial_number: equip.serial_number, ...payload };
        // QoS 0, as pyeconet sends it -- what Rheem's broker is known to take.
        await client.publishAsync(`user/${accountId}/device/desired`, JSON.stringify(message), { qos: 0 });
      } finally {
        await client.endAsync().catch(() => {});
      }
    },
  };
}
