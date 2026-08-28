import fs from 'node:fs';

/**
 * Unified log-entry shape used across the dashboard.
 * Both log streams (CLAIR Base + CLAIR Gateway) are normalized into this.
 */
export interface UnifiedEntry {
  /** ISO 8601 timestamp as written by the source log. */
  ts: string;
  /** Which JSONL stream the entry came from. */
  source: 'gateway' | 'base';
  session: string;
  model: string | null;
  mode: string | null;
  original: number;
  compressed: number;
  saved: number;
  ratio: number;
  /** Prompt-cache outcome; base log has no cache concept → null. */
  cacheState: 'HIT' | 'PARTIAL' | 'MISS' | 'BYPASS' | null;
  cacheHits: number | null;
  cacheMisses: number | null;
  latencyMs: number | null;
  status: number | null;
  note: string | null;
}

export interface LogFileMeta {
  path: string;
  exists: boolean;
  bytes: number;
  lines: number;
  corruptedLines: number;
}

export interface ReadResult {
  entries: UnifiedEntry[];
  meta: LogFileMeta;
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Derives the cache outcome label from gateway counters (0/0 = cache disabled or legacy row). */
function deriveCacheState(rec: Record<string, unknown>): UnifiedEntry['cacheState'] {
  if (rec.compression_enabled === false) return 'BYPASS';
  const hits = num(rec.cache_hits, 0);
  const misses = num(rec.cache_misses, 0);
  if (hits > 0 && misses > 0) return 'PARTIAL';
  if (hits > 0) return 'HIT';
  if (misses > 0) return 'MISS';
  return null;
}

function normalizeGateway(rec: Record<string, unknown>): UnifiedEntry {
  return {
    ts: str(rec.timestamp) ?? '',
    source: 'gateway',
    session: str(rec.session) ?? 'default',
    model: str(rec.model),
    mode: null,
    original: num(rec.original_tokens),
    compressed: num(rec.compressed_tokens),
    saved: num(rec.saved_tokens),
    ratio: num(rec.compression_ratio, 1),
    cacheState: deriveCacheState(rec),
    cacheHits: typeof rec.cache_hits === 'number' ? rec.cache_hits : null,
    cacheMisses: typeof rec.cache_misses === 'number' ? rec.cache_misses : null,
    latencyMs: num(rec.latency_ms),
    status: typeof rec.status === 'number' ? rec.status : null,
    note: str(rec.note),
  };
}

function normalizeBase(rec: Record<string, unknown>): UnifiedEntry {
  return {
    ts: str(rec.timestamp) ?? '',
    source: 'base',
    session: str(rec.session) ?? 'default',
    model: null,
    mode: str(rec.mode),
    original: num(rec.input_tokens),
    compressed: num(rec.output_tokens),
    saved: num(rec.tokens_saved),
    ratio: num(rec.compression_ratio, 1),
    cacheState: null,
    cacheHits: null,
    cacheMisses: null,
    latencyMs: null,
    status: null,
    note: null,
  };
}

/** Reads one JSONL file tolerantly: corrupted lines are counted, never fatal. */
export function readJsonl(file: string, kind: 'gateway' | 'base'): ReadResult {
  const meta: LogFileMeta = { path: file, exists: false, bytes: 0, lines: 0, corruptedLines: 0 };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { entries: [], meta };
  }
  meta.exists = true;
  meta.bytes = stat.size;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { entries: [], meta };
  }
  const entries: UnifiedEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    meta.lines += 1;
    try {
      const rec = JSON.parse(trimmed) as Record<string, unknown>;
      entries.push(kind === 'base' ? normalizeBase(rec) : normalizeGateway(rec));
    } catch {
      meta.corruptedLines += 1;
    }
  }
  return { entries, meta };
}

export interface EntryFilters {
  session?: string | null;
  cache?: string | null;
  source?: string | null;
  mode?: string | null;
  q?: string | null;
  from?: string | null;
  to?: string | null;
}

