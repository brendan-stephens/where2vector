-- where2vector: hybrid search demo
--
-- Adds FTS (tsvector + GIN) to the inline (384-dim) table and a
-- bench_hybrid_knn RPC that runs vector KNN + full-text search in
-- parallel, then fuses results with Reciprocal Rank Fusion (RRF).
--
-- Only docs_384 gets the FTS column: it stores vectors inline (no TOAST),
-- so the search latency shows the pure cost of running two indexes and
-- the RRF fusion step, without TOAST I/O noise.

------------------------------------------------------------------------------
-- 1. Update existing docs_384 payloads so FTS finds real words.
--    Run this separately after the migration (too slow for the CLI timeout):
--
--    set statement_timeout = '600s';
--    do $$
--    declare
--      vocab text[] := array['alpha','beta','gamma','delta','epsilon','zeta','eta',
--        'theta','iota','kappa','lambda','mu','nu','xi','pi','rho','sigma','tau',
--        'fast','slow','cache','index','query','scan','heap','toast','disk',
--        'memory','vector','search','rank','score','embed','data','chunk',
--        'token','page','block','read','write','fetch','store'];
--    begin
--      update bench.docs_384
--      set payload = (
--        select string_agg(w, ' ')
--        from (
--          select vocab[1 + (floor(random() * array_length(vocab, 1)))::int] as w
--          from generate_series(1, 6)
--        ) words
--      );
--    end;
--    $$;
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- 2. Add stored tsvector column so FTS doesn't recompute on every query.
--    GENERATED ALWAYS AS … STORED means Postgres updates it on INSERT/UPDATE.
------------------------------------------------------------------------------
alter table bench.docs_384
  add column if not exists fts tsvector
    generated always as (to_tsvector('english', coalesce(payload, ''))) stored;

create index if not exists docs_384_fts_gin on bench.docs_384 using gin(fts);

------------------------------------------------------------------------------
-- 3. Update bench_seed for dim=384 to generate vocabulary-rich payloads
--    so newly seeded rows have words that FTS queries can match.
------------------------------------------------------------------------------
create or replace function public.bench_seed(dim int, n int)
returns bigint
language plpgsql
security definer
set search_path = bench, extensions, public
set statement_timeout = '300s'
as $$
declare
  v_table text    := public._bench_table(dim);
  vocab   text[]  := array[
    'alpha','beta','gamma','delta','epsilon','zeta','eta','theta','iota','kappa',
    'lambda','mu','nu','xi','pi','rho','sigma','tau','fast','slow','cache','index',
    'query','scan','heap','toast','disk','memory','vector','search','rank','score',
    'embed','data','chunk','token','page','block','read','write','fetch','store'
  ];
begin
  if dim = 384 then
    -- Static insert: table name is fixed, vocab available as a PL/pgSQL variable.
    insert into bench.docs_384 (embedding, payload)
    select
      array(select random()::real from generate_series(1, 384))::extensions.vector(384),
      (select string_agg(w, ' ')
       from (
         select vocab[1 + (floor(random() * array_length(vocab, 1)))::int] as w
         from generate_series(1, 6)
       ) words)
    from generate_series(1, n);
  else
    execute format(
      'insert into %s (embedding, payload) '
      'select array(select random()::real from generate_series(1, %s))::extensions.vector(%s), '
      '''row '' || gs '
      'from generate_series(1, %s) gs',
      v_table, dim, dim, n
    );
  end if;
  return n;
end;
$$;

------------------------------------------------------------------------------
-- 4. bench_hybrid_knn: vector KNN + FTS fused via Reciprocal Rank Fusion.
--
--    qvec        – query embedding as a pgvector literal "[x,x,…]"
--    query_text  – keyword query (passed to websearch_to_tsquery)
--    k           – number of final results
--    rrf_k       – RRF smoothing constant (default 60 per the original paper)
--
--    Algorithm:
--      1. Fetch top k*10 candidates from each source (over-fetch so RRF has
--         enough overlap candidates to re-rank meaningfully).
--      2. Assign rank 1…N within each source.
--      3. RRF score = 1/(rrf_k + rank_vec) + 1/(rrf_k + rank_fts).
--         A document missing from one source contributes 0 from that term.
--      4. Return top-k by combined score.
------------------------------------------------------------------------------
create or replace function public.bench_hybrid_knn(
  qvec       text,
  query_text text,
  k          int  default 10,
  rrf_k      int  default 60
)
returns table (id bigint)
language sql
security definer
set search_path = bench, extensions, public
set statement_timeout = '120s'
as $$
  with
  -- Vector leg: rank by L2 distance (same operator as the existing KNN benchmarks)
  vec_ranked as (
    select d.id, row_number() over (order by d.dist) as rn
    from (
      select id, embedding <-> qvec::extensions.vector(384) as dist
      from docs_384
      order by embedding <-> qvec::extensions.vector(384)
      limit k * 10
    ) d
  ),
  -- FTS leg: rank by ts_rank over the GIN-indexed tsvector column
  fts_ranked as (
    select d.id, row_number() over (order by d.score desc) as rn
    from (
      select id, ts_rank(fts, websearch_to_tsquery('english', query_text)) as score
      from docs_384
      where fts @@ websearch_to_tsquery('english', query_text)
      order by score desc
      limit k * 10
    ) d
  ),
  -- RRF fusion: score = 1/(rrf_k+rank_vec) + 1/(rrf_k+rank_fts)
  rrf as (
    select
      coalesce(v.id, f.id) as rid,
      coalesce(1.0 / (rrf_k + v.rn), 0.0) + coalesce(1.0 / (rrf_k + f.rn), 0.0) as score
    from vec_ranked v
    full outer join fts_ranked f on v.id = f.id
  )
  select rid from rrf order by score desc limit k;
$$;

grant execute on function
  public.bench_hybrid_knn(text, text, int, int),
  public.bench_seed(int, int)
to service_role;
