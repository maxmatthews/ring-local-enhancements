/**
 * One-shot SmartThings OAuth pairing helper (manual code-paste flow).
 *
 * SmartThings OAuth rejects http://localhost redirect URIs (403 before login),
 * so instead of catching the redirect on a local server, we use a public HTTPS
 * redirect that just displays the authorization code, and you paste it back.
 *
 * Prereq: an OAuth-In app (SmartThings CLI) whose registered Redirect URI is a
 * PUBLIC HTTPS URL -- the default here is https://httpbin.org/get, which echoes
 * the ?code=... back so you can read it. Set the same value in ST_REDIRECT_URI.
 *
 * Run ONCE on a machine with a browser:
 *
 *   ST_CLIENT_ID=xxx ST_CLIENT_SECRET=yyy npm run pair-smartthings
 *
 * It opens the consent screen; after you authorize, your browser lands on the
 * redirect URL with `?code=...` in the address bar. Paste that code (or the
 * whole URL) at the prompt. It then exchanges it, lists your devices, and
 * prints ready-to-paste .env lines. Copy them into the Pi's .env.
 */

import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { randomUUID } from "crypto";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import {
  buildAuthorizeUrl,
  exchangeAuthCode,
  API_BASE,
} from "./smartthings-lock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load a local .env if present, without clobbering already-set env vars.
function loadEnv() {
  const envPath = resolve(__dirname, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnv();

const CLIENT_ID = process.env.ST_CLIENT_ID;
const CLIENT_SECRET = process.env.ST_CLIENT_SECRET;
// MUST be a public HTTPS URL registered on the app -- localhost is rejected.
const REDIRECT_URI = process.env.ST_REDIRECT_URI || "https://httpbin.org/get";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set ST_CLIENT_ID and ST_CLIENT_SECRET (env or .env) first.");
  process.exit(1);
}
if (REDIRECT_URI.startsWith("http://")) {
  console.error(`Redirect URI must be public HTTPS, not "${REDIRECT_URI}" (SmartThings 403s on http/localhost).`);
  process.exit(1);
}

function openInBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start \"\"" :
    "xdg-open";
  exec(`${cmd} "${url}"`, (err) => {
    if (err) console.log("(Could not auto-open a browser -- open the URL above manually.)");
  });
}

function isLock(device) {
  const caps = (device.components || []).flatMap((c) => c.capabilities || []);
  return caps.some((cap) => cap.id === "lock");
}

// Accept a bare code, a full redirect URL, or a raw query string pasted back.
function extractCode(input, expectedState) {
  const trimmed = input.trim();
  if (trimmed.includes("code=")) {
    // Works for a full URL or a bare "code=..&state=.." fragment.
    const qs = trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?") + 1) : trimmed;
    const params = new URLSearchParams(qs);
    const code = params.get("code");
    const state = params.get("state");
    if (state && expectedState && state !== expectedState) {
      console.log("WARNING: state in pasted URL does not match -- proceeding, but double-check you used this session's link.");
    }
    if (code) return code;
  }
  return trimmed;
}

async function main() {
  const state = randomUUID();
  const authUrl = buildAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, state });

  console.log(`Redirect URI: ${REDIRECT_URI}`);
  console.log("(This must be registered on the OAuth app exactly, or you'll get an error.)\n");
  console.log("Opening this URL in your browser to authorize (opening it now):\n");
  console.log(`  ${authUrl}\n`);
  openInBrowser(authUrl);

  console.log("After you approve, your browser lands on the redirect URL with `?code=...`.");
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question("\nPaste the code (or the full redirected URL) here: ");
  rl.close();

  const code = extractCode(answer, state);
  if (!code) {
    console.error("No code provided.");
    process.exit(1);
  }

  console.log("\nExchanging authorization code for tokens...");
  const token = await exchangeAuthCode({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    code,
    redirectUri: REDIRECT_URI,
  });
  if (!token.refresh_token) {
    console.error("No refresh_token in the response -- got:", JSON.stringify(token));
    process.exit(1);
  }
  console.log("Got tokens. Listing devices...\n");

  // List devices with the access token from the code exchange directly.
  // Do NOT refresh here: SmartThings rotates the refresh token on every
  // refresh, which would invalidate the token.refresh_token we're about to
  // print and save. The code exchange already gave us a valid access token.
  const locks = [];
  try {
    const res = await fetch(`${API_BASE}/devices`, {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(json)}`);
    const devices = json.items || [];
    if (devices.length === 0) {
      console.log("No devices returned (check the app's scopes / that you authorized a location).");
    } else {
      console.log("Devices on your account:");
      for (const d of devices) {
        const lock = isLock(d);
        console.log(`  ${lock ? "* LOCK" : "     "}  id=${d.deviceId}  label="${d.label || d.name}"`);
        if (lock) locks.push(d);
      }
    }
  } catch (err) {
    console.error("Device list failed (token still valid, you can find the ID later):", err.message);
  }

  const lockId = locks.length === 1 ? locks[0].deviceId : "<paste-lock-id-from-list-above>";

  console.log("\n--------------------------------------------------------------");
  console.log("Add these to the Pi's .env (values are secret -- keep them safe):\n");
  console.log(`ST_CLIENT_ID=${CLIENT_ID}`);
  console.log(`ST_CLIENT_SECRET=${CLIENT_SECRET}`);
  console.log(`ST_REFRESH_TOKEN=${token.refresh_token}`);
  console.log(`ST_LOCK_DEVICE_ID=${lockId}`);
  console.log("--------------------------------------------------------------");
}

main().catch((e) => {
  console.error("Pairing failed:", e.message);
  process.exit(1);
});
