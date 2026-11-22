import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { isDeepStrictEqual } from 'node:util';
import { DocumentationSearchService } from '@nestjs-docs/documentation-engine/application/services/documentation-search.service.js';
import type { DocumentationSearchResult } from '@nestjs-docs/documentation-engine/application/contracts/documentation-reader.contract.js';
import {
  DocumentationEmbeddingSpaceSchema,
  type DocumentationEmbeddingSpace,
} from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import { SQLiteDocumentationStore } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/sqlite-documentation-store.js';
import { SemanticRetriever } from '@nestjs-docs/documentation-engine/retrieval/retrievers/semantic-retriever.js';
import {
  hybridSearchRanking,
  LEXICAL_RETRIEVAL_TOP_K,
  SEMANTIC_RETRIEVAL_TOP_K,
} from '@nestjs-docs/documentation-engine/retrieval/fusion/reciprocal-rank-fusion.js';
import { fetchDocumentation } from './mcp/documentation-tool-handlers.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-metadata.js';
import {
  catalogFetchDocsInputSchema,
  catalogFetchDocsOutputSchema,
  catalogListDocsInputSchema,
  catalogListDocsOutputSchema,
  catalogSearchDocsInputSchema,
  catalogSearchDocsOutputSchema,
  MAX_SEARCH_SOURCES,
  MAX_TOTAL_SEARCH_RESULTS,
  type CatalogDocumentationSource,
  type CatalogSearchDocsInput,
  type CatalogSearchDocsOutput,
} from './catalog-contract.js';
import {
  listCatalogIndexes,
  type DocumentationCatalogEntry,
} from './catalog.js';
import { UsageStatsStore } from './usage-stats.js';

const serverInstructions =
  'Call list_docs to discover the documentation selectors available in this session. Search one or more exact selectors with search_docs, then pass a result group selector and document ID to fetch_docs. Pass a result chunkId as fetch_docs sectionId when you want that section. Results are grouped by source. Cite the returned source URL and revision.';

interface CatalogSearchRuntime {
  entry: DocumentationCatalogEntry;
  documentation: DocumentationSearchService;
  store: SQLiteDocumentationStore;
  semanticRetriever?: SemanticRetriever;
}

export interface SearchableCatalogRuntime {
  entry: Pick<DocumentationCatalogEntry, 'source' | 'version' | 'revision'> &
    Partial<Pick<DocumentationCatalogEntry, 'status'>>;
  documentation: Pick<DocumentationSearchService, 'search'>;
  semanticRetriever?: Pick<SemanticRetriever, 'embeddingSpace' | 'search'>;
}

export interface SemanticQueryEmbeddingProvider {
  embeddingSpace: DocumentationEmbeddingSpace;
  embedQuery(query: string): Promise<Float32Array>;
}

type CatalogSearchHit = DocumentationSearchResult;

