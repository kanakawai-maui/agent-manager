/**
 * Qwen provider — Alibaba Cloud DashScope API (OpenAI-compatible)
 *
 * Docs: https://www.alibabacloud.com/help/en/model-studio/developer-reference/use-qwen-by-calling-api
 *
 * Required environment variables:
 *   DASHSCOPE_API_KEY  — your Alibaba Cloud DashScope API key
 *
 * Optional environment variables:
 *   QWEN_MODEL         — default model (default: "qwen-max")
 *   QWEN_BASE_URL      — override base URL
 *                        (default: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1")
 *
 * Available models (as of 2025):
 *   qwen-max | qwen-plus | qwen-turbo | qwen-long
 *   qwen2.5-72b-instruct | qwen2.5-32b-instruct | qwen2.5-14b-instruct
 *   qwen2.5-7b-instruct  | qwen2.5-coder-32b-instruct
 */

import type { LLMProvider, LLMRequest, LLMResponse, ProgressCallback } from './llm-provider';
import { httpPost, requireEnv, optionalEnv } from './llm-provider';

// ── DashScope API shapes (OpenAI-compatible wire format) ──────────────────────

interface QwenRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  stream: boolean;
}

interface QwenChoice {
  message: { role: string; content: string };
  finish_reason: string;
}

interface QwenUsage {
  prompt_tokens:     number;
  completion_tokens: number;
  total_tokens:      number;
}

interface QwenResponse {
  id:    string;
  model: string;
  choices: QwenChoice[];
  usage:   QwenUsage;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface QwenProviderConfig {
  /** DashScope API key. Defaults to DASHSCOPE_API_KEY env var. */
  apiKey?: string;
  /** Default model. Defaults to QWEN_MODEL env var or "qwen-max". */
  model?: string;
  /**
   * API base URL.
   * Defaults to QWEN_BASE_URL env var or the international DashScope endpoint.
   * For China-region accounts use "https://dashscope.aliyuncs.com/compatible-mode/v1".
   */
  baseUrl?: string;
}

/**
 * DashScope exposes an OpenAI-compatible Chat Completions endpoint, so the
 * wire format is identical to the OpenAI provider — only the base URL and
 * auth header key differ.
 */
export class QwenProvider implements LLMProvider {
  readonly name = 'Qwen';

  private readonly apiKey:  string;
  private readonly model:   string;
  private readonly baseUrl: string;

  constructor(config: QwenProviderConfig = {}) {
    this.apiKey  = config.apiKey  ?? requireEnv('DASHSCOPE_API_KEY');
    this.model   = config.model   ?? optionalEnv('QWEN_MODEL',    'qwen-max');
    this.baseUrl = config.baseUrl ?? optionalEnv('QWEN_BASE_URL', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
  }

  async complete(request: LLMRequest, onProgress?: ProgressCallback): Promise<LLMResponse> {
    const model = request.model ?? this.model;

    const payload: QwenRequest = {
      model,
      messages: request.messages.map(m => ({ role: m.role, content: m.content })),
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
      throw new Error(`Qwen (DashScope) API error ${statusCode}: ${body}`);
    }

    const data    = JSON.parse(body) as QwenResponse;
    const content = data.choices[0]?.message?.content ?? '';

    if (onProgress) onProgress(content);

    return {
      content,
      model: data.model ?? model,
      usage: {
        promptTokens:     data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens:      data.usage.total_tokens,
      },
    };
  }
}
