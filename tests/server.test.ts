import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/index.js";

/**
 * The API surface, over real HTTP: health, executed pair verdicts, and the
 * refusal path when no model is configured. The last one matters as much as
 * the first two - the server must not pretend to answer it cannot give.
 */
let server: RunningServer;
let base: string;

beforeAll(async () => {
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.SANITY_ORGANIZATION_TOKEN;
  delete process.env.SANITY_MCP_ORG_ID;
  delete process.env.SANITY_MCP_KB_ENDPOINT;
  delete process.env.SANITY_MCP_GROQ_ENDPOINT;
  server = await startServer(0);
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(async () => {
  await server.close();
});

describe("GET /", () => {
  it("serves the page", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Collator");
    expect(html).toContain("UNIQUE");
  });
});

describe("GET /api/health", () => {
  it("reports that no LLM is configured", async () => {
    const res = await fetch(`${base}/api/health`);
    const body = (await res.json()) as { ok: boolean; llm: boolean; context: boolean };
    expect(body.ok).toBe(true);
    expect(body.llm).toBe(false);
    expect(body.context).toBe(false);
  });
});

describe("POST /api/check", () => {
  it("executes a pair and returns an engine-level verdict", async () => {
    const res = await fetch(`${base}/api/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: "Alice@Example.com", b: "alice@example.com" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      verdict: { kind: string; headline: string; executed: number; colliding: number };
      results: { engineId: string; outcome: string; tier: string }[];
      policies: unknown[];
    };

    expect(["COLLIDES", "DISTINCT", "SPLIT"]).toContain(body.verdict.kind);
    expect(body.verdict.executed).toBeGreaterThan(5);
    expect(body.results.length).toBeGreaterThan(10);
    expect(body.policies.length).toBeGreaterThan(5);

    // ASCII case under NOCASE is the canonical split; the verdict must
    // reflect that engines disagree rather than flatten it.
    const nocase = body.results.find((r) => r.engineId === "sqlite/nocase");
    const binary = body.results.find((r) => r.engineId === "sqlite/binary");
    expect(nocase?.outcome).toBe("COLLIDES");
    expect(binary?.outcome).toBe("DISTINCT");
    expect(body.verdict.kind).toBe("SPLIT");
  }, 90_000);

  it("rejects an empty request", async () => {
    const res = await fetch(`${base}/api/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/ask", () => {
  it("refuses honestly when no model is configured instead of fabricating an answer", async () => {
    const res = await fetch(`${base}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Is my column unique?" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("LLM_BASE_URL");
    expect(body.reason).toContain("executes");
  });
});

describe("GET /api/evidence", () => {
  it("returns the tiered evidence report", async () => {
    const res = await fetch(`${base}/api/evidence`);
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      summary: { executedChecks: number };
      claims: { sourceUrl: string }[];
      divergences: { status: string }[];
    };
    expect(report.summary.executedChecks).toBeGreaterThan(50);
    expect(report.claims.length).toBeGreaterThan(10);
    expect(report.divergences.some((d) => d.status === "DISAGREE")).toBe(true);
  }, 60_000);
});
