# Ring local enhancements

Local-network glue for a Ring + IKEA Dirigera home. One Node service
(`index.mjs`) running five automations that neither vendor offers natively:

| # | Feature | Needs | Off switch |
| --- | --- | --- | --- |
| 1 | **Camera snooze on door open** — mute "Person Detected" notifications on a Ring camera when a door opens (video keeps recording) | Ring only | always on |
| 2 | **Sunset blind close, gated by door state** — close every Dirigera blind at local sunset, but not while its mapped door is open | Ring + Dirigera | omit any `DIRIGERA_*` / `LATITUDE` / `LONGITUDE` |
| 3 | **Smoke/CO auto-unlock** — unlock an Ultraloq lock via SmartThings when the Ring Alarm panel reports a fire or CO alarm | Ring + SmartThings | omit any `ST_*` |
| 4 | **Level-sync retry** — re-send a house-wide blind level to the blinds that missed it, plus a full-open nudge | Ring + Dirigera | `BLIND_LEVEL_SYNC_ENABLED=false` |
| 5 | **Meeting-triggered smart plug** — switch a SmartThings plug on when MeetingBar joins a meeting, off when the meeting is scheduled to end | Ring + SmartThings + a Mac | omit `MEETING_PLUG_TOKEN` |

Each feature degrades independently: missing config disables just that
feature and logs why at startup, and a setup failure (Dirigera unreachable,
SmartThings credentials rejected) disables that feature for the run while
everything else keeps working.

---

## 1. Camera snooze on door open

When the contact sensor matching `DOOR_SENSOR_NAME` transitions to open, the
service PATCHes the target camera's device settings so human detection stays
**enabled and recording** but stops notifying:

```
cv_settings.detection_types.human = { enabled: true, mode: "edge", notification: false }
```

`SNOOZE_MINUTES` later a timer restores `notification: true`. A repeat trigger
inside `COOLDOWN_SECONDS` is ignored; a repeat trigger after that restarts the
window (the pending re-enable timer is replaced, not stacked).

This stops the notification flood every time you walk in or out, without
losing the footage.

## 2. Sunset blind close, gated by door state

At local sunset (computed from `LATITUDE` / `LONGITUDE` with `suncalc`) the
service lists every Dirigera blind and sorts them into two groups:

- **Close now** — blinds with no mapping, blinds whose mapping doesn't resolve
  to a real sensor (logged as `WARN:`), and blinds whose mapped sensors are
  all closed.
- **Defer** — blinds with at least one mapped sensor currently open.

The close-now group is driven **sequentially**, `10s` apart, in the room order
listed in `CLOSE_ORDER` (top of `index.mjs`). Blinds whose names match no entry
close last. Spacing them out keeps the hub from dropping commands under a burst.

A deferred blind closes `POST_CLOSE_DELAY_SECONDS` after **all** of its mapped
sensors report closed — the delay is the grace period to shut the door behind
you. If any mapped sensor reopens during that window, the timer is cancelled
and the wait restarts on the next close. If the delay would fire after sunrise,
the close is abandoned instead (no blind drops in the morning because a door
was open all night).

**Date holds:** `BLIND_HOLDS` in `blind-holds.mjs` lists blinds that stay
open on a given calendar day every year — currently Living Room Center and
Living Room Right on 10/31 (Halloween). On that day they're left out of the
sunset close entirely (so no deferral or retry either), and level-sync won't
drive them to the house level. A command you send yourself still moves them.

**Sunset retry:** after the close sequence, the service re-lists the blinds
`5min` later and re-sends the close to any that aren't at level 100 — up to
2 passes.

After a sunset fires, the next one is re-computed and scheduled, so the service
runs indefinitely without a cron.

> Disable any sunset-blind scene or automation in the IKEA Home Smart app.
> Otherwise the Dirigera hub closes blinds on its own schedule and this
> service's door guard does nothing.

## 3. Smoke/CO auto-unlock (SmartThings)

When a fire or CO alarm is detected, the service sends an **unlock** command to
the Ultraloq lock through the SmartThings REST API. Unlock only — it never
re-locks during an alarm; you relock manually once it's clear.

**Detection is panel-first.** The canonical signal is the Ring Alarm security
panel's `alarmInfo.state`, matched against:

`fire-alarm` · `co-alarm` · `user-verified-co-or-fire-alarm` · `fire-accelerated-alarm`

Watching the panel catches *any* smoke/CO detector on the hub at once.
Individual detectors are watched as a **backup** path: any smoke/CO device
(matched by device type, a type-name pattern, or a name containing "smoke" /
"carbon monoxide") is subscribed, and an `active` status in `alarmStatus`,
`smoke.alarmStatus`, `co.alarmStatus`, or the Bluejay-style
`components["alarm.smoke"|"alarm.co"]` blocks (including `lowLevelAlarmStatus`)
triggers an unlock. End-of-life warnings and `pushToTest` self-tests are
deliberately ignored.

