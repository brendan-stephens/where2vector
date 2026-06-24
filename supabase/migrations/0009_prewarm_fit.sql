-- where2vector: make prewarm fit-aware.
--
-- Only prewarm a table if it actually fits in shared_buffers. Warming a relation
-- larger than the buffer pool is futile (pages are evicted as fast as they load)
-- and just adds the cost of reading it once — which is the "prewarm slows the
-- TOASTed leg down" surprise (the 1.24 GB docs_1536 TOAST can't fit in 256 MB
-- shared_buffers, so warming buys nothing). Skip it and report why.

create or replace function public.bench_prewarm(dim int)
returns jsonb
language plpgsql
security definer
set search_path = bench, extensions, public
set statement_timeout = '120s'
as $$
declare
  v_rel   oid    := public._bench_table(dim)::regclass;
  v_toast oid;
  v_sb    bigint := pg_size_bytes(current_setting('shared_buffers'));
  v_size  bigint := pg_table_size(v_rel);  -- heap + toast
  v_heap_blocks  bigint := 0;
  v_toast_blocks bigint := 0;
begin
  if v_size > v_sb then
    return jsonb_build_object(
      'dim', dim, 'skipped', true,
      'reason', format('%s (%s) exceeds shared_buffers (%s) — warming is futile',
                       v_rel::regclass::text, pg_size_pretty(v_size), pg_size_pretty(v_sb)));
  end if;

  select reltoastrelid into v_toast from pg_class where oid = v_rel;
  v_heap_blocks := extensions.pg_prewarm(v_rel);
  if v_toast is not null and v_toast <> 0 then
    v_toast_blocks := extensions.pg_prewarm(v_toast);
  end if;

  return jsonb_build_object('dim', dim, 'skipped', false,
    'heap_blocks', v_heap_blocks, 'toast_blocks', v_toast_blocks);
end;
$$;
