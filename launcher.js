#!/usr/bin/env node
/**
 * CLAIR PRO launcher — cross-platform orchestration core.
 *
 * Starts the whole product in dependency order:
 *   1. CLAIR Base        :3000  (immutable; real dir or --demo mock)
 *   2. CLAIR Gateway     :8080  (compression + cache proxy)
 *   3. Visual Dashboard  :4000  (web UI over both JSONL logs)
 *   (+ mock LLM          :4100  in --demo mode, for offline end-to-end demos)
 *
 * Services that already answer on their /health endpoint are reused, not
 * spawned twice. Ctrl+C gracefully stops everything this launcher spawned.
 *
 * Usage:
 *   node launcher.js            # normal mode (real CLAIR Base required)
 *   node launcher.js --demo     # offline demo: mock Base + mock LLM
 *   node launcher.js --mock-llm # real Base, but LLM behind a local mock
 *   node launcher.js --no-browser
 *
 * Env overrides:
 *   CLAIR_PILOT_DIR   default c:\Clair_pilot (win) / ./clair-base (other)
 *   CLAIR_GATEWAY_DIR default ../clair-gateway relative to this project
 *   BASE_PORT=3000  GATEWAY_PORT=8080  DASHBOARD_PORT=4000  LLM_MOCK_PORT=4100
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const PRO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const DEMO = args.has('--demo');
const MOCK_LLM = args.has('--mock-llm') || DEMO;
const OPEN_BROWSER = !args.has('--no-browser');

// ── Ports & dirs ──────────────────────────────────────────────────────────────
const envInt = (name, dflt) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const BASE_PORT = envInt('BASE_PORT', 3000);
const GATEWAY_PORT = envInt('GATEWAY_PORT', 8080);
const DASHBOARD_PORT = envInt('DASHBOARD_PORT', 4000);
const LLM_MOCK_PORT = envInt('LLM_MOCK_PORT', 4100);

const GATEWAY_DIR = path.resolve(process.env.CLAIR_GATEWAY_DIR ?? path.join(PRO_DIR, '..', 'clair-gateway'));
const PILOT_DIR = path.resolve(process.env.CLAIR_PILOT_DIR ?? (IS_WIN ? 'c:\\Clair_pilot' : path.join(PRO_DIR, 'clair-base')));

// ── Console helpers ───────────────────────────────────────────────────────────
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};
const TAGS = {
  base: c.cyan('[clair-base]  '),
  gateway: c.cyan('[gateway]     '),
  dashboard: c.cyan('[dashboard]   '),
  llm: c.cyan('[llm-mock]    '),
  pro: c.green('[clair-pro]   '),
};
const say = (tag, msg) => console.log(`${TAGS[tag] ?? ''}${msg}`);

// ── Health probing ────────────────────────────────────────────────────────────
function probePath(port, path, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

const probe = (port, timeoutMs = 1200) => probePath(port, '/health', timeoutMs);

async function waitHealthy(port, label, timeoutMs = 25_000, path = '/health') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePath(port, path)) return true;
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error(`Сервис «${label}» не ответил на ${path} (порт ${port}) за ${timeoutMs / 1000} с`);
}

// ── Child process management ──────────────────────────────────────────────────
const children = [];

function spawnChild(tag, command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: opts.cwd ?? PRO_DIR,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group on POSIX → Ctrl+C reaches children only via killAll(),
    // so ordering of the graceful shutdown stays deterministic.
    detached: !IS_WIN,
    shell: opts.shell ?? false,
  });
  child.tag = tag;
  const prefix = TAGS[tag] ?? '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => d.split('\n').filter(Boolean).forEach((l) => console.log(`${prefix}${c.dim(l)}`)));
  child.stderr.on('data', (d) => d.split('\n').filter(Boolean).forEach((l) => console.log(`${prefix}${c.dim(l)}`)));
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      say(tag, c.red(`процесс завершился (code=${code} signal=${signal ?? '-'})`));
      say('pro', c.red('Критический сервис упал — останавливаю остальные. Запустите заново.'));
      shutdown(1);
    }
  });
  children.push(child);
  return child;
}

function killAll() {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode) continue;
    try {
      if (IS_WIN) {
        // Kill the whole tree (npm/shell wrappers included).
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM'); // process group first
        } catch {
          child.kill('SIGTERM');
        }
      }
    } catch {
      /* already gone */
    }
  }
}

let shuttingDown = false;
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('');
  say('pro', c.yellow('Получен сигнал остановки — закрываю сервисы…'));
  killAll();
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && children.some((ch) => ch.exitCode === null && !ch.signalCode)) {
    await new Promise((r) => setTimeout(r, 150));
  }
  say('pro', 'Все сервисы остановлены. До связи!');
  process.exit(exitCode);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
