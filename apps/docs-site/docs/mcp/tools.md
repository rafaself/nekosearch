---
title: Tool Reference
description: Exact MCP tool inputs and structured outputs for discovering sources, scoped search, section fetching, pagination, and internal references.
---

# Tool Reference

NekoSearch registers three tools: `list_docs`, `search_docs`, and `fetch_docs`. All inputs are strict objects: unknown fields are rejected. Responses include readable `content` text and schema-validated `structuredContent`.

The request examples below are the parameters of MCP `tools/call`, not complete JSON-RPC envelopes. Response examples show `structuredContent`. The bundled-source search and fetch were captured from the actual server; IDs are complete and copyable.

## list_docs

Discover the sources loaded at server startup.

**Input:** an empty object. No paths, filters, or optional fields.

```json
{
  "name": "list_docs",
  "arguments": {}
}
```

On a fresh installation, the structured response contains the bundled reference:

```json
{
  "sources": [
    {
      "selector": "mcp@2025-11-25",
      "source": "mcp",
      "version": "2025-11-25",
      "revision": "2025-11-25"
    }
  ]
}
```

Each source has `selector`, `source`, `version`, and `revision` strings. Installed sources appear alongside the bundled source. The tool does not expose filesystem paths.

Use these selectors exactly. After catalog changes, restart the server before rediscovering sources.

## search_docs

Search only the requested sources and return separate ranked groups.

| Field     | Type         | Required | Constraints                                                                                   |
| --------- | ------------ | -------- | --------------------------------------------------------------------------------------------- |
| `query`   | string       | Yes      | Trimmed, nonblank, at most 256 characters; engine allows at most 32 distinct searchable terms |
| `sources` | string array | Yes      | 1–5 exact selectors; no duplicates                                                            |
| `limit`   | integer      | No       | 1–10 **total** hits across all groups; defaults to 10                                         |

Selector strings are nonblank, exclude control characters, and have a maximum length of 321 characters. They are not fuzzy names or filesystem paths. Queries containing forbidden control characters fail engine validation; punctuation-only text can produce no matches.

Retrieval mode is controlled globally by `search.semantic.enabled` in `nekosearch.yaml`; `search_docs` has no per-request retriever option. When disabled, search uses SQLite FTS5 + BM25 and does not load a model. When enabled, it embeds the query locally once and reuses that vector across the selected sources, then fuses BM25 and semantic rankings within each snapshot. Every selected source must have complete, compatible embeddings. Selecting the bundled lexical-only MCP snapshot in hybrid mode returns an actionable tool error; the server does not fall back silently. See [Local Embeddings and Hybrid Search](../guides/hybrid-search.md).

::: code-group

```json [Request]
{
  "name": "search_docs",
  "arguments": {
    "query": "stdio transport",
    "sources": ["mcp@2025-11-25"],
    "limit": 1
  }
}
```

```json [Structured output]
{
  "groups": [
    {
      "selector": "mcp@2025-11-25",
      "source": "mcp",
      "version": "2025-11-25",
      "revision": "2025-11-25",
      "results": [
        {
          "chunkId": "mcp-spec:v2025-11-25:2e16f531c762b6be1169a1b20b73fa8ed34dfee9eef87ab3a8f1be797df8cb62:b3d5fe0d875a077fb6828687a4a00e017e12178ac20287937de2a98b61e6dfdd",
          "documentId": "mcp-spec:v2025-11-25:2e16f531c762b6be1169a1b20b73fa8ed34dfee9eef87ab3a8f1be797df8cb62",
          "title": "MCP transports",
          "canonicalUrl": "https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#standard-input-and-output",
          "sourceRevision": "2025-11-25",
          "excerpt": "## Standard input and output\n\nThe stdio transport is intended for a client that starts a server as a local process. The client writes protocol messages to the server's standard input, and the server writes protocol messages to standard output. Standard output is reserved for protocol traffic; diagnostic logs belong on standard error. A stdio server should not start an unrelated network listener.",
          "score": 4.571562874598401
        }
      ]
    }
  ],
  "totalResults": 1
}
```

:::

### Search output

| Field                                             | Meaning                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `groups`                                          | One group per requested source, preserving request order, including empty groups |
| Group `selector`, `source`, `version`, `revision` | Source identity and pinned revision                                              |
| Group `results`                                   | Ranked hits allocated from this source within the total budget                   |
| `totalResults`                                    | Number of returned hits across all groups                                        |

Every hit contains `chunkId`, `documentId`, `title`, `canonicalUrl`, `sourceRevision`, `excerpt`, and numeric `score`. Treat identifiers as opaque. The excerpt is bounded plain Markdown selected around matching query terms when possible. A final `… [Excerpt truncated]` marks omitted section content. `canonicalUrl` links to the indexed section; pass `chunkId` as `sectionId` to `fetch_docs` for the full Markdown or a continuation cursor. Scores rank hits within an index and are not a cross-source confidence measure.

For multiple sources, NekoSearch allocates hits round-robin by rank and requested source order until `limit` is exhausted. Some groups can be empty when the budget is small. An unknown selector fails the request; it never triggers an all-catalog fallback.

## fetch_docs

Fetch a document or section from exactly one snapshot.

| Field        | Type   | Required | Constraints                                                                |
| ------------ | ------ | -------- | -------------------------------------------------------------------------- |
| `selector`   | string | Yes      | Exact selector from `list_docs` or a search group                          |
| `documentId` | string | Yes      | Trimmed, nonblank, at most 512 characters; no forbidden control characters |
| `sectionId`  | string | No       | 1–256 characters; use a search hit's `chunkId`                             |
| `cursor`     | string | No       | Continuation value returned by fetch, at most 110 characters               |

