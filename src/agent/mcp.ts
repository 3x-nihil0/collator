/**
 * Sanity Context, wired in as plain tools.
 *
 * Path One expects meaningful use of Sanity Context. Collator connects to two
 * hosted Context MCP endpoints - one in Knowledge Base mode (the source
 * manifest and prior-art register live there), one in GROQ mode (the dataset
 * itself) - and exposes every tool they serve to the agent loop.
 *
 * Endpoint URL shape (from https://www.sanity.io/docs/ai/sanity-context-mcp-tools):
 *
 *   POST https://api.sanity.io/v1/context/organizations/$ORG/mcp/$ENDPOINT
 *   Authorization: Bearer $SANITY_ORGANIZATION_TOKEN
 *
 * Everything degrades gracefully: no env vars means no context tools and a
 * warning, never a crash. The oracle works without Sanity; Sanity makes the
 * answer sourced instead of merely executed.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition } from "./llm.js";

const API_ROOT = "https://api.sanity.io/v1/context";
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;
const INITIAL_CONTEXT_CAP = 8_000;

export interface SanityMcpEnv {
  orgId: string;
  token: string;
  kbEndpoint: string;
  groqEndpoint: string;
}

export interface SanityMcpConfig {
  env: SanityMcpEnv;
  /** which of the two endpoints are actually configured */
  enabled: ("kb" | "studio")[];
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; [k: string]: unknown };
}

export interface BoundTool {
  /** OpenAI-safe function name, e.g. kb__knowledge_base_read */
  qualifiedName: string;
  serverId: "kb" | "studio";
  mcpName: string;
  definition: ToolDefinition;
}

