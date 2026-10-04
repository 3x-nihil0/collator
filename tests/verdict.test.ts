import { describe, expect, it } from "vitest";
import { verdictFromResults } from "../src/server/verdict.js";
import type { EngineDescriptor, EngineResult, UnavailableEngine } from "../src/oracle/types.js";

const ENGINES: EngineDescriptor[] = [
  { id: "e1", engine: "Test", label: "Engine one", kind: "test" },
  { id: "e2", engine: "Test", label: "Engine two", kind: "test" },
];

function row(engineId: string, outcome: EngineResult["outcome"], tier: EngineResult["tier"] = "EXECUTED"): EngineResult {
  return { engineId, vectorId: "v", tier, outcome, detail: "detail" };
}

describe("verdictFromResults", () => {
  it("is COLLIDES when every executed configuration rejected the insert", () => {
    const v = verdictFromResults([row("e1", "COLLIDES"), row("e2", "COLLIDES")], ENGINES);
    expect(v.kind).toBe("COLLIDES");
    expect(v.executed).toBe(2);
    expect(v.headline).toContain("COLLIDES");
  });

  it("is DISTINCT when every executed configuration accepted both rows", () => {
    const v = verdictFromResults([row("e1", "DISTINCT"), row("e2", "DISTINCT")], ENGINES);
    expect(v.kind).toBe("DISTINCT");
    expect(v.distinct).toBe(2);
  });

  it("is SPLIT when configurations disagree - no single answer exists", () => {
    const v = verdictFromResults([row("e1", "COLLIDES"), row("e2", "DISTINCT")], ENGINES);
    expect(v.kind).toBe("SPLIT");
    expect(v.colliding).toBe(1);
    expect(v.distinct).toBe(1);
    expect(v.headline).toContain("depends on");
  });

  it("ignores ERROR rows when deciding - errors are not evidence either way", () => {
    const v = verdictFromResults(
      [row("e1", "COLLIDES"), row("e2", "ERROR", "UNAVAILABLE")],
      ENGINES,
    );
    expect(v.kind).toBe("COLLIDES");
    expect(v.executed).toBe(1);
  });

  it("REFUSES when nothing executed, and says why", () => {
    const unavailable: UnavailableEngine[] = [
      { engine: "DuckDB", tier: "UNAVAILABLE", reason: "driver blocked by host policy", remediation: "cannot be remediated" },
    ];
    const v = verdictFromResults(
      [row("e1", "ERROR", "UNAVAILABLE"), row("e2", "ERROR", "UNAVAILABLE")],
      ENGINES,
      unavailable,
    );
    expect(v.kind).toBe("REFUSED");
    expect(v.headline).toContain("REFUSED");
    expect(v.refusals.join(" ")).toContain("blocked by host policy");
  });

  it("REFUSES on an empty result set rather than defaulting to an answer", () => {
    const v = verdictFromResults([], ENGINES);
    expect(v.kind).toBe("REFUSED");
    expect(v.executed).toBe(0);
    expect(v.refusals.length).toBeGreaterThan(0);
  });
});
