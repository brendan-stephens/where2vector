import { NextRequest, NextResponse } from "next/server";
import { admin, bucketClient } from "@/lib/supabase";
import { probeBucket, queryBucket } from "@/lib/buckets";
import {
  BenchmarkResponse,
  parseExplain,
  randomVectorArray,
  runPool,
  ScenarioId,
  ScenarioResult,
  SCENARIOS,
  summarize,
  vectorLiteral,
} from "@/lib/bench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  scenarios?: ScenarioId[];
  queries?: number;
  k?: number;
  concurrency?: number;
  useIndex?: boolean;
  prewarm?: boolean;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  // default is low on purpose: the TOASTed exact-scan leg reads ~1.2 GB/query (~10s)
  const queries = clamp(body.queries ?? 3, 1, 200);
  const k = clamp(body.k ?? 10, 1, 100);
  const concurrency = clamp(body.concurrency ?? 1, 1, 32);
  const useIndex = !!body.useIndex;
  const prewarm = !!body.prewarm;
  const want = new Set<ScenarioId>(body.scenarios ?? SCENARIOS.map((s) => s.id));

  const supabase = admin();
  const results: ScenarioResult[] = [];

  // Shared query vectors so the 1536 legs (TOASTed pgvector + bucket) are driven
  // by the *same* queries each iteration. The 384 leg needs its own dimension.
  const q1536 = Array.from({ length: queries }, () => randomVectorArray(1536));
  const q384 = Array.from({ length: queries }, () => randomVectorArray(384));

  for (const meta of SCENARIOS) {
    if (!want.has(meta.id)) continue;

    if (meta.dim === null) {
      results.push(await runBucketLeg(meta.id, meta.label, q1536, k, concurrency));
    } else {
      const qs = meta.dim === 1536 ? q1536 : q384;
      results.push(await runPgLeg(supabase, meta.id, meta.label, meta.dim, qs, k, useIndex, prewarm, concurrency));
    }
  }

  const payload: BenchmarkResponse = {
    ranAt: new Date().toISOString(),
    queries,
    k,
    concurrency,
    useIndex,
    prewarm,
    results,
  };
  return NextResponse.json(payload);
}

async function runPgLeg(
  supabase: ReturnType<typeof admin>,
  id: ScenarioId,
  label: string,
  dim: 384 | 1536,
  queryVectors: number[][],
  k: number,
  useIndex: boolean,
  prewarm: boolean,
  concurrency: number
): Promise<ScenarioResult> {
  // HNSW indexes are pre-built out-of-band (building one on demand over the
  // TOASTed table would exceed the anon timeout). If it's missing, fail clearly
  // instead of triggering a multi-minute build that times out.
  if (useIndex) {
    const { data: exists, error } = await supabase.rpc("bench_index_exists", { dim });
    if (error) return failLeg(id, label, error.message);
    if (!exists) {
      return failLeg(id, label, `HNSW index docs_${dim}_hnsw not built — see README "Pre-build the HNSW indexes".`);
    }
  }
  let prewarmInfo: string | undefined;
  if (prewarm) {
    const { data: pw } = await supabase.rpc("bench_prewarm", { dim });
    if (pw?.skipped) {
      prewarmInfo = `prewarm skipped — ${pw.reason}`;
    } else if (pw) {
      prewarmInfo = `prewarmed ${((pw.heap_blocks ?? 0) + (pw.toast_blocks ?? 0)).toLocaleString()} pages into shared_buffers`;
    }
  }

  const before = await statio(supabase, dim);

  let failErr: string | null = null;
  const wall0 = performance.now();
  const samples = await runPool(queryVectors, concurrency, async (v) => {
    const qvec = vectorLiteral(v);
    const t0 = performance.now();
    const { error } = await supabase.rpc("bench_knn", { dim, qvec, k, use_index: useIndex });
    const dt = performance.now() - t0;
    if (error) failErr = failErr ?? error.message;
    return dt;
  });
  const wallMs = performance.now() - wall0;
  if (failErr) return failLeg(id, label, failErr);

  const after = await statio(supabase, dim);

  // one representative EXPLAIN for server-side timing/buffer attribution
  const { data: plan } = await supabase.rpc("bench_explain_knn", {
    dim,
    qvec: vectorLiteral(queryVectors[0]),
    k,
    use_index: useIndex,
  });
  const ex = plan ? parseExplain(plan) : { planMs: null, sharedHitBlocks: null, sharedReadBlocks: null, ioReadMs: null };

  return {
    id,
    label,
    available: true,
    samples,
    ...summarize(samples),
    wallMs,
    throughput: throughputOf(samples.length, wallMs),
    prewarmInfo,
    server: {
      ...ex,
      toastBlksRead: delta(after?.toast_blks_read, before?.toast_blks_read),
      toastBlksHit: delta(after?.toast_blks_hit, before?.toast_blks_hit),
      heapBlksRead: delta(after?.heap_blks_read, before?.heap_blks_read),
    },
  };
}

async function runBucketLeg(
  id: ScenarioId,
  label: string,
  queryVectors: number[][],
  k: number,
  concurrency: number
): Promise<ScenarioResult> {
  const supabase = bucketClient();
  if (!supabase) {
    return {
      id,
      label,
      available: false,
      note: "Vector Buckets need the service-role key. Add SUPABASE_SERVICE_ROLE_KEY to .env.local and run `npm run seed`.",
      samples: [],
      p50: null,
      p95: null,
      p99: null,
      mean: null,
    };
  }
  const probe = await probeBucket(supabase);
  if (!probe.available) {
    return { id, label, available: false, note: probe.note, samples: [], p50: null, p95: null, p99: null, mean: null };
  }

  let failErr: string | null = null;
  const wall0 = performance.now();
  const samples = await runPool(queryVectors, concurrency, async (qvec) => {
    const t0 = performance.now();
    try {
      await queryBucket(supabase, qvec, k);
    } catch (e: any) {
      failErr = failErr ?? (e?.message ?? String(e));
      return NaN;
    }
    return performance.now() - t0;
  });
  const wallMs = performance.now() - wall0;
  if (failErr) return { id, label, available: false, note: failErr, samples: [], p50: null, p95: null, p99: null, mean: null };

  return { id, label, available: true, samples, ...summarize(samples), wallMs, throughput: throughputOf(samples.length, wallMs) };
}

function throughputOf(n: number, wallMs: number): number | null {
  return wallMs > 0 ? n / (wallMs / 1000) : null;
}

async function statio(supabase: ReturnType<typeof admin>, dim: number): Promise<any | null> {
  const { data } = await supabase.rpc("bench_statio", { dim });
  return data ?? null;
}

function delta(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return Math.max(0, a - b);
  return null;
}

function failLeg(id: ScenarioId, label: string, note: string): ScenarioResult {
  return { id, label, available: false, note, samples: [], p50: null, p95: null, p99: null, mean: null };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
