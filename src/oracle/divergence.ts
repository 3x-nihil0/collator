import type {
  Divergence,
  DocumentedClaim,
  EngineResult,
  EvidenceReport,
  Outcome,
  PolicyResult,
  SourceConflict,
} from "./types.js";

export type { SourceConflict };

function observedFor(
  claim: DocumentedClaim,
  results: EngineResult[],
  policies: PolicyResult[],
): { outcome: Outcome | null; checkedAgainst: string } {
  if (claim.target.kind === "engine") {
    const family = claim.target.engineFamily;
    const hit = results.find((r) => r.engineId === family && r.vectorId === claim.vectorId);
    if (!hit || hit.tier !== "EXECUTED") {
      return { outcome: null, checkedAgainst: `${family} (not executable here)` };
    }
    return { outcome: hit.outcome, checkedAgainst: hit.engineId };
  }

  const policyId = claim.target.policyId;
  const policy = policies.find((p) => p.policyId === policyId && p.vectorId === claim.vectorId);
  if (!policy || policy.equal === null) {
    return { outcome: null, checkedAgainst: `${policyId} (not executable here)` };
  }
  return {
    outcome: policy.equal ? "COLLIDES" : "DISTINCT",
    checkedAgainst: policy.policyId,
  };
}

/**
 * Compare what the sources *claim* against what the engines *did*.
 *
 * Two outcomes matter:
 *   DISAGREE  - the source is contradicted by an executed probe
 *   UNVERIFIED - nobody ran it here, so it stays a DOCUMENTED claim forever
 */
export function detectDivergences(
  claims: DocumentedClaim[],
  results: EngineResult[],
  policies: PolicyResult[],
): { divergences: Divergence[]; conflicts: SourceConflict[] } {
  const divergences: Divergence[] = claims.map((claim) => {
    const { outcome, checkedAgainst } = observedFor(claim, results, policies);

    if (outcome === null) {
      return {
        claimId: claim.id,
        vectorId: claim.vectorId,
        status: "UNVERIFIED",
        predicted: claim.predicts,
        observed: null,
        checkedAgainst,
        note: "No executable configuration for this target exists in this environment, so the claim cannot be confirmed or refuted.",
      };
    }

    const agree = outcome === claim.predicts;
    return {
      claimId: claim.id,
      vectorId: claim.vectorId,
      status: agree ? "AGREE" : "DISAGREE",
      predicted: claim.predicts,
      observed: outcome,
      checkedAgainst,
      note: agree
        ? "Executed result matches the claim."
        : `Claim predicts ${claim.predicts}; the probe returned ${outcome}.`,
    };
  });

  // Sources that contradict each other about the *same* configuration are what
  // a Sanity Knowledge Base raises as an Issue during a build.
  const groups = new Map<string, DocumentedClaim[]>();
  for (const claim of claims) {
    const family = claim.target.kind === "engine" ? claim.target.engineFamily : claim.target.policyId;
    const key = `${family}::${claim.vectorId}`;
    groups.set(key, [...(groups.get(key) ?? []), claim]);
  }

  const conflicts: SourceConflict[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const predictions = new Set(group.map((c) => c.predicts));
    if (predictions.size < 2) continue;

    const [family, vectorId] = key.split("::") as [string, string];
    const { outcome, checkedAgainst } = observedFor(group[0]!, results, policies);
    conflicts.push({
      vectorId,
      family,
      claims: group.map((c) => ({
        id: c.id,
        kind: c.kind,
        source: c.source,
        predicts: c.predicts,
      })),
      resolution: outcome,
      resolvedBy: outcome === null ? null : checkedAgainst,
    });
  }

  return { divergences, conflicts };
}

export function summarise(
  divergences: Divergence[],
  results: EngineResult[],
  engines: EvidenceReport["engines"],
  unavailable: EvidenceReport["unavailable"],
): EvidenceReport["summary"] {
  const executedChecks = results.filter((r) => r.tier === "EXECUTED").length;
  const enginesExecuted = new Set(
    results.filter((r) => r.tier === "EXECUTED").map((r) => r.engineId),
  ).size;
  const enginesNamedOnly =
    engines.filter((e) => !results.some((r) => r.engineId === e.id && r.tier === "EXECUTED"))
      .length + unavailable.length;

  return {
    executedChecks,
    enginesExecuted,
    enginesNamedOnly,
    claimsChecked: divergences.length,
    claimsDisagreeing: divergences.filter((d) => d.status === "DISAGREE").length,
    claimsUnverified: divergences.filter((d) => d.status === "UNVERIFIED").length,
  };
}
