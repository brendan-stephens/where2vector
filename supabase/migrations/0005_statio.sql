-- where2vector: per-table block I/O counters
--
-- pg_statio_all_tables splits reads/hits into heap vs TOAST vs index. Snapshotting
-- this before/after a query batch lets the dashboard attribute disk reads
-- specifically to the TOAST relation (huge for docs_1536, ~0 for docs_384).

create or replace function public.bench_statio(dim int)
returns jsonb
language sql
security definer
set search_path = bench, extensions, public
as $$
  select to_jsonb(t) from (
    select
      heap_blks_read, heap_blks_hit,
      idx_blks_read,  idx_blks_hit,
      coalesce(toast_blks_read, 0) as toast_blks_read,
      coalesce(toast_blks_hit, 0)  as toast_blks_hit,
      coalesce(tidx_blks_read, 0)  as tidx_blks_read,
      coalesce(tidx_blks_hit, 0)   as tidx_blks_hit
    from pg_statio_all_tables
    where relid = public._bench_table(dim)::regclass
  ) t;
$$;

grant execute on function public.bench_statio(int) to service_role;