export async function serve(): Promise<void> {
  const entries = await listCatalogIndexes();
  const { resolveConfiguredEmbeddingProvider } =
    await import('./semantic-search.js');
  const configuredEmbeddingProvider =
    await resolveConfiguredEmbeddingProvider();
  if (
    configuredEmbeddingProvider &&
    typeof configuredEmbeddingProvider.embedQuery !== 'function'
  ) {
    throw new Error(
      'Semantic Search is enabled, but the configured embedding provider cannot embed queries.',
    );
  }
  const queryEmbeddingProvider: SemanticQueryEmbeddingProvider | undefined =
    configuredEmbeddingProvider
      ? {
          embeddingSpace: configuredEmbeddingProvider.embeddingSpace,
          embedQuery: configuredEmbeddingProvider.embedQuery!,
        }
      : undefined;
  const runtimes: CatalogSearchRuntime[] = [];
  let runtimesBySelector: Map<string, CatalogSearchRuntime>;
  try {
    for (const entry of entries) {
      const store = new SQLiteDocumentationStore(
        entry.databasePath,
        entry.manifest,
      );
      const runtime: CatalogSearchRuntime = {
        entry,
        store,
        documentation: new DocumentationSearchService(store, entry.manifest),
      };
      runtimes.push(runtime);
      if (entry.manifest.embeddings && configuredEmbeddingProvider) {
        runtime.semanticRetriever = new SemanticRetriever(
          store,
          entry.manifest.embeddings,
          configuredEmbeddingProvider.embeddingSpace,
        );
      }
    }
    runtimesBySelector = indexRuntimesBySelector(runtimes);
  } catch (error) {
    for (const runtime of runtimes) runtime.store.close();
    throw error;
  }

  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
    },
    {
      instructions: serverInstructions,
    },
  );
  const usageStats = new UsageStatsStore(undefined, Date.now, (error) => {
    process.stderr.write(
      `MCP usage statistics could not be stored (${getErrorClass(error)}).\n`,
    );
  });
  server.registerTool(
    'list_docs',
    {
      description:
        'Lists documentation available to this serve session. Returns only each canonical selector, source, version, and revision; use a selector with search_docs or fetch_docs.',
      inputSchema: catalogListDocsInputSchema,
      outputSchema: catalogListDocsOutputSchema,
      annotations: readOnlyAnnotations,
    },
    (input) =>
      usageStats.record('list_docs', input, () =>
        runTool('list_docs', () =>
          listCatalogDocumentation(runtimesBySelector.values()),
        ),
      ),
  );
  registerSearchDocsTool(
    server,
    runtimesBySelector,
    queryEmbeddingProvider,
    usageStats,
  );
  server.registerTool(
    'fetch_docs',
    {
      description:
        'Fetches a document from one exact selector returned by list_docs or a search result group. Pass the documentId and optional sectionId from that group; use the result chunkId as sectionId. The structured response includes up to 100 resolved internal links fully visible on this page, each with offline-fetchable target IDs. External and unresolved links remain in the Markdown. Use a returned cursor to continue a truncated excerpt.',
      inputSchema: catalogFetchDocsInputSchema,
      outputSchema: catalogFetchDocsOutputSchema,
      annotations: readOnlyAnnotations,
    },
    (input) =>
      usageStats.record('fetch_docs', input, () =>
        runTool('fetch_docs', () => {
          const runtime = findRuntime(runtimesBySelector, input.selector);
          const result = fetchDocumentation(runtime.documentation, {
            documentId: input.documentId,
            sectionId: input.sectionId,
            cursor: input.cursor,
          });
          return {
            ...result,
            structuredContent: {
              ...result.structuredContent,
              ...documentationSource(runtime),
            },
          };
        }),
      ),
  );

  const stores = runtimes.map((runtime) => runtime.store);
  process.once('exit', () => closeStores(stores));
  process.once('SIGINT', () => shutdown(server, stores, 130));
  process.once('SIGTERM', () => shutdown(server, stores, 143));

  await server.connect(new StdioServerTransport());
  process.stderr.write('NekoSearch MCP server ready on stdio\n');
}

/** Register the public search tool with the globally configured retrieval mode. */
export function registerSearchDocsTool(
  server: McpServer,
  runtimesBySelector: ReadonlyMap<string, SearchableCatalogRuntime>,
  embeddingProvider?: SemanticQueryEmbeddingProvider,
  usageStats = new UsageStatsStore(),
): void {
  server.registerTool(
    'search_docs',
    {
      description: `Searches only the 1 to ${MAX_SEARCH_SOURCES} exact selectors in sources. Get selectors from list_docs. Results are grouped by selector and preserve each snapshot's lexical or fused ranking; limit caps the total response at ${MAX_TOTAL_SEARCH_RESULTS} hits across all groups.`,
      inputSchema: catalogSearchDocsInputSchema,
      outputSchema: catalogSearchDocsOutputSchema,
      annotations: readOnlyAnnotations,
    },
    (input) => {
      return usageStats.record('search_docs', input, () => {
        if (!embeddingProvider) {
          return runTool('search_docs', () =>
            searchCatalogDocumentation(runtimesBySelector, input),
          );
        }
        return runAsyncTool('search_docs', () =>
          searchCatalogDocumentationWithSemantic(
            runtimesBySelector,
            input,
            embeddingProvider,
          ),
        );
      });
    },
  );
}

export function searchCatalogDocumentation(
  runtimesBySelector: ReadonlyMap<string, SearchableCatalogRuntime>,
  input: CatalogSearchDocsInput,
): {
  content: [{ type: 'text'; text: string }];
  structuredContent: CatalogSearchDocsOutput;
} {
  // Resolve every selector before querying any index. Unknown selectors never
  // broaden the request to the rest of the catalog.
  const selectedRuntimes = resolveRequestedRuntimes(
    runtimesBySelector,
    input.sources,
  );
  const totalBudget = input.limit ?? MAX_TOTAL_SEARCH_RESULTS;
  const rankedResults = selectedRuntimes.map((runtime) =>
    runtime.documentation.search(input.query, totalBudget),
  );
  return formatCatalogSearchResults(
    selectedRuntimes,
    rankedResults,
    totalBudget,
  );
}

