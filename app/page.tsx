"use client";

import { useEffect, useState } from "react";
import type { BenchmarkResponse, ScenarioResult } from "@/lib/bench";

const SCENARIO_COLORS: Record<string, string> = {
  inline_384: "var(--green)",
  toast_1536: "var(--red)",
  bucket_1536: "var(--blue)",
  hybrid_384: "var(--purple)",
  bucket_hybrid: "var(--teal)",
};

interface TableStat {
  dim: number;
  est_rows: number;
  heap_bytes: number;
  toast_bytes: number;
  index_bytes: number;
  total_bytes: number;
}

interface BucketInfo {
  bucket: string;
  index: string;
  dimension: number;
  dataType: string;
  distanceMetric: string;
  vectors: number | null;
  estBytes: number | null;
}

export default function Page() {
  const [queries, setQueries] = useState(3);
  const [k, setK] = useState(10);
  const [concurrency, setConcurrency] = useState(1);
  const [searchType, setSearchType] = useState<"knn" | "ann" | "hybrid">("knn");
  const [prewarm, setPrewarm] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BenchmarkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<TableStat[] | null>(null);
  const [bucketInfo, setBucketInfo] = useState<BucketInfo | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => {
        setStats(d.tables ?? null);
        setBucketInfo(d.bucket ?? null);
      })
      .catch(() => {});
  }, [result]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const useIndex = searchType === "ann" || searchType === "hybrid";
      const scenarios = searchType === "hybrid"
        ? ["inline_384", "hybrid_384", "bucket_hybrid"]
        : ["inline_384", "toast_1536", "bucket_1536"];
      const r = await fetch("/api/benchmark", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries, k, concurrency, useIndex, prewarm: searchType !== "hybrid" && prewarm, scenarios }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "benchmark failed");
      setResult(d as BenchmarkResponse);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRunning(false);
    }
  }

  const maxP95 = result
    ? Math.max(1, ...result.results.filter((r) => r.available).map((r) => r.p95 ?? 0))
    : 1;

  const toastLeg = result?.results.find((r) => r.id === "toast_1536");

  return (
    <div className="wrap">
      <h1>where2vector</h1>
      <p className="sub">
        {searchType === "hybrid" ? (
          <>How does full-text search change vector query latency? Hybrid combines{" "}
          <strong>vector search</strong> with <strong>GIN full-text search</strong>, fused by{" "}
          <strong>Reciprocal Rank Fusion</strong>.</>
        ) : (
          <>When does vector search hit disk? Compare query latency across{" "}
          <strong>pgvector inline (no TOAST)</strong>, <strong>pgvector TOASTed</strong>, and{" "}
          <strong>Supabase Vector Buckets</strong>.</>
        )}
      </p>

      <div className="panel">
        <div className="controls">
          <div className="field field-full">
            <label>Search type</label>
            <div className="seg">
              {(["knn", "ann", "hybrid"] as const).map((t) => (
                <button
                  key={t}
                  className={`seg-btn${searchType === t ? " active" : ""}`}
                  onClick={() => setSearchType(t)}
                >
                  {t === "knn" ? "KNN — exact" : t === "ann" ? "ANN — HNSW" : "Hybrid — vector + FTS"}
                </button>
              ))}
            </div>
          </div>

          <div className="tldr field-full">
            <SearchTypeTldr type={searchType} />
          </div>

          <div className="field">
            <label>Queries</label>
            <input type="number" min={1} max={200} value={queries} onChange={(e) => setQueries(+e.target.value)} />
            <small className="field-desc">Total queries per storage leg — more = stable percentiles</small>
          </div>
          <div className="field">
            <label>Top-K</label>
            <input type="number" min={1} max={100} value={k} onChange={(e) => setK(+e.target.value)} />
            <small className="field-desc">Nearest neighbours to return per query (LIMIT clause)</small>
          </div>
          <div className="field">
            <label>Concurrency</label>
            <input type="number" min={1} max={32} value={concurrency} onChange={(e) => setConcurrency(+e.target.value)} />
            <small className="field-desc">Parallel queries in flight — watch queries/sec across legs</small>
          </div>
          <div className="field">
            <label>Options</label>
            {searchType === "hybrid" ? (
              <p className="option-note">Prewarm not applicable — hybrid queries via HNSW; cache warmth isn&apos;t the variable being tested here.</p>
            ) : (
              <div className="checks">
                <label>
                  <input type="checkbox" checked={prewarm} onChange={(e) => setPrewarm(e.target.checked)} />
                  Prewarm into shared_buffers (warm baseline)
                </label>
              </div>
            )}
          </div>
          <button className="run" onClick={run} disabled={running}>
            {running ? "Running…" : "Run benchmark"}
          </button>
        </div>
        {error && <p className="err" style={{ marginTop: 12 }}>⚠ {error}</p>}
      </div>

      {result && (
        <>
          <div className="panel">
            <h2>End-to-end query latency</h2>
            <div className="legend">
              <span><span className="dot" style={{ background: "var(--muted)" }} />p50</span>
              <span><span className="dot" style={{ background: "var(--text)" }} />p95</span>
              <span><span className="dot" style={{ background: "var(--amber)" }} />p99</span>
            </div>
            <div className="chart">
              {result.results.map((r) => (
                <LatencyRow key={r.id} r={r} max={maxP95} />
              ))}
            </div>
            <p className="note-box">
              {result.queries} queries · top-{result.k} · concurrency {result.concurrency} ·{" "}
              {result.results.some((r) => r.id === "hybrid_384")
                ? "ANN + hybrid (HNSW + GIN + RRF)"
                : result.useIndex ? "ANN — HNSW index" : "KNN — exact seq scan"}{" "}
              {!result.results.some((r) => r.id === "hybrid_384") && `· ${result.prewarm ? "prewarmed" : "no prewarm"}`}
              {result.concurrency > 1 && (
                <>
                  {" "}— watch <strong>queries/sec</strong> per leg below: it&apos;s how each engine handles
                  parallel load. (Concurrent exact scans on one table can <em>share</em> disk reads via
                  Postgres synchronized scans, so the TOASTed leg&apos;s throughput often scales even though
                  each query stays slow.)
                </>
              )}
            </p>
          </div>

          {toastLeg?.server && (
            <div className="panel">
              <h2>Disk attribution — the TOASTed leg{result.useIndex ? " (HNSW)" : ""}</h2>
              <div className="io-grid">
                <IoCard
                  lab="Read from disk / query"
                  value={fmtBlocksBytes(toastLeg.server.sharedReadBlocks)}
                  note={`${fmtInt(toastLeg.server.sharedReadBlocks)} × 8 KB pages not in shared_buffers — fetched from disk.`}
                />
                <IoCard
                  lab="Served from cache / query"
                  value={fmtBlocksBytes(toastLeg.server.sharedHitBlocks)}
                  note={`${fmtInt(toastLeg.server.sharedHitBlocks)} pages straight from shared_buffers (no disk).`}
                />
                <IoCard
                  lab="TOAST pages read"
                  value={fmtInt(toastLeg.server.toastBlksRead)}
                  note={`Disk reads against the TOAST relation across ${result.queries} queries — ≈0 for the 384-dim leg.`}
                />
                <IoCard
                  lab="I/O read time"
                  value={toastLeg.server.ioReadMs == null ? "n/a" : fmtMs(toastLeg.server.ioReadMs)}
                  note="Needs track_io_timing (superuser-only on Supabase) — use bytes-from-disk instead."
                />
              </div>
              {result.useIndex ? (
                <p className="note-box">
                  <strong>TOAST pages read ≈ 0 — and that&apos;s the point.</strong> HNSW stores a copy
                  of every vector <em>inside the index</em>, so the search walks index pages and
                  computes distances from those copies — it never de-TOASTs the heap. The disk cost
                  doesn&apos;t vanish, it moves: the 1536 HNSW index is{" "}
                  {fmtBytes(stats?.find((s) => s.dim === 1536)?.index_bytes ?? null)} (see the Index
                  column below), a second on-disk copy of the vectors. Exact KNN pays ~1.2 GB of TOAST
                  reads on every query; HNSW pays once at build time.
                </p>
              ) : (
                <p className="note-box">
                  Exact KNN scans <strong>all {fmtInt(stats?.find((s) => s.dim === 1536)?.est_rows ?? null)} rows</strong>
                  {" "}and evaluates <code>embedding &lt;-&gt; query</code> for each — so it
                  <strong> de-TOASTs every scanned row&apos;s 1536-dim vector</strong> to compute the
                  distance, not just the 10 it returns (the result set is only <code>id</code>s, stored
                  inline). That TOAST relation is larger than shared_buffers, so the scan re-reads ~1.2 GB
                  from disk on every query. The 384-dim leg reads its vectors straight from the heap
                  tuple — no TOAST. Switch on <strong>HNSW</strong> and TOAST reads drop to ≈0: the index
                  walk reads vector copies from the index, never the heap. (Larger vectors also cost more
                  distance CPU; the bytes-from-disk figure isolates the storage component.)
                </p>
              )}
            </div>
          )}

          {result.results.some((r) => r.id === "hybrid_384" && r.available) && (
            <HybridPanel k={result.k} inlineLeg={result.results.find((r) => r.id === "inline_384")} />
          )}

          {result.results.some((r) => !r.available) && (
            <div className="panel">
              <h2>Unavailable legs</h2>
              {result.results
                .filter((r) => !r.available)
                .map((r) => (
                  <p key={r.id} className="unavail">
                    <strong>{r.label}</strong>: {r.note}
                  </p>
                ))}
            </div>
          )}
        </>
      )}

      {stats && (
        <div className="panel">
          <h2>Storage layout (proof)</h2>
          <table className="stats">
            <thead>
              <tr>
                <th>Table</th>
                <th>Est. rows</th>
                <th>Heap</th>
                <th>TOAST</th>
                <th>Index</th>
                <th>Total</th>
                <th>TOASTed?</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.dim}>
                  <td>docs_{s.dim} (vector({s.dim}))</td>
                  <td>{fmtInt(s.est_rows)}</td>
                  <td>{fmtBytes(s.heap_bytes)}</td>
                  <td>{fmtBytes(s.toast_bytes)}</td>
                  <td>{fmtBytes(s.index_bytes)}</td>
                  <td>{fmtBytes(s.total_bytes)}</td>
                  <td className={isToasted(s) ? "toast-yes" : "toast-no"}>
                    {isToasted(s) ? "yes" : "no"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note-box">
            <code>vector(384)</code> = 1544 B fits inline (no TOAST). <code>vector(1536)</code> = 6152 B
            exceeds Postgres&apos; ~2 KB tuple threshold and spills to a TOAST relation.
          </p>

          <h2 style={{ marginTop: 24 }}>Vector Bucket (S3)</h2>
          {bucketInfo ? (
            <>
              <table className="stats">
                <thead>
                  <tr>
                    <th>Bucket / index</th>
                    <th>Vectors</th>
                    <th>Dimension</th>
                    <th>Data type</th>
                    <th>Metric</th>
                    <th>Raw vector size</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{bucketInfo.bucket} / {bucketInfo.index}</td>
                    <td>{fmtInt(bucketInfo.vectors)}</td>
                    <td>{bucketInfo.dimension}</td>
                    <td>{bucketInfo.dataType}</td>
                    <td>{bucketInfo.distanceMetric}</td>
                    <td>≈ {fmtBytes(bucketInfo.estBytes)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="note-box">
                Holds the <strong>same 1536-dim float32 vectors as <code>docs_1536</code></strong>
                {" "}(mirrored by key), using <strong>{bucketInfo.distanceMetric}</strong> distance to
                match pgvector&apos;s L2 <code>&lt;-&gt;</code>. The <strong>raw vector size</strong> is an
                estimate ({fmtInt(bucketInfo.vectors)} × {bucketInfo.dimension} × 4 B) — the S3 API
                doesn&apos;t report actual on-disk footprint (which also includes ANN index structures).
                For comparison that&apos;s about the same payload as the heap+TOAST of <code>docs_1536</code>
                {" "}(~1.2 GB) and its HNSW index (~790 MB).{" "}
                {result?.useIndex ? (
                  <>
                    With <strong>HNSW selected</strong>, the pgvector legs also do{" "}
                    <strong>approximate (ANN)</strong> search — so this is <strong>ANN vs ANN</strong>{" "}
                    across storage engines: a local HNSW index (vectors cached in RAM/on local disk) vs
                    S3 object storage. Same data, same metric — the difference is where the index lives.
                  </>
                ) : (
                  <>
                    The bucket does <strong>approximate (ANN)</strong> search while the{" "}
                    <strong>exact-KNN</strong> pgvector legs scan everything — the access-method tradeoff,
                    not a data difference. Toggle <strong>HNSW</strong> on for an ANN-vs-ANN comparison.
                  </>
                )}
              </p>
            </>
          ) : (
            <p className="unavail">
              Bucket metadata unavailable — add SUPABASE_SERVICE_ROLE_KEY and run <code>npm run seed</code>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const TLDR: Record<"knn" | "ann" | "hybrid", { running: string; lookFor: string }> = {
  knn: {
    running: "Full sequential scan on all 3 storage backends. Every row is fetched and its distance to the query vector computed — no index skips any work.",
    lookFor: "The TOASTed leg (1536-dim) reads ≈ 1.2 GB from disk per query because each distance computation requires de-TOASTing the vector from a separate storage relation. The inline leg (384-dim) keeps vectors in the heap tuple — no extra fetch. That gap is pure storage cost, not query complexity.",
  },
  ann: {
    running: "HNSW index walk on all 3 backends. The index stores a copy of every vector; the heap and TOAST relation are never touched during search.",
    lookFor: "TOAST reads drop to ≈ 0 for the 1536-dim leg — the index already has the vectors. The latency gap between inline and TOASTed should nearly disappear. The remaining difference is index size: a 1536-dim HNSW index is ~5× larger than a 384-dim one, so more pages to walk.",
  },
  hybrid: {
    running: "Three bars, two architectures — all using ANN (HNSW). Inline ANN is the vector-only baseline. Inline hybrid: a single Postgres query runs HNSW + GIN in parallel and fuses with RRF as a SQL CTE — the database does everything. Bucket hybrid: S3 ANN and Postgres GIN run in parallel network calls; RRF happens in application code.",
    lookFor: "Inline ANN → Inline hybrid gap shows the GIN scan + RRF overhead when search stays inside Postgres. Inline hybrid → Bucket hybrid gap shows what the distributed pattern adds: two network round-trips instead of one SQL query, plus application-layer fusion. Same result quality, different latency profile.",
  },
};

function SearchTypeTldr({ type }: { type: "knn" | "ann" | "hybrid" }) {
  const { running, lookFor } = TLDR[type];
  return (
    <div className="tldr-box">
      <div className="tldr-row">
        <span className="tldr-label">Running</span>
        <span className="tldr-text">{running}</span>
      </div>
      <div className="tldr-row">
        <span className="tldr-label">Look&nbsp;for</span>
        <span className="tldr-text">{lookFor}</span>
      </div>
    </div>
  );
}

function HybridPanel({ k, inlineLeg }: { k: number; inlineLeg: ScenarioResult | undefined }) {
  const rrfK = 60;
  const examples = [1, 2, 3, 4].map((rank) => ({
    rank,
    score: (1 / (rrfK + rank)).toFixed(4),
  }));

  return (
    <div className="panel">
      <h2>Hybrid search — how it works</h2>
      <p className="note-box" style={{ borderColor: "var(--purple)" }}>
        Each query runs <strong>two indexes in parallel</strong>: an <strong>HNSW vector index</strong> (ANN,
        L2 distance on 384-dim inline embeddings) and a <strong>GIN full-text index</strong> (
        <code>tsvector</code> column, queried with a random vocabulary word). Results are fused with{" "}
        <strong>Reciprocal Rank Fusion</strong>: score&nbsp;=&nbsp;1/(60+rank<sub>vec</sub>)&nbsp;+&nbsp;1/(60+rank
        <sub>fts</sub>). A document missing from one source contributes 0 from that term; top-{k} by
        combined score are returned.
        {inlineLeg?.p50 != null && (
          <>
            {" "}The ANN-only inline baseline runs in ~{fmtMs(inlineLeg.p50)} (p50); the extra time above
            that is the GIN scan + RRF overhead.
          </>
        )}
      </p>
      <div className="rrf-diagram">
        <div className="rrf-col">
          <div className="rrf-head">Vector ANN (HNSW)</div>
          {examples.map(({ rank, score }) => (
            <div key={rank} className="rrf-item">rank {rank} → {score}</div>
          ))}
          <div className="rrf-item" style={{ color: "var(--muted)" }}>…</div>
        </div>
        <div className="rrf-plus">+</div>
        <div className="rrf-col">
          <div className="rrf-head">Full-text (GIN)</div>
          {examples.map(({ rank, score }) => (
            <div key={rank} className="rrf-item">rank {rank} → {score}</div>
          ))}
          <div className="rrf-item" style={{ color: "var(--muted)" }}>…</div>
        </div>
        <div className="rrf-plus">→</div>
        <div className="rrf-col">
          <div className="rrf-head">RRF score (combined)</div>
          {[
            { label: "in both  rank 1+1", score: (2 / (rrfK + 1)).toFixed(4) },
            { label: "vec rank 1, fts miss", score: (1 / (rrfK + 1)).toFixed(4) },
            { label: "vec rank 3, fts rank 2", score: (1 / (rrfK + 3) + 1 / (rrfK + 2)).toFixed(4) },
            { label: "fts only rank 1", score: (1 / (rrfK + 1)).toFixed(4) },
          ].map(({ label, score }) => (
            <div key={label} className="rrf-item">{label} → {score}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LatencyRow({ r, max }: { r: ScenarioResult; max: number }) {
  const color = SCENARIO_COLORS[r.id] ?? "var(--green)";
  return (
    <div className="row">
      <div className="name">
        {r.label}
        {!r.available && <small className="unavail">unavailable</small>}
        {r.available && r.throughput != null && (
          <small>{r.throughput.toFixed(r.throughput < 10 ? 1 : 0)} queries/sec</small>
        )}
        {r.available && r.prewarmInfo && <small>{r.prewarmInfo}</small>}
      </div>
      {r.available ? (
        <div className="bars">
          <Bar tag="p50" ms={r.p50} max={max} color={color} alpha={0.55} />
          <Bar tag="p95" ms={r.p95} max={max} color={color} alpha={0.8} />
          <Bar tag="p99" ms={r.p99} max={max} color={color} alpha={1} />
        </div>
      ) : (
        <div className="unavail">{r.note}</div>
      )}
    </div>
  );
}

function Bar({ tag, ms, max, color, alpha }: { tag: string; ms: number | null; max: number; color: string; alpha: number }) {
  const pct = ms == null ? 0 : Math.max(2, (ms / max) * 100);
  return (
    <div className="bar-line">
      <span className="bar-tag">{tag}</span>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%`, background: color, opacity: alpha }} />
      </div>
      <span className="bar-val">{fmtMs(ms)}</span>
    </div>
  );
}

function IoCard({ lab, value, note }: { lab: string; value: string; note: string }) {
  return (
    <div className="io-card">
      <div className="lab">{lab}</div>
      <div className="big">{value}</div>
      <div className="note">{note}</div>
    </div>
  );
}

function fmtMs(v: number | null): string {
  if (v == null) return "—";
  if (v < 1) return `${v.toFixed(2)} ms`;
  if (v < 100) return `${v.toFixed(1)} ms`;
  return `${Math.round(v)} ms`;
}
function fmtInt(v: number | null): string {
  return v == null ? "—" : v.toLocaleString();
}
function fmtBlocksBytes(blocks: number | null): string {
  return blocks == null ? "—" : fmtBytes(blocks * 8192);
}
// Every table with a toastable column gets an ~8 KB empty TOAST relation. Only
// count it as TOASTed when it actually holds out-of-line data (> 64 KB).
function isToasted(s: TableStat): boolean {
  return s.toast_bytes > 65536;
}
function fmtBytes(v: number | null): string {
  if (v == null) return "—";
  if (v === 0) return "0";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = v;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
