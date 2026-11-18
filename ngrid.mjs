/**
 * National Grid Upstate NY (Niagara Mohawk) electric prices for a
 * time-of-use account, fetched once a day for the dashboard's cost figures.
 *
 * Two public sources, both on nationalgridus.com:
 *
 *   - Supply ($/kWh, changes daily, by load zone and service class): the
 *     "Electric Supply Charge" lookup on the Supply Costs page. That page
 *     embeds an app (brp.nationalgrid.com) whose data comes from the API
 *     below, authenticated with the subscription key the app itself ships to
 *     every visitor. It is undocumented and could change without notice; the
 *     owner approved calling it once a day. A day's prices appear the next
 *     day, so the newest available is yesterday's.
 *
 *   - Delivery (¢/kWh, changes rarely): printed on the public "Service Rates"
 *     page, in the SC-1 VTOU block. Parsed from the page text.
 *
 * Neither covers the small riders listed only on the PDF rate statements
 * (system benefits, revenue decoupling, transmission adjustment, ...), so
 * totals here are supply + delivery: close, not exact.
 */

const SUPPLY_API = "https://gridapi-cm-prod-appgw.dpit.nationalgrid.com/api/cxptechdebt-cu-brp-exp/v1";
// The key National Grid's own supply-charge page sends from every browser.
const SUPPLY_KEY = "63d94f11420240fab923206326e1805a";
export const SERVICE_RATES_URL = "https://www.nationalgridus.com/Upstate-NY-Home/Rates/Service-Rates";
const USER_AGENT = "ring-local-enhancements (home thermostat dashboard; one request a day)";
const REQUEST_TIMEOUT_MS = 30000;

// --- Fetching ----------------------------------------------------------------

/**
 * One day's supply prices. zoneId 2 = Central (see the LoadZones endpoint);
 * SC1V is sent as class "SC1" with its description, as the page does.
 */
export async function fetchSupplyPrices({
  day,
  zoneId = 2,
  serviceClass = "SC1",
  serviceClassDescription = "(SC1V) Residential Voluntary Time of Use",
}) {
  const params = new URLSearchParams({
    LoadAreaId: String(zoneId),
    LevelId: "0", // voltage level: only meaningful for SC3
    ServiceClass: serviceClass,
    ServiceClassDescription: serviceClassDescription,
    FromDate: day,
    ToDate: day,
    SendAllData: "false",
    PageNumber: "1",
    PageSize: "20",
  });
  const res = await fetch(`${SUPPLY_API}/ElectricSupplyChargeDetails?${params}`, {
    headers: { "Ocp-Apim-Subscription-Key": SUPPLY_KEY, Accept: "*/*", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`National Grid supply prices ${res.status}`);
  return parseSupplyRows(await res.json(), day);
}

export async function fetchDeliveryRates() {
  const res = await fetch(SERVICE_RATES_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`National Grid service rates page ${res.status}`);
  return parseDeliveryRates(await res.text());
}

// --- Parsing (pure) ------------------------------------------------------------

/**
 * Rows like { serviceClassName: "SC1 Vol TOU Off Peak", price: 0.046 } ->
 * { day, offPeak, onPeak, superPeak } in $/kWh. Null when a period is missing;
 * throws when there's nothing usable (e.g. the day isn't published yet).
 */
export function parseSupplyRows(json, day) {
  const rows = json?.data || [];
  const out = { day, offPeak: null, onPeak: null, superPeak: null };
  for (const r of rows) {
    const name = String(r.serviceClassName || "").toLowerCase();
    const price = Number(r.price);
    if (!Number.isFinite(price)) continue;
    if (name.includes("off peak")) out.offPeak = price;
    else if (name.includes("super peak")) out.superPeak = price;
    else if (name.includes("on peak")) out.onPeak = price;
  }
  if (out.offPeak == null || out.onPeak == null) throw new Error(`National Grid has no supply prices for ${day} yet`);
  // Outside June-August the super-peak row reads 0: super-peak hours bill at on-peak then.
  if (!out.superPeak) out.superPeak = null;
  return out;
}

/** Tag-stripped, whitespace-collapsed text of an HTML page. */
export function pageText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&cent;|&#162;/g, "¢")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/**
 * The SC-1 VTOU delivery charges from the Service Rates page:
 * "On Peak/ Super Peak Delivery Charge (per kWh) 12.633¢" and
 * "Off Peak Delivery Charge (per kWh) 1.299¢" -> { onPeak, offPeak } in $/kWh.
 * Only looks inside the VTOU block, so other classes' numbers can't leak in.
 */
export function parseDeliveryRates(html) {
  const text = pageText(html);
  const start = text.search(/Rates? Components? for SC-?1[- ]?VTOU/i);
  if (start < 0) throw new Error("Service Rates page: no SC-1 VTOU block (page layout changed?)");
  const block = text.slice(start, start + 2500);
  const cents = (re) => {
    const m = block.match(re);
    return m ? Number(m[1]) / 100 : null;
  };
  const onPeak = cents(/On[- ]Peak\s*\/?\s*Super[- ]Peak Delivery Charge[^¢]{0,40}?([\d.]+)\s*¢/i);
  const offPeak = cents(/Off[- ]Peak Delivery Charge[^¢]{0,40}?([\d.]+)\s*¢/i);
  if (onPeak == null || offPeak == null) throw new Error("Service Rates page: couldn't read the VTOU delivery charges");
  return { onPeak, offPeak };
}

// --- Periods and prices (pure) ---------------------------------------------------

/**
 * The VTOU period an instant falls in. Off-peak is 23:00-07:00 every day.
 * Super-peak is 14:00-18:00 on June-August weekdays, excluding holidays --
 * the only one in that season is Independence Day.
 */
export function vtouPeriod(d, { offStart = 23, offEnd = 7 } = {}) {
  const h = d.getHours();
  if (h >= offStart || h < offEnd) return "offPeak";
  const m = d.getMonth() + 1;
  const weekday = d.getDay() >= 1 && d.getDay() <= 5;
  const july4 = m === 7 && d.getDate() === 4;
  if (m >= 6 && m <= 8 && weekday && !july4 && h >= 14 && h < 18) return "superPeak";
  return "onPeak";
}

/**
 * $/kWh at an instant: supply for that period plus delivery (super-peak
 * delivery is the on-peak rate). `supply` is that day's parseSupplyRows();
 * a super-peak hour with no super-peak supply price bills at on-peak.
 */
export function priceAt(d, supply, delivery, opts) {
  if (!supply || !delivery) return null;
  const period = vtouPeriod(d, opts);
  const sup = period === "superPeak" ? supply.superPeak ?? supply.onPeak : supply[period];
  const del = period === "offPeak" ? delivery.offPeak : delivery.onPeak;
  return { period, supply: sup, delivery: del, total: sup + del };
}
