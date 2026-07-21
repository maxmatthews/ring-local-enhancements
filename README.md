# Ring local enhancements

Local-network glue for a Ring + IKEA Dirigera home. Two automations in
one Node service:

1. **Camera snooze on door open** — when a designated Ring Alarm contact
   sensor opens, silence "Person Detected" notifications on a Ring camera
   for a while (video keeps recording). Stops the flood of notifications
   every time you walk in or out.
2. **Sunset blind close, gated by door state** — at local sunset, close
   every IKEA Dirigera blind. Skip any blind whose mapped contact sensor
   is currently open; close it `POST_CLOSE_DELAY_SECONDS` after the sensor
   reports closed. Blinds with no mapping always close.
3. **Smoke-triggered lock unlock** — when the Ring Alarm panel reports a
   fire or CO alarm (`alarmInfo.state`), unlock an Ultraloq lock via the
   SmartThings REST API. Unlock only — it never re-locks during an alarm.

## How It Works

- Connects to Ring via `ring-client-api` using your refresh token, and to
  the Dirigera hub via the `dirigera` package using a paired access token.
- Subscribes to real-time state changes on every contact sensor named in
  `DOOR_SENSOR_NAME` (snooze trigger) or in `blind-sensor-map.json` (blind
  guard).
- Computes local sunset from your latitude/longitude with `suncalc` and
  schedules the close. After firing, it re-schedules for the next sunset.
- Open→closed transitions on a guarded sensor start a delay timer; if the
  door reopens within that window, the timer is cancelled.

## Prerequisites

- Node.js 20+ (`ring-client-api` is ESM-only and dropped Node 18)
- A Ring account with 2FA enabled, a Ring Alarm hub, and at least one
  contact sensor
- An IKEA Dirigera hub on the same LAN as this service (blind feature only)

## Setup

```bash
cd ring-local-enhancements
npm install

# Ring: generate a refresh token (interactive 2FA prompt)
npm run auth

# Dirigera: pair this machine with the hub. The CLI does mDNS discovery
# by default; when it finds the hub it'll prompt you to press the action
# button on the bottom of the hub within 60 seconds.
npm run pair-dirigera

# If mDNS discovery fails (different VLAN, mDNS not forwarded, etc.),
# find the hub's IP yourself and pass it explicitly. Quick scan:
#   sudo nmap -p 8443 --open -T4 192.168.1.0/24
# Then:
#   npx dirigera authenticate --gateway-IP 192.168.1.XXX

# Config
cp .env.example .env
# Edit .env -- paste Ring refresh token, Dirigera host + token, your
# latitude/longitude, and sensor/camera names.

# Mapping (optional but the whole point of feature #2)
cp blind-sensor-map.json.example blind-sensor-map.json
# Edit it. Keys = Dirigera blind name substring. Values = Ring sensor
# name substring. Both match case-insensitively. Blinds not listed close
# unconditionally at sunset.
```

**Important:** disable any sunset-blind scene/automation in the IKEA
Home Smart app. Otherwise the Dirigera hub will close blinds on its own
schedule and this service's guard does nothing.

## Finding Your Device Names

On first run the service logs the cameras, blinds, and contact sensors it
discovers. Run it once and copy names from the output:

```bash
npm start
```

You'll see something like:

```
Location: "Home"
Target camera: "Front Door"
Connected. Got 25 devices.
Watching: "Front Door" (open=false)
Watching: "Left Living Room Window" (open=true)
Dirigera connected. 3 blind(s): Living Room Left, Kitchen Left, Bedroom Center
Next sunset: 2026-06-03T00:38:12.408Z (in 174min)
Automation active.
```

Name matching is case-insensitive partial — `front` matches `Front Door`.
Any mapping entry that doesn't resolve to a real sensor or blind is
logged with a `WARN:` line at startup.

## Running as a Service (systemd)

