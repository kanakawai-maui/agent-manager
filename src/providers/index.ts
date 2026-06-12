/**
 * LLM Providers — barrel export and factory
 *
 * Usage (factory):
 *
 *   import { createProvider } from './providers';
 *
 *   // Auto-selects based on LLM_PROVIDER env var (default: "openai"):
 *   const provider = createProvider();
 *
 *   // Explicit:
 *   const provider = createProvider('anthropic');
 *
 * Usage (direct instantiation):
 *
 *   import { AnthropicProvider } from './providers';
 *   const provider = new AnthropicProvider({ apiKey: '...' });
 *
 * Supported LLM_PROVIDER values:
 *   openai | anthropic | google | ollama | azure-openai | qwen
 */

export type { LLMProvider, LLMRequest, LLMResponse, LLMMessage, LLMUsage, ProgressCallback } from './llm-provider';

export { OpenAIProvider }      from './openai.provider';
export { AnthropicProvider }   from './anthropic.provider';
export { GoogleProvider }      from './google.provider';
export { OllamaProvider }      from './ollama.provider';
export { AzureOpenAIProvider } from './azure-openai.provider';
export { QwenProvider }        from './qwen.provider';
export { OpenRouterProvider }  from './openrouter.provider';
export { DummyProvider }       from './dummy.provider';

export type { OpenAIProviderConfig }      from './openai.provider';
export type { AnthropicProviderConfig }   from './anthropic.provider';
export type { GoogleProviderConfig }      from './google.provider';
export type { OllamaProviderConfig }      from './ollama.provider';
export type { AzureOpenAIProviderConfig } from './azure-openai.provider';
export type { QwenProviderConfig }        from './qwen.provider';
export type { OpenRouterProviderConfig }  from './openrouter.provider';
export type { DummyProviderConfig }       from './dummy.provider';

import type { LLMProvider } from './llm-provider';
import { optionalEnv }      from './llm-provider';
import { OpenAIProvider }      from './openai.provider';
import { AnthropicProvider }   from './anthropic.provider';
import { GoogleProvider }      from './google.provider';
import { OllamaProvider }      from './ollama.provider';
import { AzureOpenAIProvider } from './azure-openai.provider';
import { QwenProvider }        from './qwen.provider';
import { OpenRouterProvider }  from './openrouter.provider';
import { DummyProvider }       from './dummy.provider';
export type ProviderName = 'openai' | 'anthropic' | 'google' | 'ollama' | 'azure-openai' | 'qwen' | 'openrouter' | 'dummy';

/**
 * Instantiate the provider identified by `name` (or the LLM_PROVIDER
 * environment variable when `name` is omitted).
 *
 * Each provider reads its own environment variables for API keys and
 * endpoints — see the individual provider files for details.
 *
 * @throws if the provider name is unrecognised
 */
export function createProvider(name?: ProviderName | string): LLMProvider {
  const resolved = (name ?? optionalEnv('LLM_PROVIDER', 'openai')).toLowerCase();

  switch (resolved) {
    case 'openai':       return new OpenAIProvider();
    case 'anthropic':    return new AnthropicProvider();
    case 'google':       return new GoogleProvider();
    case 'ollama':       return new OllamaProvider();
    case 'azure-openai': return new AzureOpenAIProvider();
    case 'qwen':         return new QwenProvider();
    case 'openrouter':   return new OpenRouterProvider();
    case 'dummy':        return new DummyProvider();
    default:
      throw new Error(
        `Unknown LLM provider: "${resolved}". ` +
        `Valid options: openai, anthropic, google, ollama, azure-openai, qwen, openrouter, dummy`,
      );
  }
}
