/**
 * Agent Manager — Web Dashboard Server
 *
 * Serves a browser-based UI for managing and visualising agent trees in real time.
 *
 * Usage
 * ─────
 *   # Production (after `npm run build`):
 *   node dist/web-server.js [--port 3001] [--concurrency 20]
 *
 *   # Development:
 *   npx ts-node src/web-server.ts
 */

import * as http from 'http';
import * as fs   from 'fs';
import * as path from 'path';
import { AgentTree } from './AgentTree';
import type { AgentRecord } from './types';
import * as providerConfig from './provider-config';
import type { ProviderConfig } from './provider-config';
import { createProvider, OpenAIProvider, AnthropicProvider, OpenRouterProvider, AzureOpenAIProvider } from './providers';

// ── CLI flags ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function intFlag(name: string, fallback: number): number {
  const idx = argv.indexOf(name);
  return idx !== -1 ? (parseInt(argv[idx + 1], 10) || fallback) : fallback;
}

const PORT            = intFlag('--port', 3001);
const CONCURRENCY_CAP = intFlag('--concurrency', 20);

// ── Paths ─────────────────────────────────────────────────────────────────────

// __dirname is agent-manager/src (ts-node) or agent-manager/dist (compiled).
// Both are one level below agent-manager/, so public/ is always at '../public'.
const WORKER_EXT  = path.extname(__filename); // '.ts' in dev, '.js' in prod
const WORKER_PATH = path.resolve(__dirname, `worker${WORKER_EXT}`);
const PUBLIC_DIR  = path.resolve(__dirname, '..', 'public');

// ── SSE broadcast ─────────────────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>();

function broadcastSSE(event: string, payload: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch {
      sseClients.delete(res);
    }
  }
}

// ── AgentTree ─────────────────────────────────────────────────────────────────

const tree = new AgentTree({ workerPath: WORKER_PATH, concurrencyLimit: CONCURRENCY_CAP });

function serialize(rec: AgentRecord) {
  return { ...rec, children: [...rec.children] };
}

function currentStats() {
  return {
    total:  tree.totalCount,
    active: tree.activeCount,
    queued: tree.queuedCount,
  };
}

const TREE_EVENTS = [
  'spawned', 'started', 'progress', 'completed',
  'failed',  'killed',  'queued',   'drained',
] as const;

