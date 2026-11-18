/**
 * Leviton smart load center (LDATA hub) -- READ ONLY.
 *
 * Used for display only: the heat pump breaker's live draw goes on the
 * dashboard. Nothing here writes to the panel, and nothing switches a breaker.
 * Switching a heat pump at the breaker cuts its crankcase heater and control
 * board and short-cycles the compressor; the ThinQ API is the control path.
 *
 * Leviton has no local API; this is the cloud API behind the My Leviton app
 * (https://my.leviton.com, a LoopBack server):
 *
 *   - Login:    POST /api/Person/login?include=user  {email, password} -> {id (token), ttl, userId}
 *   - Homes:    GET  /api/Person/{userId}/residentialPermissions -> residentialAccountId
 *               GET  /api/ResidentialAccounts/{id}/residences
 *   - Breakers: GET  /api/Residences/{id}/residentialBreakerPanels, filter include residentialBreakers
 *
 * The token goes in the Authorization header as-is (no "Bearer").
 */

const API = "https://my.leviton.com/api";
const REQUEST_TIMEOUT_MS = 15000;
// Log in again this long before the token's stated expiry.
const RELOGIN_MARGIN_MS = 60 * 60 * 1000;

export function createLevitonClient({ email, password, residenceId = null }) {
  let session = null; // { token, userId, expiresAt }
  let residence = residenceId;

  async function login() {
    const res = await fetch(`${API}/Person/login?include=user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.id) {
      const msg = json?.error?.message || res.statusText;
      if (/two ?factor/i.test(msg)) throw new Error("Leviton account uses two-factor authentication -- not supported here");
      throw new Error(`Leviton login ${res.status}: ${msg}`);
    }
    session = { token: json.id, userId: json.userId, expiresAt: Date.now() + (json.ttl || 1209600) * 1000 };
  }

  async function get(path, { filter } = {}, retried = false) {
    if (!session || Date.now() > session.expiresAt - RELOGIN_MARGIN_MS) await login();
    const url = new URL(`${API}${path}`);
    if (filter) url.searchParams.set("filter", JSON.stringify(filter));
    const res = await fetch(url, {
      // The filter goes both ways: as LoopBack's standard query param, and as
      // the header the My Leviton app itself sends.
      headers: { Authorization: session.token, Accept: "application/json", ...(filter ? { Filter: JSON.stringify(filter) } : {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 && !retried) {
      session = null; // token revoked or expired early -- one fresh login, then give up
      return get(path, { filter }, true);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Leviton GET ${path} ${res.status}: ${json?.error?.message || res.statusText}`);
    return json;
  }

  async function resolveResidence() {
    if (residence) return residence;
    if (!session) await login();
    const perms = await get(`/Person/${session.userId}/residentialPermissions`);
    const direct = perms.find((p) => p.residenceId)?.residenceId;
    if (direct) return (residence = direct);
    const accountId = perms.find((p) => p.residentialAccountId)?.residentialAccountId;
    if (!accountId) throw new Error("Leviton: no residence on this account");
    const homes = await get(`/ResidentialAccounts/${accountId}/residences`);
    if (!homes?.length) throw new Error("Leviton: no residence on this account");
    return (residence = homes[0].id);
  }

  return {
    /**
     * Every breaker on every panel, normalized by normalizeBreaker().
     *
     * Watts here are only as fresh as the panel's last report (see
     * lastUpdated): the hub reports quickly only while the My Leviton app has
     * it in fast mode, which takes a write we deliberately don't make. Often
     * an hour old.
     */
    async listBreakers() {
      const id = await resolveResidence();
      const panels = await get(`/Residences/${id}/residentialBreakerPanels`, { filter: { include: ["residentialBreakers"] } });
      return (panels || []).flatMap((p) => (p.residentialBreakers || []).map(normalizeBreaker));
    },

    /**
     * Hourly energy for one local calendar day, per breaker position:
     * { [position]: [{ hour: "YYYY-MM-DD HH:00", kWh, cost }] }. The hours are
     * local to `timezone`; hours still to come read 0.
     */
    async hourlyEnergy(day, timezone) {
      const id = await resolveResidence();
      const json = await get(`/Residences/getAllEnergyConsumptionForDay?${new URLSearchParams({ startDay: day, timezone, id })}`);
      return parseHourlyEnergy(json);
    },
  };
}

export function parseHourlyEnergy(json) {
  const out = {};
  for (const panel of Object.values(json || {})) {
    for (const [position, rows] of Object.entries(panel?.residentialBreakers || {})) {
      out[position] = (rows || []).map((r) => ({
        hour: String(r.timestamp).slice(0, 16),
        kWh: Number.isFinite(+r.energyConsumption) ? +r.energyConsumption : 0,
        cost: Number.isFinite(+r.totalCost) ? +r.totalCost : null,
      }));
    }
  }
  return out;
}

/**
 * The fields the dashboard shows. `power` is per leg: a two-pole breaker (the
 * heat pump) reports one leg, so the draw is power x poles -- unless the panel
 * reports both legs separately (power2), in which case they're summed.
 */
export function normalizeBreaker(b) {
  const num = (v) => (Number.isFinite(+v) && v !== null && v !== "" ? +v : null);
  const p1 = num(b.power);
  const p2 = num(b.power2);
  const poles = num(b.poles) || 1;
  return {
    id: b.id ?? null,
    name: b.name || `Breaker ${b.position ?? "?"}`,
    position: num(b.position),
    poles,
    watts: p1 == null ? null : p2 != null ? p1 + p2 : p1 * poles,
    amps: num(b.rmsCurrent),
    volts: num(b.rmsVoltage),
    state: b.currentState ?? null,
    // Cumulative counter where the panel reports one; units as Leviton sends them (kWh).
    energyKWh: num(b.energyConsumption),
    lastUpdated: b.lastUpdated ?? b.updatedAt ?? null,
  };
}

/** The breaker whose name matches exactly, else contains, `name` (case-insensitive). */
export function findBreaker(breakers, name) {
  const want = String(name).toLowerCase();
  return breakers.find((b) => b.name.toLowerCase() === want) || breakers.find((b) => b.name.toLowerCase().includes(want)) || null;
}
