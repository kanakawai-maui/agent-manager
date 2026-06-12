/**
 * Provider Configuration Management
 *
 * Handles storing and retrieving LLM provider configurations including API keys.
 * Configurations are stored in a local JSON file with sensitive data.
 *
 * Security note: In production, consider using environment variables or
 * a secure secrets manager instead of storing API keys in a file.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProviderName } from './providers';

export interface ProviderConfig {
  /** Unique identifier for this configuration */
  id: string;
  /** Provider type (openai, anthropic, etc.) */
  provider: ProviderName;
  /** Human-readable name for this configuration */
  name: string;
  /** API key or authentication token */
  apiKey: string;
  /** Optional custom base URL/endpoint */
  baseUrl?: string;
  /** Default model to use with this provider */
  model?: string;
  /** Whether this is the active/default provider */
  isDefault: boolean;
  /** Additional provider-specific settings */
  settings?: Record<string, unknown>;
  /** Timestamp when created */
  createdAt: number;
  /** Timestamp when last updated */
  updatedAt: number;
}

export interface ProviderConfigStore {
  version: string;
  configs: ProviderConfig[];
}

// Configuration file path (in the project root by default)
const CONFIG_FILE = path.resolve(__dirname, '..', 'provider-configs.json');

/**
 * Load all provider configurations from disk.
 */
export function loadConfigs(): ProviderConfig[] {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const store: ProviderConfigStore = JSON.parse(raw);
    return store.configs || [];
  } catch (err) {
    console.error('Failed to load provider configs:', err);
    return [];
  }
}

/**
 * Save provider configurations to disk.
 */
export function saveConfigs(configs: ProviderConfig[]): void {
  try {
    const store: ProviderConfigStore = {
      version: '1.0',
      configs,
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save provider configs:', err);
    throw new Error('Failed to save configurations');
  }
}

/**
 * Get a single configuration by ID.
 */
export function getConfigById(id: string): ProviderConfig | undefined {
  const configs = loadConfigs();
  return configs.find(c => c.id === id);
}

/**
 * Add a new provider configuration.
 */
export function addConfig(config: Omit<ProviderConfig, 'id' | 'createdAt' | 'updatedAt'>): ProviderConfig {
  const configs = loadConfigs();
  
  // Generate unique ID
  const id = `provider-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // If this is set as default, unset other defaults
  if (config.isDefault) {
    configs.forEach(c => { c.isDefault = false; });
  }
  
  const newConfig: ProviderConfig = {
    ...config,
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  
  configs.push(newConfig);
  saveConfigs(configs);
  
  return newConfig;
}

/**
 * Update an existing provider configuration.
 */
export function updateConfig(id: string, updates: Partial<Omit<ProviderConfig, 'id' | 'createdAt'>>): ProviderConfig {
  const configs = loadConfigs();
  const index = configs.findIndex(c => c.id === id);
  
  if (index === -1) {
    throw new Error(`Configuration not found: ${id}`);
  }
  
  // If setting as default, unset other defaults
  if (updates.isDefault) {
    configs.forEach(c => { c.isDefault = false; });
  }
  
  const updated: ProviderConfig = {
    ...configs[index],
    ...updates,
    id, // Preserve ID
    createdAt: configs[index].createdAt, // Preserve creation time
    updatedAt: Date.now(),
  };
  
  configs[index] = updated;
  saveConfigs(configs);
  
  return updated;
}

/**
 * Delete a provider configuration.
 */
export function deleteConfig(id: string): boolean {
  const configs = loadConfigs();
  const index = configs.findIndex(c => c.id === id);
  
  if (index === -1) {
    return false;
  }
  
  configs.splice(index, 1);
  saveConfigs(configs);
  
  return true;
}

/**
 * Get the default provider configuration.
 */
export function getDefaultConfig(): ProviderConfig | undefined {
  const configs = loadConfigs();
  return configs.find(c => c.isDefault);
}

/**
 * Get sanitized configs (with masked API keys) for sending to the client.
 */
export function getSanitizedConfigs(): Omit<ProviderConfig, 'apiKey'>[] {
  const configs = loadConfigs();
  return configs.map(c => {
    const { apiKey, ...rest } = c;
    return {
      ...rest,
      apiKeyPreview: apiKey ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : '',
    };
  });
}

/**
 * List all available provider types.
 */
export function getAvailableProviders(): Array<{ name: ProviderName; label: string; requiresApiKey: boolean }> {
  return [
    { name: 'openrouter', label: 'OpenRouter', requiresApiKey: true },
    { name: 'openai', label: 'OpenAI', requiresApiKey: true },
    { name: 'azure-openai', label: 'Azure OpenAI', requiresApiKey: true },
    { name: 'anthropic', label: 'Anthropic (Claude)', requiresApiKey: true },
    { name: 'google', label: 'Google (Gemini)', requiresApiKey: true },
    { name: 'qwen', label: 'Qwen', requiresApiKey: true },
    { name: 'ollama', label: 'Ollama (Local)', requiresApiKey: false },
    { name: 'dummy', label: 'Dummy (Testing)', requiresApiKey: false },
  ];
}
