import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1 } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import {
  DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
  DocumentationIndexRuntimeManifestSchema,
} from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
import { writeDocumentationEmbeddings } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/documentation-embeddings.js';
import { SQLiteDocumentationStore } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/sqlite-documentation-store.js';
import { SemanticRetriever } from '@nestjs-docs/documentation-engine/retrieval/retrievers/semantic-retriever.js';
import { createDocumentationTestIndex } from '../../../../fixtures/documentation-index.js';

describe('SQLite semantic retrieval', () => {
  it('ranks persisted normalized vectors by exact dot product within the snapshot version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'semantic-retrieval-'));
    const databasePath = join(directory, 'index.sqlite');
    mkdirSync(directory, { recursive: true });
    const corpus = createDocumentationTestIndex(databasePath, '12');
    const chunks = corpus.documents.flatMap((document) => document.chunks);
    const database = new DatabaseSync(databasePath);
    try {
      writeDocumentationEmbeddings(database, [
        { chunkId: chunks[0]!.id, vector: unitVector(1, 0) },
        { chunkId: chunks[1]!.id, vector: unitVector(0, 1) },
      ]);
    } finally {
      database.close();
    }

    const manifest = DocumentationIndexRuntimeManifestSchema.parse({
      manifestVersion: DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
      documentation: { id: 'nestjs', version: '12' },
      source: corpus.source,
      index: {
        file: 'index.sqlite',
        sha256: 'a'.repeat(64),
        documentationVersion: '12',
        sourceRevision: corpus.source.revision,
        schemaVersion: 1,
        formatVersion: 2,
        documentCount: corpus.documents.length,
        chunkCount: chunks.length,
      },
      embeddings: QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
    });
    const store = new SQLiteDocumentationStore(databasePath, manifest);
    try {
      const retriever = new SemanticRetriever(
        store,
        manifest.embeddings,
        QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
      );
      const results = retriever.search(unitVector(0, 1), 2, [
        'ExecutionContext',
      ]);

      expect(results.map(({ chunkId }) => chunkId)).toEqual([
        chunks[1]!.id,
        chunks[0]!.id,
      ]);
      expect(results.map(({ score }) => score)).toEqual([1, 0]);
      expect(results[0]?.excerpt).toContain('ExecutionContext');
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function unitVector(first: number, second: number): Float32Array {
  const vector = new Float32Array(1024);
  vector[0] = first;
  vector[1] = second;
  return vector;
}
