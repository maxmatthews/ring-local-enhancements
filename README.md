# Ring Door Sensor -> Camera Snooze

Automatically snooze motion alerts on your Ring camera when your Ring Alarm
door contact sensor opens. Useful for preventing a flood of motion
notifications every time you walk in or out.

## How It Works

1. Connects to Ring via `ring-client-api` using your refresh token
2. Subscribes to real-time state changes on your door contact sensor
   (via the Ring Alarm WebSocket connection)
3. When the sensor reports "open" (faulted), sends a `motion_snooze` API
   call to the target camera
4. Includes a configurable cooldown to avoid repeat triggers from
   rapid open/close cycles

## Prerequisites

- Node.js 20+ (the library is ESM-only and dropped Node 18)
- A Ring account with 2FA enabled
- Ring Alarm system with a contact sensor on the door
- Ring camera at the same location

## Setup

```bash
# Clone/copy this directory to your server
cd ring-door-snooze

# Install dependencies
npm install

# Generate your refresh token (requires 2FA)
npm run auth
# Follow the prompts -- it will print a token at the end

# Configure
cp .env.example .env
# Edit .env and paste your refresh token + set device names
```

## Finding Your Device Names

On first run, the script logs all cameras and contact sensors it finds.
If your names don't match, just run it once and check the output:

```bash
npm start
```

You'll see something like:

```
Cameras: "Front Door" (id: 12345), "Backyard" (id: 67890)
Available sensors: "Front Door", "Back Door", "Garage"
```

Update `.env` to match. The name matching is case-insensitive and uses
partial matching, so "front" would match "Front Door".

## Running as a Service (systemd)

```bash
# Copy the service file
sudo cp ring-door-snooze.service /etc/systemd/system/

# Edit if your username or install path differs
sudo systemctl daemon-reload
sudo systemctl enable ring-door-snooze
sudo systemctl start ring-door-snooze

# Check logs
journalctl -u ring-door-snooze -f
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `RING_REFRESH_TOKEN` | (required) | Token from `ring-auth-cli` |
| `DOOR_SENSOR_NAME` | `Front Door` | Contact sensor name (partial, case-insensitive) |
| `CAMERA_NAME` | `Front Door` | Camera name (partial, case-insensitive) |
| `SNOOZE_MINUTES` | `30` | Duration to snooze motion alerts |
| `COOLDOWN_SECONDS` | `60` | Min gap between snooze triggers |

## Token Refresh

Ring refresh tokens expire shortly after use. The script automatically
persists updated tokens back to `.env` so the next restart works. This
is handled by the `onRefreshTokenUpdated` subscription.

## Important Caveats

- **Unofficial API**: `ring-client-api` is a community reverse-engineering
  project. Ring can break it at any time with backend changes.
- **Snooze is per-client**: The `motion_snooze` endpoint suppresses alerts
  for the session that made the request. In practice it seems to also
  suppress push notifications app-wide for that camera, but YMMV.
  If it only snoozes your own session, an alternative approach is to
  disable motion detection entirely and re-enable it on a timer.
- **Network requirement**: The script needs a persistent outbound
  connection to `mtalk.google.com:5228` (Firebase Cloud Messaging)
  for real-time push events from Ring.

## Troubleshooting

**No events received**: Make sure port 5228 outbound to
`mtalk.google.com` is not blocked. Also check that you haven't exceeded
Ring's device session limit (remove stale sessions in the Ring app under
Account > Authorized Client Devices).

**Token errors**: Re-run `npm run auth` and update `.env`.

**Camera not snoozing**: Check the logs for HTTP errors from the snooze
endpoint. If Ring has changed the API, the endpoint path or payload may
need updating.
