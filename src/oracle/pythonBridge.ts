import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { Vector, EngineDescriptor, EngineResult, PolicyResult, UnavailableEngine } from "./types.js";

const execFileAsync = promisify(execFile);

/** Raw shape emitted by oracle/run.py before we normalise it. */
interface PythonReport {
  tool: string;
  generatedAt: string;
  runtime: Record<string, string>;
  vectors: (Vector & { codepointsA: Vector["codepointsA"]; codepointsB: Vector["codepointsB"] })[];
  engines: EngineDescriptor[];
  results: (Omit<EngineResult, "detail"> & { detail?: string })[];
  policies: {
    policyId: string;
    label: string;
    vectorId: string;
    equal: boolean | null;
    normalizedA?: string;
    normalizedB?: string;
    tier: string;
    detail?: string;
  }[];
  unavailable: UnavailableEngine[];
}

export interface PythonOracleOutput {
  runtime: Record<string, string>;
  vectors: Vector[];
  engines: EngineDescriptor[];
  results: EngineResult[];
  policies: PolicyResult[];
  unavailable: UnavailableEngine[];
}

const ORACLE_SCRIPT = path.resolve(process.cwd(), "oracle", "run.py");

/**
 * Run the Python oracle as a subprocess and parse its JSON report.
 *
 * The Python process owns SQLite (via the stdlib, which exposes
 * create_collation) and the Unicode policy checks (str.casefold has no
 * JavaScript equivalent, which is precisely one of the things being tested).
 */
/**
 * Run the interpreter candidates for this platform. Windows ships `python`
 * (the PEP 486 launcher); most Linux hosts — including hosting platforms —
 * ship only `python3`. Try the platform's usual name first and fall back on
 * ENOENT; any other failure (the script itself failing) propagates at once.
 */
async function execOracle(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const candidates =
    process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  let lastMissing: Error | undefined;
  for (const bin of candidates) {
    try {
      return await execFileAsync(bin, args, {
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw err;
      lastMissing = err as Error;
    }
  }
  throw new Error(
    `no Python interpreter found (tried ${candidates.join(", ")}): ` +
      `${lastMissing?.message ?? "install Python 3"}`,
  );
}

export async function runPythonOracle(
  vectorId?: string,
  pair?: [string, string],
): Promise<PythonOracleOutput> {
  const args = [ORACLE_SCRIPT];
  if (vectorId) args.push("--vector", vectorId);
  if (pair) args.push("--pair", pair[0], pair[1]);

  const { stdout, stderr } = await execOracle(args);

  if (stderr.trim()) {
    // The oracle writes diagnostics to stderr but still emits valid JSON.
    process.stderr.write(`[oracle:py] ${stderr.trim()}\n`);
  }

  const raw = JSON.parse(stdout) as PythonReport;

  return {
    runtime: raw.runtime,
    vectors: raw.vectors,
    engines: raw.engines,
    results: raw.results.map((r) => ({
      engineId: r.engineId,
      vectorId: r.vectorId,
      tier: r.tier,
      outcome: r.outcome,
      detail: r.detail ?? "",
    })),
    policies: raw.policies.map((p) => ({
      policyId: p.policyId,
      label: p.label,
      side: "python" as const,
      vectorId: p.vectorId,
      equal: p.equal,
      normalizedA: p.normalizedA ?? "",
      normalizedB: p.normalizedB ?? "",
      tier: p.tier as PolicyResult["tier"],
      ...(p.detail ? { detail: p.detail } : {}),
    })),
    unavailable: raw.unavailable,
  };
}