::: code-group

```json [Request]
{
  "name": "fetch_docs",
  "arguments": {
    "selector": "mcp@2025-11-25",
    "documentId": "mcp-spec:v2025-11-25:2e16f531c762b6be1169a1b20b73fa8ed34dfee9eef87ab3a8f1be797df8cb62",
    "sectionId": "mcp-spec:v2025-11-25:2e16f531c762b6be1169a1b20b73fa8ed34dfee9eef87ab3a8f1be797df8cb62:b3d5fe0d875a077fb6828687a4a00e017e12178ac20287937de2a98b61e6dfdd"
  }
}
```

```json [Structured output]
{
  "documentationId": "mcp",
  "documentationVersion": "2025-11-25",
  "documentId": "mcp-spec:v2025-11-25:2e16f531c762b6be1169a1b20b73fa8ed34dfee9eef87ab3a8f1be797df8cb62",
  "sectionId": "mcp-spec:v2025-11-25:2e16f531c762b6be1169a1b20b73fa8ed34dfee9eef87ab3a8f1be797df8cb62:b3d5fe0d875a077fb6828687a4a00e017e12178ac20287937de2a98b61e6dfdd",
  "found": true,
  "title": "MCP transports",
  "sourceRevision": "2025-11-25",
  "sections": [
    {
      "headingPath": "MCP transports > Standard input and output",
      "canonicalUrl": "https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#standard-input-and-output",
      "markdown": "## Standard input and output\n\nThe stdio transport is intended for a client that starts a server as a local process. The client writes protocol messages to the server's standard input, and the server writes protocol messages to standard output. Standard output is reserved for protocol traffic; diagnostic logs belong on standard error. A stdio server should not start an unrelated network listener.\n"
    }
  ],
  "references": [],
  "truncated": false,
  "nextCursor": null,
  "selector": "mcp@2025-11-25",
  "source": "mcp",
  "version": "2025-11-25",
  "revision": "2025-11-25"
}
```

:::

### Fetch output

| Field                                       | Meaning                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| `documentationId`, `documentationVersion`   | Documentation identity from the index                                            |
| `selector`, `source`, `version`, `revision` | Selected catalog source metadata                                                 |
| `documentId`, `sectionId`                   | Requested document and section; `sectionId` is null for a whole-document request |
| `found`                                     | Whether the document/section exists                                              |
| `title`, `sourceRevision`                   | Document metadata, null when not found                                           |
| `sections`                                  | Objects with `headingPath`, `canonicalUrl`, and `markdown`                       |
| `references`                                | Up to 100 resolved internal links visible in this response page                  |
| `truncated`                                 | Whether more selected content remains                                            |
| `nextCursor`                                | Opaque continuation string, or null when complete                                |

A section fetch can include multiple stored chunks from the same section. Missing documents or sections return `found: false`, null metadata, empty arrays, `truncated: false`, and `nextCursor: null`. Unknown selectors and invalid input produce errors instead.

### Continue a truncated fetch

Fetch uses a 12,000-character budget for section Markdown plus section framing, not for the complete response envelope. When `truncated` is true, call `fetch_docs` again with the **same** selector, document ID, and optional section ID, adding the returned `nextCursor` as `cursor`.

Cursors have a hash-and-offset wire format validated by the input schema. Do not construct, shorten, or edit them. They bind the selected content and revision; mismatched or stale cursors fail. Restart the fetch without a cursor after changing scope or snapshot content.

### Follow internal references

New snapshots resolve links within their own corpus. For the [custom documentation example](../guides/custom-documentation.md), a whole-document fetch returns this reference:

```json
{
  "href": "./authentication.md#bearer-tokens",
  "documentId": "documentation:v1:55fe8f2d6a8bc269d3c62ddb917e6fbb07fa9b2468b61165195f2d901dc8d23c",
  "sectionId": "documentation:v1:55fe8f2d6a8bc269d3c62ddb917e6fbb07fa9b2468b61165195f2d901dc8d23c:657c23b70eebeac37e659583aa3ef9b6b1b41374bc33a746f90a7df8d0968af6"
}
```

Fetch its target with the same selector:

```json
{
  "name": "fetch_docs",
  "arguments": {
    "selector": "my-api@1",
    "documentId": "documentation:v1:55fe8f2d6a8bc269d3c62ddb917e6fbb07fa9b2468b61165195f2d901dc8d23c",
    "sectionId": "documentation:v1:55fe8f2d6a8bc269d3c62ddb917e6fbb07fa9b2468b61165195f2d901dc8d23c:657c23b70eebeac37e659583aa3ef9b6b1b41374bc33a746f90a7df8d0968af6"
  }
}
```

Only links completely visible in the fetched page are returned as references. External and unresolved URLs remain in the Markdown and are not fetched by the server.

## Failure behavior

- Missing fields, unknown fields, out-of-range limits, malformed cursors, and duplicate source selectors fail validation.
- Unknown selectors instruct callers to use `list_docs`; requests never silently broaden to other sources.
- A valid search with no matches returns empty result arrays and `totalResults: 0`.
- A missing document or section is a successful `found: false` result.
- Invalid/stale continuation cursors are errors, not missing-document responses.

The MCP SDK surfaces validation and execution failures through its protocol/tool error handling. Clients should inspect errors rather than treating them as empty search results.
