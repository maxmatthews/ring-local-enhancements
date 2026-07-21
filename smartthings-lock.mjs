/**
 * SmartThings OAuth2 lock client.
 *
 * The Ultraloq lock is linked into SmartThings (cloud-to-cloud), so we drive it
 * through the official SmartThings REST API. Covers what this project needs:
 * OAuth2 token handling and the lock/unlock command.
 *
 *   - Authorize:  https://api.smartthings.com/oauth/authorize
 *   - Token:      https://api.smartthings.com/oauth/token   (HTTP Basic auth)
 *   - Commands:   POST https://api.smartthings.com/v1/devices/{id}/commands
 *
 * Access tokens last 24h; refresh tokens ROTATE on every refresh (SmartThings
 * hands back a new one), so callers must persist the rotated value -- same as
 * the Ring refresh-token handling elsewhere in this repo.
 */

export const OAUTH_AUTHORIZE_URL = "https://api.smartthings.com/oauth/authorize";
export const OAUTH_TOKEN_URL = "https://api.smartthings.com/oauth/token";
export const API_BASE = "https://api.smartthings.com/v1";
// Read devices + execute commands. Space-delimited in the authorize URL.
export const SCOPES = ["r:devices:*", "x:devices:*"];

// Refresh this many seconds before the access token's stated expiry.
const TOKEN_EXPIRY_MARGIN_SECONDS = 120;

function basicAuthHeader(clientId, clientSecret) {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

async function requestToken({ clientId, clientSecret, params }) {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    // client_id/client_secret are sent in the body too; SmartThings accepts
    // both, and the working reference examples include them.
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }).toString(),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    throw new Error(`SmartThings token endpoint ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

/** Build the browser authorize URL for the one-time consent step. */
export function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const u = new URL(OAUTH_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", SCOPES.join(" "));
  if (state) u.searchParams.set("state", state);
  return u.toString();
}

/** Exchange an authorization code for tokens (used by the pairing helper). */
export function exchangeAuthCode({ clientId, clientSecret, code, redirectUri }) {
  return requestToken({
    clientId,
    clientSecret,
    params: { grant_type: "authorization_code", code, redirect_uri: redirectUri },
  });
}

/** Trade a refresh token for a fresh access token (and a rotated refresh token). */
export function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  return requestToken({
    clientId,
    clientSecret,
    params: { grant_type: "refresh_token", refresh_token: refreshToken },
  });
}

/**
 * Create a SmartThings API client that keeps a valid access token on hand.
 *
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.clientSecret
 * @param {string} opts.refreshToken
 * @param {(newRefreshToken: string) => void} [opts.onRefreshToken]
 *        Called whenever the refresh token rotates, so the caller can persist
 *        it. SmartThings rotates on every refresh, so this fires often.
 */
export function createSmartThingsClient({ clientId, clientSecret, refreshToken, onRefreshToken }) {
  let accessToken = null;
  let expiresAt = 0;
  let currentRefreshToken = refreshToken;

  async function ensureAccessToken() {
    if (accessToken && Date.now() < expiresAt) return accessToken;

    const token = await refreshAccessToken({ clientId, clientSecret, refreshToken: currentRefreshToken });

    accessToken = token.access_token;
    const ttl = Number(token.expires_in) || 86400;
    expiresAt = Date.now() + Math.max(0, ttl - TOKEN_EXPIRY_MARGIN_SECONDS) * 1000;

    if (token.refresh_token && token.refresh_token !== currentRefreshToken) {
      currentRefreshToken = token.refresh_token;
      if (onRefreshToken) onRefreshToken(currentRefreshToken);
    }
    return accessToken;
  }

  async function apiRequest(method, path, body) {
    const token = await ensureAccessToken();
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`SmartThings API ${method} ${path} ${res.status}: ${JSON.stringify(json)}`);
    }
    return json;
  }

  function sendLockCommand(deviceId, command) {
    return apiRequest("POST", `/devices/${deviceId}/commands`, {
      commands: [{ component: "main", capability: "lock", command }],
    });
  }

  return {
    /** List all devices on the account. Returns the raw `items` array. */
    async listDevices() {
      const json = await apiRequest("GET", "/devices");
      return json.items || [];
    },
    /** Send the unlock command to a lock device. */
    unlockLock(deviceId) {
      return sendLockCommand(deviceId, "unlock");
    },
    /** Send the lock command (handy for manual testing). */
    lockLock(deviceId) {
      return sendLockCommand(deviceId, "lock");
    },
    /** Force a token refresh; used to validate credentials. */
    ensureAccessToken,
  };
}
