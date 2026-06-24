-- where2vector: read vectors out of a bench table as float arrays.
-- Used by the seed script to mirror the EXACT docs_1536 vectors into the Vector
-- Bucket, so the bucket and the TOASTed pgvector leg hold identical data.

create or replace function public.bench_fetch_batch(dim int, after_id bigint, lim int)
returns table (id bigint, e real[])
language plpgsql
security definer
set search_path = bench, extensions, public
set statement_timeout = '120s'
as $$
begin
  return query execute format(
    'select id, embedding::real[] from %s where id > %s order by id limit %s',
    public._bench_table(dim), after_id, lim
  );
end;
$$;

grant execute on function public.bench_fetch_batch(int, bigint, int) to service_role;
