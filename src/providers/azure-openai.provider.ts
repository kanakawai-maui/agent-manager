/**
 * Azure OpenAI provider — Azure-hosted OpenAI Chat Completions API
 *
 * Docs: https://learn.microsoft.com/en-us/azure/ai-services/openai/reference
 *
 * Required environment variables:
 *   AZURE_OPENAI_API_KEY       — your Azure OpenAI resource key
 *   AZURE_OPENAI_ENDPOINT      — resource endpoint, e.g. "https://my-resource.openai.azure.com"
 *   AZURE_OPENAI_DEPLOYMENT    — deployment name (maps to a specific model version)
 *
 * Optional environment variables:
 *   AZURE_OPENAI_API_VERSION   — REST API version (default: "2024-02-01")
 */

import type { LLMProvider, LLMRequest, LLMResponse, ProgressCallback } from './llm-provider';
import { httpPost, requireEnv, optionalEnv } from './llm-provider';

// ── Azure OpenAI API shapes (same wire format as OpenAI) ──────────────────────

interface AzureOpenAIRequest {
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  stream: boolean;
}

interface AzureOpenAIChoice {
  message: { role: string; content: string };
  finish_reason: string;
}

interface AzureOpenAIUsage {
  prompt_tokens:     number;
  completion_tokens: number;
  total_tokens:      number;
}

interface AzureOpenAIResponse {
  id:    string;
  model: string;
  choices: AzureOpenAIChoice[];
  usage:   AzureOpenAIUsage;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface AzureOpenAIProviderConfig {
  /** Azure resource key. Defaults to AZURE_OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Resource endpoint URL. Defaults to AZURE_OPENAI_ENDPOINT env var. */
  endpoint?: string;
  /** Deployment name. Defaults to AZURE_OPENAI_DEPLOYMENT env var. */
  deployment?: string;
  /** REST API version. Defaults to AZURE_OPENAI_API_VERSION env var or "2024-02-01". */
  apiVersion?: string;
}

/**
 * Azure OpenAI uses the same JSON payload as OpenAI but authenticates with
 * `api-key` header and encodes the deployment name in the URL path rather
 * than the `model` field (the `model` field is ignored by Azure).
 */
export class AzureOpenAIProvider implements LLMProvider {
  readonly name = 'Azure OpenAI';

  private readonly apiKey:     string;
  private readonly endpoint:   string;
  private readonly deployment: string;
  private readonly apiVersion: string;

  constructor(config: AzureOpenAIProviderConfig = {}) {
    this.apiKey     = config.apiKey     ?? requireEnv('AZURE_OPENAI_API_KEY');
    this.endpoint   = config.endpoint   ?? requireEnv('AZURE_OPENAI_ENDPOINT');
    this.deployment = config.deployment ?? requireEnv('AZURE_OPENAI_DEPLOYMENT');
    this.apiVersion = config.apiVersion ?? optionalEnv('AZURE_OPENAI_API_VERSION', '2024-02-01');
  }

  async complete(request: LLMRequest, onProgress?: ProgressCallback): Promise<LLMResponse> {
    // Azure routes by deployment, not model name; use deployment as display model.
    const displayModel = request.model ?? this.deployment;

    const payload: AzureOpenAIRequest = {
      messages: request.messages,
      stream: false,
    };
    if (request.maxTokens  !== undefined) payload.max_tokens  = request.maxTokens;
    if (request.temperature !== undefined) payload.temperature = request.temperature;

    // Endpoint format:
    // {endpoint}/openai/deployments/{deployment}/chat/completions?api-version={version}
    const base = this.endpoint.replace(/\/$/, '');
    const url  = `${base}/openai/deployments/${encodeURIComponent(this.deployment)}/chat/completions?api-version=${this.apiVersion}`;

    const { statusCode, body } = await httpPost(
      url,
      { 'api-key': this.apiKey },
      payload,
    );

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Azure OpenAI API error ${statusCode}: ${body}`);
    }

    const data    = JSON.parse(body) as AzureOpenAIResponse;
    const content = data.choices[0]?.message?.content ?? '';

    if (onProgress) onProgress(content);

    return {
      content,
      model: data.model ?? displayModel,
      usage: {
        promptTokens:     data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens:      data.usage.total_tokens,
      },
    };
  }
}