Both paths are also evaluated once at startup, so a service restart during a
live alarm still unlocks.

**Unlock delivery:** up to 5 attempts, 3s apart. The
`SMOKE_UNLOCK_COOLDOWN_SECONDS` cooldown starts only after a **successful**
unlock — if all attempts fail, no cooldown is set and the next alarm update
re-triggers, so an ongoing alarm keeps retrying in bursts. An in-progress guard
prevents the panel and a device firing simultaneously from sending overlapping
commands.

Every panel `alarmInfo.state` transition is logged, alarm or not, so a real
event leaves an audit trail.

> **This is a life-safety supplement, not a replacement.** Anyone inside can
> always egress via the thumb-turn; the auto-unlock mainly helps responders get
> in. It's a cloud path — but so is the Ring smoke *trigger* (the hub event
> arrives over Ring's cloud), so both halves already depend on the internet; a
> local unlock would not change that. The only fully-local alternative for
> *both* halves would be different detection plus a Z-Wave lock.

## 4. Level-sync retry

Dirigera levels run **0 = fully open, 100 = fully closed**.

A house-wide level command (IKEA app, remote, scene) sometimes fails to reach a
few blinds. The service subscribes to the hub's event stream, collects the
burst of `blindsTargetLevel` changes, waits `BLIND_LEVEL_SYNC_SETTLE_MS` for it
to go quiet (never deferring past `BLIND_LEVEL_SYNC_MAX_BURST_MS`), then
compares every blind against the level the majority landed on and re-sends it
to the ones that missed — up to `BLIND_LEVEL_SYNC_MAX_RETRIES` times,
`BLIND_LEVEL_SYNC_RETRY_DELAY_MS` apart, re-listing the blinds between passes
and dropping the ones that arrived.

Because blinds report `blindsTargetLevel` and `blindsCurrentLevel` separately,
both failure modes are caught and distinguished in the logs:

- `did-not-move` — the blind got the command but the motor never ran (target
  matches, current level doesn't).
- `missed-command` — the blind never heard the command at all (target and
  current are both stale).

It deliberately does nothing when:

- fewer than `BLIND_LEVEL_SYNC_MIN_BURST` blinds moved together (you were
  adjusting one blind by hand, not the house);
- no level holds a `BLIND_LEVEL_SYNC_CONSENSUS_RATIO` majority of reachable
  blinds;
- more than `BLIND_LEVEL_SYNC_MAX_STRAGGLERS` blinds disagree — that looks like
  a deliberate partial-house state, not dropped commands;
- the blind is unreachable or hidden, reports no current level, is awaiting a
  deferred sunset close, or has an open mapped door sensor;
- the blind was explicitly set to a *different* level during the same burst —
  it emitted its own event, so it's distinguishable from one that simply missed
  the command;
- a sunset close sequence is running (that path does its own retries).

The door-sensor, pending-close and deliberately-set-apart fences are re-checked
**between** retry passes, not just up front, so a door opened mid-sync drops
that blind from the remaining passes.

Landing within `BLIND_LEVEL_SYNC_TOLERANCE` points of the target counts as
arrived.

**Superseding.** Every new externally-driven burst bumps a generation counter.
An in-flight sync checks it before each pass and between sleep slices, and
stands down as soon as a fresh command arrives — retries never fight a newer
instruction. If a burst arrives while the previous sync is still winding down,
it waits for that one to finish rather than being dropped.

**Self-command suppression.** Commands the service issues are tagged for
`90s`, and target changes on tagged blinds are ignored, so the service never
reacts to its own writes.

**Full-open nudge:** when the consensus level is 0 (fully open), the house is
driven to `BLIND_FULL_OPEN_NUDGE_LEVEL` (default 3 — 3% closed, 97% open)
instead. The whole house moves on this pass, so the straggler cap doesn't apply
to it. Set `BLIND_FULL_OPEN_NUDGE=false` to turn it off.

### Diagnosing it against the live hub

```bash
npm run diag
```

Read-only. Prints every blind's current level, target level, battery and
reachability, then runs the **real** decision logic (`level-sync.mjs`) over the
live snapshot and reports the verdict, the consensus, what it would leave alone
and why, and which blinds didn't respond. Add `--apply` to actually drive the
stragglers it finds.

Caveat: the running service builds its burst from live hub events, which is how
it tells a blind that *missed* a command from one you deliberately set apart.
After the fact that distinction is gone, so the diag reconstructs the burst as
"every blind already sitting on the majority target" — a blind you deliberately
set differently shows up as a straggler there even though the live service
would leave it alone.

The decision logic is pure and I/O-free, and unit-tested with `npm test`
(17 cases covering both failure modes, every safety valve, and the full-open
nudge). Both the service and the diag call the same function.

---

## 5. Meeting-triggered smart plug

Joining a meeting in [MeetingBar](https://github.com/leits/MeetingBar) on the
Mac switches a Zigbee plug on (here: the "Logo Light"), and it switches off
again when the meeting was scheduled to end. If the meeting length can't be
worked out, it runs for `MEETING_PLUG_DEFAULT_MINUTES` (default 60).

```
Mac: MeetingBar joins a meeting
      -> joinEventScript.scpt   (gets the event, incl. its real end date)
      -> ~/.local/bin/meeting-plug-notify
      -> POST /meeting/start {"title": "...", "minutes": 30}

Pi:  switch the plug on now, remember "off at 14:30"
      -> a tick every MEETING_PLUG_TICK_MS switches it off when that passes
```

**Why the schedule lives on the Pi, not the Mac.** The laptop is usually shut
the moment a meeting ends, and a sleeping Mac switches nothing off. The Pi is
always up, so the off lands on time no matter what the laptop does.

**Why it runs inside `index.mjs` rather than as its own script.** SmartThings
rotates the refresh token on every use. A second client with its own copy of
the token would silently invalidate the one the smoke-unlock path (feature 3)
depends on, so both features share the single client this service already has.

### Behaviour

- **Overlapping and back-to-back meetings** extend the off time; they never
  retract it. A 15-minute call joined inside an hour-long one can't cut the
  hour short.
- **A plug that was already on** when the first meeting started is left on at
  the end — you switched it on, so it isn't ours to switch off. Set
  `MEETING_PLUG_RESPECT_EXISTING=false` to switch off regardless.
- **All-day events are ignored** by the Mac script.
- **A silly end date is clamped** to `MEETING_PLUG_MIN_MINUTES` ..
  `MEETING_PLUG_MAX_MINUTES`, so one bad event can't leave the plug on for days.
- **Restarts are survived.** The session is written to
  `.meeting-plug-state.json` on the Pi; a deploy mid-meeting reloads it and
  still switches off on time, including catching up on an off time that fell
  while the service was down.
- **Failures are quiet on the Mac.** A plug that doesn't answer must never
  delay or block joining the actual call.

### MeetingBar version matters

| MeetingBar | Join hook gets event data? | Result |
| --- | --- | --- |
| **v5.0.0+** | yes — `execute(withAppleEvent:)` | real meeting length |
| **4.11.6 and earlier** | no — `execute { }`, zero parameters | always the 60-minute default |

The bundled script handles both: it defines a `meetingStart` handler for the
14-parameter payload and a bare `run` handler for older builds. Only the
accuracy of the off time differs.

### Setup

On the **Pi**, add to `.env` (the `ST_*` credentials from feature 3 are reused
as-is — do not create a second set):

```sh
MEETING_PLUG_DEVICE_NAME=Logo Light
MEETING_PLUG_TOKEN=$(openssl rand -hex 24)
```

Deploy, then confirm the plug resolved:

```sh
curl -H "Authorization: Bearer $MEETING_PLUG_TOKEN" http://pi.local:8787/meeting/status
```

On the **Mac**:

```sh
mac/install-meeting-plug.sh --url http://pi.local:8787 --token <the same token>
```

`--url` accepts a comma-separated list, tried in order — handy as a fallback
when mDNS is flaky:

```sh
mac/install-meeting-plug.sh --url "http://pi.local:8787, http://192.168.1.104:8787" --token ...
```

Then in MeetingBar → Preferences → Advanced, tick **"Run AppleScript when
joining a meeting"** and click **"Edit script"** once, selecting
*User → Library → Application Scripts → leits.MeetingBar* (this grants the
sandbox bookmark; without it the script never runs).

### More than one Mac

Any number of Macs can drive the same plug — run the installer on each. Give
each machine its own token and list them all in the Pi's `MEETING_PLUG_TOKEN`,
so a machine can be cut off on its own (handing back a work laptop, say)
without re-keying the others:

```sh
# on the Pi, in .env
MEETING_PLUG_TOKEN=<personal mac token>,<work mac token>
```

Meetings from different machines merge the same way overlapping meetings on one
machine do: the latest end time wins, so a call on the work laptop can't switch
the plug off while a call on the personal one is still running.

**This is home-LAN only, by design.** Off the LAN the Pi is unreachable, so the
call fails after a 3-second connect timeout, is written to
`~/Library/Logs/meeting-plug.log`, and is otherwise completely silent — no
alert, and no delay to joining the meeting.

### Endpoints

All require `Authorization: Bearer $MEETING_PLUG_TOKEN`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/meeting/status` | What the Pi thinks is running, and when it switches off |
| `GET` | `/meeting/devices` | Every SmartThings device with a `switch` capability — how you find a plug's name or id |
| `POST` | `/meeting/start` | `{"title": "...", "minutes": 30}` — `minutes` optional; omit it to get the default |
| `POST` | `/meeting/end` | Switch off now, ending the meeting early |

### Troubleshooting

```sh
tail -f ~/Library/Logs/meeting-plug.log      # on the Mac: every call and its reply
~/.local/bin/meeting-plug-notify --status    # on the Mac: is the Pi reachable?
~/.local/bin/meeting-plug-notify --end       # switch off now
```

Nothing in the log at all means MeetingBar never ran the script — check the
"Run AppleScript when joining a meeting" tick and the folder bookmark above.

## How it works

- Connects to Ring via `ring-client-api` using a refresh token, and to the
  Dirigera hub via the `dirigera` package using a paired access token.
- Subscribes to real-time state changes on every contact sensor named in
  `DOOR_SENSOR_NAME` (snooze trigger) or in `blind-sensor-map.json` (blind
  guard). Other sensors are ignored.
- Subscribes to the Ring Alarm security panel and every smoke/CO device for the
  fire/CO unlock path.
- Computes local sunset with `suncalc` and schedules the close, re-scheduling
  after each firing.
- Subscribes to the Dirigera event stream (`startListeningForUpdates`) to
  notice blind level changes from any source — the IKEA app, a remote, or a
  scene.
- The hub connection retries indefinitely with exponential backoff, and
  re-resolves the hub's address on each attempt (see [Hub addressing](#hub-addressing)).
  Sunset stays scheduled while the hub is unreachable, so a hub that returns
  before evening still gets its close.
- `SIGINT` / `SIGTERM` stop the Dirigera listener and exit cleanly; unhandled
  rejections are logged rather than fatal.

## Hub addressing

The Dirigera hub is a DHCP client, so its IP moves — and when it does, nothing
about the failure is obvious: the REST calls fail, and the event-stream
WebSocket has the old IP baked into its URL and retries that dead address
forever without surfacing an error.

So `DIRIGERA_HOST` is treated as a *hint*, not a pin:

1. **Connect** to `DIRIGERA_HOST` if set. The blind list doubles as the
   reachability probe, since building the client does no I/O.
2. **Discover** over mDNS (`_ihsp._tcp.local`) if that fails, preferring the
   hub's IPv4 — the `A` record, or the `ipv4address` field it publishes in TXT.
   Addresses are only accepted after correlating `PTR → SRV → A`, so records
   from other services sharing the response packet can't be mistaken for it.
3. **Persist** the new address back to `.env` (`DIRIGERA_PERSIST_HOST=false`
   to disable), so the next restart starts from the right place.
4. **Retry** with backoff from `DIRIGERA_RECONNECT_MIN_MS` up to
   `DIRIGERA_RECONNECT_MAX_MS`, forever. A hub that's slow to boot or briefly
   off the network resolves itself without a restart.

A health check every `DIRIGERA_HEALTH_CHECK_MS` catches the silent failures.
When the event stream is running it watches for silence: the client pings every
30s and the hub pongs back, so nothing at all for `DIRIGERA_SILENCE_TIMEOUT_MS`
means the connection is dead rather than the house merely being quiet. With
level-sync off there's no stream to watch, so it polls the REST API instead —
otherwise a hub that moved between sunsets would go unnoticed until the
evening's close silently failed.

**A DHCP reservation is still worth setting** — it removes the most common
trigger, and discovery then only has to cover the rarer cases (hub reboot,
router replacement, the Pi booting first). The two are complementary. If you
have a reservation and would rather a wrong address fail loudly than be
silently corrected, set `DIRIGERA_DISCOVERY_ENABLED=false`.

Note that mDNS discovery needs the hub on the same L2 segment as the Pi, or
mDNS reflection enabled across VLANs. If they're separated and you can't
reflect mDNS, keep `DIRIGERA_HOST` set and rely on the reservation.

## Prerequisites

- Node.js 20+ (`ring-client-api` is ESM-only and dropped Node 18)
- A Ring account with 2FA enabled, a Ring Alarm hub, and at least one contact
  sensor
- An IKEA Dirigera hub on the same LAN as this service (features 2 and 4)
- A lock linked into SmartThings (feature 3)

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

# Blind -> sensor mapping (optional, but the whole point of feature 2)
cp blind-sensor-map.json.example blind-sensor-map.json
```

SmartThings pairing is a separate flow — see
[Smoke-unlock setup](#smoke-unlock-setup-smartthings) below.

### Finding your device names

On first run the service logs the cameras, blinds, contact sensors, smoke/CO
devices and panel it discovers. Run it once and copy names from the output:

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
Watching smoke/CO device: "Hallway Smoke" (alarm.smoke, alarmActive=false)
Watching security panel "Alarm Panel" for fire/CO alarm (alarmInfo.state=none)
Dirigera connected. 3 blind(s): Living Room Left, Kitchen Left, Bedroom Center
Next sunset: 2026-08-01T00:38:12.408Z (in 174min)
Level-sync retry active: 3 attempt(s), 45s apart, settle 20s, min burst 3, max 3 straggler(s)
Automation active.
```

Name matching everywhere is **case-insensitive partial** — `front` matches
`Front Door`. Any mapping entry that doesn't resolve to a real sensor or blind
is logged with a `WARN:` line at startup.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Run the service in the foreground |
| `npm test` | Unit tests for the level-sync and meeting-plug decision logic. Pure and offline. |
| `npm run diag` | Read-only live report of blind levels + what level-sync would do (`--apply` to act). Needs LAN access to the hub — run it on the Pi. |
| `npm run deploy` | Deploy to the Pi (`--dry-run`, `--prune`) |
| `npm run auth` | Mint a Ring refresh token (interactive 2FA) |
| `npm run pair-dirigera` | Pair with the Dirigera hub |
| `npm run pair-smartthings` | One-time SmartThings OAuth pairing; prints the refresh token and device list |

## Deploying

The service runs on a Raspberry Pi under pm2 (`ecosystem.config.cjs`:
autorestart, single instance, 500M memory ceiling), inside the pi user's pm2
daemon (`pm2-pi.service`). Deploy from your dev machine:

```bash
npm run deploy
```

`./deploy.sh --dry-run` shows what would change without touching the Pi;
`--prune` also removes Pi files that are no longer in the repo. Override the
target with `PI_HOST=pi@192.168.1.104 ./deploy.sh` (also `PI_DIR`, `PM2_APP`).

The script:

1. refuses to run on a dirty working tree (untracked files count — they'd be
   rsynced, which would make the stamped commit a lie);
2. warns if the commit isn't on the remote;
3. runs the tests locally;
4. checks the Pi is reachable and reports what's currently deployed;
5. rsyncs, excluding `.git`, `node_modules`, `.env`, `.env.pi.bak`,
   `blind-sensor-map.json`, `.DS_Store`, `scratchpad`;
6. runs `npm ci` **and the tests again on the Pi** (different arch and Node
   build — a green run locally proves nothing about there);
7. stamps `.deployed-commit`, restarts pm2, `pm2 save`;
8. verifies the app came back `online` and fails loudly if not;
9. prints recent logs and a rollback command.

**The Pi's copy is not a git clone** — it has no remote and no commits. Code
gets there by rsync, so `git pull` on the Pi does not work and never has.
`.deployed-commit` is the only record of what's running:

```bash
ssh pi@pi.local 'cat /home/pi/ring-local-enhancements/.deployed-commit'
```

`.env` and `blind-sensor-map.json` live only on the Pi and are never
transferred or deleted.

```bash
ssh pi@pi.local 'pm2 logs ring-local-enhancements'
```

`journal-cleaner.timer` / `journal-cleaner.service` stay on systemd — a daily
`journalctl --vacuum-time=14d` maintenance job, not an app process, so it
doesn't fit the pm2 model.

pm2's own logs (`~/.pm2/logs`) are capped by the `pm2-logrotate` module,
installed once into the pi daemon rather than by the deploy, so it covers every
app on the Pi. It rotates each log at 10M or midnight, gzips, and keeps 14 — the
same window as the journal. Inspect or change it with `pm2 conf pm2-logrotate`
and `pm2 set pm2-logrotate:<key> <value>`.

## Configuration

### .env

Loaded from the project directory at startup. Real environment variables win
over `.env` values, so you can override any of these on the command line.

**Ring (required)**

| Variable | Default | Description |
| --- | --- | --- |
| `RING_REFRESH_TOKEN` | (required) | Token from `npm run auth`. Auto-rotated in place. |
| `DOOR_SENSOR_NAME` | `Front Door` | Sensor that triggers camera snooze |
| `CAMERA_NAME` | `Front Door` | Camera to snooze |
| `SNOOZE_MINUTES` | `30` | Snooze duration |
| `COOLDOWN_SECONDS` | `60` | Min gap between snooze triggers |

**Dirigera blinds** — features 2 and 4 need `DIRIGERA_TOKEN`, `LATITUDE` and
`LONGITUDE`. `DIRIGERA_HOST` is optional; see [Hub addressing](#hub-addressing).

| Variable | Default | Description |
| --- | --- | --- |
| `DIRIGERA_HOST` | (optional) | Starting address for the hub. A hint, not a pin — see below |
| `DIRIGERA_TOKEN` | (optional) | Access token from `npm run pair-dirigera` |
| `LATITUDE` | (optional) | Decimal degrees, for sunset calc |
| `LONGITUDE` | (optional) | Decimal degrees, for sunset calc |
| `BLIND_SENSOR_MAP_FILE` | `blind-sensor-map.json` | Mapping file path, relative to the project dir |
| `POST_CLOSE_DELAY_SECONDS` | `60` | Delay between last mapped sensor closing and the blind closing |

**Hub reachability**

| Variable | Default | Description |
| --- | --- | --- |
| `DIRIGERA_DISCOVERY_ENABLED` | `true` | Fall back to mDNS when the configured address fails |
| `DIRIGERA_PERSIST_HOST` | `true` | Write a newly discovered address back to `.env` |
| `DIRIGERA_DISCOVERY_TIMEOUT_MS` | `10000` | How long to wait for an mDNS answer |
| `DIRIGERA_PROBE_TIMEOUT_MS` | `10000` | How long a candidate address gets to serve a request |
| `DIRIGERA_RECONNECT_MIN_MS` | `5000` | First reconnect delay |
| `DIRIGERA_RECONNECT_MAX_MS` | `300000` | Backoff ceiling; retries continue at this rate forever |
| `DIRIGERA_HEALTH_CHECK_MS` | `60000` | How often the connection is checked |
| `DIRIGERA_SILENCE_TIMEOUT_MS` | `150000` | Event-stream silence that counts as a dead connection |

**Level-sync retry**

| Variable | Default | Description |
| --- | --- | --- |
| `BLIND_LEVEL_SYNC_ENABLED` | `true` | Master switch (`false` disables) |
| `BLIND_LEVEL_SYNC_SETTLE_MS` | `20000` | Quiet period after the last observed change before evaluating |
| `BLIND_LEVEL_SYNC_MAX_BURST_MS` | `120000` | Hard cap on how long one burst may keep extending the settle window |
| `BLIND_LEVEL_SYNC_MAX_RETRIES` | `3` | Retry passes |
| `BLIND_LEVEL_SYNC_RETRY_DELAY_MS` | `45000` | Gap between passes |
| `BLIND_LEVEL_SYNC_MIN_BURST` | `3` | Min blinds moving together to count as house-wide |
| `BLIND_LEVEL_SYNC_MAX_STRAGGLERS` | `3` | Above this, assume a deliberate partial-house state and stand down |
| `BLIND_LEVEL_SYNC_CONSENSUS_RATIO` | `0.667` | Fraction of reachable blinds that must share a target level |
| `BLIND_LEVEL_SYNC_TOLERANCE` | `2` | Points of slack counted as "arrived" |
| `BLIND_FULL_OPEN_NUDGE` | `true` | Nudge a fully-open house off 0 |
| `BLIND_FULL_OPEN_NUDGE_LEVEL` | `3` | Level to nudge to (3 = 3% closed) |

**SmartThings smoke-unlock** — if any of the four required values are missing,
feature 3 stays off.

| Variable | Default | Description |
| --- | --- | --- |
| `ST_CLIENT_ID` | (optional) | OAuth2 client ID from `smartthings apps:create` |
| `ST_CLIENT_SECRET` | (optional) | OAuth2 client secret |
| `ST_REFRESH_TOKEN` | (optional) | From `npm run pair-smartthings`. Rotates on every refresh; auto-persisted. |
| `ST_LOCK_DEVICE_ID` | (optional) | SmartThings device ID of the lock |
| `SMOKE_UNLOCK_COOLDOWN_SECONDS` | `300` | Min gap between successful unlocks |
| `ST_REDIRECT_URI` | `https://httpbin.org/get` | Redirect URI for the one-time pairing flow only |

**Meeting plug** — feature 5. Reuses the `ST_*` credentials above. Without
`MEETING_PLUG_TOKEN` the listener never starts, so the feature is off.

| Variable | Default | Description |
| --- | --- | --- |
| `MEETING_PLUG_TOKEN` | (optional) | Bearer token(s) the Macs send. Comma-separate one per machine so each can be revoked alone. Required to enable the feature |
| `MEETING_PLUG_DEVICE_NAME` | (optional) | Plug's name in the SmartThings app, e.g. `Logo Light`. Exact match wins over substring |
| `MEETING_PLUG_DEVICE_ID` | (optional) | Pin the device id outright instead of looking the name up |
| `MEETING_PLUG_PORT` | `8787` | Listener port |
| `MEETING_PLUG_HOST` | `0.0.0.0` | Listener bind address |
| `MEETING_PLUG_DEFAULT_MINUTES` | `60` | Used when the meeting length can't be worked out |
| `MEETING_PLUG_MIN_MINUTES` | `5` | Floor on the computed run time |
| `MEETING_PLUG_MAX_MINUTES` | `240` | Ceiling — stops one bad end date leaving the plug on for days |
| `MEETING_PLUG_RESPECT_EXISTING` | `true` | Leave a plug that was already on alone at the end |
| `MEETING_PLUG_TICK_MS` | `20000` | Off-time check interval, and the worst-case lateness of an off |
| `ST_REDIRECT_URI` | `https://httpbin.org/get` | Only used by `npm run pair-smartthings`; must be public HTTPS and match the OAuth app exactly |

Non-`.env` knobs live at the top of `index.mjs`: `CLOSE_ORDER` (sunset close
order), `BLIND_CLOSED_LEVEL`, close spacing, sunset retry timing, and the
self-command echo window.

### blind-sensor-map.json

Keys are partial substrings of Dirigera blind names; values are partial
substrings of Ring contact sensor names. Both sides match case-insensitively.
A value may be a single name or an **array** — with an array, the blind only
closes once **all** listed sensors are closed. Keys starting with `_` are
ignored, so you can keep comments in the file. Blinds not listed always close
at sunset.

```json
{
  "_comment": "Kitchen Center has two windows; both must be shut.",
  "Living Room Blind": "Front Door",
  "Kitchen Blind": "Back Door",
  "Kitchen Center Blind": ["Left Kitchen Window", "Right Kitchen Window"]
}
```

If the file is missing, all blinds close unconditionally at sunset. If it's
malformed, it's logged and treated as empty.

### Smoke-unlock setup (SmartThings)

The Ultraloq lock is linked into **SmartThings** (cloud-to-cloud), and this
drives it through the official SmartThings REST API. First create an
**OAuth-In app** with the
[SmartThings CLI](https://github.com/SmartThingsCommunity/smartthings-cli):

```bash
smartthings apps:create
#  -> choose "OAuth-In App"
#  -> Display Name / Description: anything (e.g. "ring-local-enhancements")
#  -> Scopes: r:devices:*  and  x:devices:*
#  -> Redirect URI: https://httpbin.org/get   (see note below)
```

**Redirect URI must be public HTTPS.** SmartThings returns a 403 on the
authorize page for `http://localhost` URIs, so the pairing uses a public HTTPS
redirect that just displays the code. `https://httpbin.org/get` works (it echoes
the `?code=` back); anything public + HTTPS that lets you read the address bar
is fine. It must match `ST_REDIRECT_URI` exactly.

`apps:create` prints an **OAuth Client Id** and **OAuth Client Secret** (the
secret is shown only once). Then, **on a machine with a browser**, mint a
refresh token and find the lock's device ID:

```bash
ST_CLIENT_ID=xxx ST_CLIENT_SECRET=yyy npm run pair-smartthings
```

It opens the consent screen; after you approve, the browser lands on the
redirect URL with `?code=...`. Paste that code (or the whole URL) at the prompt.
It exchanges the code, prints an `ST_REFRESH_TOKEN`, and lists your devices
(locks flagged `* LOCK`). Copy `ST_CLIENT_ID`, `ST_CLIENT_SECRET`,
`ST_REFRESH_TOKEN`, and the lock's `ST_LOCK_DEVICE_ID` into the Pi's `.env`.

## Token refresh

Ring refresh tokens rotate. The service writes the updated token back to `.env`
automatically (`onRefreshTokenUpdated`). The Dirigera access token does not
rotate.

SmartThings access tokens last 24h and are refreshed 2 minutes before expiry.
Refresh tokens rotate on **every** refresh and expire after ~30 days if unused;
the service persists each rotated `ST_REFRESH_TOKEN` back to `.env`, validates
the credentials once at startup (so a bad token is a startup error, not a
surprise mid-alarm), and refreshes on a 12-hour keepalive so the token stays
alive and an unlock never waits on a cold refresh. If the service is stopped
for more than ~30 days, re-run `npm run pair-smartthings`.

## Repo layout

| File | Role |
| --- | --- |
| `index.mjs` | The service: all five automations, config, lifecycle |
| `hub-discovery.mjs` | mDNS lookup of the Dirigera hub, preferring IPv4 (`discoverDirigeraHost`) |
| `level-sync.mjs` | Pure decision logic for the level-sync retry (`planLevelSync`) |
| `test-level-sync.mjs` | Unit tests for the above (`npm test`) |
| `blind-holds.mjs` | Calendar days on which specific blinds skip the sunset close (`holdOpenReason`) |
| `test-blind-holds.mjs` | Unit tests for the above (`npm test`) |
| `diag-level-sync.mjs` | Live read-only diagnostic (`npm run diag`) |
| `smartthings-lock.mjs` | SmartThings OAuth2 client: lock/unlock, switch on/off, list devices |
| `meeting-plug.mjs` | Pure decision logic for the meeting plug (`planMeetingStart`, `planTick`) |
| `test-meeting-plug.mjs` | Unit tests for the above (`npm test`) |
| `mac/` | The Mac half of feature 5: MeetingBar join script, helper, installer |
| `pair-smartthings.mjs` | One-time SmartThings OAuth pairing helper |
| `deploy.sh` | rsync + test + pm2 restart deploy to the Pi |
| `ecosystem.config.cjs` | pm2 app definition |
| `journal-cleaner.{service,timer}` | systemd journal vacuum, 14-day retention |
| `update-node.cron` | Reference copy of `/etc/cron.weekly/update-node` on the Pi — weekly Node upgrade + pm2 migration |
| `.env.example`, `blind-sensor-map.json.example` | Tracked templates |

`.env`, `.env.pi.bak`, `blind-sensor-map.json` and `.meeting-plug-state.json`
are gitignored and exist only where they're used. Never put real secrets in `.env.example`.

## Caveats

- **Unofficial Ring API**: `ring-client-api` is community-maintained. Ring can
  break it any time with backend changes.
- **push-receiver override**: `package.json` `overrides` forces
  `@eneris/push-receiver` 4.4.0 under `ring-client-api`, which pins 4.3.0.
  4.3.0 misparses Ring's `crypto-key` header when it carries more than `dh=`
  and logs `ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY` for every such push. Drop the
  override once `ring-client-api` ships 4.4.0 or later itself.
- **Snooze survives a restart as "off"**: the re-enable is an in-memory timer.
  If the service restarts inside a snooze window, that camera's Person
  notifications stay disabled until a later snooze cycle completes. Re-enable
  them in the Ring app if you notice it.
- **Snooze scope**: the setting is on the camera itself, so the mute applies to
  everyone on the account, not just this session.
- **Network requirement**: needs persistent outbound to `mtalk.google.com:5228`
  (FCM) for real-time Ring push, LAN access to the Dirigera hub, and outbound
  HTTPS to `api.smartthings.com`.
- **Blind direction**: assumes `blindsTargetLevel: 100` = closed (rolled down),
  which matches FYRTUR/KADRILJ defaults. If yours go the other way, flip
  `BLIND_CLOSED_LEVEL` in `index.mjs`.
- **SmartThings unlock is cloud + best-effort**: it goes through the
  SmartThings (and U-tec) cloud, so it depends on internet and service uptime
  and can't be guaranteed during a fire. The same is true of the Ring smoke
  trigger, so this doesn't add a dependency the detection side didn't already
  have.
- **Fire trigger is unverified in the field**: the unlock command → lock path
  was verified end-to-end, but the panel `fire-alarm` trigger itself is per
  Ring's data model and hadn't been observed firing (testing was done in
  Practice Mode). Individual smoke/CO detectors were observed *not* to flip
  their own `alarmStatus` in the data shadow (the Bluejay signals via
  `pushToTest`/impulses; the listener via impulses), which is why per-device
  `alarmStatus` is only a backup. Every panel `alarmInfo.state` transition is
  logged — check the log after any real alarm.
- **Sunset scheduling uses a single timer**: a large system clock jump or a
  long suspend can skew the next firing until the following day's reschedule.

## Troubleshooting

- **No Ring events**: check that port 5228 outbound to `mtalk.google.com` isn't
  blocked. Also prune stale sessions in the Ring app under Account → Authorized
  Client Devices.
- **Dirigera pairing fails**: the action-button press window is short (~60s).
  Re-run pairing and press the button as soon as the CLI starts polling. If you
  see `Gateway discovery timed out`, mDNS isn't reaching the hub — find the IP
  with `sudo nmap -p 8443 --open -T4 <your-subnet>` and use
  `npx dirigera authenticate --gateway-IP <ip>`.
- **Sunset doesn't fire**: check the startup log for the computed next sunset.
  If it's wrong, `LATITUDE` / `LONGITUDE` are off or the system clock is in a
  surprising timezone.
- **Blind closes anyway when a door is open**: confirm the IKEA Home Smart
  sunset scene is disabled. Then check the startup log — an unresolved mapping
  entry logs a `WARN:` line, and an unmapped blind closes unconditionally by
  design.
- **Level-sync never fires**: run `npm run diag` on the Pi. The verdict line
  names the exact rule that stood it down (burst too small, no consensus, too
  many stragglers).
- **Smoke-unlock silent**: `Smoke-unlock: armed` must appear at startup;
  otherwise one of the four `ST_*` values is missing. A keepalive failure logs
  `SmartThings token keepalive failed` — re-run `npm run pair-smartthings`.
- **Node upgrades on the Pi**: `/etc/cron.weekly/update-node` installs the
  latest v24 and migrates pm2 onto it — carrying global packages across,
  regenerating the systemd unit, and restarting the daemon. It logs every run:

  ```bash
  ssh pi@pi.local 'journalctl -t update-node -n 20'
  ```

  If it fails it says so at error priority and leaves the old, working unit in
  place rather than tearing down a good boot path. The usual cause is
  root-owned files under `~/.nvm` or `~/.npm` (they must be `pi:pi`), which
  stops nvm carrying pm2 into the new version; the error message names the
  fix. `ecosystem.config.cjs` sets `interpreter: "node"` deliberately, so the
  app is never pinned to a Node version that a later upgrade removes.
- **Service won't start**: it exits deliberately on missing
  `RING_REFRESH_TOKEN`, no Ring locations, no camera matching `CAMERA_NAME`, no
  alarm hub, or no contact sensor matching any wanted name. Each logs the
  reason and the available names. An unreachable Dirigera hub is *not* fatal —
  it retries in the background.
- **Blinds do nothing, but Ring still works**: the hub is unreachable. The log
  shows `Dirigera connect attempt N failed`. If discovery also fails
  (`no Dirigera hub answered _ihsp._tcp.local`), the Pi can't see the hub over
  mDNS — check they're on the same subnet, then find it by hand with
  `sudo nmap -p 8443 --open -T4 <your-subnet>` and set `DIRIGERA_HOST`.
- **Hub moved**: nothing to do — the log shows
  `Hub address changed -- saved DIRIGERA_HOST=<ip> to .env` and carries on.
  To find it yourself: `dns-sd -B _ihsp._tcp` (macOS) or
  `avahi-browse -rt _ihsp._tcp` (Linux). A DHCP reservation avoids the whole
  situation.
