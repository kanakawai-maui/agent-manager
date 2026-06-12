/**
 * Unit tests for llm-provider.ts shared utilities:
 *   - httpPost()
 *   - requireEnv()
 *   - optionalEnv()
 */

import * as net from 'net';
import * as http from 'http';
import { httpPost, requireEnv, optionalEnv } from './llm-provider';

// ── requireEnv ────────────────────────────────────────────────────────────────

describe('requireEnv()', () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    // Restore any env vars mutated during tests
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL);
  });

  it('returns the value when the env var is set', () => {
    process.env.TEST_KEY = 'hello';
    expect(requireEnv('TEST_KEY')).toBe('hello');
  });

  it('throws when the env var is absent', () => {
    delete process.env.MISSING_KEY;
    expect(() => requireEnv('MISSING_KEY')).toThrow('MISSING_KEY');
  });

  it('throws when the env var is an empty string', () => {
    process.env.EMPTY_KEY = '';
    expect(() => requireEnv('EMPTY_KEY')).toThrow('EMPTY_KEY');
  });
});

// ── optionalEnv ───────────────────────────────────────────────────────────────

describe('optionalEnv()', () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL);
  });

  it('returns the env var value when set', () => {
    process.env.OPT_KEY = 'world';
    expect(optionalEnv('OPT_KEY', 'fallback')).toBe('world');
  });

  it('returns the default when the env var is absent', () => {
    delete process.env.OPT_KEY_MISSING;
    expect(optionalEnv('OPT_KEY_MISSING', 'fallback')).toBe('fallback');
  });
});

// ── httpPost() ────────────────────────────────────────────────────────────────

describe('httpPost()', () => {
  let server: http.Server;
  let port: number;

  /** Start a tiny HTTP server that echoes body and status on demand. */
  beforeAll(() => new Promise<void>(resolve => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        // Respond with a simple JSON payload mirroring the request
        const responseBody = JSON.stringify({ echo: JSON.parse(body), method: req.method });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as net.AddressInfo).port;
      resolve();
    });
  }));

  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  it('POSTs JSON and returns the status code + body', async () => {
    const url = `http://127.0.0.1:${port}/test`;
    const result = await httpPost(url, { 'X-Test': 'yes' }, { hello: 'world' });
    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.echo).toEqual({ hello: 'world' });
    expect(parsed.method).toBe('POST');
  });

  it('includes custom headers in the request', async () => {
    let capturedHeaders: Record<string, string | string[] | undefined> = {};
    const customServer = http.createServer((req, res) => {
      capturedHeaders = req.headers as Record<string, string | string[] | undefined>;
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => { res.writeHead(200); res.end('{}'); });
    });
    await new Promise<void>(r => customServer.listen(0, '127.0.0.1', r));
    const p = (customServer.address() as net.AddressInfo).port;

    await httpPost(`http://127.0.0.1:${p}/`, { Authorization: 'Bearer token123' }, {});
    expect(capturedHeaders['authorization']).toBe('Bearer token123');

    await new Promise<void>(resolve => customServer.close(() => resolve()));
  });

  it('rejects on connection refused', async () => {
    await expect(
      httpPost('http://127.0.0.1:1/unreachable', {}, { x: 1 }),
    ).rejects.toThrow();
  });
});
