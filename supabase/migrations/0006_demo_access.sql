-- where2vector: demo access config
--
-- DEMO-ONLY. These loosen defaults so the dashboard runs on the publishable
-- (anon) key with no server secret. Do NOT copy this into a production project.

-- 1) Expose the read-oriented benchmark RPCs to anon (the dashboard's key).
--    Seeding/truncation stay service_role-only.
grant execute on function
  public.bench_knn(int, text, int, boolean),
  public.bench_explain_knn(int, text, int, boolean),
  public.bench_prewarm(int),
  public.bench_toast_stats(),
  public.bench_statio(int)
to anon;

-- 2) The TOASTed exact-scan leg intentionally runs ~10s disk-bound queries, which
--    exceed the default 3s anon statement_timeout. Raise it for this demo project.
--    (Requires a PostgREST config reload to take effect: notify pgrst, 'reload config'.)
alter role anon set statement_timeout = '180s';

-- Vector Bucket operations still require the service-role key ("Access denied:
-- Invalid role" with anon), so the bucket leg uses SUPABASE_SERVICE_ROLE_KEY.
