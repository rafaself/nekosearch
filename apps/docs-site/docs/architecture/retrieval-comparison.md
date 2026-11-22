---
title: Retrieval Comparison
description: Reproduce a small comparison of search excerpts, fetched sections, and direct Markdown pages.
---

# Retrieval Comparison

This benchmark compares NekoSearch's visible search excerpts and fetched sections with a full Markdown page selected from the same documentation snapshot. It uses six fixed queries, checks predefined evidence phrases, and reports retrieval calls and UTF-8 text bytes. It makes no model calls and blocks network access while running.

## Run the comparison

Use Node.js `24.15` or later, install the workspace dependencies, and make sure `nestjs@12` is installed in the NekoSearch catalog. The MCP protocol snapshot is bundled with the application.

```sh
npm install
npm run search:compare
```

The command builds the workspace and prints a JSON report. To select another user catalog or save a copy of the report:

```sh
NEKOSEARCH_EVALUATION_CATALOG_ROOT=/path/to/nekosearch \
NEKOSEARCH_RETRIEVAL_COMPARISON_OUTPUT=./retrieval-comparison.json \
npm run search:compare
```

The NestJS snapshot can be installed before running the comparison with `node apps/nekosearch/dist/apps/nekosearch/cli.js add nestjs@12`. That installation obtains the curated documentation from its official upstream source; the comparison itself is offline. No embedding model or paid service is needed.

## Queries and evidence

Every phrase in a row is required. The script checks the phrases against the full corpus, the selected canonical page, top-1 and top-3 search output, and the corresponding search-plus-fetch output. Matching ignores Markdown formatting, letter case, and repeated whitespace.

| Selector         | Query                            | Direct-page oracle path                      | Sufficient evidence phrases                                                                                                      |
| ---------------- | -------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `nestjs@12`      | `dependency injection providers` | `/providers`                                 | `can be injected as a dependency`; `runtime takes care of wiring up these objects`                                               |
| `nestjs@12`      | `ExecutionContext guards`        | `/guards`                                    | `guards, on the other hand, have access to the ExecutionContext instance`                                                        |
| `nestjs@12`      | `pipes validation DTO`           | `/application/validation`                    | `rules are decorators on a DTO class`                                                                                            |
| `mcp@2025-11-25` | `tool annotations`               | `/specification/2025-11-25/schema`           | `readOnlyHint?: boolean`; `openWorldHint?: boolean`; `all properties in ToolAnnotations are hints`                               |
| `mcp@2025-11-25` | `stdio transport`                | `/specification/2025-11-25/basic/transports` | `the client writes protocol messages to the server's standard input, and the server writes protocol messages to standard output` |
| `mcp@2025-11-25` | `resources URI templates`        | `/specification/2025-11-25/server/resources` | `resource templates allow servers to expose parameterized resources`; `"uriTemplate": "file:///{path}"`                          |

The direct-page paths are manually chosen oracle targets. The benchmark records each path and uses the full page Markdown stored in that snapshot's `corpus.json`; it does not discover the page by searching. It reports the snapshot revision so search results and the page baseline can be tied to the same source revision.

## Measurements

For each query, the report measures:

- **Search excerpt, top 1 and top 3:** one `search_docs` call with that result limit. Evidence is checked in the visible tool text.
- **Search and section fetch, top 1 and top 3:** one search call followed by one `fetch_docs` call per returned hit, using each hit's section ID. The top-3 case fetches all returned sections, up to three.
- **Direct Markdown:** one full-page read from the selected canonical path. Its path is supplied by the oracle, so page discovery is not counted.

Payload bytes are calculated with UTF-8 byte length over the visible MCP text output. The direct-page baseline measures the full stored Markdown text. JSON-RPC framing, structured-content duplication, and transport overhead are excluded. These are byte counts, not token estimates.

## Limits

This is a six-query corpus check, not a user study or a model-answer quality evaluation. Evidence matching is literal phrase containment after Markdown normalization; it does not judge whether other wording is semantically equivalent. The manually selected direct page is a perfect-path oracle, so it has an information advantage over search. Fetching every top-3 result describes a bounded retrieval workflow and does not model a client choosing one result adaptively. Results can change when the installed snapshot revision changes, and any moved or rewritten evidence phrases need corresponding case updates.
