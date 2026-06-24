import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Server-side clients for the API routes.
//
// - pgvector RPCs (bench_*) are granted to `anon`, so the publishable key is
//   enough for the two pgvector legs.
// - Vector Bucket operations require the service-role key ("Access denied:
//   Invalid role" otherwise), so the bucket leg only lights up when
//   SUPABASE_SERVICE_ROLE_KEY is present.

const URL = () => process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = () => process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

let _db: SupabaseClient | null = null;
let _bucket: SupabaseClient | null = null;

// Force no-store so Next.js never serves cached responses for our reads — we always
// want live index metadata and real (uncached) query latency.
const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });

function make(key: string): SupabaseClient {
  return createClient(URL()!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: noStoreFetch },
  });
}

/**
 * Client for the pgvector bench RPCs. Prefers the ANON key on purpose: anon is the
 * role configured for this demo (RPCs granted + statement_timeout raised to 180s so
 * the ~10s disk-bound scans complete). service_role keeps the shorter default
 * timeout through PostgREST and would cancel the TOASTed leg.
 */
export function admin(): SupabaseClient {
  if (_db) return _db;
  const key = ANON() ?? SERVICE();
  if (!URL() || !key) {
    throw new Error(
      "Missing SUPABASE_URL and a key (SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY). Copy .env.example to .env.local."
    );
  }
  _db = make(key);
  return _db;
}

export function hasServiceRole(): boolean {
  return !!SERVICE();
}

/** Service-role client required for Vector Bucket operations. Null if the key isn't set. */
export function bucketClient(): SupabaseClient | null {
  if (_bucket) return _bucket;
  if (!URL() || !SERVICE()) return null;
  _bucket = make(SERVICE()!);
  return _bucket;
}

export const VECTOR_BUCKET = process.env.VECTOR_BUCKET ?? "embeddings";
export const VECTOR_INDEX = process.env.VECTOR_INDEX ?? "docs-1536";
