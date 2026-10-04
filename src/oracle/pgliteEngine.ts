import { PGlite } from "@electric-sql/pglite";
import type { EngineDescriptor, EngineResult, PolicyResult, Vector } from "./types.js";

interface CollationCandidate {
  id: string;
  label: string;
  /** SQL fragment for COLLATE, or null for the database default */
  collate: string | null;
  note: string;
  /** SQL that must succeed before this configuration can be used */
  prepare?: string;
  /**
   * Calibration: properties this configuration must exhibit if it is
   * actually in effect.  A WASM build can accept a collation and then not
   * apply it; without this check we would publish a confident wrong answer.
   */
  calibrate?: { eqCase?: boolean; aLessThanB?: boolean };
}

/**
 * PGlite runs genuine PostgreSQL as WebAssembly - no native library, so it
 * loads even on hosts whose Application Control policy blocks native
 * drivers. That policy is why PostgreSQL runs through PGlite here rather
 * than against a local server: no credentials, no install, no bypass.
 */
const CANDIDATES: CollationCandidate[] = [
  {
    id: "postgres/default",
    label: "PostgreSQL (database default)",
    collate: null,
    note: "Whatever the cluster was created with. In most managed services this is a C-family collation: byte exact.",
  },
  {
    id: "postgres/C",
    label: 'PostgreSQL COLLATE "C"',
    collate: '"C"',
    note: "Byte-order comparison. Deterministic, case sensitive, accent sensitive.",
    calibrate: { eqCase: false, aLessThanB: false },
  },
  {
    id: "postgres/ucs_basic",
    label: 'PostgreSQL COLLATE "ucs_basic"',
    collate: '"ucs_basic"',
    note: "Code-point order for text. Deterministic - no folding of any kind.",
    calibrate: { eqCase: false, aLessThanB: false },
  },
  {
    id: "postgres/en_US.utf8",
    label: 'PostgreSQL COLLATE "en_US.utf8"',
    collate: '"en_US.utf8"',
    note: "A glibc locale. If it is functional it sorts alphabetically ('a' before 'B'); equality stays case sensitive.",
    calibrate: { eqCase: false, aLessThanB: true },
  },
  {
    id: "postgres/unicode",
    label: 'PostgreSQL COLLATE "unicode" (ICU)',
    collate: '"unicode"',
    note: "ICU collation, still deterministic - tertiary differences such as case remain significant, but ordering is alphabetical.",
    calibrate: { eqCase: false, aLessThanB: true },
  },
  {
    id: "postgres/primary-nondet",
    label: "PostgreSQL nondeterministic ICU (primary strength)",
    collate: '"collator_nd"',
    note: "deterministic = false at primary strength: case- and accent-insensitive. This is PostgreSQL's answer to MySQL utf8mb4_0900_ai_ci.",
    prepare:
      "CREATE COLLATION IF NOT EXISTS collator_nd (provider = icu, locale = 'und-u-ks-level1', deterministic = false)",
    // Primary strength must ignore case.  This build does not, which is
    // exactly what calibration is for.
    calibrate: { eqCase: true },
  },
];

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (e?.code === "23505") return true;
  return typeof e?.message === "string" && e.message.includes("duplicate key value violates unique constraint");
}

function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0] ?? msg;
}

export interface PgliteOracleOutput {
  engines: EngineDescriptor[];
  results: EngineResult[];
  policies: PolicyResult[];
  runtime: { postgres: string };
  failures: { engineId: string; reason: string }[];
}

