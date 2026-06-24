-- where2vector: extensions
-- pgvector for vector(d) columns + distance operators; pg_prewarm to warm a
-- table's pages into shared_buffers for the "warm" benchmark baseline.

create extension if not exists vector with schema extensions;
create extension if not exists pg_prewarm with schema extensions;
