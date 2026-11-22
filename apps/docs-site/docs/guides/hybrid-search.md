---
title: Local Embeddings and Hybrid Search
description: Install the optional Qwen3 model, build local embeddings, manage Semantic Search, and troubleshoot hybrid retrieval.
---

# Local Embeddings and Hybrid Search

NekoSearch always provides local SQLite FTS5 + BM25 lexical search. Semantic Search is an optional local feature: install Qwen3 explicitly, generate vectors for installed documentation, then enable hybrid retrieval. Lexical search remains available when the model is absent or Semantic Search is disabled. Inference runs on the local CPU and does not use Ollama or a hosted inference service.

## Lexical and Hybrid Search

| Mode    | Retrieval                                                  | Setup                                                                 | Best fit                                                                      |
| ------- | ---------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Lexical | SQLite FTS5 + BM25 with title and heading match boosts     | Included with NekoSearch                                              | Exact names, symbols, configuration keys, and phrase matches                  |
| Hybrid  | BM25 + exact semantic dot product + reciprocal rank fusion | Optional Qwen3 model, Transformers.js runtime, and compatible vectors | Natural-language questions and vocabulary that differs from the documentation |

Hybrid Search runs both retrievers independently within each selected snapshot. It takes up to 50 results from each, combines their 1-based ranks with equal-weight RRF using `k = 60`, and resolves ties by chunk ID. Lexical ranking adds a bounded boost for exact query terms in page titles and heading paths, capped at 10% of the strongest BM25 score. For a single-symbol query, an exact literal match in a lexical result's title, heading URL, or excerpt is kept first after fusion; both retrievers still run, and the result keeps its RRF score. This protects exact API and decorator lookups while retaining semantic candidates for the rest of the ranking. It does not compare raw BM25 and vector scores or fuse rankings across documentation versions. Existing source ordering and the MCP response limit remain unchanged.

Lexical search is always enabled. Semantic Search defaults to disabled. When it is enabled, every selected source must have a complete, compatible embedding set. Selecting a lexical-only snapshot, including the bundled `mcp@2025-11-25` reference, returns an actionable error; omit that source from the request or disable Semantic Search with `nekosearch embeddings disable`. The server never silently falls back to BM25 for an incomplete hybrid request.

## Search benchmark results

