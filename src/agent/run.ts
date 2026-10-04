/**
 * The agent harness: a short, readable tool-calling loop.
 *
 * Three properties matter here and are enforced in code, not hoped for in
 * prompting alone:
 *
 *   1. Every engine answer comes from run_oracle / check_pair - tools that
 *      execute real engines. The model never gets to "recall" an outcome.
 *   2. Every claim is tiered EXECUTED / DOCUMENTED / UNAVAILABLE. The system
 *      prompt makes UNAVAILABLE a refusal, and the tools report the tier on
 *      every row they return.
 *   3. Sanity Context is a first-class source: KB entries and dataset queries
 *      arrive as tools alongside the oracle, so citations can be read back
 *      from the Knowledge Base rather than trusted from model memory.
 */

import "dotenv/config"
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvidence, EVIDENCE_PATH } from "../oracle/buildEvidence.js";
import { checkPair, type PairCheck } from "../oracle/pair.js";
import type { EvidenceReport } from "../oracle/types.js";
import { chat, configFromEnv, LlmError, type ChatMessage, type LlmConfig, type ToolDefinition } from "./llm.js";
import { connectSanityMcp, sanityMcpConfigFromEnv, type McpSession } from "./mcp.js";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface AgentTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}... (+${s.length - max} chars)`;
}

function show(s: string): string {
  return JSON.stringify(truncate(s, 60));
}

/** Compact engine x vector matrix: one row per engine, one token per vector. */
function matrixRows(report: EvidenceReport): string[] {
  const vectorIds = report.vectors.map((v) => v.id);
  const engineIds = [...new Set(report.results.map((r) => r.engineId))];
  const lines: string[] = [];
  for (const engineId of engineIds) {
    const cells = vectorIds.map((vid) => {
      const row = report.results.find((r) => r.engineId === engineId && r.vectorId === vid);
      if (!row) return "-";
      return row.outcome === "COLLIDES" ? "COLLIDE" : row.outcome === "DISTINCT" ? "distinct" : "ERROR";
    });
    lines.push(`${engineId.padEnd(34)} ${cells.join(" ")}`);
  }
  return lines;
}

/**
 * check_pair: execute one arbitrary pair of strings against every engine
 * that can run on this host. This is the product's core verb.
 */
export const checkPairTool: AgentTool = {
  definition: {
    name: "check_pair",
    description:
      "Execute two arbitrary strings against every runnable engine and collation " +
      "(SQLite BINARY/NOCASE/RTRIM/custom folds, PostgreSQL 18 collations, Python and " +
      "JavaScript Unicode policies) and report COLLIDES or DISTINCT per configuration, " +
      "each row tagged with its evidence tier. Use this before making any claim about " +
      "whether a UNIQUE constraint would treat two values as equal.",
    parameters: {
      type: "object",
      properties: {
        a: { type: "string", description: "First value, verbatim" },
        b: { type: "string", description: "Second value, verbatim" },
      },
      required: ["a", "b"],
    },
  },
  async execute(args) {
    const a = String(args.a ?? "");
    const b = String(args.b ?? "");
    try {
      const check = await checkPair(a, b);
      return formatPairCheck(check);
    } catch (err) {
      return `check_pair failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export function formatPairCheck(check: PairCheck): string {
  const out: string[] = [];
  out.push(`PAIR  A = ${show(check.a)}`);
  out.push(`      B = ${show(check.b)}`);

  const cp = (arr: { hex: string }[]): string => arr.map((c) => c.hex).join(" ");
  if (cp(check.vector.codepointsA) !== cp(check.vector.codepointsB)) {
    out.push(`  codepoints A: ${cp(check.vector.codepointsA)}`);
    out.push(`  codepoints B: ${cp(check.vector.codepointsB)}`);
  } else {
    out.push(`  codepoints identical: ${cp(check.vector.codepointsA)}`);
  }

  out.push("");
  out.push("ENGINES (a real UNIQUE constraint was attempted for each):");
  const enginesById = new Map(check.engines.map((e) => [e.id, e]));
  for (const result of check.results) {
    const engine = enginesById.get(result.engineId);
    const label = engine ? `${engine.id} [${engine.engine}${engine.version ? ` ${engine.version}` : ""}]` : result.engineId;
    out.push(`  ${label}`);
    out.push(`      tier=${result.tier} outcome=${result.outcome} :: ${truncate(result.detail, 200)}`);
  }

  out.push("");
  out.push("POLICIES (application-side normalisation, what your code does first):");
  for (const p of check.policies) {
    const eq = p.equal === null ? "UNAVAILABLE" : p.equal ? "equal" : "different";
    out.push(`  ${p.policyId} [${p.side}] ${eq} (${p.tier})`);
    if (p.equal !== null && !p.equal) {
      out.push(`      A -> ${show(p.normalizedA)}`);
      out.push(`      B -> ${show(p.normalizedB)}`);
    }
    if (p.detail) out.push(`      ${truncate(p.detail, 160)}`);
  }

  out.push("");
  out.push(
    "Rules: only rows with tier=EXECUTED may be stated as fact. tier=DOCUMENTED is " +
      "attribution only ('source X says'), never a verdict. tier=UNAVAILABLE or " +
      "outcome=ERROR is a refusal: say you could not run it and why.",
  );
  return out.join("\n");
}

