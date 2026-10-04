/**
 * Verdict derivation.
 *
 * The verdict shown in the UI is computed from executed rows, never from
 * model prose. Four states exist, and the fourth is a first-class answer:
 *
 *   COLLIDES - every configuration that ran rejected the second insert
 *   DISTINCT - every configuration that ran accepted both rows
 *   SPLIT    - configurations disagree, so the answer depends on the engine
 *   REFUSED  - nothing ran, so there is no admissible answer at all
 */

import type { EngineDescriptor, EngineResult, UnavailableEngine } from "../oracle/types.js";

export type VerdictKind = "COLLIDES" | "DISTINCT" | "SPLIT" | "REFUSED";

export interface Verdict {
  kind: VerdictKind;
  headline: string;
  executed: number;
  colliding: number;
  distinct: number;
  /** reasons nothing could run - only present when kind === "REFUSED" */
  refusals: string[];
}

export function verdictFromResults(
  results: EngineResult[],
  engines: EngineDescriptor[],
  unavailable: UnavailableEngine[] = [],
): Verdict {
  const labels = new Map(engines.map((e) => [e.id, e.label]));
  const executed = results.filter((r) => r.tier === "EXECUTED" && r.outcome !== "ERROR");
  const colliding = executed.filter((r) => r.outcome === "COLLIDES");
  const distinct = executed.filter((r) => r.outcome === "DISTINCT");

  if (executed.length === 0) {
    const refusals = [
      ...results
        .filter((r) => r.outcome === "ERROR" || r.tier === "UNAVAILABLE")
        .map((r) => `${labels.get(r.engineId) ?? r.engineId}: ${r.detail || "no admissible evidence"}`),
      ...unavailable.map((u) => `${u.engine}: ${u.reason}${u.remediation ? ` (${u.remediation})` : ""}`),
    ];
    return {
      kind: "REFUSED",
      headline: "REFUSED: nothing executed - no admissible evidence for this pair",
      executed: 0,
      colliding: 0,
      distinct: 0,
      refusals: refusals.length > 0 ? refusals : ["no engine on this host could execute the constraint"],
    };
  }

  if (colliding.length > 0 && distinct.length === 0) {
    return {
      kind: "COLLIDES",
      headline: `COLLIDES: all ${colliding.length} executed configurations rejected the second insert`,
      executed: executed.length,
      colliding: colliding.length,
      distinct: 0,
      refusals: [],
    };
  }

  if (distinct.length > 0 && colliding.length === 0) {
    return {
      kind: "DISTINCT",
      headline: `DISTINCT: all ${distinct.length} executed configurations accepted both rows - two accounts, one identity`,
      executed: executed.length,
      colliding: 0,
      distinct: distinct.length,
      refusals: [],
    };
  }

  return {
    kind: "SPLIT",
    headline:
      `SPLIT: ${colliding.length} configuration(s) collide, ${distinct.length} stay distinct - ` +
      "the answer depends on which engine and collation you actually run",
    executed: executed.length,
    colliding: colliding.length,
    distinct: distinct.length,
    refusals: [],
  };
}