// Startup failures must never leave orphaned children behind.
process.on('uncaughtException', (err) => {
  say('pro', c.red(`✗ Ошибка запуска: ${err?.message ?? err}`));
  void shutdown(1);
});
process.on('unhandledRejection', (err) => {
  say('pro', c.red(`✗ Ошибка запуска: ${err instanceof Error ? err.message : String(err)}`));
  void shutdown(1);
});

// ── Entry point discovery for the immutable CLAIR Base ────────────────────────
function resolveBaseCommand() {
  // Explicit override wins: CLAIR_START_CMD="node C:\custom.js"
  if (process.env.CLAIR_START_CMD) {
    const parts = process.env.CLAIR_START_CMD.split(/\s+/);
    return { command: parts[0], args: parts.slice(1), cwd: PILOT_DIR };
  }
  const candidates = ['dist/index.js', 'dist/server.js', 'dist/main.js', 'dist/app.js', 'dist/clair_pilot.js'];
  for (const rel of candidates) {
    const abs = path.join(PILOT_DIR, rel);
    if (fs.existsSync(abs)) return { command: process.execPath, args: [abs], cwd: PILOT_DIR };
  }
  // Fall back to the package.json hints (main / scripts.start), skipping npm.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PILOT_DIR, 'package.json'), 'utf8'));
    const start = pkg?.scripts?.start;
    if (typeof start === 'string') {
      const parts = start.split(/\s+/);
      if (parts[0] === 'node') return { command: process.execPath, args: parts.slice(1), cwd: PILOT_DIR };
    }
    if (typeof pkg?.main === 'string') {
      return { command: process.execPath, args: [path.join(PILOT_DIR, pkg.main)], cwd: PILOT_DIR };
    }
  } catch {
    /* no package.json — handled below */
  }
  return null;
}

// tsx runner for the TypeScript services (both repos ship tsx as devDependency).
function tsxRunner(dir) {
  const cli = path.join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return fs.existsSync(cli) ? cli : null;
}

// ── Startup plan ──────────────────────────────────────────────────────────────
console.log('');
say('pro', c.bold('CLAIR PRO — Unified Experience'));
say('pro', `Режим: ${DEMO ? c.bold('DEMO (моки без интернета и ключей)') : c.bold('PRODUCTION (реальный CLAIR Base)')}`);
console.log('');

// 1 ─ CLAIR Base ----------------------------------------------------------------
// Absolute paths shared by every service (single source of truth):
let baseLog = path.resolve(
  process.env.BASE_LOG_FILE ??
    (fs.existsSync(PILOT_DIR)
      ? path.join(PILOT_DIR, 'logs', 'clair_pilot.log.jsonl')
      : path.join(PRO_DIR, 'logs', 'clair_pilot.log.jsonl')),
);
let gatewayLog = path.resolve(process.env.GATEWAY_LOG_FILE ?? path.join(GATEWAY_DIR, 'logs', 'gateway.jsonl'));
{
  const alive = await probe(BASE_PORT, 800);
  if (alive) {
    say('base', c.green(`уже запущен на :${BASE_PORT} — переиспользую`));
    say('base', c.dim(`лог Base: ${baseLog}`));
  } else if (DEMO) {
    say('base', 'поднимаю mock CLAIR Base (--demo)…');
    spawnChild('base', process.execPath, [path.join(PRO_DIR, 'mocks', 'clair-base-mock.mjs')], {
      env: { CLAIR_MOCK_PORT: String(BASE_PORT), BASE_LOG_FILE: baseLog },
    });
    await waitHealthy(BASE_PORT, 'CLAIR Base (mock)');
    say('base', c.green(`готов: http://127.0.0.1:${BASE_PORT} (лог: ${baseLog})`));
  } else {
    if (!fs.existsSync(PILOT_DIR)) {
      console.log('');
      say('pro', c.red(`✗ CLAIR Base не найден в ${PILOT_DIR}`));
      console.log('');
      console.log('  Что делать:');
      console.log(`   • Проверьте, что CLAIR Base установлен и путь верен (сейчас: ${c.bold(PILOT_DIR)})`);
      console.log('   • Или укажите путь:        set CLAIR_PILOT_DIR=D:\\path\\to\\Clair_pilot');
      console.log('   • Или запустите демо-режим без Base: clair-pro --demo');
      console.log('');
      process.exit(1);
    }
    const cmd = resolveBaseCommand();
    if (!cmd) {
      say('pro', c.red(`✗ Не удалось определить точку входа CLAIR Base в ${PILOT_DIR}`));
      console.log('  Подскажите её явно: set CLAIR_START_CMD=node dist\\<entry>.js');
      process.exit(1);
    }
    say('base', `запускаю из ${PILOT_DIR}…`);
    spawnChild('base', cmd.command, cmd.args, { cwd: cmd.cwd, env: { BASE_LOG_FILE: baseLog } });
    await waitHealthy(BASE_PORT, 'CLAIR Base');
    say('base', c.green(`готов: http://127.0.0.1:${BASE_PORT}`));
  }
}