```bash
sudo cp ring-local-enhancements.service /etc/systemd/system/
# Edit if your username or install path differs
sudo systemctl daemon-reload
sudo systemctl enable ring-local-enhancements
sudo systemctl start ring-local-enhancements

journalctl -u ring-local-enhancements -f
```

## Configuration

### .env

| Variable | Default | Description |
| --- | --- | --- |
| `RING_REFRESH_TOKEN` | (required) | Token from `npm run auth` |
| `DOOR_SENSOR_NAME` | `Front Door` | Sensor that triggers camera snooze |
| `CAMERA_NAME` | `Front Door` | Camera to snooze |
| `SNOOZE_MINUTES` | `30` | Snooze duration |
| `COOLDOWN_SECONDS` | `60` | Min gap between snooze triggers |
| `DIRIGERA_HOST` | (optional) | Dirigera hub IP. Omit to disable blind feature. |
| `DIRIGERA_TOKEN` | (optional) | Access token from `npm run pair-dirigera` |
| `LATITUDE` | (optional) | Decimal degrees, for sunset calc |
| `LONGITUDE` | (optional) | Decimal degrees, for sunset calc |
| `BLIND_SENSOR_MAP_FILE` | `blind-sensor-map.json` | Mapping file path |
| `POST_CLOSE_DELAY_SECONDS` | `60` | Delay between sensor-close and blind-close |
| `ST_CLIENT_ID` | (optional) | SmartThings OAuth2 client ID. Omit to disable smoke-unlock. |
| `ST_CLIENT_SECRET` | (optional) | SmartThings OAuth2 client secret |
| `ST_REFRESH_TOKEN` | (optional) | Refresh token from `npm run pair-smartthings` (auto-rotated) |
| `ST_LOCK_DEVICE_ID` | (optional) | SmartThings device ID of the lock to unlock |
| `SMOKE_UNLOCK_COOLDOWN_SECONDS` | `300` | Min gap between unlock commands |

If any of `DIRIGERA_HOST`, `DIRIGERA_TOKEN`, `LATITUDE`, `LONGITUDE` are
missing, the blind feature stays off and the service still does the
camera snooze. Likewise, if any of the four required `ST_*` values are
missing, the smoke-unlock stays off and the rest keeps running.

### Smoke-triggered unlock (SmartThings)

