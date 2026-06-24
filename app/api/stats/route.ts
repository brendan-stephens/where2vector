import { NextResponse } from "next/server";
import { admin, bucketClient, VECTOR_BUCKET, VECTOR_INDEX } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Powers the "proof" panel: row counts + heap/TOAST/index sizes per pgvector table,
// plus the bucket's index metadata (S3-backed — no Postgres relation size exists).
export async function GET() {
  const supabase = admin();
  const { data, error } = await supabase.rpc("bench_toast_stats");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let bucket: any = null;
  const bc = bucketClient();
  if (bc) {
    try {
      const res = await (bc as any).storage.vectors.from(VECTOR_BUCKET).getIndex(VECTOR_INDEX);
      if (!res.error && res.data?.index) {
        const ix = res.data.index;
        // The vectors API exposes no size/count, so estimate the raw float32
        // payload: dim × 4 B × vector count. The bucket mirrors docs_1536 1:1,
        // so use that table's row count.
        const rows1536 = (data ?? []).find((t: any) => t.dim === 1536)?.est_rows ?? null;
        const estBytes = rows1536 != null ? ix.dimension * 4 * rows1536 : null;
        bucket = {
          bucket: VECTOR_BUCKET,
          index: ix.indexName,
          dimension: ix.dimension,
          dataType: ix.dataType,
          distanceMetric: ix.distanceMetric,
          vectors: rows1536,
          estBytes,
        };
      }
    } catch {
      /* bucket optional */
    }
  }

  return NextResponse.json({ tables: data ?? [], bucket });
}
