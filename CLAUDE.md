# ring-local-enhancements

## Checks

- `npm test` — unit tests for the level-sync decision logic
  (`level-sync.mjs`). Pure and offline; run before deploying.
- `npm run diag` — read-only report of live blind levels and what the
  level-sync logic would decide. Needs LAN access to the Dirigera hub, so
  run it on the Pi. `--apply` makes it act.

## Deployment

- Runs on a Raspberry Pi reachable at `pi.local` (user `pi`).
- Project lives at `/home/pi/ring-local-enhancements` on the Pi.
- Managed by pm2 (`ecosystem.config.cjs`), running under the pi user's pm2
  daemon (`pm2-pi.service`), consistent with the other projects on this Pi.
- `journal-cleaner` stays on its systemd timer — it's a system-level
  `journalctl --vacuum-time` maintenance job, not an app process, so it
  doesn't fit the pm2 model.

## Secrets

- `.env` holds Ring + Dirigera credentials and is gitignored (literal match).
- `.env.example` is the tracked template — do not put real secrets in it.
- When pulling backups from the Pi, save under a name that is explicitly
  gitignored (e.g. `.env.pi.bak`) and verify with `git status --ignored`
  before any commit.