The Ultraloq lock is linked into **SmartThings** (cloud-to-cloud), and this
drives it through the official SmartThings REST API. First create an
**OAuth-In app** with the [SmartThings CLI](https://github.com/SmartThingsCommunity/smartthings-cli):

```bash
smartthings apps:create
#  -> choose "OAuth-In App"
#  -> Display Name / Description: anything (e.g. "ring-local-enhancements")
#  -> Scopes: r:devices:*  and  x:devices:*
#  -> Redirect URI: https://httpbin.org/get   (see note below)
```

**Redirect URI must be public HTTPS.** SmartThings returns a 403 on the
authorize page for `http://localhost` URIs, so the pairing uses a public
HTTPS redirect that just displays the code. `https://httpbin.org/get` works
(it echoes the `?code=` back); anything public+HTTPS that lets you read the
address bar is fine. It must match `ST_REDIRECT_URI` exactly.

`apps:create` prints an **OAuth Client Id** and **OAuth Client Secret** (the
secret is shown only once). Then, **on a machine with a browser**, mint a
refresh token and find the lock's device ID:

```bash
ST_CLIENT_ID=xxx ST_CLIENT_SECRET=yyy npm run pair-smartthings
```

It opens the consent screen; after you approve, the browser lands on the
redirect URL with `?code=...`. Paste that code (or the whole URL) at the
prompt. It exchanges it, prints an `ST_REFRESH_TOKEN`, and lists your devices
(locks flagged `* LOCK`). Copy `ST_CLIENT_ID`, `ST_CLIENT_SECRET`,
`ST_REFRESH_TOKEN`, and the lock's `ST_LOCK_DEVICE_ID` into the Pi's `.env`.

**This is a life-safety supplement, not a replacement.** Anyone inside can
always egress via the thumb-turn; the auto-unlock mainly helps responders
get in. It's a cloud path — but so is the Ring smoke *trigger* (the hub
event arrives over Ring's cloud), so both halves already depend on the
internet; a local unlock would not change that. The only fully-local
alternative for *both* halves would be different detection + a Z-Wave lock.

### blind-sensor-map.json

```json
{
  "Living Room Blind": "Front Door",
  "Kitchen Blind": "Back Door"
}
```

Keys are partial substrings of Dirigera blind names. Values are partial
substrings of Ring contact sensor names. Both sides match
case-insensitively. Blinds not listed always close at sunset.

## Token Refresh

Ring refresh tokens rotate. The service writes the updated token back to
`.env` automatically (`onRefreshTokenUpdated`). The Dirigera access token
does not rotate.

SmartThings refresh tokens also rotate — on **every** refresh — and expire
after ~30 days if unused. The service persists each rotated `ST_REFRESH_TOKEN`
back to `.env`, and refreshes on a 12-hour keepalive so the token stays alive
(and an unlock never waits on a cold refresh) even if no alarm fires for weeks.
If the service is stopped for more than ~30 days, re-run `npm run
pair-smartthings` to mint a fresh token.

## Caveats

- **Unofficial Ring API**: `ring-client-api` is community-maintained. Ring
  can break it any time with backend changes.
- **Snooze scope**: `motion_snooze` suppresses alerts for the calling
  session. In practice it also seems to suppress push notifications
  app-wide for that camera, but YMMV.
- **Network requirement**: needs persistent outbound to
  `mtalk.google.com:5228` (FCM) for real-time Ring push, and LAN access
  to the Dirigera hub.
- **Blind direction**: this assumes `blindsTargetLevel: 100` = closed
  (rolled down), which matches FYRTUR/KADRILJ defaults. If yours go the
  other way, flip `BLIND_CLOSED_LEVEL` in `index.mjs`.
- **SmartThings unlock is cloud + best-effort**: it goes through the
  SmartThings (and U-tec) cloud, so it depends on internet + service uptime
  and can't be guaranteed during a fire. The same is true of the Ring smoke
  trigger, so this doesn't add a dependency the detection side didn't
  already have.
- **Detection is panel-based**: the primary trigger is the Ring Alarm
  panel's `alarmInfo.state` (`fire-alarm` / `co-alarm` / the user-verified
  and accelerated fire-CO variants). Individual smoke/CO detectors were
  observed *not* to flip their own `alarmStatus` in the data shadow (the
  Bluejay signals via `pushToTest`/impulses; the listener via impulses), so
  per-device `alarmStatus` is only a backup. The unlock command → lock was
  verified end-to-end; the panel `fire-alarm` trigger itself is per Ring's
  data model but hadn't been observed firing (testing was done in Practice
  Mode). The service logs every panel `alarmInfo.state` transition, so a
  real event leaves an audit trail — check it after any alarm.

## Troubleshooting

- **No Ring events**: check that port 5228 outbound to `mtalk.google.com`
  isn't blocked. Also prune stale sessions in the Ring app under
  Account → Authorized Client Devices.
- **Dirigera pairing fails**: the action-button press window is short
  (~60s). Re-run pairing and press the button as soon as the CLI starts
  polling. If you see `Gateway discovery timed out`, mDNS isn't reaching
  the hub — find the IP with `sudo nmap -p 8443 --open -T4 <your-subnet>`
  and use `npx dirigera authenticate --gateway-IP <ip>`.
- **Sunset doesn't fire**: check the startup log for the computed next
  sunset time. If it's wrong, your `LATITUDE` / `LONGITUDE` are off, or
  the system clock is in a surprising timezone.
- **Blind closes anyway when door is open**: confirm the IKEA Home Smart
  sunset scene is disabled. Also check the startup log — if the mapping
  entry didn't resolve to a real sensor, you'll see a `WARN:` line.
