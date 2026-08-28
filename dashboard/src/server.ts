import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { loadConfig, type DashboardConfig } from './config.js';
import { aggregate, applyFilters, readJsonl, toCsv, type UnifiedEntry } from './stats.js';

export interface DashboardApp {
  app: express.Express;
  config: DashboardConfig;
  /** Combined, newest-first view of both log streams. */
  readAll(): { entries: UnifiedEntry[]; meta: unknown[] };
}

export function buildApp(config: DashboardConfig = loadConfig()): DashboardApp {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const parseFilters = (query: Record<string, unknown>) => ({
    session: (query.session as string) || null,
    cache: (query.cache as string) || null,
    source: (query.source as string) || null,
    mode: (query.mode as string) || null,
    q: (query.q as string) || null,
    from: (query.from as string) || null,
    to: (query.to as string) || null,
  });

  function readAll(): { entries: UnifiedEntry[]; meta: unknown[] } {
    const gw = readJsonl(config.gatewayLog, 'gateway');
    const base = readJsonl(config.baseLog, 'base');
    const entries = [...gw.entries, ...base.entries].sort((a, b) =>
      (b.ts || '').localeCompare(a.ts || ''),
    );
    return { entries, meta: [gw.meta, base.meta] };
  }

  // ── Static UI ────────────────────────────────────────────────────────────────
  app.use(express.static(config.publicDir));

  // ── Health ───────────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'clair-dashboard', generatedAt: new Date().toISOString() });
  });

  // ── Single consolidated data endpoint (stats + table rows + file meta) ──────
  app.get('/api/data', (req, res) => {
    const limit = Math.min(5000, Math.max(1, Number.parseInt((req.query.limit as string) ?? '100', 10) || 100));
    const { entries, meta } = readAll();
    const filtered = applyFilters(entries, parseFilters(req.query as Record<string, string>));
    res.json({
      stats: aggregate(entries),
      entries: filtered.slice(0, limit),
      matched: filtered.length,
      files: meta,
      filters: parseFilters(req.query as Record<string, string>),
    });
  });

  // ── Exports (respect the same filters) ───────────────────────────────────────
  app.get('/api/export.csv', (req, res) => {
    const { entries } = readAll();
    const filtered = applyFilters(entries, parseFilters(req.query as Record<string, string>));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="clair-pro-export.csv"');
    res.send(toCsv(filtered));
  });

  app.get('/api/export.json', (req, res) => {
    const { entries } = readAll();
    const filtered = applyFilters(entries, parseFilters(req.query as Record<string, string>));
    res.setHeader('content-disposition', 'attachment; filename="clair-pro-export.json"');
    res.json({ exportedAt: new Date().toISOString(), count: filtered.length, entries: filtered });
  });

  // ── SSE: pushes "update" whenever either log file grows ─────────────────────
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    let lastSig = '';
    const poll = () => {
      try {
        const sig = [config.gatewayLog, config.baseLog]
          .map((f) => {
            try {
              const s = fs.statSync(f);
              return `${s.size}:${s.mtimeMs}`;
            } catch {
              return 'absent';
            }
          })
          .join('|');
        if (lastSig && sig !== lastSig) res.write(`event: update\ndata: ${Date.now()}\n\n`);
        lastSig = sig;
      } catch {
        /* polling must never kill the stream */
      }
    };
    const timer = setInterval(poll, 2000);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => {
      clearInterval(timer);
      clearInterval(keepalive);
    });
  });

  // ── Test request: UI → dashboard → Gateway → CLAIR → LLM ────────────────────
  app.post('/api/test-request', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) {
      res.status(400).json({ ok: false, error: 'Field "text" is required' });
      return;
    }
    const startedAt = Date.now();
    const payload = {
      model: typeof body.model === 'string' && body.model ? body.model : 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: text },
      ],
      stream: false,
    };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      const upstream = await fetch(`${config.gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const json = (await upstream.json()) as Record<string, unknown>;

      // Best effort: attach the freshest gateway log row produced by this call.
      let metrics: unknown = null;
      try {
        const { entries } = readAll();
        metrics =
          entries.find(
            (e) => e.source === 'gateway' && e.ts && Date.parse(e.ts) >= startedAt - 1000,
          ) ?? null;
      } catch {
        /* metrics are optional */
      }
      res.status(upstream.status).json({ ok: upstream.ok, status: upstream.status, gateway: json, metrics });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: `Gateway unreachable at ${config.gatewayUrl}: ${String((err as Error).message ?? err)}`,
      });
    }
  });

  // ── SPA-ish fallback for unknown GETs → root page ────────────────────────────
  app.get(/^\/(?!api\/|health).*/, (_req, res) => {
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });

  return { app, config, readAll };
}

/** Binds the dashboard to the configured port. Returns the HTTP server. */
export function start(config: DashboardConfig = loadConfig()): Promise<Server> {
  const { app } = buildApp(config);
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, () => resolve(server));
    server.on('error', reject);
  });
}

// Direct execution: node/tsx dashboard/src/server.ts
const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) {
  const cfg = loadConfig();
  start(cfg).then(() => {
    console.log(`[clair-dashboard] listening on http://127.0.0.1:${cfg.port}`);
    console.log(`[clair-dashboard] gateway log: ${cfg.gatewayLog}`);
    console.log(`[clair-dashboard] base log:     ${cfg.baseLog}`);
  });
}
