/**
 * Unit tests for providers/index.ts — the createProvider() factory.
 *
 * We mock the individual provider constructors so this test never
 * makes real HTTP requests.
 */

import { createProvider } from './index';

// ── Spy on each provider constructor ─────────────────────────────────────────

jest.mock('./openai.provider',      () => ({ OpenAIProvider:      jest.fn().mockImplementation(() => ({ name: 'OpenAI' })) }));
jest.mock('./anthropic.provider',   () => ({ AnthropicProvider:   jest.fn().mockImplementation(() => ({ name: 'Anthropic' })) }));
jest.mock('./google.provider',      () => ({ GoogleProvider:      jest.fn().mockImplementation(() => ({ name: 'Google' })) }));
jest.mock('./ollama.provider',      () => ({ OllamaProvider:      jest.fn().mockImplementation(() => ({ name: 'Ollama' })) }));
jest.mock('./azure-openai.provider',() => ({ AzureOpenAIProvider: jest.fn().mockImplementation(() => ({ name: 'AzureOpenAI' })) }));
jest.mock('./qwen.provider',        () => ({ QwenProvider:        jest.fn().mockImplementation(() => ({ name: 'Qwen' })) }));

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  // Restore env mutations
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createProvider()', () => {
  it('creates OpenAI provider by explicit name', () => {
    const p = createProvider('openai');
    expect(p.name).toBe('OpenAI');
  });

  it('creates Anthropic provider by explicit name', () => {
    const p = createProvider('anthropic');
    expect(p.name).toBe('Anthropic');
  });

  it('creates Google provider by explicit name', () => {
    const p = createProvider('google');
    expect(p.name).toBe('Google');
  });

  it('creates Ollama provider by explicit name', () => {
    const p = createProvider('ollama');
    expect(p.name).toBe('Ollama');
  });

  it('creates Azure OpenAI provider by explicit name', () => {
    const p = createProvider('azure-openai');
    expect(p.name).toBe('AzureOpenAI');
  });

  it('creates Qwen provider by explicit name', () => {
    const p = createProvider('qwen');
    expect(p.name).toBe('Qwen');
  });

  it('defaults to OpenAI when no name is given and LLM_PROVIDER is unset', () => {
    delete process.env.LLM_PROVIDER;
    const p = createProvider();
    expect(p.name).toBe('OpenAI');
  });

  it('uses LLM_PROVIDER env var when no name is given', () => {
    process.env.LLM_PROVIDER = 'anthropic';
    const p = createProvider();
    expect(p.name).toBe('Anthropic');
  });

  it('is case-insensitive', () => {
    const p = createProvider('GOOGLE' as any);
    expect(p.name).toBe('Google');
  });

  it('throws for an unrecognised provider name', () => {
    expect(() => createProvider('fakeai' as any)).toThrow('fakeai');
  });
});
