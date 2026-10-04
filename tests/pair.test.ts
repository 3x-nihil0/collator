import { describe, expect, it } from "vitest";
import { checkPair } from "../src/oracle/pair.js";

/**
 * Pair checks against ground truth: outcomes we can predict from the
 * specification of each collation and that the oracle must reproduce by
 * actually running the constraint.
 */
describe("checkPair", () => {
  it("splits ASCII case: NOCASE collides, BINARY does not", async () => {
    const check = await checkPair("Alice@Example.com", "alice@example.com");
    const outcome = (id: string) => check.results.find((r) => r.engineId === id);

    expect(outcome("sqlite/binary")?.outcome).toBe("DISTINCT");
    expect(outcome("sqlite/binary")?.tier).toBe("EXECUTED");
    expect(outcome("sqlite/nocase")?.outcome).toBe("COLLIDES");
    expect(outcome("sqlite/nocase")?.tier).toBe("EXECUTED");
  }, 60_000);

  it("separates str.lower() from str.casefold() on sharp s", async () => {
    const check = await checkPair("strasse@x.com", "stra\u00dfe@x.com");
    const policy = (id: string) => check.policies.find((p) => p.policyId === id);

    expect(policy("python.lower")?.equal).toBe(false);
    expect(policy("python.casefold")?.equal).toBe(true);
    // JavaScript has no casefold: toLowerCase also misses ß -> ss.
    expect(policy("js.toLowerCase")?.equal).toBe(false);
  }, 60_000);

  it("sees NFC and NFD as identical bytes apart, and identical after NFC", async () => {
    const check = await checkPair("caf\u00e9@x.com", "cafe\u0301@x.com");
    const outcome = (id: string) => check.results.find((r) => r.engineId === id);
    const policy = (id: string) => check.policies.find((p) => p.policyId === id);

    expect(outcome("sqlite/binary")?.outcome).toBe("DISTINCT");
    expect(policy("js.normalizeNFC")?.equal).toBe(true);
    expect(policy("python.nfc")?.equal).toBe(true);
  }, 60_000);

  it("no engine folds confusables - the homoglyph duplicate survives every UNIQUE constraint", async () => {
    const check = await checkPair("admin@x.com", "adm\u0430in@x.com");
    const executed = check.results.filter((r) => r.tier === "EXECUTED");
    expect(executed.length).toBeGreaterThan(5);
    for (const r of executed) expect(r.outcome, r.engineId).toBe("DISTINCT");
    // ...and no application policy rescues it either.
    for (const p of check.policies) {
      if (p.equal !== null) expect(p.equal, p.policyId).toBe(false);
    }
  }, 60_000);

  it("exposes codepoint introspection so the UI can show why they differ", async () => {
    const check = await checkPair("JOS\u00c9@EXAMPLE.COM", "jos\u00e9@example.com");
    expect(check.vector.codepointsA).toHaveLength("JOS\u00c9@EXAMPLE.COM".length);
    expect(check.vector.codepointsB).toHaveLength("jos\u00e9@example.com".length);
    const accented = check.vector.codepointsA.find((c) => c.hex === "U+00C9");
    expect(accented?.name).toContain("LATIN CAPITAL LETTER E WITH ACUTE");
    // Unicode case: NOCASE only folds ASCII, so this pair slips through.
    const nocase = check.results.find((r) => r.engineId === "sqlite/nocase");
    expect(nocase?.outcome).toBe("DISTINCT");
  }, 60_000);

  it("every result carries an admissible tier", async () => {
    const check = await checkPair("bob@x.com", "bob@x.com ");
    for (const r of check.results) {
      expect(["EXECUTED", "DOCUMENTED", "UNAVAILABLE"]).toContain(r.tier);
      if (r.tier === "EXECUTED") expect(r.outcome).not.toBe("ERROR");
    }
    // Trailing space: RTRIM collides, BINARY does not.
    const byId = (id: string) => check.results.find((r) => r.engineId === id);
    expect(byId("sqlite/rtrim")?.outcome).toBe("COLLIDES");
    expect(byId("sqlite/binary")?.outcome).toBe("DISTINCT");
  }, 60_000);
});
