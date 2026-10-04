/**
 * A deliberately small OpenAI-compatible chat client.
 *
 * Provider-agnostic by construction: any endpoint that speaks
 * /chat/completions works, chosen entirely by environment variables. No SDK
 * version churn, no provider lock-in, and the tool-calling loop is short
 * enough to read in one sitting.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxSteps: number;
  temperature?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseUrl = (env.LLM_BASE_URL ?? "").replace(/\/+$/, "");
  const model = env.LLM_MODEL ?? "";
  if (!baseUrl || !model) {
    throw new Error(
      "LLM_BASE_URL and LLM_MODEL must be set. See .env.example for a table of " +
        "providers - any OpenAI-compatible endpoint works.",
    );
  }
  return {
    baseUrl,
    apiKey: env.LLM_API_KEY ?? "",
    model,
    maxSteps: Number(env.LLM_MAX_STEPS ?? 8),
    temperature: 0,
  };
}

export interface ChatResult {
  message: ChatMessage;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** One turn of chat completion. Throws LlmError with the provider's body. */
export async function chat(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0,
  };
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    body.tool_choice = "auto";
  }

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new LlmError(`LLM request failed with HTTP ${res.status}`, res.status, text.slice(0, 2000));
  }

  let parsed: {
    choices?: { message?: ChatMessage }[];
    usage?: ChatResult["usage"];
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LlmError("LLM returned a non-JSON body", res.status, text.slice(0, 2000));
  }

  const message = parsed.choices?.[0]?.message;
  if (!message) {
    throw new LlmError("LLM response contained no message", res.status, text.slice(0, 2000));
  }

  return { message, ...(parsed.usage ? { usage: parsed.usage } : {}) };
}
