import { runJsPolicies } from "./jsPolicies.js";
import { runPgliteOracle } from "./pgliteEngine.js";
import { runPythonOracle } from "./pythonBridge.js";
import type { EngineDescriptor, EngineResult, PolicyResult, Vector } from "./types.js";

export interface PairCheck {
  a: string;
  b: string;
  vector: Vector;
  engines: EngineDescriptor[];
  results: EngineResult[];
  policies: PolicyResult[];
}

/**
 * Check one arbitrary pair of strings against every engine we can execute.
 *
 * This is what makes Collator a tool rather than a demo: paste any two
 * values and get the answer from the engines, not from prose.
 */
export async function checkPair(a: string, b: string): Promise<PairCheck> {
  const py = await runPythonOracle(undefined, [a, b]);
  const vector = py.vectors[0] as Vector;

  const pg = await runPgliteOracle([vector]);
  const js = runJsPolicies([vector]);

  return {
    a,
    b,
    vector,
    engines: [...py.engines, ...pg.engines],
    results: [...py.results, ...pg.results],
    policies: [...py.policies, ...pg.policies, ...js],
  };
}
