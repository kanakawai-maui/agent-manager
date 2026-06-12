/**
 * Agent Worker Process
 *
 * Runs as a forked child process. Receives a task assignment via IPC,
 * executes it, and streams progress + final result back to the orchestrator.
 *
 * Task types (determined by prefix):
 *   sh: <cmd>        — Execute a shell command
 *   fetch: <url>     — HTTP GET a URL
 *   script: <path>   — Run a local JS/TS file with node
 *   <anything else>  — Routed through the LLM provider (LLM_PROVIDER env var)
 *                      Falls back to a built-in stub when no provider is set.
 */
import { exec }                         from 'child_process';
import * as https                        from 'https';
import * as http                         from 'http';
import * as fs                           from 'fs';
import type { ToWorkerMessage, FromWorkerMessage } from './types';
import { createProvider, OpenAIProvider, AnthropicProvider, OpenRouterProvider, AzureOpenAIProvider } from './providers';
import type { LLMProvider } from './providers';
import { getDefaultConfig } from './provider-config';

// ── Helpers ───────────────────────────────────────────────────────────────────

const send  = (msg: FromWorkerMessage) => process.send!(msg);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function emitProgress(apid: string, data: string) {
  send({ type: 'progress', apid, data });
}

// ── Task runners ──────────────────────────────────────────────────────────────

async function runShell(apid: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    emitProgress(apid, `$ ${cmd}`);
    exec(cmd, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (stderr.trim()) emitProgress(apid, `[stderr] ${stderr.trim()}`);
      if (err) { reject(new Error(stderr.trim() || err.message)); return; }
      resolve(stdout.trimEnd() || '(no output)');
    });
  });
}

