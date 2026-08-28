import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { buildApp, type DashboardApp } from '../dashboard/src/server.js';
import type { DashboardConfig } from '../dashboard/src/config.js';

let tmp: string;
let gwLog: string;
let baseLog: string;
let ctx: DashboardApp;

// ── Fixtures ──────────────────────────────────────────────────────────────────
const GW_HIT = {
  timestamp: '2026-06-12T06:20:54.361Z',
  session: 'ChatGPT',
  request_id: 'r1',
  route: 'chat_completions',
  model: 'gpt-4o-mini',
  compression_enabled: true,
  stream: false,
  original_tokens: 100,
  compressed_tokens: 60,
  saved_tokens: 40,
  compression_ratio: 1.67,
  cache_hits: 1,
  cache_misses: 0,
  llm_response_tokens: 25,
  latency_ms: 120,
  status: 200,
  note: null,
};
const GW_PARTIAL = {
  ...GW_HIT,
  timestamp: '2026-06-12T06:21:30.000Z',
  request_id: 'r2',
  session: 'DeepSeek',
  model: 'deepseek-chat',
  original_tokens: 200,
  compressed_tokens: 160,
  saved_tokens: 40,
  compression_ratio: 1.25,
  cache_hits: 1,
  cache_misses: 1,
  latency_ms: 340,
};
const GW_BYPASS = {
  ...GW_HIT,
  timestamp: '2026-06-12T07:10:00.000Z',
  request_id: 'r3',
  model: 'gpt-4o',
  compression_enabled: false,
  original_tokens: 50,
  compressed_tokens: 50,
  saved_tokens: 0,
  compression_ratio: 1,
  cache_hits: 0,
  cache_misses: 0,
  latency_ms: 20,
  note: 'compression_disabled_by_header',
};
const BASE_ROW = {
  timestamp: '2026-06-12T06:20:54.400Z',
  session: 'Qwen',
  mode: 'high',
  input_tokens: 40,
  output_tokens: 20,
  tokens_saved: 20,
  compression_ratio: 2,
};
const BASE_ROW2 = {
  ...BASE_ROW,
  timestamp: '2026-06-12T08:00:00.000Z',
  session: 'ChatGPT',
  mode: 'low',
  input_tokens: 10,
  output_tokens: 10,
  tokens_saved: 0,
  compression_ratio: 1,
};

