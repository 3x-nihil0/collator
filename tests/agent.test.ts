import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, runAgent } from "../src/agent/run.js";
import type { LlmConfig } from "../src/agent/llm.js";
import type { McpSession } from "../src/agent/mcp.js";

/**
 * The harness, proven against a scripted OpenAI-compatible server.
 *
 * This tests the loop itself: tool dispatch, message assembly, tier
 * instructions in the prompt, and the fact that the model's final text is
 * returned verbatim after the tools have run - with no API key required.
 */

interface Captured {
  body: Record<string, unknown>;
}

async function startFakeLlm(): Promise<{
  config: LlmConfig;
  captured: Captured[];
  close: () => Promise<void>;
}> {
  const captured: Captured[] = [];
  let calls = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      captured.push({ body });
      calls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      if (calls === 1) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "check_pair",
                        arguments: JSON.stringify({ a: "Alice@Example.com", b: "alice@example.com" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "COLLIDES: sqlite/nocase rejected the second insert (EXECUTED).",
                },
              },
            ],
          }),
        );
      }
    });
  });

  // The harness pauses for seconds between turns while the oracle runs; the
  // default 5s idle timeout would reset the pooled connection underneath it.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  return {
    config: { baseUrl: `http://127.0.0.1:${port}`, apiKey: "", model: "fake-model", maxSteps: 4, temperature: 0 },
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("runAgent", () => {
  it("runs the oracle tool before answering and reports tiers in the prompt", async () => {
    const fake = await startFakeLlm();
    try {
      const events: { kind: string; name?: string }[] = [];
      const answer = await runAgent({
        question: "Would these two collide?",
        llm: fake.config,
        onEvent: (e) => events.push({ kind: e.kind, name: e.name }),
      });

      expect(answer.steps).toBe(2);
      expect(answer.toolCalls).toHaveLength(1);
      expect(answer.toolCalls[0]?.name).toBe("check_pair");
      expect(answer.text).toContain("COLLIDES");

      // The system prompt must carry the tier contract.
      const first = fake.captured[0]?.body as { messages: { role: string; content: string }[] };
      const system = first.messages.find((m) => m.role === "system");
      expect(system?.content).toContain("EVIDENCE TIERS");
      expect(system?.content).toContain("EXECUTED");
      expect(system?.content).toContain("DOCUMENTED");
      expect(system?.content).toContain("UNAVAILABLE");
      expect(system?.content).toContain("never");

      // The second request must carry the tool's executed evidence back.
      const second = fake.captured[1]?.body as {
        messages: { role: string; content: string; tool_call_id?: string }[];
      };
      const toolMsg = second.messages.find((m) => m.role === "tool");
      expect(toolMsg?.content).toContain("tier=EXECUTED");
      expect(toolMsg?.content).toContain("sqlite/nocase");

      expect(events.some((e) => e.kind === "tool" && e.name === "check_pair")).toBe(true);
      expect(events.some((e) => e.kind === "text")).toBe(true);
    } finally {
      await fake.close();
    }
  }, 60_000);
});

describe("buildSystemPrompt", () => {
  it("makes UNAVAILABLE a refusal, not a hedge", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Refuse explicitly");
    expect(prompt).toContain("never invent an execution");
    expect(prompt).toContain("REFUSED");
  });

  it("includes Sanity Context outline and tool names when a session exists", () => {
    const session = {
      tools: [
        {
          qualifiedName: "kb__knowledge_base_read",
          serverId: "kb",
          mcpName: "knowledge_base_read",
          definition: { name: "kb__knowledge_base_read", description: "", parameters: {} },
        },
      ],
      initialContext: { kb: "kb12345\n  - prior-art/stack-overflow-nocase" },
      warnings: [],
      call: async () => "",
      close: async () => undefined,
    } as unknown as McpSession;

    const prompt = buildSystemPrompt({ session });
    expect(prompt).toContain("SANITY CONTEXT");
    expect(prompt).toContain("kb__knowledge_base_read");
    expect(prompt).toContain("prior-art/stack-overflow-nocase");
  });
});
