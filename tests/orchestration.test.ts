import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end orchestration test.
 *
 * Boots the FULL product via launcher.js --demo on isolated ports:
 *   mock Base :13000 → Gateway :18080 → Dashboard :14000 (+ mock LLM :14100)
 * then verifies the acceptance criteria from the spec:
 *   1. one command starts every service,
 *   2. all three services answer /health,
 *   3. a real test request flows through Gateway (compression + cache) into the mock LLM,
 *   4. the dashboard API serves metrics from BOTH logs,
 *   5. Ctrl+C (SIGINT) shuts everything down without orphans.
 */

const BASE_PORT = 13000;
const GATEWAY_PORT = 18080;
const DASHBOARD_PORT = 14000;
const LLM_MOCK_PORT = 14100;

const health = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });

const waitUntil = async (cond: () => Promise<boolean>, timeoutMs: number, what: string) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timeout waiting for: ${what}`);
};

const getJson = <T>(port: number, url: string): Promise<{ status: number; body: T }> =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: url, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as T });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });

const postJson = (port: number, url: string, body: unknown): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 15000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });

let launcher: ChildProcess;
let tmpDir: string;
let gwLog: string;
let baseLog: string;
let launcherOut = '';

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clair-e2e-'));
  gwLog = path.join(tmpDir, 'gateway.jsonl');
  baseLog = path.join(tmpDir, 'clair_pilot.log.jsonl');

  launcher = spawn(process.execPath, ['launcher.js', '--demo', '--no-browser'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BASE_PORT: String(BASE_PORT),
      GATEWAY_PORT: String(GATEWAY_PORT),
      DASHBOARD_PORT: String(DASHBOARD_PORT),
      LLM_MOCK_PORT: String(LLM_MOCK_PORT),
      GATEWAY_LOG_FILE: gwLog,
      BASE_LOG_FILE: baseLog,
      GATEWAY_SESSION_NAME: 'e2e-orchestration',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  launcher.stdout.on('data', (d: Buffer) => {
    launcherOut += d.toString();
  });
  launcher.stderr.on('data', (d: Buffer) => {
    launcherOut += d.toString();
  });
}, 150_000);

/**
 * Platform-aware launcher stop.
 *
 * POSIX: SIGINT → graceful shutdown of the launcher (exit 0), children die via
 *   process groups.
 * Windows CI: the launcher has no attached console, so a programmatic SIGINT is
 *   not delivered (libuv cannot send CTRL_C_EVENT to a foreign process) — the
 *   tree is killed with taskkill /T /F, exactly the same way launcher.killAll()
 *   does it on Windows. The "graceful Ctrl+C with exit 0" scenario was verified
 *   manually on a real Windows machine during acceptance.
 */
const stopLauncher = async () => {
  if (!launcher || launcher.exitCode !== null || launcher.signalCode !== null) return;
  if (process.platform === 'win32' && launcher.pid) {
    spawn('taskkill', ['/pid', String(launcher.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    launcher.kill('SIGINT');
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && launcher.exitCode === null && launcher.signalCode === null) {
    await new Promise((r) => setTimeout(r, 250));
  }
};

afterAll(async () => {
  await stopLauncher();
  // Make sure no orphans remain.
  for (const port of [BASE_PORT, GATEWAY_PORT, DASHBOARD_PORT]) {
    if (await health(port)) {
      throw new Error(`orphan still alive on :${port}`);
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}, 30_000);

describe('CLAIR PRO orchestration (e2e, --demo)', () => {
  it('starts all three services with healthy endpoints', async () => {
    await waitUntil(() => health(BASE_PORT), 30_000, 'mock Base /health');
    await waitUntil(() => health(GATEWAY_PORT), 45_000, 'Gateway /health');
    await waitUntil(() => health(DASHBOARD_PORT), 45_000, 'Dashboard /health');
  }, 120_000);

  it('serves the dashboard UI from /', async () => {
    const res = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('CLAIR');
    expect(html).toContain('chart-saved');
  }, 30_000);

  it('flows a real request through Gateway → Base → LLM and logs it', async () => {
    const before = Date.now();
    // Vowel-heavy text: the mock Base strips vowels, so savings are guaranteed > 0.
    const prompt =
      'Идея автоматизации образования: аудио-визуальные ассоциации, оранжерея с эвкалиптом, аудитория оценила очарование Эйфелевой башни и оливковое дерево у авеню. '.repeat(4);
    let res: { status: number; body: any };
    try {
      res = await postJson(GATEWAY_PORT, '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (e) {
      console.error('[DIAG] gateway request failed. launcher output:\n' + launcherOut);
      throw e;
    }
    expect(res.status).toBe(200);
    expect(res.body.choices?.[0]?.message?.content).toBeTruthy();

    // Gateway JSONL has been written
    await waitUntil(async () => fs.existsSync(gwLog) && fs.readFileSync(gwLog, 'utf8').includes('e2e-orchestration'), 10_000, 'gateway log row');
    // Base JSONL has been written by the mock Base
    await waitUntil(async () => fs.existsSync(baseLog) && fs.readFileSync(baseLog, 'utf8').trim().length > 0, 10_000, 'base log row');

    const gwRow = JSON.parse(fs.readFileSync(gwLog, 'utf8').trim().split('\n').at(-1)!);
    expect(gwRow.compression_enabled).toBe(true);
    expect(gwRow.saved_tokens).toBeGreaterThan(0);
    expect(Date.parse(gwRow.timestamp)).toBeGreaterThanOrEqual(before - 1000);
  }, 60_000);

  it('dashboard /api/data aggregates both log streams', async () => {
    await waitUntil(async () => {
      const { body } = await getJson<{ stats: { totals: { requests: number } } }>(DASHBOARD_PORT, '/api/data');
      return body.stats.totals.requests >= 2; // 1 gateway + >=1 base
    }, 15_000, 'dashboard aggregates');

    const { body } = await getJson<{
      stats: { totals: { requests: number; savedTokens: number }; sessions: string[] };
      files: Array<{ path: string; exists: boolean }>;
    }>(DASHBOARD_PORT, '/api/data');
    expect(body.stats.totals.requests).toBeGreaterThanOrEqual(2);
    expect(body.stats.totals.savedTokens).toBeGreaterThan(0);
    expect(body.files).toHaveLength(2);
    expect(body.files.every((f) => f.exists)).toBe(true);
  }, 45_000);

  it('dashboard export endpoints respond with data', async () => {
    const csv = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/export.csv`);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text).toContain('timestamp,source,session');

    const json = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/export.json`);
    const body = (await json.json()) as { count: number; entries: unknown[] };
    expect(body.count).toBeGreaterThan(0);
  }, 30_000);

  it('stop signal (SIGINT / tree-kill on Windows) stops the launcher without orphans', async () => {
    await stopLauncher();
    if (process.platform === 'win32') {
      // In CI a graceful Ctrl+C is not programmatically achievable (no attached
      // console): here we verify the core guarantee — the launcher has exited
      // and no orphans remain (afterAll probes the ports). exit code 0 on
      // SIGINT is verified on POSIX in this same run, and on Windows manually
      // during acceptance (docs/WINDOWS_CHECKLIST.md).
      expect(launcher.exitCode ?? launcher.signalCode).not.toBeNull();
    } else {
      expect(launcher.exitCode).toBe(0); // graceful shutdown exits cleanly
    }
  }, 30_000);
});