function writeJsonl(file: string, rows: object[]): void {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function makeConfig(overrides: Partial<DashboardConfig> = {}): DashboardConfig {
  return {
    port: 0,
    gatewayLog: gwLog,
    baseLog,
    gatewayUrl: 'http://127.0.0.1:1', // never used in most tests
    publicDir: path.resolve('dashboard/src/public'),
    ...overrides,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clair-dash-'));
  gwLog = path.join(tmp, 'gateway.jsonl');
  baseLog = path.join(tmp, 'clair_pilot.log.jsonl');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Health & static ───────────────────────────────────────────────────────────
describe('GET /health', () => {
  it('reports ok', async () => {
    ctx = buildApp(makeConfig());
    const res = await request(ctx.app).get('/health');
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('clair-dashboard');
  });
});

// ── /api/data ─────────────────────────────────────────────────────────────────
describe('GET /api/data', () => {
  it('tolerates missing log files', async () => {
    ctx = buildApp(makeConfig());
    const res = await request(ctx.app).get('/api/data');
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body.stats.totals.requests).toBe(0);
    expect(body.entries).toEqual([]);
    for (const f of body.files) {
      expect(f.exists).toBe(false);
      expect(f.lines).toBe(0);
    }
  });

  it('unifies gateway + base streams with correct aggregates', async () => {
    writeJsonl(gwLog, [GW_HIT, GW_PARTIAL, GW_BYPASS]);
    writeJsonl(baseLog, [BASE_ROW, BASE_ROW2]);
    ctx = buildApp(makeConfig());
    const res = await request(ctx.app).get('/api/data');
    const body = res.body;

    // totals across both streams
    expect(body.stats.totals.requests).toBe(5);
    // original: 100+200+50+40+10=400, compressed: 60+160+50+20+10=300 → saved 100
    expect(body.stats.totals.originalTokens).toBe(400);
    expect(body.stats.totals.compressedTokens).toBe(300);
    expect(body.stats.totals.savedTokens).toBe(100);
    expect(body.stats.totals.avgRatio).toBeCloseTo(400 / 300, 3);

    // newest first
    expect(body.entries[0].ts).toBe('2026-06-12T08:00:00.000Z');

    // cache doughnut: only gateway rows count
    expect(body.stats.cache).toEqual({ HIT: 1, PARTIAL: 1, MISS: 0, BYPASS: 1, none: 2 });

    // latency only from gateway
    expect(body.stats.latency.samples).toBe(3);
    expect(body.stats.latency.avg).toBe(Math.round((120 + 340 + 20) / 3));
    expect(body.stats.latency.p95).toBe(340);

    // sessions merged from both logs
    const names = body.stats.bySession.map((b: { key: string }) => b.key).sort();
    expect(names).toEqual(['ChatGPT', 'DeepSeek', 'Qwen']);

    // modes only from base log
    expect(body.stats.byMode.map((b: { key: string }) => b.key)).toEqual(['high', 'low']);
  });

  it('counts corrupted lines but never crashes', async () => {
    fs.writeFileSync(gwLog, '{"timestamp":"2026-06-12T06:00:00.000Z","session":"s","original_tokens":5,"compressed_tokens":4,"saved_tokens":1,"compression_ratio":1.25,"latency_ms":10}\nnot-json-at-all\n\n', 'utf8');
    ctx = buildApp(makeConfig());
    const res = await request(ctx.app).get('/api/data');
    const body = res.body;
    expect(body.stats.totals.requests).toBe(1);
    const gwFile = body.files.find((f: { path: string }) => f.path === gwLog);
    expect(gwFile.corruptedLines).toBe(1);
    expect(gwFile.lines).toBe(2);
  });
});

// ── Filters ───────────────────────────────────────────────────────────────────
describe('filters', () => {
  beforeEach(() => {
    writeJsonl(gwLog, [GW_HIT, GW_PARTIAL, GW_BYPASS]);
    writeJsonl(baseLog, [BASE_ROW, BASE_ROW2]);
    ctx = buildApp(makeConfig());
  });

  it('by session (BYPASS row shares the session)', async () => {
    const res = await request(ctx.app).get('/api/data?session=ChatGPT');
    const body = res.body;
    expect(body.matched).toBe(3); // GW_HIT + GW_BYPASS + BASE_ROW2
    for (const e of body.entries) expect(e.session).toBe('ChatGPT');
  });

  it('by cache state (PARTIAL derived from counters)', async () => {
    const res = await request(ctx.app).get('/api/data?cache=PARTIAL');
    const body = res.body;
    expect(body.matched).toBe(1);
    expect(body.entries[0].request_id ?? body.entries[0].model).toBe('deepseek-chat');
  });

  it('by source', async () => {
    const res = await request(ctx.app).get('/api/data?source=base');
    const body = res.body;
    expect(body.matched).toBe(2);
    expect(body.entries.every((e: { source: string }) => e.source === 'base')).toBe(true);
  });

  it('by free-text q over model/session/note', async () => {
    const res = await request(ctx.app).get('/api/data?q=deepseek');
    expect(res.body.matched).toBe(1);
  });

  it('limit is respected', async () => {
    const res = await request(ctx.app).get('/api/data?limit=2');
    expect(res.body.entries.length).toBe(2);
  });
});

// ── Exports ───────────────────────────────────────────────────────────────────
describe('exports', () => {
  beforeEach(() => {
    writeJsonl(gwLog, [GW_HIT, GW_BYPASS]);
    writeJsonl(baseLog, [BASE_ROW]);
    ctx = buildApp(makeConfig());
  });

  it('csv contains BOM, header and rows, honoring filters', async () => {
    const all = await request(ctx.app).get('/api/export.csv');
    expect(all.statusCode).toBe(200);
    expect(all.headers['content-type']).toContain('text/csv');
    const text = all.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('timestamp,source,session,model,mode,original_tokens');
    expect(text.split('\n').filter((l) => l.trim()).length).toBe(4); // header + 3 rows

    const filtered = await request(ctx.app).get('/api/export.csv?session=Qwen');
    expect(filtered.text.split('\n').filter((l) => l.trim()).length).toBe(2); // header + 1 row
    expect(filtered.text).toContain('Qwen');
  });

  it('json export wraps entries with metadata', async () => {
    const res = await request(ctx.app).get('/api/export.json');
    const body = res.body;
    expect(body.count).toBe(3);
    expect(body.entries).toHaveLength(3);
    expect(body.exportedAt).toBeTruthy();
  });
});

// ── Test-request proxy ────────────────────────────────────────────────────────
describe('POST /api/test-request', () => {
  it('proxies to the gateway and attaches fresh log metrics', async () => {
    // Fake upstream "Gateway" that records the last request and answers OpenAI-style.
    let seenBody: unknown = null;
    const upstream = express();
    upstream.use(express.json());
    upstream.post('/v1/chat/completions', (req, res) => {
      seenBody = req.body;
      res.json({ choices: [{ message: { role: 'assistant', content: 'ok from fake gateway' } }] });
    });
    const server = http.createServer(upstream);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    writeJsonl(gwLog, [{ ...GW_HIT, timestamp: new Date(Date.now() - 500).toISOString() }]); // "just happened"
    ctx = buildApp(makeConfig({ gatewayUrl: `http://127.0.0.1:${port}` }));

    const res = await request(ctx.app)
      .post('/api/test-request')
      .send({ text: 'Привет, сожми меня', model: 'gpt-4o-mini' });
    const body = res.body;

    expect(seenBody).toMatchObject({ model: 'gpt-4o-mini' });
    expect(body.ok).toBe(true);
    expect(body.gateway.choices[0].message.content).toBe('ok from fake gateway');
    // metrics attached (the pre-existing GW_HIT row is the newest on the log)
    expect(body.metrics).not.toBeNull();
    expect(body.metrics.saved).toBe(40);

    await new Promise<void>((r) => server.close(() => r()));
  });

  it('rejects empty text with 400', async () => {
    ctx = buildApp(makeConfig());
    const res = await request(ctx.app).post('/api/test-request').send({ text: '   ' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 502 when the gateway is unreachable', async () => {
    ctx = buildApp(makeConfig({ gatewayUrl: 'http://127.0.0.1:9' }));
    const res = await request(ctx.app).post('/api/test-request').send({ text: 'x' });
    expect(res.statusCode).toBe(502);
    expect(res.body.ok).toBe(false);
  });
});
