-- where2vector: hybrid search on the Vector Bucket
--
-- Adds FTS infrastructure to docs_1536 so the bucket hybrid leg can fuse
-- S3 ANN results with Postgres keyword results in the API route.
--
-- The fusion pattern:
--   1. queryBucket(qvec, k*10)   → vector candidates (S3 ANN)
--   2. bench_fts_1536(text, k*10) → keyword candidates (GIN on docs_1536)
--   3. RRF in TypeScript          → top-k by combined score
--
-- This intentionally crosses the storage boundary: the bucket holds the
-- vectors; Postgres holds the text. The two indices run in parallel and
-- the application does the fusion — showing the "distributed hybrid"
-- architectural pattern vs. the single-query Postgres hybrid.

------------------------------------------------------------------------------
-- 1. Add stored tsvector column to docs_1536.
--    The existing payload is "row <n>" — re-seeding (see below) will replace
--    it with vocabulary words so FTS finds meaningful matches.
------------------------------------------------------------------------------
alter table bench.docs_1536
  add column if not exists fts tsvector
    generated always as (to_tsvector('english', coalesce(payload, ''))) stored;

create index if not exists docs_1536_fts_gin on bench.docs_1536 using gin(fts);

------------------------------------------------------------------------------
-- 2. Update bench_seed for both dims to use vocabulary-rich payloads.
--    Re-seed docs_1536 after applying this migration (TRUNCATE + batch calls)
--    so existing "row <n>" rows get replaced with searchable text.
------------------------------------------------------------------------------
create or replace function public.bench_seed(dim int, n int)
returns bigint
language plpgsql
security definer
set search_path = bench, extensions, public
set statement_timeout = '300s'
as $$
declare
  vocab text[] := array[
    'alpha','beta','gamma','delta','epsilon','zeta','eta','theta','iota','kappa',
    'lambda','mu','nu','xi','pi','rho','sigma','tau','fast','slow','cache','index',
    'query','scan','heap','toast','disk','memory','vector','search','rank','score',
    'embed','data','chunk','token','page','block','read','write','fetch','store'
  ];
begin
  if dim = 384 then
    insert into bench.docs_384 (embedding, payload)
    select
      array(select random()::real from generate_series(1, 384))::extensions.vector(384),
      (select string_agg(w, ' ')
       from (
         select vocab[1 + (floor(random() * array_length(vocab, 1)))::int] as w
         from generate_series(1, 6)
       ) words)
    from generate_series(1, n);

  elsif dim = 1536 then
    insert into bench.docs_1536 (embedding, payload)
    select
      array(select random()::real from generate_series(1, 1536))::extensions.vector(1536),
      (select string_agg(w, ' ')
       from (
         select vocab[1 + (floor(random() * array_length(vocab, 1)))::int] as w
         from generate_series(1, 6)
       ) words)
    from generate_series(1, n);

  else
    raise exception 'unsupported dim %, expected 384 or 1536', dim;
  end if;

  return n;
end;
$$;

------------------------------------------------------------------------------
-- 3. bench_fts_1536: FTS leg for the bucket hybrid scenario.
--
--    Returns the top-k rows from docs_1536 ranked by ts_rank, with their
--    ordinal rank (rn 1..k) so the API route can compute RRF scores without
--    a second round-trip.
--
--    The bucket hybrid leg calls this in parallel with queryBucket() and
--    fuses results via Reciprocal Rank Fusion in TypeScript.
------------------------------------------------------------------------------
create or replace function public.bench_fts_1536(
  query_text text,
  k          int default 100
)
returns table (id bigint, rn bigint)
language sql
security definer
set search_path = bench, extensions, public
set statement_timeout = '120s'
as $$
  select
    d.id,
    row_number() over (order by d.score desc) as rn
  from (
    select id, ts_rank(fts, websearch_to_tsquery('english', query_text)) as score
    from docs_1536
    where fts @@ websearch_to_tsquery('english', query_text)
    order by score desc
    limit k
  ) d;
$$;

grant execute on function
  public.bench_fts_1536(text, int),
  public.bench_seed(int, int)
to service_role;
