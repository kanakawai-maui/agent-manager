/**
 * Core interface and shared types for all LLM provider implementations.
 *
 * All providers implement LLMProvider and use the same request/response
 * shapes so the worker can swap providers without any other changes.
 */

// ── Request / Response types ──────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
  role: MessageRole;
  content: string;
}

export interface LLMRequest {
  /** Ordered conversation history. */
  messages: LLMMessage[];
  /**
   * Override the provider's default model.
   * e.g. "gpt-4o", "claude-3-5-sonnet-20241022", "gemini-1.5-pro"
   */
  model?: string;
  /** Maximum tokens to generate in the response. */
  maxTokens?: number;
  /** Sampling temperature in [0, 2]. Lower = more deterministic. */
  temperature?: number;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  /** The assistant's reply text. */
  content: string;
  /** Resolved model identifier returned by the API. */
  model: string;
  /** Token counts (may be undefined if the provider doesn't report them). */
  usage?: LLMUsage;
}

/** Called incrementally with streamed text chunks when streaming is active. */
export type ProgressCallback = (chunk: string) => void;

// ── Provider contract ─────────────────────────────────────────────────────────

export interface LLMProvider {
  /** Human-readable provider name, e.g. "OpenAI". */
  readonly name: string;
  /**
   * Send a completion request and return the full response.
   * @param request       Prompt + model parameters.
   * @param onProgress    Optional callback invoked with each streamed chunk.
   */
  complete(request: LLMRequest, onProgress?: ProgressCallback): Promise<LLMResponse>;
}

// ── Shared HTTP helper ────────────────────────────────────────────────────────

import * as https from 'https';
import * as http  from 'http';

export interface HttpResponse {
  statusCode: number;
  body: string;
}

/**
 * Minimal JSON-over-HTTPS POST used by all providers.
 * Avoids any runtime SDK dependency; relies only on Node's built-in modules.
 */
export function httpPost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed  = new URL(url);
    const mod     = parsed.protocol === 'https:' ? https : http;

    const options: http.RequestOptions = {
      method:   'POST',
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    };

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
    });

    req.on('error', reject);
    req.setTimeout(120_000, () => {
      req.destroy();
      reject(new Error('LLM request timed out after 120 s'));
    });

    req.write(payload);
    req.end();
  });
}

// ── Configuration helpers ─────────────────────────────────────────────────────

/** Read a required environment variable; throw if absent. */
export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

/** Read an optional environment variable with a fallback default. */
export function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}
