/**
 * Ollama provider — local model inference
 *
 * Docs: https://github.com/ollama/ollama/blob/main/docs/api.md
 *
 * Ollama must be running locally (or at a reachable address).
 * No API key is required for the default local setup.
 *
 * Optional environment variables:
 *   OLLAMA_MODEL    — default model (default: "llama3")
 *   OLLAMA_BASE_URL — server base URL (default: "http://localhost:11434")
 */

import type { LLMProvider, LLMRequest, LLMResponse, ProgressCallback } from './llm-provider';
import { httpPost, optionalEnv } from './llm-provider';

// ── Ollama API shapes ─────────────────────────────────────────────────────────

interface OllamaMessage {
  role: string;
  content: string;
}

interface OllamaRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: {
    num_predict?: number;  // max tokens
    temperature?: number;
  };
}

interface OllamaResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface OllamaProviderConfig {
  /** Default model. Defaults to OLLAMA_MODEL env var or "llama3". */
  model?: string;
  /** Ollama server base URL. Defaults to OLLAMA_BASE_URL env var or "http://localhost:11434". */
  baseUrl?: string;
}

/**
 * Ollama exposes an OpenAI-compatible /api/chat endpoint.
 * Works with any model pulled via `ollama pull <model>`.
 */
export class OllamaProvider implements LLMProvider {
  readonly name = 'Ollama';

  private readonly model:   string;
  private readonly baseUrl: string;

  constructor(config: OllamaProviderConfig = {}) {
    this.model   = config.model   ?? optionalEnv('OLLAMA_MODEL',    'llama3');
    this.baseUrl = config.baseUrl ?? optionalEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
  }

  async complete(request: LLMRequest, onProgress?: ProgressCallback): Promise<LLMResponse> {
    const model = request.model ?? this.model;

    const payload: OllamaRequest = {
      model,
      messages: request.messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
    };

    if (request.maxTokens !== undefined || request.temperature !== undefined) {
      payload.options = {};
      if (request.maxTokens  !== undefined) payload.options.num_predict = request.maxTokens;
      if (request.temperature !== undefined) payload.options.temperature  = request.temperature;
    }

    const { statusCode, body } = await httpPost(
      `${this.baseUrl}/api/chat`,
      {},
      payload,
    );

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Ollama API error ${statusCode}: ${body}`);
    }

    const data    = JSON.parse(body) as OllamaResponse;
    const content = data.message?.content ?? '';

    if (onProgress) onProgress(content);

    const promptTokens     = data.prompt_eval_count ?? 0;
    const completionTokens = data.eval_count ?? 0;

    return {
      content,
      model: data.model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };
  }
}