/** Embed the query once, fuse rankings independently within each snapshot. */
export async function searchCatalogDocumentationWithSemantic(
  runtimesBySelector: ReadonlyMap<string, SearchableCatalogRuntime>,
  input: CatalogSearchDocsInput,
  embeddingProvider: SemanticQueryEmbeddingProvider,
): Promise<{
  content: [{ type: 'text'; text: string }];
  structuredContent: CatalogSearchDocsOutput;
}> {
  const selectedRuntimes = resolveRequestedRuntimes(
    runtimesBySelector,
    input.sources,
  );
  const queryEmbeddingSpace = DocumentationEmbeddingSpaceSchema.parse(
    embeddingProvider.embeddingSpace,
  );
  const incompatibleRuntimes = selectedRuntimes.filter(
    (runtime) =>
      !runtime.semanticRetriever ||
      !isDeepStrictEqual(
        runtime.semanticRetriever.embeddingSpace,
        queryEmbeddingSpace,
      ),
  );
  if (incompatibleRuntimes.length > 0) {
    const unavailableSources = incompatibleRuntimes.map((runtime) => {
      const selector = selectorFor(runtime.entry);
      if (runtime.entry.status === 'bundled') {
        return `${selector} is a bundled lexical-only snapshot; omit it from sources or disable Semantic Search with nekosearch embeddings disable`;
      }
      return `${selector} has no compatible embeddings; run nekosearch embeddings build ${selector}`;
    });
    throw new Error(
      `Semantic Search is enabled, but compatible embeddings are unavailable for selected sources: ${unavailableSources.join('; ')}. Semantic Search does not fall back to lexical retrieval.`,
    );
  }

  const lexicalRankings = selectedRuntimes.map((runtime) =>
    runtime.documentation.search(input.query, LEXICAL_RETRIEVAL_TOP_K),
  );
  const queryVector = await embeddingProvider.embedQuery(input.query);
  const fusedRankings = selectedRuntimes.map((runtime, index) => {
    const semanticRetriever = runtime.semanticRetriever!;
    const semanticResults = semanticRetriever.search(
      queryVector,
      SEMANTIC_RETRIEVAL_TOP_K,
    );
    return hybridSearchRanking(
      input.query,
      lexicalRankings[index] ?? [],
      semanticResults,
      LEXICAL_RETRIEVAL_TOP_K,
    );
  });
  const totalBudget = input.limit ?? MAX_TOTAL_SEARCH_RESULTS;
  return formatCatalogSearchResults(
    selectedRuntimes,
    fusedRankings,
    totalBudget,
  );
}

function formatCatalogSearchResults(
  selectedRuntimes: SearchableCatalogRuntime[],
  rankedResults: DocumentationSearchResult[][],
  totalBudget: number,
): {
  content: [{ type: 'text'; text: string }];
  structuredContent: CatalogSearchDocsOutput;
} {
  const resultsBySource = selectedRuntimes.map(() => [] as CatalogSearchHit[]);

  let totalResults = 0;
  for (let rank = 0; totalResults < totalBudget; rank += 1) {
    let foundAtRank = false;
    for (
      let sourceIndex = 0;
      sourceIndex < rankedResults.length;
      sourceIndex += 1
    ) {
      const hit = rankedResults[sourceIndex]?.[rank];
      if (!hit) continue;
      resultsBySource[sourceIndex]?.push(hit);
      totalResults += 1;
      foundAtRank = true;
      if (totalResults === totalBudget) break;
    }
    if (!foundAtRank) break;
  }

  const groups = selectedRuntimes.map((runtime, index) => ({
    ...documentationSource(runtime),
    results: resultsBySource[index] ?? [],
  }));
  const structuredContent: CatalogSearchDocsOutput = {
    groups,
    totalResults,
  };
  return {
    content: [{ type: 'text', text: formatSearchGroups(groups, totalResults) }],
    structuredContent,
  };
}

export function listCatalogDocumentation(
  runtimes: Iterable<SearchableCatalogRuntime>,
): {
  content: [{ type: 'text'; text: string }];
  structuredContent: { sources: CatalogDocumentationSource[] };
} {
  const sources = [...runtimes].map(documentationSource);
  const text = sources.length
    ? [
        'Documentation available in this session:',
        ...sources.map(
          ({ selector, source, version, revision }) =>
            `- ${selector} (source: ${source}, version: ${version}, revision: ${revision})`,
        ),
      ].join('\n')
    : 'No documentation sources are available in this session.';
  return {
    content: [{ type: 'text', text }],
    structuredContent: { sources },
  };
}