for (const ev of TREE_EVENTS) {
  tree.on(ev, (apid: string, extra?: unknown) => {
    const rec = tree.get(apid);
    broadcastSSE('agent-event', {
      event: ev,
      apid,
      extra,
      agent: rec ? serialize(rec) : null,
      stats: currentStats(),
    });
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

// ── Request router ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const method   = req.method ?? 'GET';
  const url      = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS (local dev convenience)
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {

    // ── SSE stream ────────────────────────────────────────────────────────────
    if (pathname === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(':ping\n\n');
      sseClients.add(res);

      // Send current state immediately so the page can hydrate on connect/reconnect
      res.write(
        `event: init\ndata: ${JSON.stringify({
          agents:           tree.getAll().map(serialize),
          stats:            currentStats(),
          concurrencyLimit: tree.concurrencyLimit,
        })}\n\n`,
      );

      // Heartbeat every 20 s to keep proxies from closing the connection
      const hb = setInterval(() => {
        try { res.write(':ping\n\n'); }
        catch { clearInterval(hb); sseClients.delete(res); }
      }, 20_000);

      req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }

    // ── GET /api/agents ───────────────────────────────────────────────────────
    if (pathname === '/api/agents' && method === 'GET') {
      sendJSON(res, 200, {
        agents:           tree.getAll().map(serialize),
        stats:            currentStats(),
        concurrencyLimit: tree.concurrencyLimit,
      });
      return;
    }

    // ── POST /api/spawn ───────────────────────────────────────────────────────
    if (pathname === '/api/spawn' && method === 'POST') {
      const body = await readBody(req) as { task?: unknown; parentApid?: unknown };
      const task = typeof body.task === 'string' ? body.task.trim() : '';
      if (!task) { sendJSON(res, 400, { error: 'task is required' }); return; }
      const parent = typeof body.parentApid === 'string' ? body.parentApid : undefined;
      const apid = tree.spawn(task, parent);
      sendJSON(res, 200, { apid });
      return;
    }

    // ── POST /api/batch ───────────────────────────────────────────────────────
    if (pathname === '/api/batch' && method === 'POST') {
      const body = await readBody(req) as {
        tasks?: unknown; task?: unknown; count?: unknown; parentApid?: unknown;
      };
      let tasks: string[];

      if (Array.isArray(body.tasks) && body.tasks.length) {
        tasks = (body.tasks as unknown[])
          .filter((t): t is string => typeof t === 'string' && !!t.trim())
          .map(t => t.trim());
      } else if (typeof body.task === 'string' && body.task.trim()) {
        const n = Math.min(Math.max(1, Number(body.count) || 1), 500);
        tasks = Array(n).fill(body.task.trim());
      } else {
        sendJSON(res, 400, { error: 'Provide tasks[] or task + count' }); return;
      }

      if (!tasks.length) { sendJSON(res, 400, { error: 'No valid tasks' }); return; }
      const parent = typeof body.parentApid === 'string' ? body.parentApid : undefined;
      const apids = tree.spawnBatch(tasks, parent);
      sendJSON(res, 200, { apids, count: apids.length });
      return;
    }

    // ── DELETE /api/agents/:apid ──────────────────────────────────────────────
    const killOneMatch = pathname.match(/^\/api\/agents\/([A-Za-z0-9]+)$/);
    if (killOneMatch && method === 'DELETE') {
      if (!tree.get(killOneMatch[1])) { sendJSON(res, 404, { error: 'Agent not found' }); return; }
      const killed = tree.killSubtree(killOneMatch[1]);
      sendJSON(res, 200, { killed });
      return;
    }

    // ── DELETE /api/agents ────────────────────────────────────────────────────
    if (pathname === '/api/agents' && method === 'DELETE') {
      tree.killAll();      // Broadcast a clear-all event so UIs can reset their state
      broadcastSSE('clear-all', { stats: currentStats() });      sendJSON(res, 200, { ok: true });
      return;
    }

    // ── PUT /api/concurrency ──────────────────────────────────────────────────
    if (pathname === '/api/concurrency' && method === 'PUT') {
      const body = await readBody(req) as { limit?: unknown };
      const limit = Number(body.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        sendJSON(res, 400, { error: 'limit must be an integer 1–1000' }); return;
      }
      tree.concurrencyLimit = limit;
      sendJSON(res, 200, { concurrencyLimit: tree.concurrencyLimit });
      return;
    }

    // ── GET /api/agents/:apid ─────────────────────────────────────────────────
    const getOneMatch = pathname.match(/^\/api\/agents\/([A-Za-z0-9]+)$/);
    if (getOneMatch && method === 'GET') {
      const rec = tree.get(getOneMatch[1]);
      if (!rec) { sendJSON(res, 404, { error: 'Agent not found' }); return; }
      sendJSON(res, 200, serialize(rec));
      return;
    }

    // ── Provider Configuration API ────────────────────────────────────────────

    // GET /api/providers — List all available provider types
    if (pathname === '/api/providers' && method === 'GET') {
      sendJSON(res, 200, { providers: providerConfig.getAvailableProviders() });
      return;
    }

    // GET /api/provider-configs — List all configured providers (sanitized)
    if (pathname === '/api/provider-configs' && method === 'GET') {
      sendJSON(res, 200, { configs: providerConfig.getSanitizedConfigs() });
      return;
    }

    // POST /api/provider-configs — Add a new provider configuration
    if (pathname === '/api/provider-configs' && method === 'POST') {
      const body = await readBody(req) as Partial<ProviderConfig>;
      
      if (!body.provider || !body.name) {
        sendJSON(res, 400, { error: 'provider and name are required' });
        return;
      }
      
      // Validate provider type
      const validProviders = providerConfig.getAvailableProviders().map(p => p.name);
      if (!validProviders.includes(body.provider as any)) {
        sendJSON(res, 400, { error: `Invalid provider. Valid options: ${validProviders.join(', ')}` });
        return;
      }
      
      try {
        const newConfig = providerConfig.addConfig({
          provider: body.provider,
          name: body.name,
          apiKey: body.apiKey || '',
          baseUrl: body.baseUrl,
          model: body.model,
          isDefault: body.isDefault || false,
          settings: body.settings,
        });
        
        // Return sanitized version
        const { apiKey, ...sanitized } = newConfig;
        sendJSON(res, 201, { config: sanitized });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJSON(res, 500, { error: msg });
      }
      return;
    }

    // PUT /api/provider-configs/:id — Update a provider configuration
    const updateConfigMatch = pathname.match(/^\/api\/provider-configs\/([^/]+)$/);
    if (updateConfigMatch && method === 'PUT') {
      const id = updateConfigMatch[1];
      const body = await readBody(req) as Partial<ProviderConfig>;
      
      try {
        const updated = providerConfig.updateConfig(id, body);
        const { apiKey, ...sanitized } = updated;
        sendJSON(res, 200, { config: sanitized });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJSON(res, 404, { error: msg });
      }
      return;
    }

    // DELETE /api/provider-configs/:id — Delete a provider configuration
    const deleteConfigMatch = pathname.match(/^\/api\/provider-configs\/([^/]+)$/);
    if (deleteConfigMatch && method === 'DELETE') {
      const id = deleteConfigMatch[1];
      const success = providerConfig.deleteConfig(id);
      
      if (success) {
        sendJSON(res, 200, { ok: true });
      } else {
        sendJSON(res, 404, { error: 'Configuration not found' });
      }
      return;
    }

    // POST /api/provider-configs/:id/test — Test a provider configuration
    const testConfigMatch = pathname.match(/^\/api\/provider-configs\/([^/]+)\/test$/);
    if (testConfigMatch && method === 'POST') {
      const id = testConfigMatch[1];
      const config = providerConfig.getConfigById(id);
      
      if (!config) {
        sendJSON(res, 404, { error: 'Configuration not found' });
        return;
      }
      
      try {
        console.log(`[Test] Testing provider: ${config.provider} (${config.name})`);
        console.log(`[Test] Model: ${config.model || 'default'}`);
        console.log(`[Test] API Key: ${config.apiKey.substring(0, 10)}...`);
        
        // Create a provider instance with this config's API key
        let provider;
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
              endpoint: config.baseUrl,
              deployment: config.model,
            });
            break;
          default:
            throw new Error(`Testing not supported for provider: ${config.provider}`);
        }
        
        console.log(`[Test] Sending test request...`);
        
        // Simple test: try to send a minimal request
        const testResponse = await provider.complete({
          messages: [{ role: 'user', content: 'Say OK' }],
          maxTokens: 10,
        });
        
        console.log(`[Test] Success! Response: ${testResponse.content.substring(0, 50)}`);
        
        sendJSON(res, 200, { 
          success: true, 
          model: testResponse.model,
          response: testResponse.content.substring(0, 100),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Test] Failed: ${msg}`);
        sendJSON(res, 500, { success: false, error: msg });
      }
      return;
    }

    // ── Static file serving ───────────────────────────────────────────────────
    // Resolve path and guard against directory traversal
    const rel      = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const filePath = path.resolve(PUBLIC_DIR, rel);

    if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
      sendJSON(res, 403, { error: 'Forbidden' }); return;
    }

    const target = fs.existsSync(filePath) ? filePath : path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(target)) { sendJSON(res, 404, { error: 'Not found' }); return; }

    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    sendJSON(res, 500, { error: msg });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log(  '  ║     Agent Manager  —  Web Dashboard     ║');
  console.log(  '  ╚══════════════════════════════════════════╝');
  console.log(`\n  Open:  http://localhost:${PORT}`);
  console.log(`\n  concurrency cap : ${tree.concurrencyLimit}`);
  console.log(`  worker path     : ${WORKER_PATH}`);
  console.log('\n  Press Ctrl+C to stop\n');
});

process.on('SIGINT', () => {
  tree.killAll();
  server.close(() => process.exit(0));
});
