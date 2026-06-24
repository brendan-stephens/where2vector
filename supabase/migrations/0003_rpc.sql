-- where2vector: benchmark RPCs
--
-- These live in `public` (not `bench`) so PostgREST exposes them to supabase-js
-- `.rpc(...)` without changing the exposed-schema config. They are SECURITY
-- DEFINER so the underlying bench.* tables can stay private; the dashboard's
-- service-role client is the only intended caller.

------------------------------------------------------------------------------
-- Resolve "384" | "1536" -> a safe, fully-qualified table name. Rejects anything
-- else so the dim arg can never be used for SQL injection in the dynamic queries.
------------------------------------------------------------------------------
create or replace function public._bench_table(dim int)
returns text
language plpgsql
immutable
as $$
begin
  if dim = 384 then
    return 'bench.docs_384';
  elsif dim = 1536 then
    return 'bench.docs_1536';
  else
    raise exception 'unsupported dim %, expected 384 or 1536', dim;
  end if;
end;
$$;

------------------------------------------------------------------------------
-- bench_knn: plain KNN, returns the matched ids. Used for client-side
-- end-to-end timing (no EXPLAIN overhead). use_index=false forces an exact
-- sequential scan, which makes every row's vector get de-TOASTed.
------------------------------------------------------------------------------
create or replace function public.bench_knn(
  dim int,
  qvec text,
  k int default 10,
  use_index boolean default false
)
returns table (id bigint)
language plpgsql
security definer
set search_path = bench, extensions, public
set statement_timeout = '120s'  -- exact scans on TOASTed data exceed the 3s anon default
as $$
declare
  v_table text := public._bench_table(dim);
begin
  if not use_index then
    -- force exact KNN (seq scan) so the TOAST fetch cost is exercised
    set local enable_indexscan = off;
    set local enable_bitmapscan = off;
  end if;

  return query execute format(
    'select id from %s order by embedding <-> %L::extensions.vector(%s) limit %s',
    v_table, qvec, dim, k
  );
end;
$$;

------------------------------------------------------------------------------
-- bench_explain_knn: same query under EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON).
-- The returned plan carries per-node `Shared Hit/Read Blocks` and `I/O Read
-- Time` (track_io_timing is on by default on Supabase) for BOTH the heap and
-- the TOAST relation -- this is how the dashboard attributes latency to disk.
------------------------------------------------------------------------------
create or replace function public.bench_explain_knn(
  dim int,
  qvec text,
  k int default 10,
  use_index boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = bench, extensions, public
set statement_timeout = '120s'
as $$
declare
  v_table text := public._bench_table(dim);
  v_plan  jsonb;
begin
  if not use_index then
    set local enable_indexscan = off;
    set local enable_bitmapscan = off;
  end if;

  execute format(
    'explain (analyze, buffers, format json) '
    || 'select id from %s order by embedding <-> %L::extensions.vector(%s) limit %s',
    v_table, qvec, dim, k
  ) into v_plan;

  return v_plan;
end;
$$;

------------------------------------------------------------------------------
-- bench_prewarm: pull a table + its TOAST relation (and indexes) into
-- shared_buffers, establishing the "warm" baseline. Returns blocks warmed.
------------------------------------------------------------------------------
create or replace function public.bench_prewarm(dim int)
returns jsonb
language plpgsql
security definer
set search_path = bench, extensions, public
set statement_timeout = '120s'
as $$
declare
  v_table  text := public._bench_table(dim);
  v_rel    oid  := v_table::regclass;
  v_toast  oid;
  v_heap_blocks   bigint := 0;
  v_toast_blocks  bigint := 0;
begin
  select reltoastrelid into v_toast from pg_class where oid = v_rel;

  v_heap_blocks := extensions.pg_prewarm(v_rel);
  if v_toast is not null and v_toast <> 0 then
    v_toast_blocks := extensions.pg_prewarm(v_toast);
  end if;

  return jsonb_build_object(
    'dim', dim,
    'heap_blocks', v_heap_blocks,
    'toast_blocks', v_toast_blocks
  );
end;
$$;

------------------------------------------------------------------------------
-- bench_toast_stats: heap vs TOAST vs index sizes per table. The proof panel
-- shows that docs_1536 has a large TOAST relation while docs_384 has none.
------------------------------------------------------------------------------
create or replace function public.bench_toast_stats()
returns jsonb
language sql
security definer
set search_path = bench, extensions, public
as $$
  with rels as (
    select 384  as dim, 'bench.docs_384'::regclass  as rel
    union all
    select 1536 as dim, 'bench.docs_1536'::regclass as rel
  )
  select jsonb_agg(jsonb_build_object(
    'dim', dim,
    'est_rows', (select reltuples::bigint from pg_class where oid = rel),
    'heap_bytes',  pg_relation_size(rel),
    'toast_bytes', coalesce(
        (select pg_total_relation_size(reltoastrelid)
         from pg_class where oid = rel and reltoastrelid <> 0), 0),
    'index_bytes', pg_indexes_size(rel),
    'total_bytes', pg_total_relation_size(rel)
  ) order by dim)
  from rels;
$$;

------------------------------------------------------------------------------
-- Index management: HNSW indexes are created on demand (they are large for
-- 1536-dim) so the exact-KNN demo can run before paying to build them.
------------------------------------------------------------------------------
create or replace function public.bench_ensure_index(dim int)
returns text
language plpgsql
security definer
set search_path = bench, extensions, public
set statement_timeout = '600s'  -- HNSW builds on 1536-dim data are slow
as $$
declare
  v_table text := public._bench_table(dim);
  v_idx   text := 'docs_' || dim || '_hnsw';
begin
  execute format(
    'create index if not exists %I on %s using hnsw (embedding extensions.vector_l2_ops)',
    v_idx, v_table
  );
  return v_idx;
end;
$$;

-- The dashboard authenticates with the service-role key.
grant execute on function
  public.bench_knn(int, text, int, boolean),
  public.bench_explain_knn(int, text, int, boolean),
  public.bench_prewarm(int),
  public.bench_toast_stats(),
  public.bench_ensure_index(int)
to service_role;