function formatSearchGroups(
  groups: CatalogSearchDocsOutput['groups'],
  totalResults: number,
): string {
  if (totalResults === 0) {
    return `No matching documentation found in ${groups.map(({ selector }) => selector).join(', ')}.`;
  }
  return groups
    .map(({ selector, revision, results }) => {
      const header = `## ${selector}\nRevision: ${revision}`;
      if (results.length === 0)
        return `${header}\nNo matching documentation found.`;
      const formattedResults = results.map((hit, index) =>
        [
          `### ${index + 1}. ${hit.title}`,
          `Document ID: ${hit.documentId}`,
          `Section ID: ${hit.chunkId}`,
          `Source revision: ${hit.sourceRevision}`,
          `Source: ${hit.canonicalUrl}`,
          `Excerpt: ${hit.excerpt}`,
        ].join('\n'),
      );
      return [header, ...formattedResults].join('\n\n');
    })
    .join('\n\n');
}

function resolveRequestedRuntimes(
  runtimesBySelector: ReadonlyMap<string, SearchableCatalogRuntime>,
  selectors: string[],
): SearchableCatalogRuntime[] {
  const duplicateSelectors = selectors.filter(
    (selector, index) => selectors.indexOf(selector) !== index,
  );
  if (duplicateSelectors.length > 0) {
    throw new Error(
      `Source selectors may appear only once: ${[...new Set(duplicateSelectors)].join(', ')}.`,
    );
  }

  const unknownSelectors = selectors.filter(
    (selector) => !runtimesBySelector.has(selector),
  );
  if (unknownSelectors.length > 0) {
    throw new Error(
      `Unknown documentation selector${unknownSelectors.length === 1 ? '' : 's'}: ${unknownSelectors.join(', ')}. Call list_docs and use exact selectors from its response.`,
    );
  }
  return selectors.map((selector) => runtimesBySelector.get(selector)!);
}

function indexRuntimesBySelector(
  runtimes: CatalogSearchRuntime[],
): Map<string, CatalogSearchRuntime> {
  const indexed = new Map<string, CatalogSearchRuntime>();
  for (const runtime of runtimes) {
    const selector = selectorFor(runtime.entry);
    if (indexed.has(selector)) {
      throw new Error(
        `Catalog contains more than one documentation source for selector ${selector}.`,
      );
    }
    indexed.set(selector, runtime);
  }
  return indexed;
}

function findRuntime(
  runtimesBySelector: Map<string, CatalogSearchRuntime>,
  selector: string,
): CatalogSearchRuntime {
  const runtime = runtimesBySelector.get(selector);
  if (!runtime) {
    throw new Error(
      `Unknown documentation selector: ${selector}. Call list_docs and use an exact selector from its response.`,
    );
  }
  return runtime;
}

function documentationSource(
  runtime: SearchableCatalogRuntime,
): CatalogDocumentationSource {
  const { source, version, revision } = runtime.entry;
  return {
    selector: selectorFor(runtime.entry),
    source,
    version,
    revision,
  };
}

function selectorFor(
  entry: Pick<DocumentationCatalogEntry, 'source' | 'version'>,
): string {
  return `${entry.source}@${entry.version}`;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function runTool<T>(name: string, handler: () => T): T {
  const startedAt = Date.now();
  try {
    const result = handler();
    if (process.env.DEBUG === '1')
      process.stderr.write(
        `MCP tool ${name} success in ${Date.now() - startedAt} ms\n`,
      );
    return result;
  } catch (error) {
    if (process.env.DEBUG === '1')
      process.stderr.write(
        `MCP tool ${name} failure in ${Date.now() - startedAt} ms (${getErrorClass(error)}).\n`,
      );
    throw error;
  }
}

function runAsyncTool<T>(name: string, handler: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  return handler().then(
    (result) => {
      if (process.env.DEBUG === '1')
        process.stderr.write(
          `MCP tool ${name} success in ${Date.now() - startedAt} ms\n`,
        );
      return result;
    },
    (error: unknown) => {
      if (process.env.DEBUG === '1')
        process.stderr.write(
          `MCP tool ${name} failure in ${Date.now() - startedAt} ms (${getErrorClass(error)}).\n`,
        );
      throw error;
    },
  );
}

function shutdown(
  server: McpServer,
  stores: SQLiteDocumentationStore[],
  exitCode: number,
): void {
  process.exitCode = exitCode;
  void server
    .close()
    .catch((error: unknown) => {
      process.stderr.write(`MCP shutdown failed: ${formatError(error)}\n`);
    })
    .finally(() => closeStores(stores));
}

function closeStores(stores: SQLiteDocumentationStore[]): void {
  for (const store of stores) store.close();
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

function getErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  return error.name.replace(/[^A-Za-z0-9_.$]/gu, '').slice(0, 100) || 'Error';
}
