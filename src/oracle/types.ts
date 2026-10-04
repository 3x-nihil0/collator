/**
 * Shared evidence model.
 *
 * Every claim Collator makes carries a tier, because the whole point of the
 * product is that it will not assert something it did not run:
 *
 *   EXECUTED    - a probe actually ran and this is the raw outcome
 *   DOCUMENTED  - a source says so; we could not run it here
 *   UNAVAILABLE - no admissible evidence at all, so we refuse
 */

export type EvidenceTier = "EXECUTED" | "DOCUMENTED" | "UNAVAILABLE";
export type Outcome = "COLLIDES" | "DISTINCT" | "ERROR";

export interface CodePointInfo {
  char: string;
  hex: string;
  name: string;
  category: string;
}

export interface Vector {
  id: string;
  klass: string;
  label: string;
  a: string;
  b: string;
  why: string;
  codepointsA: CodePointInfo[];
  codepointsB: CodePointInfo[];
}

export interface EngineDescriptor {
  id: string;
  engine: string;
  version?: string;
  label: string;
  note?: string;
  kind: string;
  collation?: string | null;
}

export interface EngineResult {
  engineId: string;
  vectorId: string;
  tier: EvidenceTier;
  outcome: Outcome;
  detail: string;
}

export interface PolicyResult {
  policyId: string;
  label: string;
  /** engine = a database builtin such as PostgreSQL normalize() */
  side: "python" | "javascript" | "engine";
  vectorId: string;
  equal: boolean | null;
  normalizedA: string;
  normalizedB: string;
  tier: EvidenceTier;
  detail?: string;
}

export interface UnavailableEngine {
  engine: string;
  tier: EvidenceTier;
  reason: string;
  remediation?: string;
  port?: number;
  detected?: boolean;
}

/** A claim found in the world: vendor documentation, a spec, or folklore. */
export interface DocumentedClaim {
  id: string;
  /** vendor-doc = authoritative; spec = standard; folklore = SO/blog advice */
  kind: "vendor-doc" | "spec" | "folklore";
  engine: string;
  source: string;
  sourceUrl: string;
  /** what this claim predicts, expressed against a test vector */
  vectorId: string;
  predicts: Outcome;
  text: string;
  /** where the prediction can be checked, if anywhere */
  target: { kind: "engine"; engineFamily: string } | { kind: "policy"; policyId: string };
}

export interface SourceConflict {
  vectorId: string;
  family: string;
  claims: { id: string; kind: DocumentedClaim["kind"]; source: string; predicts: Outcome }[];
  resolution: Outcome | null;
  resolvedBy: string | null;
}

export interface Divergence {
  claimId: string;
  vectorId: string;
  status: "AGREE" | "DISAGREE" | "UNVERIFIED";
  predicted: Outcome;
  observed: Outcome | null;
  checkedAgainst: string;
  note: string;
}

export interface OracleRuntime {
  python?: string;
  sqlite?: string;
  implementation?: string;
  platform?: string;
  postgres?: string;
}

export interface EvidenceReport {
  tool: string;
  generatedAt: string;
  runtime: OracleRuntime;
  vectors: Vector[];
  engines: EngineDescriptor[];
  results: EngineResult[];
  policies: PolicyResult[];
  unavailable: UnavailableEngine[];
  /** every sourced claim, so the UI can cite URLs next to outcomes */
  claims: DocumentedClaim[];
  /** configurations that were rejected by calibration, with the reason */
  engineFailures: { engineId: string; reason: string }[];
  divergences: Divergence[];
  /** claims that contradict each other about the same configuration */
  conflicts: SourceConflict[];
  /** headline numbers for the UI and the writeup */
  summary: {
    executedChecks: number;
    enginesExecuted: number;
    /** engines named in the evidence that could not be executed in this host */
    enginesNamedOnly: number;
    claimsChecked: number;
    claimsDisagreeing: number;
    claimsUnverified: number;
  };
}
