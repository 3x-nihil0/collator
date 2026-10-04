import { beforeAll, describe, expect, it } from "vitest";
import { buildEvidence } from "../src/oracle/buildEvidence.js";
import type { EvidenceReport } from "../src/oracle/types.js";

/**
 * The load-bearing assertions of the whole project: the oracle must catch
 * documented claims that execution contradicts, surface source-vs-source
 * conflicts, refuse the engines it cannot run, and reject configurations
 * that fail calibration. If any of these regress, Collator is making things
 * up again.
 */
let report: EvidenceReport;

beforeAll(async () => {
  report = await buildEvidence();
}, 120_000);

describe("evidence report", () => {
  it("actually executed a full matrix", () => {
    expect(report.summary.enginesExecuted).toBeGreaterThanOrEqual(9);
    expect(report.summary.executedChecks).toBeGreaterThanOrEqual(100);
    expect(report.vectors).toHaveLength(12);
    // Every EXECUTED row must carry a non-error outcome.
    for (const r of report.results) {
      if (r.tier === "EXECUTED") expect(r.outcome).not.toBe("ERROR");
    }
  });

  it("catches the Stack Overflow NOCASE folklore: predicts COLLIDES, SQLite returns DISTINCT", () => {
    const d = report.divergences.find((x) => x.claimId === "folklore-nocase-unique");
    expect(d, "folklore-nocase-unique must be checked").toBeDefined();
    expect(d?.status).toBe("DISAGREE");
    expect(d?.predicted).toBe("COLLIDES");
    expect(d?.observed).toBe("DISTINCT");
    expect(d?.checkedAgainst).toBe("sqlite/nocase");
  });

  it("catches both lowercase-the-email folklore claims on sharp s", () => {
    for (const id of ["folklore-lowercase-email", "folklore-lowercase-email-js"]) {
      const d = report.divergences.find((x) => x.claimId === id);
      expect(d, id).toBeDefined();
      expect(d?.status, id).toBe("DISAGREE");
      expect(d?.vectorId).toBe("sharp-s");
      expect(d?.observed).toBe("DISTINCT");
    }
  });

  it("keeps vendor documentation it cannot execute at UNVERIFIED, never promoted", () => {
    const mysql = report.divergences.filter((x) => x.claimId.startsWith("vendor-mysql"));
    expect(mysql.length).toBeGreaterThan(0);
    for (const d of mysql) {
      expect(d.status, d.claimId).toBe("UNVERIFIED");
      expect(d.observed).toBeNull();
    }
  });

  it("records the source-vs-source conflict on sqlite/nocase and resolves it by execution", () => {
    const conflict = report.conflicts.find((c) => c.vectorId === "unicode-case" && c.family.includes("sqlite/nocase"));
    expect(conflict, "SO vs sqlite.org conflict must be recorded").toBeDefined();
    expect(conflict?.resolution).toBe("DISTINCT");
    expect(conflict?.resolvedBy).toBeTruthy();
    const kinds = (conflict?.claims ?? []).map((c) => c.kind).sort();
    expect(kinds).toContain("folklore");
    expect(kinds).toContain("vendor-doc");
  });

  it("rejects PostgreSQL collations that fail calibration, with reasons", () => {
    const ids = report.engineFailures.map((f) => f.engineId);
    expect(ids).toContain("postgres/en_US.utf8");
    expect(ids).toContain("postgres/primary-nondet");
    for (const f of report.engineFailures) {
      expect(f.reason.length).toBeGreaterThan(20);
    }
    // A rejected configuration must not have published an EXECUTED row.
    for (const f of report.engineFailures) {
      const rows = report.results.filter((r) => r.engineId === f.engineId);
      expect(rows.every((r) => r.tier !== "EXECUTED"), f.engineId).toBe(true);
    }
  });

  it("accounts for DuckDB either way - executed here, or refused with remediation", () => {
    const rows = report.results.filter((r) => r.engineId.startsWith("duckdb/"));
    const duck = report.unavailable.find((u) => u.engine === "DuckDB");
    if (rows.length > 0) {
      // The driver loads on this host: then it must have really executed.
      expect(duck, "an executable engine must not also be listed as unavailable").toBeUndefined();
      expect(rows.every((r) => r.tier === "EXECUTED")).toBe(true);
      expect(new Set(rows.map((r) => r.engineId)).size).toBeGreaterThanOrEqual(2);
    } else {
      // Host policy blocks the native library: then the refusal must be honest.
      expect(duck?.tier).toBe("UNAVAILABLE");
      expect(duck?.remediation).toBeTruthy();
    }
  });

  it("refuses engines that cannot run here, with remediation text", () => {
    const mysql = report.unavailable.find((u) => u.engine === "MySQL");
    expect(mysql, "MySQL has no credentials on this host and must be reported").toBeDefined();
    expect(mysql?.reason).toBeTruthy();
    expect(mysql?.remediation).toBeTruthy();
    // A listening server without credentials is DOCUMENTED (we know it exists),
    // an absent one is UNAVAILABLE - either way it is never a verdict.
    expect(["DOCUMENTED", "UNAVAILABLE"]).toContain(mysql?.tier);
  });

  it("carries every sourced claim with a URL for the citations panel", () => {
    expect(report.claims.length).toBeGreaterThanOrEqual(14);
    const ids = new Set(report.claims.map((c) => c.id));
    expect(ids.size, "claim ids must be unique").toBe(report.claims.length);
    for (const c of report.claims) {
      expect(c.sourceUrl, c.id).toMatch(/^https:\/\//);
      expect(["vendor-doc", "spec", "folklore"], c.id).toContain(c.kind);
      expect(["COLLIDES", "DISTINCT"], c.id).toContain(c.predicts);
    }
  });

  it("never claims an execution it did not perform", () => {
    const engineIds = new Set(report.engines.map((e) => e.id));
    for (const r of report.results) {
      expect(engineIds.has(r.engineId), `unknown engine ${r.engineId}`).toBe(true);
      expect(["EXECUTED", "DOCUMENTED", "UNAVAILABLE"]).toContain(r.tier);
    }
  });
});
