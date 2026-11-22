---
title: Retrieval
description: Understand source-scoped BM25 and hybrid retrieval, per-snapshot ranking, bounded fetches, continuation cursors, and internal references.
---

# Retrieval

Each loaded snapshot has a `DocumentationSearchService` backed by a read-only SQLite store. The MCP catalog layer selects services by exact selector, aggregates search groups, and presents fetch results with source metadata.

## Search input

Queries are treated as text, not executable SQL or arbitrary FTS syntax. Validation bounds query length to 256 characters and the tokenized query to 32 distinct terms. Unicode letters, numbers, and underscores form terms. A query without searchable tokens returns no results.

The engine quotes terms and combines alternatives. For multiple terms, an additional contiguous phrase clause improves phrase relevance while retaining individual-term recall. It rejects forbidden control characters and invalid result limits.

## Ranking within a source

SQLite FTS5 provides full-text matching, snippets, and weighted BM25 ranking across the indexed fields. Exact query terms in the page title and heading path add a bounded metadata boost, with title matches weighted above heading matches and total metadata contribution capped at 10% of the strongest BM25 score. Stable document and chunk identifiers break ties. Results include `chunkId`, `documentId`, title, canonical URL, source revision, excerpt, and the combined lexical score.

The engine has an internal result cap of 50, but the **public MCP contract caps the entire response at 10**. Internal engine limits are not extra MCP options.

## Optional snapshot embeddings

Snapshot builds may include one normalized 1024-dimensional Float32 vector for every canonical chunk. The vectors live in a separate `documentation_embeddings(chunk_id, embedding)` table and do not copy chunk text or add a foreign key to the FTS5 virtual table. The FTS5 schema and BM25 queries are unchanged.

Hybrid manifests record the supported Qwen3 model revision and ONNX artifact checksum along with dimensions, data type, pooling, normalization, query-instruction version, and embedding-pipeline version. Validation checks the metadata, exact Float32 BLOB size, vector normalization, and one-to-one chunk IDs against the corpus before promotion. Lexical-only snapshots omit both the metadata and the embeddings table.

When `search.semantic.enabled` is false or absent, serving uses only FTS5/BM25 and does not load the embedding runtime. When enabled, the query encoder runs once for a request. Each selected snapshot checks that its embedding metadata matches the query space, then runs exact dot-product retrieval over normalized Float32 vectors. A selected snapshot without compatible vectors is rejected with an instruction to build them; bundled snapshots are lexical-only and must be omitted from hybrid requests. NekoSearch never silently falls back to lexical retrieval when Semantic Search is enabled.

## Hybrid ranking

For each snapshot, NekoSearch retrieves up to 50 lexical and 50 semantic candidates, then applies equal-weight reciprocal rank fusion with `k = 60`. RRF uses 1-based positions and breaks equal fused scores by chunk ID. For a single-symbol query, if a lexical result title, heading URL, or excerpt contains that exact identifier, its highest-ranked lexical match is kept first after fusion; both retrievers still run and the result retains its RRF score. This narrow safeguard prevents semantic candidates from burying an exact API or decorator match. Fusion never crosses snapshot boundaries. The catalog then keeps its existing source order and round-robin result allocation up to the public total limit of 10. Lexical and semantic scores are not compared directly.

## Combining selected sources

The MCP layer resolves every selector before searching any index. It rejects unknown or duplicated selectors rather than dropping them or broadening the request.

Each source is searched independently. With hybrid search, fusion completes inside each source before results are allocated round-robin following the requested source order. Output remains grouped by source and preserves source-local ranking. Scores from different snapshots are not globally compared.

For a small budget and many sources, some groups can be empty even though their index has hits. Empty groups retain their source metadata; `totalResults` counts returned hits across all groups.

## Fetching sections

Fetch uses one selector and a deterministic document ID. If `sectionId` is supplied, the store resolves the chunk's section and returns rows with that section's heading path and canonical URL. A search hit's `chunkId` is the accepted section selector; fetching a section can therefore include several chunks belonging to it.

Missing documents or sections return `found: false` with empty sections/references. Invalid input or a stale cursor is an error, not a missing-document result.

## Response bounds and cursors

Fetch pagination uses a 12,000-character budget for section Markdown and section framing. It does not promise a 12,000-character limit for the entire JSON/text response envelope.

When content remains, the response sets `truncated: true` and supplies `nextCursor`. The cursor binds the documentation identity, document, optional section, revision, and selected content. Continue with the same selector, document ID, and section ID; changing that scope or using a stale cursor fails.

Treat cursors as opaque values. They are not offsets for callers to construct.

## Following references

New-format snapshots store resolved links with positions and target IDs. A fetched page returns at most 100 references whose complete link occurrence lies within the visible Markdown. Each contains the original `href`, target `documentId`, and optional `sectionId`.

Use those IDs with the same source selector to fetch the target offline. Reference following does not cross snapshots or fetch external URLs.

The exact public schemas and examples are in the [MCP Tool Reference](../mcp/tools.md).

For model installation, resource requirements, embedding builds, configuration, and licensing, see [Local Embeddings and Hybrid Search](../guides/hybrid-search.md).
