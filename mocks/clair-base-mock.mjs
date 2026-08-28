// Demo stand-in for the IMMUTABLE CLAIR Base service. Zero dependencies.
//
// Mirrors the real Base contract:
//   GET  /health
//   POST /compress  { text, mode?, session? } → { compressed, original_tokens, compressed_tokens, ... }
// and — unlike the lightweight mock in clair-gateway — also writes
// logs/clair_pilot.log.jsonl in the REAL Base log format:
//
//   {"timestamp":..., "session":..., "mode":..., "input_tokens":...,
//    "output_tokens":..., "tokens_saved":..., "compression_ratio":...}
//
// This lets the Visual Dashboard show both log streams during offline demos.
// The real CLAIR Base is untouched; this file lives outside c:\Clair_pilot\.
//
//   node mocks/clair-base-mock.mjs            # listens on :3000
//   CLAIR_MOCK_PORT=3001 node mocks/clair-base-mock.mjs
//   BASE_LOG_FILE=/tmp/demo.jsonl node mocks/clair-base-mock.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.CLAIR_MOCK_PORT ?? 3000);
const LOG_FILE = process.env.BASE_LOG_FILE ?? path.resolve('logs/clair_pilot.log.jsonl');
const estimateTokens = (text) => Math.max(1, Math.ceil((text ?? '').length / 4));

// Same deterministic pseudo-compression idea as the gateway mock, extended for
// Cyrillic demos: strip vowels (Latin + Russian) + collapse whitespace.
const compress = (text) =>
  (text ?? '').replace(/[aeiouаеёиоуыэюя]/gi, '').replace(/\s+/g, ' ').trim();

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'clair-base-mock' }));
    return;
  }
  if (req.method !== 'POST' || !(req.url ?? '').startsWith('/compress')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found (clair-base-mock serves POST /compress)' }));
    return;
  }
  let data = '';
  req.on('data', (chunk) => {
    data += chunk.toString('utf8');
  });
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(data);
    } catch {
      /* ignore malformed body */
    }
    const text = typeof body.text === 'string' ? body.text : '';
    const mode = typeof body.mode === 'string' ? body.mode : 'medium';
    const session = typeof body.session === 'string' && body.session ? body.session : 'default';

    const compressed = compress(text);
    const inputTokens = estimateTokens(text);
    const outputTokens = estimateTokens(compressed);
    const saved = Math.max(0, inputTokens - outputTokens);
    const ratio = outputTokens > 0 ? inputTokens / outputTokens : 1;

    const record = {
      timestamp: new Date().toISOString(),
      session,
      mode,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      tokens_saved: saved,
      compression_ratio: Number(ratio.toFixed(2)),
    };
    logStream.write(JSON.stringify(record) + '\n');

    const payload = {
      compressed,
      original_tokens: inputTokens,
      compressed_tokens: outputTokens,
      tokens_saved: saved,
      compression_ratio: record.compression_ratio,
      mode,
      session,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    setTimeout(() => res.end(JSON.stringify(payload)), 10);
  });
});

server.listen(PORT, () => {
  console.log(`[clair-base-mock] listening on http://127.0.0.1:${PORT} (POST /compress)`);
  console.log(`[clair-base-mock] base log file: ${LOG_FILE}`);
});

const shutdown = () => {
  logStream.end(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
