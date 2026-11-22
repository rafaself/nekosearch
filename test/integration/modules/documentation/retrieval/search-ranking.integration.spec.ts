import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestNestJsDocuments } from '../../../../fixtures/ingestion.fixtures.js';
import { TestDocumentationSearchService as DocumentationSearchService } from '../../../../fixtures/test-documentation-search-service.js';
import { fixture } from '../../../../fixtures/ingestion.fixtures.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';

describe('documentation search ranking', () => {
  let directory: string;
  const databasePaths = new Map<'11' | '12', string>();

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'nekosearch-ranking-'));
    const [requestContext, guards] = await Promise.all([
      fixture('search-request-context.md'),
      fixture('search-guards.md'),
    ]);

    for (const version of ['11', '12'] as const) {
      const canonicalRoot =
        version === '11'
          ? 'https://docs.nestjs.com/v11'
          : 'https://docs.nestjs.com';
      const corpus = ingestNestJsDocuments(version, [
        {
          path: 'content/fundamentals/injection-scopes.md',
          canonicalUrl: `${canonicalRoot}/fundamentals/injection-scopes`,
          markdown: `# Request scoped providers\n\n${requestContext}`,
        },
        {
          path: 'content/fundamentals/execution-context.md',
          canonicalUrl: `${canonicalRoot}/fundamentals/execution-context`,
          markdown: guards,
        },
        {
          path: 'content/faq/request-lifecycle.md',
          canonicalUrl: `${canonicalRoot}/faq/request-lifecycle`,
          markdown:
            '# HTTP request lifecycle\n\nThis page explains the HTTP request lifecycle in a Nest application.',
        },
        {
          path: 'content/techniques/streaming-files.md',
          canonicalUrl:
            version === '11'
              ? `${canonicalRoot}/techniques/streaming-files`
              : `${canonicalRoot}/http/file-upload`,
          markdown:
            '# Streaming files\n\nHow can I stream a file from a controller? This guide explains streaming files from a controller.',
        },
        {
          path: 'content/techniques/validation.md',
          canonicalUrl: `${canonicalRoot}/techniques/validation`,
          markdown:
            '# Validation\n\n## Pipes\n\nPipes transform and validate incoming DTO payloads.',
        },
        {
          path: 'content/migration.md',
          canonicalUrl: `${canonicalRoot}/migration-guide`,
          markdown: `# Framework migration recipe\n\n## Validation and DTO changes\n\n${Array.from(
            { length: 40 },
            () =>
              'During the migration, validation pipes validate each DTO payload and update its validation rules.',
          ).join('\n\n')}`,
        },
      ]);
      const databasePath = join(directory, `documentation-v${version}.sqlite`);
      const writer = new DocumentationIndexWriter(databasePath, version);
      writer.indexCorpus(corpus);
      writer.close();
      databasePaths.set(version, databasePath);
    }
  });

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function search(version: '11' | '12', query: string, limit?: number) {
    const service = new DocumentationSearchService(
      databasePaths.get(version)!,
      version,
    );
    try {
      return service.search(query, limit);
    } finally {
      service.close();
    }
  }

  it.each(['11', '12'] as const)(
    'ranks request scoped provider documentation first for NestJS v%s',
    (version) => {
      const result = search(version, 'request scoped providers')[0];
      expect(result?.canonicalUrl).toContain(
        version === '11'
          ? '/v11/fundamentals/injection-scopes'
          : '/fundamentals/injection-scopes',
      );
    },
  );

  it.each(['11', '12'] as const)(
    'keeps identifier, lifecycle, and streaming searches useful for NestJS v%s',
    (version) => {
      expect(search(version, 'ExecutionContext')[0]?.canonicalUrl).toContain(
        version === '11'
          ? '/v11/fundamentals/execution-context'
          : '/fundamentals/execution-context',
      );
      expect(
        search(version, 'HTTP request lifecycle')[0]?.canonicalUrl,
      ).toContain(
        version === '11'
          ? '/v11/faq/request-lifecycle'
          : '/faq/request-lifecycle',
      );
      expect(
        search(version, 'How can I stream a file from a controller?', 5).some(
          (result) =>
            result.canonicalUrl.includes(
              version === '11'
                ? '/v11/techniques/streaming-files'
                : '/http/file-upload',
            ),
        ),
      ).toBe(true);
    },
  );

  it.each(['11', '12'] as const)(
    'ranks the primary validation guide above a matching migration recipe for NestJS v%s',
    (version) => {
      const results = search(version, 'pipes validation DTO');
      const result = results[0];

      expect(result?.canonicalUrl).toContain(
        version === '11'
          ? '/v11/techniques/validation'
          : '/techniques/validation',
      );
    },
  );
});
