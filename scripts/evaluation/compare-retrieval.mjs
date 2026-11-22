#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DocumentationCorpusSchema } from '@nestjs-docs/documentation-engine/domain/documentation.schemas.js';
import { DocumentationSearchService } from '@nestjs-docs/documentation-engine/application/services/documentation-search.service.js';
import { SQLiteDocumentationStore } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/sqlite-documentation-store.js';
import {
  fetchDocumentation,
  searchDocumentation,
} from '../../apps/nekosearch/dist/apps/nekosearch/mcp/documentation-tool-handlers.js';
import {
  getCatalogIndex,
  getUserCatalogDirectory,
} from '../../apps/nekosearch/dist/apps/nekosearch/catalog.js';

const cases = [
  {
    selector: 'nestjs@12',
    query: 'dependency injection providers',
    oraclePath: '/providers',
    sufficientEvidence: [
      'can be injected as a dependency',
      'runtime takes care of wiring up these objects',
    ],
  },
  {
    selector: 'nestjs@12',
    query: 'ExecutionContext guards',
    oraclePath: '/guards',
    sufficientEvidence: [
      'guards, on the other hand, have access to the ExecutionContext instance',
    ],
  },
  {
    selector: 'nestjs@12',
    query: 'pipes validation DTO',
    oraclePath: '/application/validation',
    sufficientEvidence: ['rules are decorators on a DTO class'],
  },
  {
    selector: 'mcp@2025-11-25',
    query: 'tool annotations',
    oraclePath: '/specification/2025-11-25/schema',
    sufficientEvidence: [
      'readOnlyHint?: boolean',
      'openWorldHint?: boolean',
      'all properties in ToolAnnotations are hints',
    ],
  },
  {
    selector: 'mcp@2025-11-25',
    query: 'stdio transport',
    oraclePath: '/specification/2025-11-25/basic/transports',
    sufficientEvidence: [
      "the client writes protocol messages to the server's standard input, and the server writes protocol messages to standard output",
    ],
  },
  {
    selector: 'mcp@2025-11-25',
    query: 'resources URI templates',
    oraclePath: '/specification/2025-11-25/server/resources',
    sufficientEvidence: [
      'resource templates allow servers to expose parameterized resources',
      '"uriTemplate": "file:///{path}"',
    ],
  },
];

const catalogRoot =
  process.env.NEKOSEARCH_EVALUATION_CATALOG_ROOT?.trim() ||
  getUserCatalogDirectory();
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('Network access is disabled during retrieval comparison');
};

const snapshots = new Map();
try {
  for (const selector of new Set(cases.map(({ selector }) => selector))) {
    const entry = await getCatalogIndex(selector, { catalogRoot });
    if (!entry) {
      throw new Error(
        `Missing documentation snapshot ${selector}. Install it before running the comparison.`,
      );
    }
    const corpus = DocumentationCorpusSchema.parse(
      JSON.parse(
        readFileSync(join(dirname(entry.databasePath), 'corpus.json'), 'utf8'),
      ),
    );
    const normalizedCorpus = normalizeMarkdown(
      corpus.documents.map(({ markdown }) => markdown).join('\n'),
    );
    const store = new SQLiteDocumentationStore(
      entry.databasePath,
      entry.manifest,
    );
    snapshots.set(selector, {
      entry,
      corpus,
      normalizedCorpus,
      store,
      documentation: new DocumentationSearchService(store, entry.manifest),
    });
  }

  const results = cases.map((testCase) => {
    const snapshot = snapshots.get(testCase.selector);
    if (!snapshot)
      throw new Error(`Snapshot was not loaded: ${testCase.selector}`);
    const { entry, corpus, normalizedCorpus, documentation } = snapshot;
    const corpusEvidence = inspectNormalizedEvidence(
      normalizedCorpus,
      testCase.sufficientEvidence,
    );
    const oraclePage = corpus.documents.find(
      (document) =>
        new URL(document.canonicalUrl).pathname === testCase.oraclePath,
    );
    const directMarkdown = oraclePage?.markdown;

    const top1Search = searchDocumentation(documentation, {
      query: testCase.query,
      limit: 1,
    });
    const top3Search = searchDocumentation(documentation, {
      query: testCase.query,
      limit: 3,
    });
    const top1Text = visibleToolText(top1Search);
    const top3Text = visibleToolText(top3Search);
    const top1Expanded = expandResults(documentation, testCase, top1Search);
    const top3Expanded = expandResults(documentation, testCase, top3Search);

    return {
      selector: testCase.selector,
      sourceRevision: entry.revision,
      query: testCase.query,
      sufficientEvidence: testCase.sufficientEvidence,
      corpusEvidence,
      directMarkdown: {
        oracleSelection: 'Manually selected canonical page path',
        canonicalPath: testCase.oraclePath,
        available: Boolean(oraclePage),
        evidence: directMarkdown
          ? inspectEvidence(directMarkdown, testCase.sufficientEvidence)
          : null,
        retrievalCalls: oraclePage ? 1 : 0,
        payloadBytesUtf8: directMarkdown
          ? Buffer.byteLength(directMarkdown)
          : 0,
      },
      searchExcerpt: {
        top1: {
          resultCount: top1Search.structuredContent.results.length,
          retrievalCalls: 1,
          payloadBytesUtf8: Buffer.byteLength(top1Text),
          evidence: inspectEvidence(top1Text, testCase.sufficientEvidence),
        },
        top3: {
          resultCount: top3Search.structuredContent.results.length,
          retrievalCalls: 1,
          payloadBytesUtf8: Buffer.byteLength(top3Text),
          evidence: inspectEvidence(top3Text, testCase.sufficientEvidence),
        },
      },
      searchThenSectionFetch: {
        top1: top1Expanded,
        top3: top3Expanded,
      },
    };
  });

  const report = {
    benchmark: 'retrieval-vs-direct-markdown-v1',
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      network: 'disabled',
      modelCalls: 0,
      tokenizer: null,
    },
    method: {
      evidence:
        'Every listed normalized literal phrase must appear for a query to count as covered. The report checks corpus-wide evidence, returned search text, fetched section text, and the selected direct page separately.',
      payload:
        'UTF-8 bytes of visible MCP content text; direct baseline uses the stored full-page Markdown text. Structured-content duplication, JSON-RPC framing, and transport overhead are excluded.',
      calls:
        'A search is one retrieval call. Search plus section fetch counts one search and one fetch per returned top-K hit. The direct-page baseline counts one read for its manually selected canonical page; path resolution is supplied by the benchmark oracle.',
      oracle:
        'Direct-page paths are fixed in the case list and recorded with each result. This is a perfect-page oracle baseline, not automatic page discovery.',
    },
    snapshots: [...snapshots.values()].map(({ entry }) => ({
      selector: `${entry.source}@${entry.version}`,
      revision: entry.revision,
      status: entry.status,
      documentCount: entry.manifest.index.documentCount,
      chunkCount: entry.manifest.index.chunkCount,
    })),
    totals: summarize(results),
    results,
  };

  const output = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = process.env.NEKOSEARCH_RETRIEVAL_COMPARISON_OUTPUT?.trim();
  if (outputPath) writeFileSync(resolve(outputPath), output);
  process.stdout.write(output);
} finally {
  for (const snapshot of snapshots.values()) snapshot.store.close();
  globalThis.fetch = originalFetch;
}