/**
 * run_oracle: the full evidence report - all 12 vectors x every engine,
 * sourced claims checked against observation, divergences and conflicts.
 */
export const runOracleTool: AgentTool = {
  definition: {
    name: "run_oracle",
    description:
      "Run the complete Collator evidence pass and return: runtime versions, the " +
      "engine x vector outcome matrix, sourced claims with AGREE/DISAGREE/UNVERIFIED " +
      "status, source-vs-source conflicts, engines that are UNAVAILABLE on this host " +
      "with remediation text, and calibration-rejected configurations. Use this to " +
      "answer questions about collation behaviour, folklore, or what was proven.",
    parameters: { type: "object", properties: {} },
  },
  async execute() {
    try {
      const report = await buildEvidence();
      return formatEvidenceReport(report);
    } catch (err) {
      return `run_oracle failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export function formatEvidenceReport(report: EvidenceReport): string {
  const out: string[] = [];
  const rt = report.runtime;
  out.push(
    `RUNTIME python=${rt.python ?? "?"} sqlite=${rt.sqlite ?? "?"} ` +
      `postgres=${rt.postgres ?? "?"} impl=${rt.implementation ?? "?"}`,
  );
  out.push(`GENERATED ${report.generatedAt}`);
  out.push("");
  out.push(`ENGINE x VECTOR (rows=engines, cols=${report.vectors.map((v) => v.id).join(",")})`);
  out.push(...matrixRows(report));
  out.push("");
  out.push(
    `SUMMARY executed=${report.summary.executedChecks} enginesExecuted=${report.summary.enginesExecuted} ` +
      `enginesNamedOnly=${report.summary.enginesNamedOnly} claims=${report.summary.claimsChecked} ` +
      `disagreeing=${report.summary.claimsDisagreeing} unverified=${report.summary.claimsUnverified} ` +
      `conflicts=${report.conflicts.length}`,
  );

  if (report.divergences.length > 0) {
    out.push("");
    out.push("CLAIMS vs EXECUTION:");
    for (const d of report.divergences) {
      out.push(
        `  [${d.status}] ${d.claimId} on ${d.vectorId}: predicted ${d.predicted}, ` +
          `observed ${d.observed ?? "n/a"} (checked against ${d.checkedAgainst})`,
      );
      out.push(`      ${d.note}`);
    }
  }

  for (const c of report.conflicts) {
    out.push("");
    out.push(`SOURCE-vs-SOURCE CONFLICT on ${c.vectorId} (${c.family}):`);
    for (const claim of c.claims) {
      out.push(`  ${claim.kind} ${claim.source} predicts ${claim.predicts}`);
    }
    out.push(
      `  resolved by execution -> ${c.resolution ?? "unresolved"}${c.resolvedBy ? ` (${c.resolvedBy})` : ""}`,
    );
  }

  if (report.unavailable.length > 0) {
    out.push("");
    out.push("UNAVAILABLE (refuse these; do not guess):");
    for (const u of report.unavailable) {
      out.push(`  ${u.engine} tier=${u.tier}: ${u.reason}`);
      if (u.remediation) out.push(`      remediation: ${u.remediation}`);
    }
  }

  if (report.engineFailures.length > 0) {
    out.push("");
    out.push("CALIBRATION-REJECTED (accepted SQL, failed behaviour check - not publishable):");
    for (const f of report.engineFailures) {
      out.push(`  ${f.engineId}: ${f.reason}`);
    }
  }

  out.push("");
  out.push(`Full machine-readable report: ${EVIDENCE_PATH}`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export interface PromptSources {
  session?: McpSession;
  evidence?: EvidenceReport;
}

export function buildSystemPrompt(sources: PromptSources = {}): string {
  const lines: string[] = [];
  lines.push(
    "You are Collator, an agent that answers one question precisely: would a " +
      "UNIQUE constraint treat these two strings as the same value? You answer it " +
      "by executing the constraint, never by recalling prose.",
  );
  lines.push("");
  lines.push("EVIDENCE TIERS - every assertion you make must carry one:");
  lines.push("  EXECUTED    - a probe ran on this machine and this is the raw outcome. Only tier may be stated as fact.");
  lines.push("  DOCUMENTED  - a source says so and we could not run it here. Attribution only: 'MySQL docs say...'. Never a verdict.");
  lines.push("  UNAVAILABLE - no admissible evidence. Refuse explicitly: name what could not run, why, and the remediation. Never guess, never soften a refusal into a hedge.");
  lines.push("");
  lines.push("METHOD:");
  lines.push("  1. For any pair of values, call check_pair BEFORE answering. The tool returns COLLIDES/DISTINCT per engine with tiers.");
  lines.push("  2. For questions about collation behaviour, folklore, or what has been proven, call run_oracle.");
  lines.push(
    "  3. When a DOCUMENTED claim contradicts EXECUTED observation, say so plainly: the " +
      "source says X, execution says Y, execution wins, here is the source URL.",
  );
  lines.push("  4. When two sources contradict each other, report the conflict and say which one execution resolved it in favour of.");
  lines.push("");
  lines.push("ANSWER SHAPE:");
  lines.push("  - First line: the verdict. 'COLLIDES: ...' or 'DISTINCT: ...' or 'REFUSED: ...' naming the configuration it applies to.");
  lines.push("  - Then: which engines agree and which disagree, each with its tier.");
  lines.push("  - Then: caveats, divergences, and source URLs for anything DOCUMENTED.");
  lines.push("  - A verdict never applies to 'databases in general' - name the engine and collation.");
  lines.push("");
  lines.push(
    "HARD RULES: never invent an execution, an engine version, or a source URL. " +
      "Never claim you ran something you did not run. If a tool errors, report the " +
      "error rather than substituting a plausible answer.",
  );

  const session = sources.session;
  if (session) {
    lines.push("");
    if (session.initialContext.kb) {
      lines.push("SANITY CONTEXT - KNOWLEDGE BASE outline (read entries with kb__knowledge_base_read):");
      lines.push("```");
      lines.push(session.initialContext.kb);
      lines.push("```");
    }
    if (session.initialContext.studio) {
      lines.push("SANITY CONTEXT - DATASET schema summary (query with studio__groq_query):");
      lines.push("```");
      lines.push(session.initialContext.studio);
      lines.push("```");
    }
    const contextTools = session.tools.map((t) => t.qualifiedName);
    if (contextTools.length > 0) {
      lines.push("");
      lines.push(
        `Sanity Context tools available: ${contextTools.join(", ")}. Use kb__knowledge_base_read ` +
          "for the source manifest, prior art register, and claim entries; use studio__groq_query " +
          "to check how the dataset itself records a configuration. Citation URLs for DOCUMENTED " +
          "claims should come from the Knowledge Base when it has them.",
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface AgentEvent {
  kind: "text" | "tool" | "tool_result" | "warning";
  /** for text: the assistant text of that step */
  text?: string;
  /** for tool/tool_result: tool name */
  name?: string;
  /** for tool: the arguments; for tool_result: the (possibly truncated) result */
  payload?: string;
}

export interface RunAgentOptions {
  question: string;
  llm: LlmConfig;
  session?: McpSession;
  extraTools?: AgentTool[];
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentAnswer {
  text: string;
  steps: number;
  toolCalls: { name: string; args: string }[];
}

const RESULT_CAP = 24_000;

export async function runAgent(opts: RunAgentOptions): Promise<AgentAnswer> {
  const tools: AgentTool[] = [checkPairTool, runOracleTool, ...(opts.extraTools ?? [])];
  const contextByName = new Map((opts.session?.tools ?? []).map((t) => [t.qualifiedName, t]));
  const defs: ToolDefinition[] = [
    ...tools.map((t) => t.definition),
    ...(opts.session?.tools ?? []).map((t) => t.definition),
  ];

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ session: opts.session }) },
    { role: "user", content: opts.question },
  ];

  const toolCalls: { name: string; args: string }[] = [];
  let steps = 0;
  let finalText = "";

  while (steps < opts.llm.maxSteps) {
    steps += 1;
    const { message } = await chat(opts.llm, messages, defs);

    if (message.content) {
      finalText = message.content;
      opts.onEvent?.({ kind: "text", text: message.content, payload: String(steps) });
    }

    const calls = message.role === "assistant" ? (message.tool_calls ?? []) : [];
    if (calls.length === 0) {
      break;
    }

    messages.push({ ...message, content: message.content ?? "" });

    for (const call of calls) {
      const name = call.function.name;
      toolCalls.push({ name, args: call.function.arguments });
      opts.onEvent?.({ kind: "tool", name, payload: call.function.arguments });

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }

      let result: string;
      const local = tools.find((t) => t.definition.name === name);
      if (local) {
        result = await local.execute(args);
      } else if (opts.session && contextByName.has(name)) {
        result = await opts.session.call(name, args);
      } else {
        result = `unknown tool: ${name}`;
      }

      const payload = result.length > RESULT_CAP ? `${result.slice(0, RESULT_CAP)}\n...[truncated]` : result;
      opts.onEvent?.({ kind: "tool_result", name, payload });
      messages.push({ role: "tool", tool_call_id: call.id, content: payload });
    }
  }

  if (!finalText && messages.length > 0) {
    // Max steps reached with only tool traffic - ask for the answer directly.
    messages.push({
      role: "user",
      content: "That is all the tool budget. Give your final answer now, with tiers on every claim.",
    });
    const { message } = await chat(opts.llm, messages, defs);
    finalText = message.content ?? "";
    if (finalText) opts.onEvent?.({ kind: "text", text: finalText, payload: String(steps + 1) });
    steps += 1;
  }

  return { text: finalText, steps, toolCalls };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `collator ask - answer "are these the same string?" by execution

  npm run ask -- "Would a UNIQUE constraint treat \"Jos\\u00E9\" and \"jos\\u00E9\" as equal on SQLite NOCASE?"
  npm run ask -- --pair "Stra\\u00DFe" "strasse"

Requires LLM_BASE_URL + LLM_MODEL (any OpenAI-compatible endpoint, see .env.example).
Sanity Context tools attach automatically when SANITY_MCP_* is set.`;

function emit(event: AgentEvent): void {
  if (event.kind === "text") {
    process.stdout.write(`\n--- answer (step ${event.payload ?? "?"}) ---\n${event.text}\n`);
  } else if (event.kind === "tool") {
    process.stdout.write(`\n> tool ${event.name} ${truncate(event.payload ?? "", 300)}\n`);
  } else if (event.kind === "tool_result") {
    process.stdout.write(`  <- ${truncate(event.payload ?? "", 600)}\n`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let question = "";
  if (argv[0] === "--pair" && argv.length >= 3) {
    question = `Would a UNIQUE constraint treat these two values as the same row? A = ${JSON.stringify(argv[1])}, B = ${JSON.stringify(argv[2])}. Run check_pair and give the verdict per configuration.`;
  } else if (argv.length > 0) {
    question = argv.join(" ");
  } else if (!process.stdin.isTTY) {
    question = (await readStdin()).trim();
  }

  if (!question) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  let llm: LlmConfig;
  try {
    llm = configFromEnv();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const session = await connectSanityMcp(sanityMcpConfigFromEnv());
  for (const warning of session.warnings) {
    process.stderr.write(`[context] ${warning}\n`);
  }

  try {
    const answer = await runAgent({ question, llm, session, onEvent: emit });
    if (!answer.text) {
      process.stderr.write("[agent] the model returned no text\n");
      process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof LlmError) {
      process.stderr.write(`[llm] ${err.message}\n${err.body}\n`);
    } else {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
}
