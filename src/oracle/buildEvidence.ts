import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAIMS } from "./claims.js";
import { detectDivergences, summarise } from "./divergence.js";
import { runJsPolicies } from "./jsPolicies.js";
import { runPgliteOracle } from "./pgliteEngine.js";
import { runPythonOracle } from "./pythonBridge.js";
import type { EvidenceReport, PolicyResult } from "./types.js";

export const EVIDENCE_PATH = path.resolve(process.cwd(), "evidence", "report.json");

/**
 * Assemble the full evidence report.
 *
 * Three independent producers are merged:
 *   - Python: SQLite (stdlib create_collation) and Python Unicode policies
 *   - PGlite: genuine PostgreSQL 18 in WebAssembly
 *   - JavaScript: application-side policies as a Node process would run them
 *
 * Then sourced claims are checked against what was actually observed.
 */
export async function buildEvidence(): Promise<EvidenceReport> {
  const py = await runPythonOracle();

  // PostgreSQL is executed through PGlite below; the Python pass only
  // discovered that a local server was listening without credentials, which
  // would otherwise appear twice and read as a contradiction.
  const unavailable = py.unavailable.filter((u) => u.engine !== "PostgreSQL");

  const pg = await runPgliteOracle(py.vectors);

  const jsPolicies: PolicyResult[] = runJsPolicies(py.vectors);
  const policies: PolicyResult[] = [...py.policies, ...pg.policies, ...jsPolicies];

  const engines = [...py.engines, ...pg.engines];
  const results = [...py.results, ...pg.results];

  const { divergences, conflicts } = detectDivergences(CLAIMS, results, policies);

  return {
    tool: "collator-evidence",
    generatedAt: new Date().toISOString(),
    runtime: {
      python: py.runtime.python,
      sqlite: py.runtime.sqlite,
      implementation: py.runtime.implementation,
      platform: py.runtime.platform,
      postgres: pg.runtime.postgres,
    },
    vectors: py.vectors,
    engines,
    results,
    policies,
    unavailable,
    claims: CLAIMS,
    engineFailures: pg.failures,
    divergences,
    conflicts,
    summary: summarise(divergences, results, engines, unavailable),
  };
}

async function main(): Promise<void> {
  const report = await buildEvidence();
  await mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(EVIDENCE_PATH, JSON.stringify(report, null, 2), "utf8");

  const { summary, runtime } = report;
  process.stdout.write(
    [
      `collator evidence -> ${path.relative(process.cwd(), EVIDENCE_PATH)}`,
      `  runtime      : python ${runtime.python}, sqlite ${runtime.sqlite}, ${runtime.postgres}`,
      `  engines      : ${summary.enginesExecuted} executed, ${summary.enginesNamedOnly} named but not executable here`,
      `  checks       : ${summary.executedChecks} executed`,
      `  claims       : ${summary.claimsChecked} checked, ${summary.claimsDisagreeing} DISAGREE, ${summary.claimsUnverified} UNVERIFIED`,
      `  conflicts    : ${report.conflicts.length} source-vs-source`,
      "",
    ].join("\n"),
  );
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
