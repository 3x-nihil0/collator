/**
 * Collator's local server: a JSON API plus one static page.
 *
 * No framework - the surface is four routes, and keeping them in one file
 * makes the trust boundary obvious: the UI only ever sees verdicts computed
 * here from executed rows (src/server/verdict.ts) or evidence produced by
 * the oracle. Nothing in the browser is asked to trust model prose.
 *
 *   GET  /            the page
 *   GET  /api/evidence  full evidence report (cached)
 *   POST /api/check {a,b}  execute one pair, return verdict + matrix
 *   POST /api/ask {question}  agent narrative (needs LLM_*; honest 503 otherwise)
 *   GET  /api/health  what is configured
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvidence } from "../oracle/buildEvidence.js";
import { checkPair } from "../oracle/pair.js";
import type { EvidenceReport } from "../oracle/types.js";
import { configFromEnv, LlmError } from "../agent/llm.js";
import { connectSanityMcp, sanityMcpConfigFromEnv, type McpSession } from "../agent/mcp.js";
import { runAgent } from "../agent/run.js";
import { verdictFromResults } from "./verdict.js";

const PAGE_PATH = path.resolve(process.cwd(), "web", "index.html");
const BODY_LIMIT = 64 * 1024;

let evidenceCache: Promise<EvidenceReport> | undefined;
function evidence(): Promise<EvidenceReport> {
  evidenceCache ??= buildEvidence();
  return evidenceCache;
}

let sessionCache: Promise<McpSession> | undefined;
function contextSession(): Promise<McpSession> {
  sessionCache ??= connectSanityMcp(sanityMcpConfigFromEnv());
  return sessionCache;
}

function llmConfigured(): boolean {
  return Boolean(process.env.LLM_BASE_URL && process.env.LLM_MODEL);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error("invalid JSON body");
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = await readFile(PAGE_PATH, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      llm: llmConfigured(),
      model: process.env.LLM_MODEL ?? null,
      context: Boolean(sanityMcpConfigFromEnv()),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/evidence") {
    const report = await evidence();
    json(res, 200, report);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/check") {
    const body = await readBody(req);
    const a = typeof body.a === "string" ? body.a : "";
    const b = typeof body.b === "string" ? body.b : "";
    if (!a && !b) {
      json(res, 400, { error: "provide both a and b" });
      return;
    }
    const check = await checkPair(a, b);
    const report = await evidence();
    const verdict = verdictFromResults(check.results, check.engines, report.unavailable);
    json(res, 200, { ...check, verdict });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ask") {
    if (!llmConfigured()) {
      json(res, 503, {
        ok: false,
        reason:
          "No LLM configured. Set LLM_BASE_URL and LLM_MODEL (any OpenAI-compatible endpoint) " +
          "in .env to enable narrative answers. The pair checker above needs no model - it executes.",
      });
      return;
    }
    const body = await readBody(req);
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) {
      json(res, 400, { error: "provide a question" });
      return;
    }
    try {
      const llm = configFromEnv();
      const session = await contextSession();
      const answer = await runAgent({ question, llm, session });
      json(res, 200, { ok: true, text: answer.text, steps: answer.steps, toolCalls: answer.toolCalls });
    } catch (err) {
      if (err instanceof LlmError) {
        json(res, 502, { ok: false, reason: err.message, detail: err.body.slice(0, 1000) });
        return;
      }
      json(res, 500, { ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  json(res, 404, { error: "not found" });
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export async function startServer(port: number): Promise<RunningServer> {
  // Bind all interfaces by default: hosting platforms (Render, Fly, etc.)
  // route traffic to 0.0.0.0 and cannot reach a loopback-only listener.
  // HOST=127.0.0.1 restores the old local-only behaviour.
  const host = process.env.HOST ?? "0.0.0.0";
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) json(res, 500, { error: message });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  // Warm the evidence report immediately: without this the FIRST /api/check
  // pays for buildEvidence() and checkPair() serially (~25s), while later
  // requests wait only for their own probe.
  // void evidence().catch((err) => {
    // process.stderr.write(`[evidence] warm-up failed: ${err instanceof Error ? err.message : String(err)}\n`);
  // });

  process.stdout.write(`collator listening on http://${host}:${actualPort}\n`);
  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const port = Number(process.env.PORT ?? 4173);
  startServer(port).catch((err) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EADDRINUSE") {
      process.stderr.write(`port ${port} is already in use - set PORT in .env\n`);
    } else {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
    process.exit(1);
  });
}