function expandResults(documentation, testCase, searchResponse) {
  const results = searchResponse.structuredContent.results;
  const searchText = visibleToolText(searchResponse);
  const fetchResponses = results.map((result) =>
    fetchDocumentation(documentation, {
      documentId: result.documentId,
      sectionId: result.chunkId,
    }),
  );
  const fetchTexts = fetchResponses.map(visibleToolText);
  const combinedText = [searchText, ...fetchTexts].join('\n');

  return {
    resultCount: results.length,
    searchCalls: 1,
    fetchCalls: fetchResponses.length,
    retrievalCalls: 1 + fetchResponses.length,
    payloadBytesUtf8:
      Buffer.byteLength(searchText) +
      fetchTexts.reduce((total, text) => total + Buffer.byteLength(text), 0),
    evidence: inspectEvidence(combinedText, testCase.sufficientEvidence),
    fetchedSections: fetchResponses.map((response) => ({
      found: response.structuredContent.found,
      sectionId: response.structuredContent.sectionId,
      truncated: response.structuredContent.truncated,
    })),
  };
}

function visibleToolText(response) {
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function inspectEvidence(text, requiredPhrases) {
  return inspectNormalizedEvidence(normalizeMarkdown(text), requiredPhrases);
}

function normalizeMarkdown(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/`{1,3}/gu, '')
    .replace(/[*_>#]/gu, '')
    .replace(/["'“”]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en');
}

function inspectNormalizedEvidence(normalizedText, requiredPhrases) {
  const phrases = requiredPhrases.map((phrase) => ({
    phrase,
    found: normalizedText.includes(normalizeMarkdown(phrase)),
  }));
  return {
    allPresent: phrases.every(({ found }) => found),
    phrases,
  };
}

function summarize(results) {
  const scenarios = [
    {
      name: 'searchExcerptTop1',
      get: (result) => result.searchExcerpt.top1,
    },
    {
      name: 'searchExcerptTop3',
      get: (result) => result.searchExcerpt.top3,
    },
    {
      name: 'searchThenFetchTop1',
      get: (result) => result.searchThenSectionFetch.top1,
    },
    {
      name: 'searchThenFetchTop3',
      get: (result) => result.searchThenSectionFetch.top3,
    },
    { name: 'directMarkdown', get: (result) => result.directMarkdown },
  ];

  return Object.fromEntries(
    scenarios.map(({ name, get }) => {
      const measured = results.map(get);
      return [
        name,
        {
          queries: measured.length,
          evidenceComplete: measured.filter(
            ({ evidence }) => evidence?.allPresent,
          ).length,
          retrievalCalls: measured.reduce(
            (total, scenario) => total + scenario.retrievalCalls,
            0,
          ),
          payloadBytesUtf8: measured.reduce(
            (total, scenario) => total + scenario.payloadBytesUtf8,
            0,
          ),
        },
      ];
    }),
  );
}
