/**
 * OpenRouter provider — Chat Completions API
 *
 * Docs: https://openrouter.ai/docs
 *
 * Required environment variables:
 *   OPENROUTER_API_KEY   — your OpenRouter API key
 *
 * Optional environment variables:
 *   OPENROUTER_MODEL     — default model (default: "openai/gpt-4o")
 *   OPENROUTER_BASE_URL  — override base URL (default: "https://openrouter.ai/api/v1")
 */

import type { LLMProvider, LLMRequest, LLMResponse, ProgressCallback } from './llm-provider';
import { httpPost, requireEnv, optionalEnv } from './llm-provider';

// ── OpenRouter API shapes (OpenAI-compatible) ─────────────────────────────────

interface OpenRouterRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  stream: boolean;
}

interface OpenRouterChoice {
  message: { role: string; content: string };
  finish_reason: string;
}

interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenRouterResponse {
  id: string;
  model: string;
  choices: OpenRouterChoice[];
  usage: OpenRouterUsage;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface OpenRouterProviderConfig {
  /** OpenRouter API key. Defaults to OPENROUTER_API_KEY env var. */
  apiKey?: string;
  /** Default model to use. Defaults to OPENROUTER_MODEL env var or "openai/gpt-4o". */
  model?: string;
  /** API base URL. Defaults to OPENROUTER_BASE_URL env var or "https://openrouter.ai/api/v1". */
  baseUrl?: string;
  /** Your site URL (optional, used for rankings on OpenRouter). */
  siteUrl?: string;
  /** Your app name (optional, used for rankings on OpenRouter). */
  appName?: string;
}

export class OpenRouterProvider implements LLMProvider {
  readonly name = 'OpenRouter';

  private readonly apiKey:  string;
  private readonly model:   string;
  private readonly baseUrl: string;
  private readonly siteUrl?: string;
  private readonly appName?: string;

  constructor(config: OpenRouterProviderConfig = {}) {
    this.apiKey  = config.apiKey  ?? requireEnv('OPENROUTER_API_KEY');
    this.model   = config.model   ?? optionalEnv('OPENROUTER_MODEL',    'openai/gpt-4o');
    this.baseUrl = config.baseUrl ?? optionalEnv('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1');
    this.siteUrl = config.siteUrl ?? process.env.OPENROUTER_SITE_URL;
    this.appName = config.appName ?? process.env.OPENROUTER_APP_NAME;
  }

  async complete(request: LLMRequest, onProgress?: ProgressCallback): Promise<LLMResponse> {
    const model = request.model ?? this.model;

    const payload: OpenRouterRequest = {
      model,
      messages: request.messages,
      stream: false,
    };
    if (request.maxTokens  !== undefined) payload.max_tokens  = request.maxTokens;
    if (request.temperature !== undefined) payload.temperature = request.temperature;

    // OpenRouter requires these headers
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'HTTP-Referer': this.siteUrl || 'https://github.com/agent-manager',
      'X-Title': this.appName || 'Agent Manager',
    };

    const { statusCode, body } = await httpPost(
      `${this.baseUrl}/chat/completions`,
      headers,
      payload,
    );

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`OpenRouter API error ${statusCode}: ${body}`);
    }

    const data = JSON.parse(body) as OpenRouterResponse;
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
