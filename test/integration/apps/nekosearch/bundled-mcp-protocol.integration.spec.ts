import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type SnapshotDocument = {
  canonicalUrl: string;
  chunks: { canonicalUrl: string }[];
  markdown: string;
  source: { path: string };
};

type SnapshotCorpus = {
  version: string;
  documents: SnapshotDocument[];
};

describe('bundled MCP protocol snapshot', () => {
  const corpus = JSON.parse(
    readFileSync(
      resolve('apps/nekosearch/data/mcp-protocol/corpus.json'),
      'utf8',
    ),
  ) as SnapshotCorpus;

  it('includes the complete pinned Tools and Resources pages and annotation fields', () => {
    expect(corpus.version).toBe('2025-11-25');

    const tools = documentFor('tools.md');
    expect(tools.canonicalUrl).toBe(
      'https://modelcontextprotocol.io/specification/2025-11-25/server/tools',
    );
    expect(tools.markdown).toContain('# Tools');
    expect(tools.markdown).toContain('## Security Considerations');
    expect(tools.markdown).toContain('For trust & safety and security');

    const resources = documentFor('resources.md');
    expect(resources.canonicalUrl).toBe(
      'https://modelcontextprotocol.io/specification/2025-11-25/server/resources',
    );
    expect(resources.markdown).toContain('### Resource Templates');
    expect(resources.markdown).toContain('resources/templates/list');
    expect(resources.markdown).toContain('uriTemplate');
    expect(resources.markdown).toContain('## Security Considerations');

    const annotations = documentFor('tool-annotations-schema.md');
    expect(annotations.canonicalUrl).toBe(
      'https://modelcontextprotocol.io/specification/2025-11-25/schema',
    );
    expect(annotations.chunks.map((chunk) => chunk.canonicalUrl)).toContain(
      'https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations',
    );
    for (const field of [
      'title',
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ]) {
      expect(annotations.markdown).toContain(field);
    }
    expect(annotations.markdown).toContain('untrusted servers');
  });

  function documentFor(path: string): SnapshotDocument {
    const document = corpus.documents.find(
      (candidate) => candidate.source.path === path,
    );
    if (!document) throw new Error(`Missing bundled MCP document: ${path}`);
    return document;
  }
});
