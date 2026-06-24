-- where2vector: HNSW index existence check.
--
-- The dashboard checks this before running the HNSW leg. HNSW indexes are NOT
-- built on demand from the request path: building one over the 150k×1536 TOASTed
-- table takes minutes and would blow past the anon statement_timeout (the
-- "TOAST times out when I pick HNSW" bug). Build them out-of-band instead
-- (see README → "Pre-build the HNSW indexes"); this RPC just reports readiness.

create or replace function public.bench_index_exists(dim int)
returns boolean
language sql
security definer
set search_path = bench, extensions, public
as $$
  select exists(
    select 1 from pg_indexes
    where schemaname = 'bench' and indexname = 'docs_' || dim || '_hnsw'
  );
$$;

grant execute on function public.bench_index_exists(int) to anon, service_role;
