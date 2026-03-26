import type { AgentRuntimeRequest } from "../types";
import {
  normalizeProviderProtocolForAuthMode,
  type ProviderProtocol,
} from "../../utils/providerProtocol";
import { isGeminiBase } from "../../utils/apiHelpers";
import type { AgentModelAdapter } from "./adapter";
import { CodexResponsesAgentAdapter } from "./codexResponses";
import { OpenAIResponsesAgentAdapter } from "./openaiResponses";
import { OpenAIChatCompatAgentAdapter } from "./openaiCompatible";
import { AnthropicMessagesAgentAdapter } from "./anthropicMessages";
import { GeminiNativeAgentAdapter } from "./geminiNative";

export function resolveRequestProviderProtocol(
  request: Pick<AgentRuntimeRequest, "providerProtocol" | "authMode" | "apiBase">,
): ProviderProtocol {
  return normalizeProviderProtocolForAuthMode({
    protocol: request.providerProtocol,
    authMode: request.authMode,
    apiBase: request.apiBase,
  });
}

export function createAgentModelAdapter(
  request: AgentRuntimeRequest,
): AgentModelAdapter {
  const protocol = resolveRequestProviderProtocol(request);
  if (
    protocol === "openai_chat_compat" &&
    isGeminiBase((request.apiBase || "").trim())
  ) {
    // Gemini's OpenAI-compatible chat endpoint drops thought signatures on
    // returned tool calls, which breaks multi-step agent continuation.
    return new GeminiNativeAgentAdapter();
  }
  if (protocol === "codex_responses") {
    return new CodexResponsesAgentAdapter();
  }
  if (protocol === "responses_api") {
    return new OpenAIResponsesAgentAdapter();
  }
  if (protocol === "anthropic_messages") {
    return new AnthropicMessagesAgentAdapter();
  }
  if (protocol === "gemini_native") {
    return new GeminiNativeAgentAdapter();
  }
  return new OpenAIChatCompatAgentAdapter();
}
