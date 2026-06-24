-- where2vector: benchmark schema + tables
--
-- Two pgvector tables that differ ONLY in vector dimension. This dimension is the
-- knob that flips Postgres TOAST behaviour on/off:
--
--   vector(384)  = 4*384  + 8 = 1544 bytes  -> below the ~2KB tuple threshold,
--                                              stays INLINE in the heap tuple.
--   vector(1536) = 4*1536 + 8 = 6152 bytes  -> exceeds the threshold, spills to
--                                              the out-of-line TOAST relation.
--
-- pgvector's `vector` type defaults to STORAGE EXTERNAL, so the large vector is
-- pushed to TOAST without compression. Reading a 1536-dim row therefore costs an
-- extra (often random) disk fetch to "de-TOAST" the value -- the latency we want
-- to make visible.

create schema if not exists bench;

create table if not exists bench.docs_384 (
  id        bigint generated always as identity primary key,
  embedding extensions.vector(384) not null,
  payload   text
);

create table if not exists bench.docs_1536 (
  id        bigint generated always as identity primary key,
  embedding extensions.vector(1536) not null,
  payload   text
);

-- The dashboard reads through these via SECURITY DEFINER RPCs (see 0003), so the
-- tables themselves stay locked down. No anon/auth grants on bench.* on purpose.
comment on schema bench is 'where2vector latency benchmark: inline (384) vs TOASTed (1536) pgvector storage.';
