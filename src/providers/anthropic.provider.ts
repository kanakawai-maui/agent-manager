/**
 * Anthropic provider — Messages API (Claude models)
 *
 * Docs: https://docs.anthropic.com/en/api/messages
 *
 * Required environment variables:
 *   ANTHROPIC_API_KEY  — your Anthropic secret key
 *
 * Optional environment variables:
 *   ANTHROPIC_MODEL    — default model (default: "claude-3-5-sonnet-20241022")
 *   ANTHROPIC_BASE_URL — override base URL (default: "https://api.anthropic.com/v1")
 */

import type { LLMProvider, LLMRequest, LLMResponse, ProgressCallback } from './llm-provider';
import { httpPost, requireEnv, optionalEnv } from './llm-provider';

// ── Anthropic API shapes ──────────────────────────────────────────────────────

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
}

interface AnthropicContentBlock {
  type: 'text';
  text: string;
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: AnthropicContentBlock[];
  usage: AnthropicUsage;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface AnthropicProviderConfig {
  /** Anthropic secret key. Defaults to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Default model. Defaults to ANTHROPIC_MODEL env var or "claude-3-5-sonnet-20241022". */
  model?: string;
  /** API base URL. Defaults to ANTHROPIC_BASE_URL env var or "https://api.anthropic.com/v1". */
  baseUrl?: string;
}

/**
 * Anthropic's Messages API separates system prompts from the conversation
 * history. This provider extracts any leading 'system' role message and
 * passes it in the dedicated `system` field.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'Anthropic';

  // Current stable version of the Messages API.
  private static readonly API_VERSION = '2023-06-01';
  private static readonly DEFAULT_MAX_TOKENS = 4096;

  private readonly apiKey:  string;
  private readonly model:   string;
  private readonly baseUrl: string;

  constructor(config: AnthropicProviderConfig = {}) {
    this.apiKey  = config.apiKey  ?? requireEnv('ANTHROPIC_API_KEY');
    this.model   = config.model   ?? optionalEnv('ANTHROPIC_MODEL',    'claude-3-5-sonnet-20241022');
    this.baseUrl = config.baseUrl ?? optionalEnv('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1');
  }

  async complete(request: LLMRequest, onProgress?: ProgressCallback): Promise<LLMResponse> {
    const model = request.model ?? this.model;

    // Extract system prompt (Anthropic keeps it separate from messages).
    const systemMsg = request.messages.find(m => m.role === 'system');
    const chatMsgs  = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const payload: AnthropicRequest = {
      model,
      max_tokens: request.maxTokens ?? AnthropicProvider.DEFAULT_MAX_TOKENS,
      messages: chatMsgs,
    };
    if (systemMsg)               payload.system      = systemMsg.content;
    if (request.temperature !== undefined) payload.temperature = request.temperature;

    const { statusCode, body } = await httpPost(
      `${this.baseUrl}/messages`,
      {
        'x-api-key':         this.apiKey,
        'anthropic-version': AnthropicProvider.API_VERSION,
      },
      payload,
    );

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Anthropic API error ${statusCode}: ${body}`);
    }

    const data = JSON.parse(body) as AnthropicResponse;
    const content = data.content.map(b => b.text).join('');

    if (onProgress) onProgress(content);

    return {
      content,
      model: data.model,
      usage: {
        promptTokens:     data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens:      data.usage.input_tokens + data.usage.output_tokens,
      },
    };
  }
}
