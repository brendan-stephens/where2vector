-- where2vector: server-side seed helpers
--
-- Vectors are generated *inside* Postgres (random reals via generate_series) so
-- we never push gigabytes of float data over the wire. The seed script just
-- calls bench_seed in batches until it hits the target row count.

create or replace function public.bench_seed(dim int, n int)
returns bigint
language plpgsql
security definer
set search_path = bench, extensions, public
set statement_timeout = '300s'  -- batches can be large; override the role's short PostgREST timeout
as $$
declare
  v_table text := public._bench_table(dim);
begin
  execute format(
    'insert into %s (embedding, payload) '
    || 'select array(select random()::real from generate_series(1, %s))::extensions.vector(%s), '
    || '''row '' || gs '
    || 'from generate_series(1, %s) gs',
    v_table, dim, dim, n
  );
  return n;
end;
$$;

create or replace function public.bench_truncate(dim int)
returns void
language plpgsql
security definer
set search_path = bench, extensions, public
as $$
begin
  execute format('truncate table %s restart identity', public._bench_table(dim));
end;
$$;

create or replace function public.bench_analyze(dim int)
returns void
language plpgsql
security definer
set search_path = bench, extensions, public
as $$
begin
  execute format('analyze %s', public._bench_table(dim));
end;
$$;

create or replace function public.bench_count(dim int)
returns bigint
language plpgsql
security definer
set search_path = bench, extensions, public
as $$
declare
  v_n bigint;
begin
  execute format('select count(*) from %s', public._bench_table(dim)) into v_n;
  return v_n;
end;
$$;

grant execute on function
  public.bench_seed(int, int),
  public.bench_truncate(int),
  public.bench_analyze(int),
  public.bench_count(int)
to service_role;
