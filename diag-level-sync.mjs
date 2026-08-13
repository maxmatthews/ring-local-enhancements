/**
 * Read-only diagnostic for the blind level-sync feature.
 *
 *   node diag-level-sync.mjs           # report only, touches nothing
 *   node diag-level-sync.mjs --apply   # actually drive the stragglers
 *
 * Prints every blind's current vs. target level and runs the real decision
 * logic (level-sync.mjs) over the live snapshot, so you can see exactly what
 * the service would do about blinds that didn't respond.
 *
 * Caveat: the running service builds its "burst" from live hub events, which
 * is how it tells a blind that MISSED a command from one you deliberately set
 * apart. After the fact that distinction is gone, so this script reconstructs
 * the burst as "every blind already sitting on the majority target". A blind
 * you deliberately set differently will therefore show up here as a straggler
 * even though the live service would leave it alone.
 */

import { createDirigeraClient } from "dirigera";
import { discoverDirigeraHost } from "./hub-discovery.mjs";
import { planLevelSync, blindDisplayName } from "./level-sync.mjs";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, ".env");
if (!existsSync(envPath)) {
  console.error("No .env file found.");
  process.exit(1);
}
for (const line of readFileSync(envPath, "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  if (!process.env[k]) process.env[k] = v;
}

const APPLY = process.argv.includes("--apply");

const cfg = {
  tolerance: parseInt(process.env.BLIND_LEVEL_SYNC_TOLERANCE || "2", 10),
  consensusRatio: parseFloat(process.env.BLIND_LEVEL_SYNC_CONSENSUS_RATIO || "0.667"),
  maxStragglers: parseInt(process.env.BLIND_LEVEL_SYNC_MAX_STRAGGLERS || "3", 10),
  minBurst: parseInt(process.env.BLIND_LEVEL_SYNC_MIN_BURST || "3", 10),
  fullOpenNudgeEnabled: (process.env.BLIND_FULL_OPEN_NUDGE || "true").toLowerCase() !== "false",
  fullOpenNudgeLevel: parseInt(process.env.BLIND_FULL_OPEN_NUDGE_LEVEL || "3", 10),
};

const pad = (s, n) => String(s).padEnd(n);

// Same hint-then-discover fallback the service uses, so a moved hub doesn't
// make the diagnostic unusable exactly when you need it to explain a failure.
async function connect() {
  const configured = process.env.DIRIGERA_HOST;
  if (configured) {
    try {
      const client = await createDirigeraClient({ accessToken: process.env.DIRIGERA_TOKEN, gatewayIP: configured });
      return { client, blinds: await client.blinds.list(), ip: configured };
    } catch (err) {
      console.error(`Hub did not answer at ${configured} (${err.message}) -- searching over mDNS...`);
    }
  }
  const { ip, hostname, via } = await discoverDirigeraHost({
    timeoutMs: parseInt(process.env.DIRIGERA_DISCOVERY_TIMEOUT_MS || "10000", 10),
  });
  console.error(`Found the hub at ${ip} (${hostname}, via ${via})`);
  if (configured) console.error(`NOTE: DIRIGERA_HOST in .env still says ${configured}`);
  const client = await createDirigeraClient({ accessToken: process.env.DIRIGERA_TOKEN, gatewayIP: ip });
  return { client, blinds: await client.blinds.list(), ip };
}

const { client, blinds } = await connect();
blinds.sort((a, b) => blindDisplayName(a).localeCompare(blindDisplayName(b)));

console.log(`\nDirigera levels: 0 = fully open, 100 = fully closed\n`);
console.log(`${pad("BLIND", 24)} ${pad("CURRENT", 8)} ${pad("TARGET", 8)} ${pad("BATTERY", 8)} REACHABLE`);
console.log("-".repeat(66));
for (const b of blinds) {
  const a = b.attributes || {};
  console.log(
    `${pad(blindDisplayName(b), 24)} ${pad(a.blindsCurrentLevel ?? "?", 8)} ${pad(a.blindsTargetLevel ?? "?", 8)} ` +
      `${pad(a.batteryPercentage ?? "?", 8)} ${b.isReachable === false ? "NO" : "yes"}`
  );
}

// Reconstruct the burst: the blinds sitting on the majority target are the
// ones that visibly followed the last house-wide command.
const tally = new Map();
for (const b of blinds) {
  if (b.isReachable === false || b.isHidden) continue;
  const t = b.attributes?.blindsTargetLevel;
  if (typeof t === "number") tally.set(t, (tally.get(t) || 0) + 1);
}
let majority = null;
let best = 0;
for (const [level, count] of tally) {
  if (count > best) {
    best = count;
    majority = level;
  }
}
const burst = new Map(
  blinds.filter((b) => b.attributes?.blindsTargetLevel === majority).map((b) => [b.id, majority])
);

const plan = planLevelSync(blinds, burst, cfg);

console.log(`\nReconstructed burst: ${burst.size} blind(s) on target level ${majority}`);
console.log(`Verdict: ${plan.action.toUpperCase()}${plan.reason ? ` -- ${plan.reason}` : ""}`);
if (plan.consensus !== undefined) {
  console.log(`Consensus level ${plan.consensus} (${plan.agreeing}/${plan.candidateCount}, needed ${plan.needed})`);
}
if (plan.nudging) console.log(`Full-open nudge active -> driving to level ${plan.target}`);
if (plan.skipped?.length) {
  console.log("Left alone:");
  for (const s of plan.skipped) console.log(`  - ${s.name}: ${s.reason}`);
}
if (plan.stragglers?.length) {
  console.log("Did not respond:");
  for (const s of plan.stragglers) console.log(`  - ${s.name}: at ${s.level}, target ${s.target} (${s.mode})`);
}

if (plan.action === "sync" && APPLY) {
  console.log(`\nApplying: driving ${plan.stragglers.length} blind(s) to level ${plan.target}...`);
  for (const s of plan.stragglers) {
    await client.blinds.setTargetLevel({ id: s.id, blindsTargetLevel: plan.target });
    console.log(`  sent ${plan.target} -> ${s.name}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("Sent. Re-run without --apply in a minute to confirm they landed.");
} else if (plan.action === "sync") {
  console.log(`\n(read-only -- re-run with --apply to drive these to level ${plan.target})`);
}

client.stopListeningForUpdates?.();
process.exit(0);
