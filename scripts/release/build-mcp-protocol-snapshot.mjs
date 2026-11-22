import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DocumentationSnapshotSchema } from '../../packages/documentation-engine/dist/domain/documentation.schemas.js';
import { normalizeAndChunkDocument } from '../../packages/documentation-engine/dist/infrastructure/markdown/document-normalizer.js';
import { parseMarkdown } from '../../packages/documentation-engine/dist/infrastructure/markdown/markdown-parser.js';
import { buildDocumentationSnapshot } from '../../packages/documentation-engine/dist/build/build-documentation-snapshot.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceDirectory = join(root, 'apps/nekosearch/content/mcp-protocol');
const { values } = parseArgs({ options: { output: { type: 'string' } } });
const outputDirectory = values.output
  ? resolve(values.output)
  : join(root, 'apps/nekosearch/data/mcp-protocol');
const version = '2025-11-25';
const identity = { id: 'mcp', version };
const source = {
  kind: 'git',
  repository: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
  ref: version,
  revision: version,
};
const canonicalPages = new Map([
  ['overview.md', `https://modelcontextprotocol.io/specification/${version}`],
  [
    'architecture.md',
    `https://modelcontextprotocol.io/specification/${version}/basic/architecture`,
  ],
  [
    'lifecycle.md',
    `https://modelcontextprotocol.io/specification/${version}/basic/lifecycle`,
  ],
  [
    'transports.md',
    `https://modelcontextprotocol.io/specification/${version}/basic/transports`,
  ],
  [
    'tools-resources-prompts.md',
    `https://modelcontextprotocol.io/specification/${version}/server`,
  ],
  [
    'tools.md',
    `https://modelcontextprotocol.io/specification/${version}/server/tools`,
  ],
  [
    'resources.md',
    `https://modelcontextprotocol.io/specification/${version}/server/resources`,
  ],
  [
    'tool-annotations-schema.md',
    `https://modelcontextprotocol.io/specification/${version}/schema`,
  ],
]);

const fileNames = (await readdir(sourceDirectory))
  .filter((name) => name.endsWith('.md'))
  .sort();
if (fileNames.length !== canonicalPages.size) {
  throw new Error('MCP protocol snapshot pages do not match their route map');
}

const documents = await Promise.all(
  fileNames.map(async (name) => {
    const canonicalUrl = canonicalPages.get(name);
    if (!canonicalUrl) throw new Error(`No MCP protocol route for ${name}`);
    const markdown = await readFile(join(sourceDirectory, name), 'utf8');
    const path = name;
    return {
      id: `mcp:${basename(name, '.md')}`,
      version,
      path,
      canonicalUrl,
      sourceLocation: canonicalUrl,
      markdown,
    };
  }),
);
const snapshot = DocumentationSnapshotSchema.parse({
  version,
  source,
  documents,
});

const summary = await buildDocumentationSnapshot({
  identity,
  snapshot,
  outputDirectory,
  mode: 'incremental',
  transformerVersion: 1,
  transformDocument: (file, provenance, maxChunkChars) =>
    normalizeAndChunkDocument(
      file,
      provenance,
      parseMarkdown(file.markdown, { path: file.path }),
      { identity, maxChunkChars, idPrefix: `mcp-spec:v${version}` },
    ),
});

console.log(
  `Built MCP specification v${version}: ${summary.documentCount} documents, ${summary.chunkCount} chunks at ${summary.sourceRevision}`,
);
