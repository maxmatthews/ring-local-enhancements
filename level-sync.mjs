/**
 * Decision logic for the blind level-sync retry.
 *
 * Pure and I/O-free on purpose: index.mjs feeds it a blind snapshot and
 * executes the plan it returns, and diag-level-sync.mjs feeds it the same
 * snapshot just to print what would happen. Both exercise identical code.
 *
 * Dirigera levels run 0 = fully open .. 100 = fully closed.
 */

export const FULL_OPEN_LEVEL = 0;

export function blindDisplayName(blind) {
  return blind.attributes?.customName || blind.id;
}

function atLevel(level, target, tolerance) {
  return Math.abs(level - target) <= tolerance;
}

/**
 * Decide what to do after a burst of blind target changes has settled.
 *
 * @param {Array} blinds        result of dirigera.blinds.list()
 * @param {Map}   burst         blindId -> target level commanded during the burst
 * @param {Object} cfg          thresholds + environment probes
 * @returns {Object} plan       { action: "sync" | "ignore", ... }
 */
export function planLevelSync(blinds, burst, cfg) {
  const {
    tolerance,
    consensusRatio,
    maxStragglers,
    minBurst,
    fullOpenNudgeEnabled,
    fullOpenNudgeLevel,
    isPendingClose = () => false,
    openSensorsFor = () => [],
    holdOpenReason = () => null,
  } = cfg;

  const ignore = (reason, extra = {}) => ({ action: "ignore", reason, ...extra });

  if (burst.size < minBurst) {
    return ignore(
      `only ${burst.size} blind(s) commanded, below the ${minBurst} needed to count as a house-wide change`
    );
  }

  const candidates = blinds.filter((b) => b.isReachable !== false && !b.isHidden);
  const unreachable = blinds.filter((b) => b.isReachable === false).map(blindDisplayName);
  if (candidates.length === 0) return ignore("no reachable blinds", { unreachable });

  // Consensus = the target level the largest share of blinds is aiming at.
  const tally = new Map();
  for (const blind of candidates) {
    const target = blind.attributes?.blindsTargetLevel;
    if (typeof target !== "number") continue;
    tally.set(target, (tally.get(target) || 0) + 1);
  }

  let consensus = null;
  let agreeing = 0;
  for (const [level, count] of tally) {
    if (count > agreeing) {
      agreeing = count;
      consensus = level;
    }
  }

  const needed = Math.ceil(candidates.length * consensusRatio);
  if (consensus === null || agreeing < needed) {
    return ignore(
      `no consensus level (best was ${consensus} with ${agreeing}/${candidates.length}, needed ${needed})`,
      { consensus, agreeing, needed, candidateCount: candidates.length, unreachable }
    );
  }

  // Opening the house all the way lands every blind on the nudged level rather
  // than 0, so the whole house is expected to move and the straggler cap
  // doesn't apply to that pass.
  const nudging = fullOpenNudgeEnabled && consensus === FULL_OPEN_LEVEL;
  const target = nudging ? fullOpenNudgeLevel : consensus;

  const stragglers = [];
  const skipped = [];
  for (const blind of candidates) {
    const name = blindDisplayName(blind);
    const level = blind.attributes?.blindsCurrentLevel;
    if (typeof level !== "number") {
      skipped.push({ name, reason: "no current-level reading" });
      continue;
    }
    if (atLevel(level, target, tolerance)) continue;

    // Compared against the commanded level, not the nudged one: a blind
    // explicitly told to go fully open is following the house, not opting out.
    const burstTarget = burst.get(blind.id);
    if (burstTarget !== undefined && burstTarget !== consensus) {
      skipped.push({ name, reason: `deliberately set to ${burstTarget}` });
      continue;
    }
    if (isPendingClose(blind.id)) {
      skipped.push({ name, reason: "deferred sunset close pending" });
      continue;
    }
    const held = holdOpenReason(name);
    if (held) {
      skipped.push({ name, reason: `held open for ${held}` });
      continue;
    }
    const open = openSensorsFor(name);
    if (open.length > 0) {
      skipped.push({ name, reason: `open sensor(s): ${open.join(", ")}` });
      continue;
    }

    // A blind whose target already matches but whose level does not was told to
    // move and didn't; one whose target is also stale never got the command.
    const blindTarget = blind.attributes?.blindsTargetLevel;
    const mode = blindTarget === consensus ? "did-not-move" : "missed-command";
    stragglers.push({ id: blind.id, name, level, target: blindTarget, mode });
  }

  const base = {
    consensus,
    target,
    nudging,
    agreeing,
    needed,
    candidateCount: candidates.length,
    stragglers,
    skipped,
    unreachable,
  };

  if (stragglers.length === 0) {
    return { ...base, action: "ignore", reason: `all ${candidates.length} blind(s) already at level ${target}` };
  }
  if (!nudging && stragglers.length > maxStragglers) {
    return {
      ...base,
      action: "ignore",
      reason: `${stragglers.length} blind(s) off level ${target}, more than the ${maxStragglers} expected -- looks like a deliberate partial-house state`,
    };
  }

  return { ...base, action: "sync" };
}
