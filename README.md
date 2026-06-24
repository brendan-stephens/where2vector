# where2vector

A benchmark demo that makes **disk latency visible** for vector search. It compares
query latency across three storage strategies so you can see *when and why* a vector
query hits disk:

| Leg | What it is | Storage | Expected |
|---|---|---|---|
| **pgvector · inline (no TOAST)** | `vector(384)` = 1544 B | lives in the heap tuple | fast — no extra fetch |
| **pgvector · TOASTed** | `vector(1536)` = 6152 B | spills to the out-of-line **TOAST** relation | slow — extra disk fetch per row |
| **Vector Bucket (S3)** | Supabase Vector Buckets (alpha) | S3-backed object store | network/object-storage latency, scales to millions |

The knob between the two pgvector legs is **vector dimension**: 384-dim vectors stay
inline; 1536-dim vectors exceed Postgres' ~2 KB tuple threshold and get pushed to a
TOAST relation. Reading a TOASTed row needs an extra (often random) disk fetch to
"de-TOAST" the value — that's the latency this demo surfaces.

## What you'll see

On the seeded project (150k rows/table, ~256 MB `shared_buffers`):

- **inline 384** — ~1.4 s for an exact scan, **0** TOAST reads.
- **TOASTed 1536** — **~9.5 s** (≈7× slower). The 1.24 GB TOAST relation is larger
  than cache, so the exact scan re-reads ~1.2 GB from disk on every query — and
  `pg_statio` attributes **100%** of those reads to the TOAST relation (heap reads ≈ 0).

The "disk attribution" panel reports bytes read from disk and TOAST pages read per
query (the headline, since `track_io_timing` is superuser-only on Supabase and off here).

## Architecture

```
supabase/migrations/   0001 extensions · 0002 tables · 0003 query RPCs ·
                       0004 seed helpers · 0005 statio · 0006 demo access
lib/                   bench.ts (types/percentiles/EXPLAIN parse) · supabase.ts · buckets.ts
app/                   api/benchmark · api/stats · page.tsx (dashboard) · globals.css
scripts/seed.ts        server-side pgvector seeding + bucket upsert
```

The dashboard talks to Postgres only through supabase-js. The pgvector legs call
SECURITY DEFINER RPCs (`bench_knn`, `bench_explain_knn`, `bench_statio`, …) that read
a private `bench` schema. Query mode defaults to **exact KNN (sequential scan)** so
every row's vector is de-TOASTed — the honest way to expose TOAST disk cost. The
optional **HNSW** toggle runs production-realistic ANN instead (Index Scan, ~120 ms
on the 1536 leg vs ~9.5 s exact); it requires the indexes to be pre-built (below).

The **Concurrency** control runs each leg's queries through a bounded pool (1–32 in
flight) and reports **queries/sec** per leg — how each engine handles parallel load.
A nice thing to observe: concurrent exact scans on one table *share* disk reads via
Postgres synchronized scans, so the TOASTed leg's throughput can scale even while each
query stays slow.

The **Prewarm** toggle warms a table into `shared_buffers` before timing — but only if
it *fits*. The inline 384 table (234 MB) fits 256 MB `shared_buffers`, so prewarm makes
it ~12× faster (1.5 s → ~0.12 s, all cache hits). The 1536 TOAST (1.2 GB) can't fit, so
prewarm is **skipped** with a note — warming a relation larger than the buffer pool is
futile (pages evict as fast as they load) and only adds the cost of reading it once.
That "fits or it's pointless" rule is itself part of the lesson.

## Run it

The hosted project (`where2vector`, ref `enxhwnktmsqcokganivn`, us-east-1) is already
provisioned, migrated, and seeded with 150k rows/table. `.env.local` is filled with
the publishable key.

```bash
npm install
npm run dev          # http://localhost:3000 — click "Run benchmark"
```

The two pgvector legs work out of the box. Defaults run **3 queries** because the
TOASTed leg is intentionally ~10 s/query.

### Enable the Vector Bucket leg

Bucket operations require the **service-role** key (anon gets "Access denied: Invalid
role"). Add it and seed the bucket:

```bash
# .env.local → uncomment and paste from Dashboard → Project Settings → API
SUPABASE_SERVICE_ROLE_KEY=<service_role secret>

npm run seed         # creates bucket "embeddings" + euclidean index "docs-1536",
                     # then mirrors the exact docs_1536 vectors into it
```

Then re-run the dashboard — the bucket leg lights up.

### Pre-build the HNSW indexes (for the ANN toggle)

The indexes are already built on this project. HNSW indexes are **not** built from
the request path — building one over the 150k×1536 TOASTed table takes minutes and
would exceed the anon `statement_timeout` (that's the "TOAST times out when I select
HNSW" symptom). If you ever need to rebuild (e.g. after `RESET`), run it out-of-band
with extra build memory:

```sql
set maintenance_work_mem = '256MB';
set statement_timeout = '600s';
create index if not exists docs_384_hnsw  on bench.docs_384  using hnsw (embedding extensions.vector_l2_ops);
create index if not exists docs_1536_hnsw on bench.docs_1536 using hnsw (embedding extensions.vector_l2_ops) with (m = 8, ef_construction = 32);
```

The dashboard checks `bench_index_exists(dim)` before the HNSW leg and reports a clear
message if an index is missing — it never blocks on a build.

### Apples-to-apples

The bucket leg is aligned with the TOASTed `vector(1536)` leg as closely as the two
engines allow:

- **Same vectors** — the seed mirrors the exact 150k `docs_1536` vectors into the
  bucket (keyed by row id), same count.
- **Same metric** — the bucket index uses **euclidean**, matching pgvector's L2 `<->`.
- **Same queries** — each benchmark iteration drives both 1536 legs with one shared
  query vector.

The one irreducible difference is the access method: the bucket does **approximate
(ANN)** search; the pgvector legs run **exact** KNN (sequential scan). That's the
storage/engine tradeoff the demo is about, not a data mismatch. (The 384 leg is a
different dimension by necessity, so it uses its own queries.)

### Re-seed / scale

```bash
PG_ROWS=300000 BUCKET_ROWS=50000 RESET=1 npm run seed   # needs the service-role key
```

More rows → larger TOAST → a bigger cold/warm gap. Keep the 1536 TOAST above
`shared_buffers` + OS cache (~1 GB here) so the exact scan stays disk-bound.

## Demo-only configuration (see `0006_demo_access.sql`)

To run on the publishable key with no server secret, this project: (1) grants the
read-only bench RPCs to `anon`, and (2) raises the `anon` `statement_timeout` to 180 s
(the disk-bound queries exceed the 3 s default). **Don't copy these into production.**

## Caveat

1536-dim also costs ~4× more distance CPU than 384-dim, so raw latency confounds
dimension with storage. The bytes-read-from-disk and TOAST-pages-read figures isolate
the storage (disk) component — which is the point of the demo.
