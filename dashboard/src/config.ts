import path from 'node:path';

export interface DashboardConfig {
  /** HTTP port of the dashboard itself. */
  port: number;
  /** Absolute path to the CLAIR Gateway JSONL operation log. */
  gatewayLog: string;
  /** Absolute path to the CLAIR Base JSONL log (real Base: <Clair_pilot>/logs/clair_pilot.log.jsonl). */
  baseLog: string;
  /** Base URL of the Gateway for proxied test requests. */
  gatewayUrl: string;
  /** Absolute path to the dashboard's static assets. */
  publicDir: string;
}

function findProjectRoot(): string {
  // The launcher and npm scripts both run with cwd = clair-pro root, but fall
  // back to walking up from this file so the server also works from dist/.
  const candidate = process.cwd();
  if (candidate.endsWith('dashboard')) return path.resolve(candidate, '..');
  return candidate;
}

/** Loads dashboard configuration from env with sane monorepo defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const root = findProjectRoot();
  const port = Number.parseInt(env.DASHBOARD_PORT ?? '4000', 10);
  return {
    port: Number.isFinite(port) && port > 0 ? port : 4000,
    gatewayLog: path.resolve(
      env.GATEWAY_LOG_FILE ?? path.join(root, '..', 'clair-gateway', 'logs', 'gateway.jsonl'),
    ),
    baseLog: path.resolve(env.BASE_LOG_FILE ?? path.join(root, 'logs', 'clair_pilot.log.jsonl')),
    gatewayUrl: env.GATEWAY_URL ?? 'http://127.0.0.1:8080',
    publicDir: path.resolve(env.DASHBOARD_PUBLIC_DIR ?? path.join(root, 'dashboard', 'src', 'public')),
  };
}