export async function runPgliteOracle(vectors: Vector[]): Promise<PgliteOracleOutput> {
  const db = await PGlite.create();
  const engines: EngineDescriptor[] = [];
  const results: EngineResult[] = [];
  const policies: PolicyResult[] = [];
  const failures: { engineId: string; reason: string }[] = [];

  const versionRow = await db.query<{ version: string }>("select version() as version");
  const postgres = (versionRow.rows[0]?.version ?? "PostgreSQL").split(" on ")[0] ?? "PostgreSQL";

  let tableSeq = 0;

  for (const candidate of CANDIDATES) {
    // Probe: does this collation exist in this build, and does it behave the
    // way it claims to?  Both must hold before any result is published.
    let usable = true;
    let reason = "";
    let calibrationNote = "";
    try {
      if (candidate.prepare) await db.query(candidate.prepare);
      const probeTable = `probe_${(tableSeq += 1)}`;
      const collateSql = candidate.collate ? ` COLLATE ${candidate.collate}` : "";
      await db.query(`CREATE TABLE ${probeTable} (email TEXT${collateSql})`);
      await db.query(`DROP TABLE ${probeTable}`);
    } catch (err) {
      usable = false;
      reason = firstLine(err);
    }

    if (usable && candidate.collate) {
      try {
        const eqRow = await db.query<{ eq: boolean }>(
          `select 'a' = 'A'::text collate ${candidate.collate} as eq`,
        );
        const ltRow = await db.query<{ less: boolean }>(
          `select 'a' < 'B'::text collate ${candidate.collate} as less`,
        );
        const gotEq = eqRow.rows[0]?.eq === true;
        const gotLt = ltRow.rows[0]?.less === true;
        calibrationNote = `calibrated: caseSensitive=${!gotEq}, codePointOrder=${!gotLt}`;

        const expected = candidate.calibrate;
        if (expected) {
          if (expected.eqCase !== undefined && expected.eqCase !== gotEq) {
            usable = false;
            reason =
              `calibration failed: this configuration should report 'a' = 'A' as ${expected.eqCase}, ` +
              `but the engine returned ${gotEq}. The collation was accepted but not applied, so no result from it is publishable.`;
          } else if (expected.aLessThanB !== undefined && expected.aLessThanB !== gotLt) {
            usable = false;
            reason =
              `calibration failed: this configuration should order 'a' before 'B' as ${expected.aLessThanB}, ` +
              `but the engine returned ${gotLt}. The locale is not functional in this build, so no result from it is publishable.`;
          }
        }
      } catch (err) {
        usable = false;
        reason = `calibration error: ${firstLine(err)}`;
      }
    }

    if (!usable) {
      engines.push({
        id: candidate.id,
        engine: "PostgreSQL",
        version: postgres,
        label: candidate.label,
        note: candidate.note,
        kind: "pglite",
        collation: candidate.collate,
      });
      failures.push({ engineId: candidate.id, reason });
      results.push(
        ...vectors.map((v) => ({
          engineId: candidate.id,
          vectorId: v.id,
          tier: "UNAVAILABLE" as const,
          outcome: "ERROR" as const,
          detail: `collation unavailable in this build: ${reason}`,
        })),
      );
      continue;
    }

    engines.push({
      id: candidate.id,
      engine: "PostgreSQL",
      version: postgres,
      label: candidate.label,
      note: calibrationNote ? `${candidate.note} [${calibrationNote}]` : candidate.note,
      kind: "pglite",
      collation: candidate.collate,
    });

    for (const vector of vectors) {
      const table = `t_${(tableSeq += 1)}`;
      const collateSql = candidate.collate ? ` COLLATE ${candidate.collate}` : "";
      try {
        await db.query(`CREATE TABLE ${table} (email TEXT${collateSql})`);
        await db.query(`INSERT INTO ${table} (email) VALUES ($1)`, [vector.a]);
        let outcome: EngineResult["outcome"] = "DISTINCT";
        let detail = "both rows accepted - two accounts for one identity";
        try {
          await db.query(`INSERT INTO ${table} (email) VALUES ($1)`, [vector.b]);
        } catch (err) {
          if (isUniqueViolation(err)) {
            outcome = "COLLIDES";
            detail = `unique_violation (23505): ${firstLine(err)}`;
          } else {
            outcome = "ERROR";
            detail = firstLine(err);
          }
        }
        results.push({
          engineId: candidate.id,
          vectorId: vector.id,
          tier: outcome === "ERROR" ? "UNAVAILABLE" : "EXECUTED",
          outcome,
          detail,
        });
      } catch (err) {
        results.push({
          engineId: candidate.id,
          vectorId: vector.id,
          tier: "UNAVAILABLE",
          outcome: "ERROR",
          detail: firstLine(err),
        });
      } finally {
        await db.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
      }
    }
  }

  // PostgreSQL 16+ ships normalize().  Run it for real rather than citing it.
  for (const vector of vectors) {
    try {
      const row = await db.query<{ eq: boolean }>(
        "select normalize($1, NFC) = normalize($2, NFC) as eq",
        [vector.a, vector.b],
      );
      const equal = row.rows[0]?.eq === true;
      policies.push({
        policyId: "postgres.normalize-nfc",
        label: "PostgreSQL normalize(text, NFC)",
        side: "engine",
        vectorId: vector.id,
        equal,
        normalizedA: vector.a,
        normalizedB: vector.b,
        tier: "EXECUTED",
      });
    } catch (err) {
      policies.push({
        policyId: "postgres.normalize-nfc",
        label: "PostgreSQL normalize(text, NFC)",
        side: "engine",
        vectorId: vector.id,
        equal: null,
        normalizedA: "",
        normalizedB: "",
        tier: "UNAVAILABLE",
        detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
      });
    }
  }

  await db.close();
  return { engines, results, policies, runtime: { postgres }, failures };
}
