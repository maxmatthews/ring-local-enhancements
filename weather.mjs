/**
 * Outdoor temperature from Open-Meteo (https://open-meteo.com): free, no API
 * key. Current temperature plus a two-day hourly forecast, in °F.
 *
 * Coordinates are rounded to two decimals (about 1 km) before they leave the
 * house -- plenty for weather, and no more precise than it needs to be.
 */

const REQUEST_TIMEOUT_MS = 15000;

export async function fetchOutdoor({ latitude, longitude }) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: latitude.toFixed(2),
    longitude: longitude.toFixed(2),
    current: "temperature_2m",
    hourly: "temperature_2m",
    temperature_unit: "fahrenheit",
    forecast_days: "2",
    timezone: "UTC",
  }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const json = await res.json();
  // timezone=UTC with no offset in the strings -- read them as UTC.
  const utc = (s) => Date.parse(`${s}Z`);
  return {
    nowF: json.current?.temperature_2m ?? null,
    hourly: (json.hourly?.time || []).map((t, i) => ({ time: utc(t), tempF: json.hourly.temperature_2m[i] })),
    fetchedAt: Date.now(),
  };
}