The `nestjs-hybrid-search-v2` evaluation measured 32 queries across NestJS 11 and 12, for 64 query/version evaluations. Queries covered exact classes, decorators, methods, configuration keys, framework concepts, ambiguous terms, and English and Portuguese natural-language questions. Each case has one relevant target page. These measurements are the November 18, 2026 release baseline, before the title and heading match boost described above; they do not measure this ranking update. The run used Linux x64, Node.js `24.22.2`, Transformers.js `4.3.2`, and ONNX Runtime Node `1.30.0`. The [evaluation script](https://github.com/rafaself/nekosearch/blob/main/scripts/evaluation/evaluate-search.mjs) blocks network access and uses local model files.

| Retrieval | Recall@5 | MRR@10 | nDCG@10 | p50 latency | p95 latency |
| --------- | -------: | -----: | ------: | ----------: | ----------: |
| BM25      |    0.906 |  0.728 |   0.780 |      6.3 ms |     15.9 ms |
| Hybrid    |    0.938 |  0.753 |   0.804 |    181.9 ms |    202.3 ms |

For 11 exact-symbol queries evaluated against both versions (22 query/version evaluations), BM25 scored Recall@5 `1.000`, MRR@10 `0.812`, and nDCG@10 `0.860`; Hybrid scored `1.000`, `0.826`, and `0.871`. No exact-symbol target-rank regressions were measured after adding the literal-match safeguard.

Results varied by query group. For ambiguous terminology, Hybrid Recall@5 and nDCG@10 improved from `0.800` to `0.900` and `0.726` to `0.747`, while MRR@10 declined from `0.700` to `0.663`. For technical concepts, Hybrid Recall@5 declined from `1.000` to `0.917`, MRR@10 from `0.882` to `0.854`, and nDCG@10 from `0.911` to `0.869`. These results describe this small evaluation set and do not establish a general quality advantage for Hybrid Search.

Hybrid's higher latency includes one local query embedding plus both retrieval paths and fusion. Model initialization with the first query took `1,698 ms`; sampled document embedding throughput was `3.149` documents per second (24 sampled chunks from 2,960 snapshot chunks). Process RSS was `271,753,216` bytes before model load and peaked at `1,604,591,616` bytes during evaluation. These are observed measurements, not performance or hardware guarantees.

## Requirements and resource use

- NekoSearch requires Node.js 24.15.0 or newer. Node.js 25.9.0 is tested, and Node.js 26 LTS is recommended for new installations.
- Qwen3 inference requires Linux x64, Node.js 24.15.0 or newer, Transformers.js `4.3.2`, and ONNX Runtime Node `1.30.0`. Offline inference was tested on Node.js `24.22.2`, `24.22.3`, `25.9.0`, and `26.13.1` with CPU execution and model dtype `q8`. The model release records its original validation environment.
- Public model release: approximately 625 MB (624,978,804 bytes across all eight release assets); the ONNX weights are 613,527,631 bytes. Keep additional free space for staging and temporary files during installation.
- The explicit Transformers.js runtime install occupied 758,284,875 bytes of file content in the Node.js 24.22.2 / npm 11.19.1 Linux x64 validation environment. Together with the model release, reserve about 1.4 GB before accounting for snapshot vectors or npm cache; lexical-only installs avoid this runtime footprint.
- Inference is CPU-only in this release. In the measured NestJS 11/12 evaluation, process RSS peaked at 1,604,591,616 bytes (about 1.50 GiB), compared with 271,753,216 bytes for BM25 before model load. This is an observed Linux x64 run, not a guaranteed minimum; actual memory use depends on the host and workload, and no official minimum RAM requirement is published.
- Embeddings add one 4,096-byte Float32 BLOB per chunk, plus SQLite overhead. They do not copy document text.

A lexical-only npm install skips the model and runtime. On Linux x64, choose **Install now** in setup or run `nekosearch model install` to install both together. The command installs the pinned Transformers.js `4.3.2` and ONNX Runtime Node `1.30.0` with npm under the application-data directory. npm verifies their package integrity using the bundled lockfile. An existing compatible runtime is reused.

`nekosearch model install` downloads the fixed `qwen3-embedding-0.6b-v1.0.0` GitHub Release from [rafaself/nekosearch-models](https://github.com/rafaself/nekosearch-models/releases/tag/qwen3-embedding-0.6b-v1.0.0). It downloads only the selected Q8 ONNX model, its tokenizer/configuration, manifest, checksums, license, and notice. The model is pinned to upstream commit `c25a394dd583836952667c12f008335071b3f43d` in `onnx-community/Qwen3-Embedding-0.6B-ONNX`; it never follows a branch at install time.

```

If you installed NekoSearch globally, run `npm install --global @huggingface/transformers@4.3.2` under the same Node.js installation. This keeps the runtime available when the MCP client launches NekoSearch from another directory.sh
nekosearch model install
nekosearch model status
```

Installation uses a hidden staging directory, verifies the pinned manifest and every SHA-256 digest, then atomically activates the model. Interrupted downloads can resume; retries are bounded. A staged or incomplete directory is not considered installed. `model status` reports the version, upstream revision, model directory, artifact integrity, runtime availability, and inference readiness.

The default model directory is under NekoSearch's persistent application-data directory: Linux and macOS use `$XDG_DATA_HOME/nekosearch/models/qwen3-embedding-0.6b/1.0.0` or `~/.local/share/nekosearch/models/qwen3-embedding-0.6b/1.0.0`; Windows uses `%LOCALAPPDATA%\nekosearch\models\qwen3-embedding-0.6b\1.0.0` (falling back to a `nekosearch` child in the home directory if `LOCALAPPDATA` is unset).

To use a different exact directory, pass `--dir` to each model command and export `NEKOSEARCH_MODEL_DIR` for embedding commands and the MCP server:

```sh
nekosearch model install --dir /data/nekosearch/qwen3
nekosearch model status --dir /data/nekosearch/qwen3
export NEKOSEARCH_MODEL_DIR=/data/nekosearch/qwen3
```

`nekosearch model remove` removes only files owned by a verified NekoSearch installation. It refuses while Semantic Search is enabled; disable Semantic Search first. Unmanaged files in the directory are preserved.

```sh
nekosearch embeddings disable
nekosearch model remove
```

## Build embeddings for existing documentation

After installing the runtime and model, generate embeddings from the canonical corpus already stored in each installed snapshot:

```sh
nekosearch embeddings build
nekosearch embeddings status
```

To build only one source/version:

```sh
nekosearch embeddings build nestjs@12
nekosearch embeddings status nestjs@12
```

For the complete later-install sequence after lexical ingestion, use:

```sh
npm install --global @huggingface/transformers@4.3.2
nekosearch model install
nekosearch model status
nekosearch embeddings build nestjs@12
nekosearch embeddings status nestjs@12
nekosearch embeddings enable
```

The command reads persisted chunks; it does not contact GitHub, rediscover documents, download source files, or parse Markdown again. Valid vectors are reused when the chunk identity/content and complete embedding metadata match. New or incompatible vectors are generated in batches. Each snapshot is staged and validated before atomic promotion; a failed or interrupted build leaves that snapshot's active version unchanged. Re-running a completed build is idempotent.

`embeddings status` reports each source identifier, model compatibility, total chunks, valid embedded chunks, missing vectors, invalid vectors, completion percentage, and snapshot integrity. Build all installed sources before enabling Semantic Search.

## Enable or disable Semantic Search

Use the CLI to validate prerequisites and update the configuration safely:

```sh
nekosearch embeddings enable
nekosearch embeddings status
nekosearch embeddings disable
```

Enable fails if the model is absent or invalid, the inference runtime is unavailable, or an installed snapshot has missing/incompatible embeddings. Its error names the source and prints `nekosearch embeddings build <source@version>`. With no installed documentation sources, enabling is allowed so future ingestion can create vectors automatically.

The configuration file is `nekosearch.yaml` in the current directory, or the path named by `NEKOSEARCH_CONFIG`:

```yaml
search:
  semantic:
    enabled: true
```

`embeddings disable` sets the flag to `false` and preserves the model and vectors. Restart the MCP server after changing configuration. Removing Qwen3 while Semantic Search is enabled is blocked; disable first so the server cannot be left configured without its runtime.

## Troubleshooting

- If `model status` reports `not-installed`, run `nekosearch model install` while online. A corrupt or unmanaged target is never overwritten; inspect the reported directory and choose an explicit `--dir` if needed.
- If artifact integrity is invalid, do not enable Semantic Search. Remove a verified managed installation with `nekosearch model remove` after disabling Semantic Search, then reinstall from the pinned release.
- If inference is unavailable, check `model status` for the exact requirement. The runtime requires Linux x64 and Node.js 24.15.0 or later with `@huggingface/transformers@4.3.2` and its `onnxruntime-node@1.30.0` dependency.
- If enable reports missing or invalid vectors, run its suggested `nekosearch embeddings build <source@version>` command, then `nekosearch embeddings status` and retry `nekosearch embeddings enable`.
- If an MCP request fails because a selected snapshot is lexical-only, remove that selector from the request's `sources` or run `nekosearch embeddings disable`; hybrid search does not fall back silently.
- If the config changed while the MCP server was running, restart the client process so it loads the updated setting.

## Offline operation

The model install is the only model-related step that needs a network connection. Install the runtime and model once, and subsequent vector generation, status checks, model integrity checks, and local MCP inference use local files. MCP server startup and searches do not download models. Serving requires the local catalog and SQLite snapshots but no network connection.

Ingesting a new curated or GitHub-hosted documentation source requires its normal HTTPS download. Ingesting a local directory or portable snapshot, rebuilding vectors from saved chunks, and lexical or hybrid search over already installed snapshots can run offline.

## Model licensing and attribution

The original [Qwen3-Embedding-0.6B model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3) declares Apache-2.0. The pinned [ONNX conversion](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX/tree/c25a394dd583836952667c12f008335071b3f43d) identifies that model as its base and attributes the conversion to Xenova/ONNX Community; its model card does not declare a separate license field. The converter's [licensing statement](https://huggingface.co/Xenova/bge-m3/discussions/9) says converted quantizations follow their source model license. The NekoSearch model release includes the Apache-2.0 license text and a `NOTICE` recording this attribution and license basis. The NekoSearch application itself is MIT licensed.

## Embedding metadata in snapshots

Each hybrid snapshot manifest identifies the exact embedding space used for every vector:

| Field                              | Current value                                                      |
| ---------------------------------- | ------------------------------------------------------------------ |
| `modelId`                          | `qwen3-embedding-0.6b`                                             |
| `modelRevision`                    | `c25a394dd583836952667c12f008335071b3f43d`                         |
| `modelArtifactSha256`              | `87cd124e0ef1fd1f223ebc283efccbaeac386d0b08344701c46975d0657b591f` |
| `embeddingDimensions` / `dataType` | `1024` / `float32`                                                 |
| `pooling` / `normalization`        | `last_token` / `l2`                                                |
| `queryInstructionVersion`          | `qwen3-software-docs-v1`                                           |
| `embeddingPipelineVersion`         | `nekosearch-qwen3-embedding-v1`                                    |

SQLite stores the vectors in `documentation_embeddings(chunk_id, embedding)`, keyed by canonical chunk ID. A valid 1024-element Float32 vector occupies 4,096 bytes. Integrity validation checks vector length and values, chunk relationships, complete coverage, and compatibility metadata before a snapshot can be activated. Lexical-only snapshots remain valid without an embedding table or embedding metadata.

See [Retrieval Architecture](../architecture/retrieval.md) for the query path and [Snapshot Guide](./snapshots.md) for snapshot lifecycle details.