async function runFetch(apid: string, rawUrl: string): Promise<string> {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  return new Promise((resolve, reject) => {
    emitProgress(apid, `GET ${url}`);
    const mod = url.toLowerCase().startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 10_000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        const preview = body.length > 1000 ? body.slice(0, 1000) + '\n…[truncated]' : body;
        resolve(`HTTP ${res.statusCode} ${res.statusMessage}\n\n${preview}`);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

async function runScript(apid: string, scriptPath: string): Promise<string> {
  const resolved = scriptPath.startsWith('/') ? scriptPath : scriptPath;
  if (!fs.existsSync(resolved)) {
    throw new Error(`Script not found: ${resolved}`);
  }
  return runShell(apid, `node "${resolved}"`);
}

/** Request the orchestrator to spawn a sub-agent under this agent. */
function spawnSubAgent(parentApid: string, task: string): void {
  send({ type: 'spawn', parentApid, task });
}

/** Routes task to the configured LLM provider (or the built-in stub). */
async function runGeneric(apid: string, task: string): Promise<string> {
  // First, try to load provider configuration from the UI-configured settings
  let provider: LLMProvider | null = null;
  
  try {
    const config = getDefaultConfig();
    if (config) {
      // Create provider instance with stored configuration
      switch (config.provider) {
        case 'openai':
          provider = new OpenAIProvider({
            apiKey: config.apiKey,
            model: config.model,
            baseUrl: config.baseUrl,
          });
          break;
        case 'openrouter':
          provider = new OpenRouterProvider({
            apiKey: config.apiKey,
            model: config.model,
            baseUrl: config.baseUrl,
          });
          break;
        case 'anthropic':
          provider = new AnthropicProvider({
            apiKey: config.apiKey,
            model: config.model,
            baseUrl: config.baseUrl,
          });
          break;
        case 'azure-openai':
          provider = new AzureOpenAIProvider({
            apiKey: config.apiKey,
            endpoint: config.baseUrl, // baseUrl is used as endpoint for Azure
            deployment: config.model, // model is used as deployment for Azure
          });
          break;
      }
      
      if (provider) {
        emitProgress(apid, `Using provider: ${config.name} (${config.provider})`);
      }
    }
  } catch (err) {
    // Failed to load config, will fall back to environment variables
    emitProgress(apid, 'No UI-configured provider found, checking environment variables...');
  }

  // Fall back to environment variables if no UI config found
  if (!provider) {
    const providerName = process.env['LLM_PROVIDER'];
    if (providerName) {
      provider = createProvider(providerName);
    }
  }

  if (provider) {
    const result = await provider.complete(
      { messages: [{ role: 'user', content: task }], model: process.env['LLM_MODEL'] },
      (chunk) => emitProgress(apid, chunk),
    );
    const usage = result.usage
      ? `  tokens: ${result.usage.promptTokens}p + ${result.usage.completionTokens}c = ${result.usage.totalTokens}`
      : '';
    return [result.content, usage].filter(Boolean).join('\n');
  }

  // ── Built-in stub with automatic sub-agent spawning ────────────────────────
  // Determine depth by counting "for:" occurrences - limit to 2 levels
  const depth = (task.match(/for:/g) || []).length;
  const maxDepth = 2;
  const canDelegate = depth < maxDepth;
  const shouldDelegate = canDelegate && Math.random() < 0.6; // 60% chance to delegate
  const subTaskCount = shouldDelegate ? Math.floor(Math.random() * 3) + 1 : 0; // 1-3 sub-tasks

  const steps = [
    'Parsing task requirements…',
    'Analyzing complexity…',
  ];

  for (const step of steps) {
    emitProgress(apid, step);
    await sleep(100 + Math.random() * 200);
  }

  // Spawn sub-agents if delegating
  if (subTaskCount > 0) {
    emitProgress(apid, `Goal: Achieve consensus from ${subTaskCount} sub-agent(s)…`);
    const subTasks = [
      'Research background context',
      'Analyze data patterns',
      'Validate assumptions',
      'Generate recommendations',
      'Compile findings',
      'Review constraints',
    ];
    for (let i = 0; i < subTaskCount; i++) {
      const subTask = subTasks[Math.floor(Math.random() * subTasks.length)];
      spawnSubAgent(apid, `${subTask} for: ${task.slice(0, 30)}`);
      await sleep(50);
    }
  }

  // Continue with own work
  const moreSteps = subTaskCount > 0
    ? [
        'Awaiting sub-agent responses…',
        'Aggregating findings…',
        'Building consensus from results…',
      ]
    : [
        'Processing primary objective…',
        'Synthesizing results…',
      ];
  for (const step of moreSteps) {
    emitProgress(apid, step);
    await sleep(150 + Math.random() * 300);
  }

  return [
    `Task  : ${task}`,
    `Status: Completed (simulated)`,
    subTaskCount > 0 ? `Goal: Achieved consensus from ${subTaskCount} sub-agent(s)` : 'No delegation',
  ].join('\n');
}

// ── Main worker loop ──────────────────────────────────────────────────────────

// Signal readiness to the orchestrator.
send({ type: 'ready' });

process.on('message', async (msg: ToWorkerMessage) => {
  if (msg.type === 'kill') {
    process.exit(0);
  }

  if (msg.type !== 'assign') return;

  const { task, apid } = msg;
  const t0 = Date.now();

  send({ type: 'started', apid });

  try {
    let result: string;

    if (/^sh(ell)?:\s*/i.test(task)) {
      result = await runShell(apid, task.replace(/^sh(ell)?:\s*/i, ''));
    } else if (/^(fetch|get|https?):\s*/i.test(task)) {
      result = await runFetch(apid, task.replace(/^(fetch|get|https?):\s*/i, ''));
    } else if (/^script:\s*/i.test(task)) {
      result = await runScript(apid, task.replace(/^script:\s*/i, '').trim());
    } else {
      result = await runGeneric(apid, task);
    }

    send({ type: 'completed', apid, result, durationMs: Date.now() - t0 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: 'failed', apid, error: message, durationMs: Date.now() - t0 });
  }
});
