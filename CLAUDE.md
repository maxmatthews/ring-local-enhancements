# ring-local-enhancements

## Checks

- `npm test` — unit tests for the level-sync, meeting-plug, blind-hold and
  Govee-lights decision logic (`level-sync.mjs`, `meeting-plug.mjs`,
  `blind-holds.mjs`, `govee-lights.mjs`). Pure and offline; run
  before deploying.
- `npm run diag` — read-only report of live blind levels and what the
  level-sync logic would decide. Needs LAN access to the Dirigera hub, so
  run it on the Pi. `--apply` makes it act.

## Deployment

- **Deploy with `./deploy.sh`** (or `npm run deploy`). `--dry-run` shows what
  would change; `--prune` also deletes Pi files no longer in the repo.
- Runs on a Raspberry Pi reachable at `pi.local` (user `pi`).
- Project lives at `/home/pi/ring-local-enhancements` on the Pi.
- **The Pi's copy is NOT a git clone.** It has no remote and no commits — the
  code is rsynced there. `git pull` on the Pi does not work and never has.
  `deploy.sh` writes the deployed SHA to `.deployed-commit` on the Pi, which
  is the only record of what's running.
- `.env` and `blind-sensor-map.json` exist **only on the Pi** and are never
  transferred or deleted by the deploy. Don't overwrite them with local copies.
- `.meeting-plug-state.json` is the Pi's own live state (the meeting currently
  holding the plug on). It's excluded from the deploy on purpose — pruning it
  mid-meeting would strand the plug on.
- `.govee-lights-state.json` is likewise the Pi's own (which of tonight's
  on/off already fired, and the last scene shown) and excluded from the deploy.
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
