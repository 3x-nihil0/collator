import { describe, expect, it } from "vitest";
import { configFromEnv } from "../src/agent/llm.js";
import { connectSanityMcp, sanityMcpConfigFromEnv } from "../src/agent/mcp.js";

/**
 * The contracts the agent depends on when nothing is configured.
 *
 * Collator must keep answering from execution evidence with zero env vars,
 * and must fail with an actionable message rather than a stack trace when
 * the model endpoint is missing. Both behaviours are load-bearing for the
 * demo (no keys on a judge's laptop) and were previously untested.
 */

const completeEnv: NodeJS.ProcessEnv = {
  SANITY_MCP_ORG_ID: "org123",
  SANITY_ORGANIZATION_TOKEN: "sk_org_token",
  SANITY_MCP_KB_ENDPOINT: "collator-kb",
  SANITY_MCP_GROQ_ENDPOINT: "collator-data",
};

describe("sanityMcpConfigFromEnv", () => {
  it("returns null when the environment is empty", () => {
    expect(sanityMcpConfigFromEnv({})).toBeNull();
  });

  it("returns null when a token exists but no endpoint is configured", () => {
    expect(
      sanityMcpConfigFromEnv({
        SANITY_MCP_ORG_ID: "org123",
        SANITY_ORGANIZATION_TOKEN: "sk_org_token",
      }),
    ).toBeNull();
  });

  it("returns null when endpoints are named but the org token is missing", () => {
    expect(
      sanityMcpConfigFromEnv({
        SANITY_MCP_ORG_ID: "org123",
        SANITY_MCP_KB_ENDPOINT: "collator-kb",
      }),
    ).toBeNull();
  });

  it("enables both endpoints when everything is set", () => {
    const cfg = sanityMcpConfigFromEnv(completeEnv);
    expect(cfg?.enabled).toEqual(["kb", "studio"]);
    expect(cfg?.env.kbEndpoint).toBe("collator-kb");
    expect(cfg?.env.groqEndpoint).toBe("collator-data");
  });

  it("enables only the endpoint that is actually named", () => {
    const cfg = sanityMcpConfigFromEnv({
      SANITY_MCP_ORG_ID: "org123",
      SANITY_ORGANIZATION_TOKEN: "tok",
      SANITY_MCP_GROQ_ENDPOINT: "collator-data",
    });
    expect(cfg?.enabled).toEqual(["studio"]);
  });
});

describe("connectSanityMcp with no configuration", () => {
  it("never throws: empty tool list, an explanatory warning, and a refusing call()", async () => {
    const session = await connectSanityMcp(null);
    expect(session.tools).toEqual([]);
    expect(session.initialContext).toEqual({});
    expect(session.warnings.join(" ")).toContain("not configured");

    // The harness may still dispatch a context tool; the answer must be an
    // honest failure string the model can read, not an exception.
    const result = await session.call("kb__knowledge_base_read", { knowledgeBase: "kb1", paths: ["a"] });
    expect(result).toContain("not connected");

    await expect(session.close()).resolves.toBeUndefined();
  });
});

describe("configFromEnv", () => {
  it("fails with an actionable message instead of a stack trace", () => {
    expect(() => configFromEnv({})).toThrow(/LLM_BASE_URL and LLM_MODEL must be set/);
  });

  it("normalises trailing slashes and applies defaults", () => {
    const cfg = configFromEnv({
      LLM_BASE_URL: "https://api.example.com/v1/",
      LLM_API_KEY: "secret",
      LLM_MODEL: "some-model",
    });
    expect(cfg.baseUrl).toBe("https://api.example.com/v1");
    expect(cfg.apiKey).toBe("secret");
    expect(cfg.maxSteps).toBe(8);
    expect(cfg.temperature).toBe(0);
  });

  it("honours LLM_MAX_STEPS", () => {
    const cfg = configFromEnv({
      LLM_BASE_URL: "http://localhost:1144/v1",
      LLM_MODEL: "qwen",
      LLM_MAX_STEPS: "3",
    });
    expect(cfg.maxSteps).toBe(3);
    expect(cfg.apiKey).toBe("");
  });
});
