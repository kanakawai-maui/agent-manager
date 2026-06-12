/**
 * OpenAI provider — Chat Completions API
 *
 * Docs: https://platform.openai.com/docs/api-reference/chat
 *
 * Required environment variables:
 *   OPENAI_API_KEY   — your OpenAI secret key
 *
 * Optional environment variables:
 *   OPENAI_MODEL     — default model (default: "gpt-4o")
 *   OPENAI_BASE_URL  — override base URL (default: "https://api.openai.com/v1")
 */

import type { LLMProvider, LLMRequest, LLMResponse, ProgressCallback } from './llm-provider';
import { httpPost, requireEnv, optionalEnv } from './llm-provider';

// ── OpenAI API shapes ─────────────────────────────────────────────────────────

interface OpenAIRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  stream: boolean;
}

interface OpenAIChoice {
  message: { role: string; content: string };
  finish_reason: string;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface OpenAIProviderConfig {
  /** OpenAI secret key. Defaults to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Default model to use. Defaults to OPENAI_MODEL env var or "gpt-4o". */
  model?: string;
  /** API base URL. Defaults to OPENAI_BASE_URL env var or "https://api.openai.com/v1". */
  baseUrl?: string;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'OpenAI';

  private readonly apiKey:  string;
  private readonly model:   string;
  private readonly baseUrl: string;

  constructor(config: OpenAIProviderConfig = {}) {
    this.apiKey  = config.apiKey  ?? requireEnv('OPENAI_API_KEY');
    this.model   = config.model   ?? optionalEnv('OPENAI_MODEL',    'gpt-4o');
    this.baseUrl = config.baseUrl ?? optionalEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  }

  async complete(request: LLMRequest, onProgress?: ProgressCallback): Promise<LLMResponse> {
    const model = request.model ?? this.model;

    const payload: OpenAIRequest = {
      model,
      messages: request.messages,
      stream: false,
    };
    if (request.maxTokens  !== undefined) payload.max_tokens  = request.maxTokens;
    if (request.temperature !== undefined) payload.temperature = request.temperature;

    const { statusCode, body } = await httpPost(
      `${this.baseUrl}/chat/completions`,
      { Authorization: `Bearer ${this.apiKey}` },
      payload,
    );

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`OpenAI API error ${statusCode}: ${body}`);
    }

    const data = JSON.parse(body) as OpenAIResponse;
    const content = data.choices[0]?.message?.content ?? '';

    if (onProgress) onProgress(content);

    return {
      content,
      model: data.model,
      usage: {
        promptTokens:     data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens:      data.usage.total_tokens,
      },
    };
  }
}