export function applyFilters(entries: UnifiedEntry[], f: EntryFilters): UnifiedEntry[] {
  const q = f.q?.toLowerCase() ?? null;
  return entries.filter((e) => {
    if (f.session && e.session !== f.session) return false;
    if (f.cache && e.cacheState !== f.cache) return false;
    if (f.source && e.source !== f.source) return false;
    if (f.mode && e.mode !== f.mode) return false;
    if (f.from && (!e.ts || e.ts < f.from)) return false;
    if (f.to && (!e.ts || e.ts > f.to)) return false;
    if (q) {
      const haystack = [e.session, e.model, e.mode, e.note].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export interface Totals {
  requests: number;
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  /** Overall compression factor: original/compressed. 1 = no compression. */
  avgRatio: number;
}

export interface Bucket {
  key: string;
  requests: number;
  savedTokens: number;
  originalTokens: number;
  compressedTokens: number;
  avgRatio: number;
  avgLatencyMs: number | null;
}

export interface Aggregates {
  totals: Totals;
  byDay: Bucket[];
  byHour: Bucket[];
  bySession: Bucket[];
  byMode: Bucket[];
  byModel: Bucket[];
  cache: { HIT: number; PARTIAL: number; MISS: number; BYPASS: number; none: number };
  latency: { avg: number; p50: number | null; p95: number | null; samples: number };
  sessions: string[];
  generatedAt: string;
}

function bucketize(entries: UnifiedEntry[], keyFn: (e: UnifiedEntry) => string | null): Bucket[] {
  const map = new Map<string, { requests: number; saved: number; original: number; compressed: number; latencySum: number; latencyN: number }>();
  for (const e of entries) {
    const key = keyFn(e);
    if (!key) continue;
    const b =
      map.get(key) ??
      { requests: 0, saved: 0, original: 0, compressed: 0, latencySum: 0, latencyN: 0 };
    b.requests += 1;
    b.saved += e.saved;
    b.original += e.original;
    b.compressed += e.compressed;
    if (e.latencyMs !== null) {
      b.latencySum += e.latencyMs;
      b.latencyN += 1;
    }
    map.set(key, b);
  }
  return [...map.entries()]
    .map(([key, b]) => ({
      key,
      requests: b.requests,
      savedTokens: b.saved,
      originalTokens: b.original,
      compressedTokens: b.compressed,
      avgRatio: b.compressed > 0 ? Number((b.original / b.compressed).toFixed(3)) : 1,
      avgLatencyMs: b.latencyN > 0 ? Math.round(b.latencySum / b.latencyN) : null,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Aggregates unified entries into every series the dashboard renders. */
export function aggregate(entries: UnifiedEntry[]): Aggregates {
  const totals: Totals = {
    requests: entries.length,
    originalTokens: 0,
    compressedTokens: 0,
    savedTokens: 0,
    avgRatio: 1,
  };
  const cache = { HIT: 0, PARTIAL: 0, MISS: 0, BYPASS: 0, none: 0 };
  const latencies: number[] = [];
  const sessions = new Set<string>();

  for (const e of entries) {
    totals.originalTokens += e.original;
    totals.compressedTokens += e.compressed;
    totals.savedTokens += e.saved;
    sessions.add(e.session);
    if (e.cacheState) cache[e.cacheState] += 1;
    else cache.none += 1;
    if (e.latencyMs !== null) latencies.push(e.latencyMs);
  }
  totals.avgRatio = totals.compressedTokens > 0 ? Number((totals.originalTokens / totals.compressedTokens).toFixed(3)) : 1;

  latencies.sort((a, b) => a - b);
  const sorted = latencies;

  return {
    totals,
    byDay: bucketize(entries, (e) => (e.ts.length >= 10 ? e.ts.slice(0, 10) : null)),
    byHour: bucketize(entries, (e) => (e.ts.length >= 13 ? `${e.ts.slice(0, 13)}:00` : null)),
    bySession: bucketize(entries, (e) => e.session || 'default'),
    byMode: bucketize(entries.filter((e) => e.mode !== null), (e) => e.mode),
    byModel: bucketize(entries.filter((e) => e.model !== null), (e) => e.model),
    cache,
    latency: {
      avg: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      samples: latencies.length,
    },
    sessions: [...sessions].sort(),
    generatedAt: new Date().toISOString(),
  };
}

const CSV_COLUMNS: Array<[string, (e: UnifiedEntry) => string | number | null]> = [
  ['timestamp', (e) => e.ts],
  ['source', (e) => e.source],
  ['session', (e) => e.session],
  ['model', (e) => e.model],
  ['mode', (e) => e.mode],
  ['original_tokens', (e) => e.original],
  ['compressed_tokens', (e) => e.compressed],
  ['saved_tokens', (e) => e.saved],
  ['compression_ratio', (e) => e.ratio],
  ['cache_state', (e) => e.cacheState],
  ['cache_hits', (e) => e.cacheHits],
  ['cache_misses', (e) => e.cacheMisses],
  ['latency_ms', (e) => e.latencyMs],
  ['status', (e) => e.status],
  ['note', (e) => e.note],
];

function csvEscape(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",;\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serializes entries as CSV (Excel-friendly, comma-separated, UTF-8 BOM for Windows). */
export function toCsv(entries: UnifiedEntry[]): string {
  const header = CSV_COLUMNS.map(([name]) => name).join(',');
  const rows = entries.map((e) => CSV_COLUMNS.map(([, get]) => csvEscape(get(e))).join(','));
  return `\uFEFF${header}\n${rows.join('\n')}\n`;
}