// 1b ─ Mock LLM (demo) -----------------------------------------------------------
if (MOCK_LLM) {
  const alive = await probePath(LLM_MOCK_PORT, '/v1/models', 800);
  if (alive) {
    say('llm', c.green(`уже запущен на :${LLM_MOCK_PORT} — переиспользую`));
  } else {
    say('llm', `демо-LLM на :${LLM_MOCK_PORT}…`);
    spawnChild('llm', process.execPath, [path.join(GATEWAY_DIR, 'mocks', 'llm-mock.mjs')], {
      env: { LLM_MOCK_PORT: String(LLM_MOCK_PORT) },
    });
    await waitHealthy(LLM_MOCK_PORT, 'Mock LLM', 15_000, '/v1/models');
    say('llm', c.green(`готов: http://127.0.0.1:${LLM_MOCK_PORT} (OpenAI-совместимый)`));
  }
}

// 2 ─ CLAIR Gateway --------------------------------------------------------------
{
  const alive = await probe(GATEWAY_PORT, 800);
  if (alive) {
    say('gateway', c.green(`уже запущен на :${GATEWAY_PORT} — переиспользую`));
  } else {
    if (!fs.existsSync(GATEWAY_DIR)) {
      say('pro', c.red(`✗ CLAIR Gateway не найден: ${GATEWAY_DIR}`));
      console.log('  Клонируйте репозиторий рядом с clair-pro или задайте CLAIR_GATEWAY_DIR.');
      shutdown(1);
    }
    say('gateway', `запускаю из ${GATEWAY_DIR}…`);
    const gatewayEnv = {
      PORT: String(GATEWAY_PORT),
      CLAIR_BASE_URL: `http://127.0.0.1:${BASE_PORT}`,
      LOG_FILE: gatewayLog,
      SESSION_NAME: process.env.GATEWAY_SESSION_NAME ?? 'clair-pro',
    };
    if (MOCK_LLM) gatewayEnv.LLM_PROVIDER_URL = `http://127.0.0.1:${LLM_MOCK_PORT}`;

    const tsx = tsxRunner(GATEWAY_DIR);
    if (tsx && fs.existsSync(path.join(GATEWAY_DIR, 'src', 'main.ts'))) {
      spawnChild('gateway', process.execPath, [tsx, 'src/main.ts'], { cwd: GATEWAY_DIR, env: gatewayEnv });
    } else {
      spawnChild('gateway', process.execPath, ['dist/main.js'], { cwd: GATEWAY_DIR, env: gatewayEnv });
    }
    await waitHealthy(GATEWAY_PORT, 'CLAIR Gateway');
    say('gateway', c.green(`готов: http://127.0.0.1:${GATEWAY_PORT} (v1.1.0, кэш включён)`));
  }
}

// 3 ─ Visual Dashboard ------------------------------------------------------------
{
  const alive = await probe(DASHBOARD_PORT, 800);
  if (alive) {
    say('dashboard', c.green(`уже запущен на :${DASHBOARD_PORT} — переиспользую`));
  } else {
    say('dashboard', 'запускаю…');
    const dashboardEnv = {
      DASHBOARD_PORT: String(DASHBOARD_PORT),
      GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
      GATEWAY_LOG_FILE: gatewayLog,
      BASE_LOG_FILE: baseLog,
    };
    const tsx = tsxRunner(PRO_DIR);
    if (tsx) {
      spawnChild('dashboard', process.execPath, [tsx, 'dashboard/src/server.ts'], { cwd: PRO_DIR, env: dashboardEnv });
    } else {
      spawnChild('dashboard', process.execPath, ['dashboard/dist/server.js'], { cwd: PRO_DIR, env: dashboardEnv });
    }
    await waitHealthy(DASHBOARD_PORT, 'Visual Dashboard');
    say('dashboard', c.green(`готов: http://127.0.0.1:${DASHBOARD_PORT}`));
  }
}

// ── Banner ────────────────────────────────────────────────────────────────────
const ui = `http://127.0.0.1:${DASHBOARD_PORT}`;
console.log('');
say('pro', c.bold('Все сервисы готовы. Открываю приборную панель:'));
console.log('');
console.log(`     ${c.bold(c.cyan(ui))}`);
console.log('');
console.log(`     Base        ${c.dim(`http://127.0.0.1:${BASE_PORT}  (immutable)`)} `);
console.log(`     Gateway     ${c.dim(`http://127.0.0.1:${GATEWAY_PORT}  (${MOCK_LLM ? 'LLM: mock' : 'LLM: из конфига Gateway'})`)}`);
console.log('');
console.log(`     ${c.dim('Остановить всё: Ctrl+C')}`);
console.log('');

if (OPEN_BROWSER) {
  try {
    if (IS_WIN) {
      spawn('cmd.exe', ['/c', 'start', '', ui], { detached: true, stdio: 'ignore', shell: false }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [ui], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [ui], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* best effort only */
  }
}

// Stay alive while children run; on unexpected child death shutdown() fired.
setInterval(() => {}, 60_000);