export interface McpSession {
  tools: BoundTool[];
  /** initial_context from each endpoint, fetched eagerly for the prompt */
  initialContext: { kb?: string; studio?: string };
  warnings: string[];
  /** invoke a bound tool by its qualified name; never rejects */
  call(qualifiedName: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/** Read Context config from the environment; null when nothing is set. */
export function sanityMcpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SanityMcpConfig | null {
  const orgId = env.SANITY_MCP_ORG_ID ?? "";
  const token = env.SANITY_ORGANIZATION_TOKEN ?? "";
  const kbEndpoint = env.SANITY_MCP_KB_ENDPOINT ?? "";
  const groqEndpoint = env.SANITY_MCP_GROQ_ENDPOINT ?? "";

  const enabled: SanityMcpConfig["enabled"] = [];
  if (kbEndpoint) enabled.push("kb");
  if (groqEndpoint) enabled.push("studio");
  if (!token || !orgId || enabled.length === 0) return null;

  return { env: { orgId, token, kbEndpoint, groqEndpoint }, enabled };
}

/** Tool names must match ^[A-Za-z0-9_-]{1,64}$ on most providers. */
function qualify(serverId: "kb" | "studio", mcpName: string): string {
  const raw = `${serverId}__${mcpName}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return raw.slice(0, 64);
}

function toDefinition(serverId: "kb" | "studio", tool: McpTool): ToolDefinition {
  const schema = tool.inputSchema ?? {};
  return {
    name: qualify(serverId, tool.name),
    description:
      `[Sanity Context ${serverId === "kb" ? "Knowledge Base" : "dataset"}] ` +
      (tool.description ?? tool.name),
    parameters:
      schema.type === "object" ? schema : { type: "object", ...schema, properties: schema.properties ?? {} },
  };
}

interface ServerHandle {
  serverId: "kb" | "studio";
  client: Client;
  transport: StreamableHTTPClientTransport;
  mcpTools: McpTool[];
}

function endpointUrl(config: SanityMcpConfig, serverId: "kb" | "studio"): string {
  const name = serverId === "kb" ? config.env.kbEndpoint : config.env.groqEndpoint;
  return `${API_ROOT}/organizations/${encodeURIComponent(config.env.orgId)}/mcp/${encodeURIComponent(name)}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function openServer(
  config: SanityMcpConfig,
  serverId: "kb" | "studio",
): Promise<ServerHandle> {
  const transport = new StreamableHTTPClientTransport(new URL(endpointUrl(config, serverId)), {
    requestInit: {
      headers: { authorization: `Bearer ${config.env.token}` },
    },
  });
  const client = new Client(
    { name: "collator", version: "0.1.0" },
    { capabilities: {} },
  );
  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${serverId}`);

  const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `tools/list ${serverId}`);
  return { serverId, client, transport, mcpTools: listed.tools as McpTool[] };
}

/** Extract plain text (or a readable error) from a CallToolResult. */
function textOf(result: unknown): string {
  const r = result as { content?: { type?: string; text?: string }[]; isError?: boolean; message?: string };
  const parts = (r?.content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);
  if (parts.length > 0) return parts.join("\n");
  if (r?.isError) return `tool error: ${r.message ?? "unknown error"}`;
  return JSON.stringify(result).slice(0, 4000);
}

/**
 * Connect to every configured Context endpoint.
 *
 * Never throws: a missing token, a 403 contextGrantRequired, or a network
 * failure all become warnings so the agent can still answer from execution
 * evidence alone. This is deliberate - the oracle must not depend on Sanity
 * being reachable.
 */
export async function connectSanityMcp(
  config: SanityMcpConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpSession> {
  const warnings: string[] = [];
  const tools: BoundTool[] = [];
  const initialContext: McpSession["initialContext"] = {};
  const handles: ServerHandle[] = [];

  const unreachable = async (qualifiedName: string): Promise<string> =>
    `Sanity Context is not connected (unknown tool: ${qualifiedName})`;

  if (!config) {
    warnings.push(
      "Sanity Context not configured (SANITY_MCP_ORG_ID / SANITY_ORGANIZATION_TOKEN / endpoint names unset) - answering from execution evidence only.",
    );
    return { tools, initialContext, warnings, call: unreachable, close: async () => undefined };
  }

  for (const serverId of config.enabled) {
    let handle: ServerHandle;
    try {
      handle = await openServer(config, serverId);
    } catch (err) {
      warnings.push(
        `Sanity Context ${serverId} endpoint unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    handles.push(handle);

    const mcpTools = handle.mcpTools;
    if (mcpTools.length === 0) {
      warnings.push(`Sanity Context ${serverId} endpoint exposes no tools (check its mode and allowlist).`);
    }
    for (const tool of mcpTools) {
      const def = toDefinition(serverId, tool);
      tools.push({
        qualifiedName: def.name,
        serverId,
        mcpName: tool.name,
        definition: def,
      });
    }

    // initial_context is cheap and gives the prompt the KB outline / schema
    // summary up front, so the model spends tool calls on entries, not on
    // discovering that they exist.
    if (mcpTools.some((t) => t.name === "initial_context")) {
      try {
        const res = await withTimeout(
          handle.client.callTool({ name: "initial_context", arguments: {} }),
          CALL_TIMEOUT_MS,
          "initial_context",
        );
        const text = textOf(res);
        if (serverId === "kb") initialContext.kb = text.slice(0, INITIAL_CONTEXT_CAP);
        else initialContext.studio = text.slice(0, INITIAL_CONTEXT_CAP);
      } catch (err) {
        warnings.push(
          `initial_context failed on ${serverId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (handles.length === 0) {
    warnings.push("No Sanity Context endpoint connected - answering from execution evidence only.");
  }

  const byName = new Map(tools.map((t) => [t.qualifiedName, t]));
  const handleFor = new Map(handles.map((h) => [h.serverId, h]));

  /**
   * Invoke a bound tool. Tool errors are returned as text rather than
   * thrown: the agent should read them and adjust, exactly as it would read
   * a UNAVAILABLE tier.
   */
  const call = async (qualifiedName: string, args: Record<string, unknown>): Promise<string> => {
    const entry = byName.get(qualifiedName);
    if (!entry) return `unknown tool: ${qualifiedName}`;
    const handle = handleFor.get(entry.serverId);
    if (!handle) return `Sanity Context ${entry.serverId} endpoint is not connected`;
    try {
      const res = await withTimeout(
        handle.client.callTool({ name: entry.mcpName, arguments: args }),
        CALL_TIMEOUT_MS,
        entry.mcpName,
      );
      return textOf(res);
    } catch (err) {
      return `${entry.mcpName} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  return {
    tools,
    initialContext,
    warnings,
    call,
    close: async () => {
      await Promise.all(
        handles.map(async (h) => {
          try {
            await h.client.close();
          } catch {
            /* closing is best-effort */
          }
        }),
      );
    },
  };
}
