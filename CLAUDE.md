# ring-local-enhancements

## Deployment

- Runs on a Raspberry Pi reachable at `pi.local` (user `pi`).
- Project lives at `/home/pi/ring-local-enhancements` on the Pi.
- Managed by the `ring-local-enhancements.service` systemd unit.

## Secrets

- `.env` holds Ring + Dirigera credentials and is gitignored (literal match).
- `.env.example` is the tracked template — do not put real secrets in it.
- When pulling backups from the Pi, save under a name that is explicitly
  gitignored (e.g. `.env.pi.bak`) and verify with `git status --ignored`
  before any commit.
