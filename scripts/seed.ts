/**
 * Seed the benchmark dataset.
 *
 *   npm run seed                      # defaults below
 *   PG_ROWS=500000 BUCKET_ROWS=50000 npm run seed
 *   RESET=1 npm run seed              # truncate pgvector tables first
 *
 * pgvector rows are generated server-side (random reals via generate_series) so
 * nothing large crosses the wire. Vector-bucket rows are upserted via the SDK in
 * batches of 500 (the documented per-request cap) and are best-effort — if the
 * Vector Buckets alpha isn't enabled the script logs and skips that leg.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const PG_ROWS = int(process.env.PG_ROWS, 150_000);
// Mirror the same number of vectors into the bucket as the 1536 pgvector table,
// so the two 1536 legs are apples-to-apples (same data, count, and — below — metric).
const BUCKET_ROWS = int(process.env.BUCKET_ROWS, PG_ROWS);
const RESET = process.env.RESET === "1";
const BUCKET = process.env.VECTOR_BUCKET ?? "embeddings";
const INDEX = process.env.VECTOR_INDEX ?? "docs-1536";
// euclidean (L2) matches pgvector's `<->` operator used by the bench RPCs.
const METRIC = process.env.VECTOR_METRIC ?? "euclidean";

const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

async function seedPg(dim: 384 | 1536, target: number) {
  if (RESET) {
    process.stdout.write(`  truncating docs_${dim}… `);
    const { error } = await supabase.rpc("bench_truncate", { dim });
    console.log(error ? `error: ${error.message}` : "ok");
  }

  const { data: existing } = await supabase.rpc("bench_count", { dim });
  let have = Number(existing ?? 0);
  if (have >= target) {
    console.log(`  docs_${dim}: already has ${have.toLocaleString()} rows (>= ${target.toLocaleString()})`);
  } else {
    // smaller batches for the wider vector to stay well under any timeout
    const batch = dim === 1536 ? 2_000 : 10_000;
    while (have < target) {
      const n = Math.min(batch, target - have);
      const { error } = await supabase.rpc("bench_seed", { dim, n });
      if (error) {
        console.error(`\n  bench_seed(${dim}, ${n}) failed: ${error.message}`);
        process.exit(1);
      }
      have += n;
      process.stdout.write(`\r  docs_${dim}: ${have.toLocaleString()} / ${target.toLocaleString()}`);
    }
    console.log("");
  }

  process.stdout.write(`  analyzing docs_${dim}… `);
  await supabase.rpc("bench_analyze", { dim });
  console.log("ok");
}

async function seedBucket(target: number) {
  const vectors = (supabase as any)?.storage?.vectors;
  if (typeof vectors?.from !== "function") {
    console.log("  Vector Buckets API not present in this SDK build — skipping bucket leg.");
    return;
  }

  try {
    await tryCall(() => vectors.createBucket(BUCKET));

    // Keep an existing euclidean index (so a re-run resumes instead of wiping
    // progress); only (re)create when missing or the metric is wrong.
    const existing = await vectors.from(BUCKET).getIndex(INDEX);
    const ix = existing?.data?.index;
    const ok = ix && ix.dimension === 1536 && ix.distanceMetric === METRIC;
    if (!ok) {
      await tryCall(() => vectors.from(BUCKET).deleteIndex(INDEX));
      const created = await vectors
        .from(BUCKET)
        .createIndex({ indexName: INDEX, dataType: "float32", dimension: 1536, distanceMetric: METRIC });
      if (created?.error) throw new Error(created.error.message ?? String(created.error));
    }

    const idx = vectors.from(BUCKET).index(INDEX);

    // Mirror the EXACT docs_1536 vectors (keyed by row id) so the bucket and the
    // TOASTed pgvector leg hold identical data — apples-to-apples on everything
    // except the storage engine + (ANN vs exact) access method. putVectors is an
    // upsert, so re-running is idempotent; BUCKET_AFTER_ID skips already-done ids.
    let afterId = int(process.env.BUCKET_AFTER_ID, 0);
    let done = 0;
    while (done < target) {
      const lim = Math.min(500, target - done); // 500 = documented per-request cap
      const rows = await withRetry(`fetch>${afterId}`, async () => {
        const { data, error } = await supabase.rpc("bench_fetch_batch", { dim: 1536, after_id: afterId, lim });
        if (error) throw new Error(error.message);
        return data as Array<{ id: number; e: number[] }>;
      });
      if (!rows || rows.length === 0) break;

      const batch = rows.map((r) => ({ key: `doc-${r.id}`, data: { float32: r.e }, metadata: { id: r.id } }));
      await withRetry(`put>${afterId}`, async () => {
        const { error } = await idx.putVectors({ vectors: batch });
        if (error) throw new Error(error.message ?? String(error));
      });

      afterId = rows[rows.length - 1].id;
      done += rows.length;
      process.stdout.write(`\r  bucket ${BUCKET}/${INDEX} [${METRIC}]: ${done.toLocaleString()} / ${target.toLocaleString()} (last id ${afterId})`);
    }
    console.log("");
  } catch (e: any) {
    console.log(`\n  bucket seeding stopped: ${e?.message ?? e}`);
  }
}

// Retry transient failures (e.g. 504 Gateway Timeout) with exponential backoff.
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const wait = 1000 * 2 ** i;
      process.stdout.write(`\n  retry ${label} (${i + 1}/${attempts}) after ${e?.message ?? e} — waiting ${wait}ms\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function main() {
  console.log(`Seeding where2vector → ${URL}`);
  console.log(`pgvector target: ${PG_ROWS.toLocaleString()} rows/table · bucket target: ${BUCKET_ROWS.toLocaleString()}\n`);

  console.log("pgvector · inline (384):");
  await seedPg(384, PG_ROWS);
  console.log("pgvector · TOASTed (1536):");
  await seedPg(1536, PG_ROWS);
  console.log("Vector Bucket (1536):");
  await seedBucket(BUCKET_ROWS);

  const { data: stats } = await supabase.rpc("bench_toast_stats");
  console.log("\nStorage layout:");
  console.table(stats);
  console.log("\nDone. Run `npm run dev` and open http://localhost:3000");
}

function int(v: string | undefined, d: number): number {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : d;
}
async function tryCall(fn: () => any) {
  try {
    const r = await fn?.();
    return r;
  } catch {
    /* ignore — likely already-exists */
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
