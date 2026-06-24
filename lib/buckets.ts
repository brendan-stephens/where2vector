import { SupabaseClient } from "@supabase/supabase-js";
import { VECTOR_BUCKET, VECTOR_INDEX } from "./supabase";

// Vector Buckets are an alpha, S3-backed feature exposed under supabase-js's
// `storage.vectors` namespace. Access is defensive: if the installed SDK or the
// org doesn't have it, the leg reports as unavailable instead of crashing the run.

export interface BucketProbe {
  available: boolean;
  note?: string;
}

function vectorsApi(supabase: SupabaseClient): any | null {
  const v = (supabase as any)?.storage?.vectors;
  return typeof v?.from === "function" ? v : null;
}

export async function probeBucket(supabase: SupabaseClient): Promise<BucketProbe> {
  const api = vectorsApi(supabase);
  if (!api) {
    return {
      available: false,
      note: "storage.vectors not present in this @supabase/supabase-js build — upgrade or enable the Vector Buckets alpha.",
    };
  }
  try {
    // A 1-vector query is the cheapest way to confirm bucket+index exist.
    await queryBucket(supabase, randomUnit(1536), 1);
    return { available: true };
  } catch (e: any) {
    return { available: false, note: e?.message ?? String(e) };
  }
}

export async function queryBucket(
  supabase: SupabaseClient,
  queryVector: number[],
  k: number
): Promise<Array<{ key: string; distance?: number }>> {
  const api = vectorsApi(supabase);
  if (!api) throw new Error("storage.vectors unavailable");

  // queryVector is a VectorData object: { float32: number[] }
  const { data, error } = await api
    .from(VECTOR_BUCKET)
    .index(VECTOR_INDEX)
    .queryVectors({ queryVector: { float32: queryVector }, topK: k, returnDistance: true });

  if (error) throw new Error(error.message ?? String(error));
  return (data?.vectors ?? data ?? []) as Array<{ key: string; distance?: number }>;
}

function randomUnit(dim: number): number[] {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random();
  return v;
}
