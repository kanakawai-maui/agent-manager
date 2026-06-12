/**
 * Google Gemini provider — Generative Language API
 *
 * Docs: https://ai.google.dev/api/generate-content
 *
 * Required environment variables:
 *   GOOGLE_API_KEY   — your Google AI Studio / Vertex AI key
 *
 * Optional environment variables:
 *   GOOGLE_MODEL     — default model (default: "gemini-1.5-pro")
 *   GOOGLE_BASE_URL  — override base URL
 *                      (default: "https://generativelanguage.googleapis.com/v1beta")
 */

import type { LLMProvider, LLMRequest, LLMResponse, ProgressCallback } from './llm-provider';
import { httpPost, requireEnv, optionalEnv } from './llm-provider';

// ── Gemini API shapes ─────────────────────────────────────────────────────────

interface GeminiPart {
  text: string;
}

interface GeminiContent {
  /** "user" | "model" (Gemini uses "model" instead of "assistant") */
  role: string;
  parts: GeminiPart[];
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
  };
}

interface GeminiCandidate {
  content: GeminiContent;
  finishReason: string;
}

interface GeminiUsageMetadata {
  promptTokenCount:     number;
  candidatesTokenCount: number;
  totalTokenCount:      number;
}

interface GeminiResponse {
  candidates: GeminiCandidate[];
  modelVersion: string;
  usageMetadata: GeminiUsageMetadata;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface GoogleProviderConfig {
  /** Google AI key. Defaults to GOOGLE_API_KEY env var. */
  apiKey?: string;
  /** Default model. Defaults to GOOGLE_MODEL env var or "gemini-1.5-pro". */
  model?: string;
  /** API base URL. Defaults to GOOGLE_BASE_URL env var. */
  baseUrl?: string;
}

/**
 * Gemini's role names differ from OpenAI convention:
 *   "assistant"  →  "model"
 * System prompts are provided via a dedicated `systemInstruction` field.
 */
export class GoogleProvider implements LLMProvider {
  readonly name = 'Google';

  private readonly apiKey:  string;
  private readonly model:   string;
  private readonly baseUrl: string;

  constructor(config: GoogleProviderConfig = {}) {
    this.apiKey  = config.apiKey  ?? requireEnv('GOOGLE_API_KEY');
    this.model   = config.model   ?? optionalEnv('GOOGLE_MODEL',    'gemini-1.5-pro');
    this.baseUrl = config.baseUrl ?? optionalEnv('GOOGLE_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta');
  }

  async complete(request: LLMRequest, onProgress?: ProgressCallback): Promise<LLMResponse> {
    const model = request.model ?? this.model;

    const systemMsg = request.messages.find(m => m.role === 'system');
    const chatMsgs  = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role:  m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const payload: GeminiRequest = { contents: chatMsgs };
    if (systemMsg) {
      payload.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }
    if (request.maxTokens !== undefined || request.temperature !== undefined) {
      payload.generationConfig = {};
      if (request.maxTokens  !== undefined) payload.generationConfig.maxOutputTokens = request.maxTokens;
      if (request.temperature !== undefined) payload.generationConfig.temperature     = request.temperature;
    }

    // Gemini embeds the API key as a query parameter.
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${this.apiKey}`;

    const { statusCode, body } = await httpPost(url, {}, payload);

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Google Gemini API error ${statusCode}: ${body}`);
    }

    const data    = JSON.parse(body) as GeminiResponse;
    const content = data.candidates[0]?.content?.parts?.map(p => p.text).join('') ?? '';

    if (onProgress) onProgress(content);

    return {
      content,
      model: data.modelVersion ?? model,
      usage: {
        promptTokens:     data.usageMetadata.promptTokenCount,
        completionTokens: data.usageMetadata.candidatesTokenCount,
        totalTokens:      data.usageMetadata.totalTokenCount,
      },
    };
  }
}
