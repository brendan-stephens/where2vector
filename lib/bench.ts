// Shared benchmark types + helpers (used by both the API route and the seed script).

export type ScenarioId = "inline_384" | "toast_1536" | "bucket_1536";

export interface ScenarioMeta {
  id: ScenarioId;
  label: string;
  blurb: string;
  /** dim for the two pgvector legs; null for the bucket leg */
  dim: 384 | 1536 | null;
}

export const SCENARIOS: ScenarioMeta[] = [
  {
    id: "inline_384",
    label: "pgvector · inline (no TOAST)",
    blurb: "384-dim vectors (1544 B) live in the heap tuple — no extra fetch.",
    dim: 384,
  },
  {
    id: "toast_1536",
    label: "pgvector · TOASTed",
    blurb: "1536-dim vectors (6152 B) spill to the TOAST relation — extra disk fetch per row.",
    dim: 1536,
  },
  {
    id: "bucket_1536",
    label: "Vector Bucket (S3)",
    blurb: "1536-dim vectors in Supabase's S3-backed store — object-storage latency, scales to millions.",
    dim: null,
  },
];

export interface ServerIO {
  /** total wall time the planner measured (ms) */
  planMs: number | null;
  /** blocks served from shared_buffers (no disk) */
  sharedHitBlocks: number | null;
  /** blocks read from disk / OS cache */
  sharedReadBlocks: number | null;
  /** actual ms spent in read I/O (track_io_timing) — the disk-latency headline */
  ioReadMs: number | null;
  /** delta of TOAST-relation block reads across the batch */
  toastBlksRead: number | null;
  toastBlksHit: number | null;
  heapBlksRead: number | null;
}

export interface ScenarioResult {
  id: ScenarioId;
  label: string;
  available: boolean;
  note?: string;
  /** client-side end-to-end latencies, ms */
  samples: number[];
  p50: number | null;
  p95: number | null;
  p99: number | null;
  mean: number | null;
  /** total wall-clock for all queries in this leg, ms (with concurrency) */
  wallMs?: number;
  /** completed queries per second = queries / (wallMs/1000) */
  throughput?: number | null;
  /** what prewarm did for this leg (applied vs skipped), when prewarm was on */
  prewarmInfo?: string;
  server?: ServerIO;
}

export interface BenchmarkResponse {
  ranAt: string;
  queries: number;
  k: number;
  concurrency: number;
  useIndex: boolean;
  prewarm: boolean;
  results: ScenarioResult[];
}

/**
 * Run `items` through `worker` with at most `limit` in flight at once.
 * Results are written to a slot array by index (order-preserving).
 */
export async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function summarize(samples: number[]): Pick<ScenarioResult, "p50" | "p95" | "p99" | "mean"> {
  if (samples.length === 0) return { p50: null, p95: null, p99: null, mean: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean,
  };
}

/** Build a random query vector as a pgvector text literal: "[0.12,0.98,...]". */
export function randomVectorLiteral(dim: number): string {
  const parts = new Array(dim);
  for (let i = 0; i < dim; i++) parts[i] = Math.random().toFixed(6);
  return `[${parts.join(",")}]`;
}

/** Same as above but as a number[] for the bucket SDK. */
export function randomVectorArray(dim: number): number[] {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random();
  return v;
}

/** number[] -> pgvector text literal, so the same query vector can drive both legs. */
export function vectorLiteral(v: number[]): string {
  return `[${v.map((x) => x.toFixed(6)).join(",")}]`;
}

/**
 * EXPLAIN (... FORMAT JSON) returns [{ "Plan": {...}, "Execution Time": n }].
 * Buffer + timing numbers on a node are inclusive of its children, so the root
 * Plan node already carries the cumulative totals we want.
 */
export function parseExplain(plan: any): Omit<ServerIO, "toastBlksRead" | "toastBlksHit" | "heapBlksRead"> {
  const top = Array.isArray(plan) ? plan[0] : plan;
  const root = top?.Plan ?? {};
  return {
    planMs: numOrNull(top?.["Execution Time"]),
    sharedHitBlocks: numOrNull(root?.["Shared Hit Blocks"]),
    sharedReadBlocks: numOrNull(root?.["Shared Read Blocks"]),
    ioReadMs: numOrNull(root?.["I/O Read Time"]),
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
