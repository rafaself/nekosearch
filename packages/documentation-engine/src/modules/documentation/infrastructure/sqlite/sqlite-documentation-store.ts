import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { DocumentationIndexRuntimeManifest } from '../../domain/documentation-index-manifest.schemas.js';
import type {
  DocumentationRow,
  DocumentationSearchStore,
  DocumentationSectionReference,
} from '../../application/contracts/documentation-search-store.contract.js';
import type { DocumentationSearchResult } from '../../application/contracts/documentation-reader.contract.js';
import type { DocumentationLinkReference } from '../../domain/documentation.types.js';
import { MAX_SEARCH_RESULT_LIMIT } from '../../retrieval/search.constants.js';
import { createSearchExcerpt } from '../../retrieval/search-excerpt.js';
import { validateRuntimeIndex } from './runtime-index.js';

const EMBEDDING_DIMENSIONS = 1024;
const EMBEDDING_BLOB_BYTES =
  EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;
const TITLE_QUERY_TERM_BOOST = 1;
const HEADING_QUERY_TERM_BOOST = 0.25;
const MAX_METADATA_BOOST_FRACTION = 0.1;

export class SQLiteDocumentationStore implements DocumentationSearchStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(
    databasePath: string,
    readonly indexManifest: DocumentationIndexRuntimeManifest,
  ) {
    if (!databasePath) throw new Error('A SQLite database path is required');
    if (databasePath === ':memory:') {
      throw new Error('A pre-existing SQLite index file is required');
    }
    this.database = new DatabaseSync(resolve(databasePath), {
      readOnly: true,
      timeout: 5000,
    });
    try {
      const summary = validateRuntimeIndex(
        this.database,
        indexManifest.documentation.version,
        indexManifest.embeddings,
      );
      if (
        summary.revision !== indexManifest.index.sourceRevision ||
        summary.documentCount !== indexManifest.index.documentCount ||
        summary.chunkCount !== indexManifest.index.chunkCount
      ) {
        throw new Error(
          'Documentation index contents do not match the validated manifest',
        );
      }
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  search(
    expression: string,
    limit: number,
    queryTerms: readonly string[] = [],
  ): DocumentationSearchResult[] {
    const candidates = this.database
      .prepare(
        `
        SELECT
          chunk_id AS chunkId,
          document_id AS documentId,
          title,
          heading_path AS headingPath,
          canonical_url AS canonicalUrl,
          source_revision AS sourceRevision,
          markdown,
          bm25(documentation_search, 8.0, 4.0, 1.0) AS rank
        FROM documentation_search
        WHERE documentation_search MATCH ?
          AND documentation_version = ?
        ORDER BY rank ASC,
          document_id COLLATE BINARY ASC,
          chunk_id COLLATE BINARY ASC
        LIMIT ?
      `,
      )
      .all(
        expression,
        this.indexManifest.documentation.version,
        MAX_SEARCH_RESULT_LIMIT,
      );

    const scoredCandidates = candidates.map((row) => {
      const result = toSearchResult(row, queryTerms);
      const title = requireString(row.title, 'title');
      const headingPath = requireString(row.headingPath, 'heading path');
      return {
        result,
        metadataBoost: queryMetadataBoost(title, headingPath, queryTerms),
      };
    });
    const maximumBm25Score = Math.max(
      0,
      ...scoredCandidates.map(({ result }) => result.score),
    );
    const maximumMetadataBoost = Math.max(
      0,
      ...scoredCandidates.map(({ metadataBoost }) => metadataBoost),
    );
    const metadataBoostScale = maximumMetadataBoost
      ? (maximumBm25Score * MAX_METADATA_BOOST_FRACTION) / maximumMetadataBoost
      : 0;

    return scoredCandidates
      .map((row) => {
        return {
          ...row.result,
          score: row.result.score + row.metadataBoost * metadataBoostScale,
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          compareStrings(left.documentId, right.documentId) ||
          compareStrings(left.chunkId, right.chunkId),
      )
      .slice(0, Math.min(limit, MAX_SEARCH_RESULT_LIMIT));
  }

  /** Exact dot-product scan over this snapshot's validated vector table. */
  searchByEmbedding(
    queryVector: Float32Array,
    limit = MAX_SEARCH_RESULT_LIMIT,
    queryTerms: readonly string[] = [],
  ): DocumentationSearchResult[] {
    if (!this.indexManifest.embeddings) {
      throw new Error(
        `Documentation ${this.indexManifest.documentation.id}@${this.indexManifest.documentation.version} has no compatible embeddings`,
      );
    }
    validateNormalizedQueryVector(queryVector);
    const boundedLimit = Math.min(limit, MAX_SEARCH_RESULT_LIMIT);
    if (!Number.isSafeInteger(limit) || boundedLimit < 1) {
      throw new Error('Semantic result limit must be a positive integer');
    }

    const topCandidates: SemanticCandidate[] = [];
    const embeddingRows = this.database
      .prepare(
        `SELECT vector.chunk_id AS chunkId, vector.embedding
         FROM documentation_embeddings AS vector
         INNER JOIN documentation_search AS document
           ON document.chunk_id = vector.chunk_id
         WHERE document.documentation_version = ?`,
      )
      .iterate(this.indexManifest.documentation.version);
    for (const row of embeddingRows) {
      if (typeof row.chunkId !== 'string' || !row.chunkId.trim()) {
        throw new Error('SQLite returned an invalid semantic chunk identifier');
      }
      insertSemanticCandidate(
        topCandidates,
        {
          chunkId: row.chunkId,
          score: dotProductWithNormalizedBlob(
            queryVector,
            row.embedding,
            row.chunkId,
          ),
        },
        boundedLimit,
      );
    }

    const resultStatement = this.database.prepare(
      `SELECT chunk_id AS chunkId, document_id AS documentId, title,
          canonical_url AS canonicalUrl, source_revision AS sourceRevision,
          markdown
       FROM documentation_search
       WHERE documentation_version = ? AND chunk_id = ?`,
    );
    return topCandidates.map((candidate) => {
      const row = resultStatement.get(
        this.indexManifest.documentation.version,
        candidate.chunkId,
      );
      if (!row) {
        throw new Error(
          `Semantic result references missing documentation chunk ${candidate.chunkId}`,
        );
      }
      return toSemanticSearchResult(row, candidate.score, queryTerms);
    });
  }

  fetchRows(documentId: string): DocumentationRow[] {
    const rows = this.database
      .prepare(
        `
        SELECT chunk_id AS chunkId, title,
          heading_path AS headingPath,
          canonical_url AS canonicalUrl,
          source_revision AS sourceRevision, markdown
        FROM documentation_search
        WHERE document_id = ? AND documentation_version = ?
        ORDER BY chunk_index ASC, chunk_id COLLATE BINARY ASC
      `,
      )
      .all(documentId, this.indexManifest.documentation.version)
      .map(toDocumentationRow);
    const referencesByChunk = new Map<string, DocumentationLinkReference[]>();
    const references = this.database
      .prepare(
        `SELECT reference.chunk_id AS chunkId, reference.href,
              reference.start_offset AS startOffset,
              reference.end_offset AS endOffset,
              reference.target_document_id AS documentId,
              reference.target_section_id AS sectionId
            FROM documentation_references AS reference
            JOIN documentation_search AS source_chunk
              ON source_chunk.chunk_id = reference.chunk_id
            WHERE source_chunk.document_id = ?
              AND source_chunk.documentation_version = ?
            ORDER BY source_chunk.chunk_index ASC,
              reference.occurrence_index ASC`,
      )
      .all(documentId, this.indexManifest.documentation.version);
    for (const row of references) {
      const referenceRow = row as Record<string, unknown>;
      if (typeof referenceRow.chunkId !== 'string') {
        throw new Error('SQLite returned an invalid documentation reference');
      }
      const referencesForChunk =
        referencesByChunk.get(referenceRow.chunkId) ?? [];
      referencesForChunk.push(toDocumentationLinkReference(referenceRow));
      referencesByChunk.set(referenceRow.chunkId, referencesForChunk);
    }
    return rows.map((row) => ({
      ...row,
      references: referencesByChunk.get(row.chunkId) ?? [],
    }));
  }

  findSection(
    documentId: string,
    sectionId: string,
  ): DocumentationSectionReference | null {
    const row = this.database
      .prepare(
        `
        SELECT canonical_url AS canonicalUrl, heading_path AS headingPath
        FROM documentation_search
        WHERE document_id = ? AND documentation_version = ? AND chunk_id = ?
      `,
      )
      .get(documentId, this.indexManifest.documentation.version, sectionId);
    if (!row) return null;
    const reference = row as Record<string, unknown>;
    if (
      typeof reference.canonicalUrl !== 'string' ||
      typeof reference.headingPath !== 'string'
    ) {
      throw new Error('SQLite returned an invalid documentation section row');
    }
    return {
      canonicalUrl: reference.canonicalUrl,
      headingPath: reference.headingPath,
    };
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

function toSearchResult(
  row: Record<string, unknown>,
  queryTerms: readonly string[],
): DocumentationSearchResult {
  const {
    chunkId,
    documentId,
    title,
    canonicalUrl,
    sourceRevision,
    markdown,
    rank,
  } = row;
  if (
    typeof chunkId !== 'string' ||
    typeof documentId !== 'string' ||
    typeof title !== 'string' ||
    typeof canonicalUrl !== 'string' ||
    typeof sourceRevision !== 'string' ||
    typeof markdown !== 'string' ||
    typeof rank !== 'number'
  ) {
    throw new Error('SQLite returned an invalid documentation search row');
  }
  return {
    chunkId,
    documentId,
    title,
    canonicalUrl,
    sourceRevision,
    excerpt: createSearchExcerpt(markdown, queryTerms),
    score: -rank,
  };
}

function queryMetadataBoost(
  title: string,
  headingPath: string,
  queryTerms: readonly string[],
): number {
  if (queryTerms.length === 0) return 0;
  const titleTerms = new Set(exactSearchTerms(title));
  const headingTerms = new Set(exactSearchTerms(headingPath));
  let boost = 0;
  for (const queryTerm of queryTerms) {
    const normalizedTerm = queryTerm.toLocaleLowerCase('en-US');
    if (titleTerms.has(normalizedTerm)) {
      boost += TITLE_QUERY_TERM_BOOST;
    } else if (headingTerms.has(normalizedTerm)) {
      boost += HEADING_QUERY_TERM_BOOST;
    }
  }
  return boost;
}

function exactSearchTerms(text: string): string[] {
  return (text.match(/[\p{L}\p{N}_]+/gu) ?? []).map((term) =>
    term.toLocaleLowerCase('en-US'),
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`SQLite returned an invalid documentation search ${field}`);
  }
  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface SemanticCandidate {
  chunkId: string;
  score: number;
}

function insertSemanticCandidate(
  candidates: SemanticCandidate[],
  candidate: SemanticCandidate,
  limit: number,
): void {
  let position = 0;
  while (
    position < candidates.length &&
    compareSemanticCandidates(candidates[position]!, candidate) <= 0
  ) {
    position += 1;
  }
  if (position >= limit) return;
  candidates.splice(position, 0, candidate);
  if (candidates.length > limit) candidates.pop();
}

function compareSemanticCandidates(
  left: SemanticCandidate,
  right: SemanticCandidate,
): number {
  return (
    right.score - left.score ||
    (left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0)
  );
}

function dotProductWithNormalizedBlob(
  queryVector: Float32Array,
  value: unknown,
  chunkId: string,
): number {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength !== EMBEDDING_BLOB_BYTES
  ) {
    throw new Error(`Semantic vector for ${chunkId} has an invalid BLOB size`);
  }
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  let squaredNorm = 0;
  let score = 0;
  for (let dimension = 0; dimension < queryVector.length; dimension += 1) {
    const value = bytes.readFloatLE(dimension * Float32Array.BYTES_PER_ELEMENT);
    if (!Number.isFinite(value)) {
      throw new Error(`Semantic vector for ${chunkId} has a non-finite value`);
    }
    squaredNorm += value * value;
    score += queryVector[dimension]! * value;
  }
  if (Math.abs(Math.sqrt(squaredNorm) - 1) > 1e-3) {
    throw new Error(`Semantic vector for ${chunkId} is not L2-normalized`);
  }
  return score;
}

function validateNormalizedQueryVector(vector: Float32Array): void {
  if (
    !(vector instanceof Float32Array) ||
    vector.length !== EMBEDDING_DIMENSIONS
  ) {
    throw new Error(
      `Semantic query embedding must be a ${EMBEDDING_DIMENSIONS}-dimensional Float32Array`,
    );
  }
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error('Semantic query embedding has a non-finite value');
    }
    squaredNorm += value * value;
  }
  if (Math.abs(Math.sqrt(squaredNorm) - 1) > 1e-3) {
    throw new Error('Semantic query embedding is not L2-normalized');
  }
}

function toSemanticSearchResult(
  row: Record<string, unknown>,
  score: number,
  queryTerms: readonly string[],
): DocumentationSearchResult {
  const { chunkId, documentId, title, canonicalUrl, sourceRevision, markdown } =
    row;
  if (
    typeof chunkId !== 'string' ||
    typeof documentId !== 'string' ||
    typeof title !== 'string' ||
    typeof canonicalUrl !== 'string' ||
    typeof sourceRevision !== 'string' ||
    typeof markdown !== 'string' ||
    !Number.isFinite(score)
  ) {
    throw new Error('SQLite returned an invalid semantic search result');
  }
  return {
    chunkId,
    documentId,
    title,
    canonicalUrl,
    sourceRevision,
    excerpt: createSearchExcerpt(markdown, queryTerms),
    score,
  };
}

function toDocumentationRow(row: Record<string, unknown>): DocumentationRow {
  const {
    chunkId,
    title,
    headingPath,
    canonicalUrl,
    sourceRevision,
    markdown,
  } = row;
  if (
    typeof chunkId !== 'string' ||
    typeof title !== 'string' ||
    typeof headingPath !== 'string' ||
    typeof canonicalUrl !== 'string' ||
    typeof sourceRevision !== 'string' ||
    typeof markdown !== 'string'
  ) {
    throw new Error('SQLite returned an invalid documentation row');
  }
  return {
    chunkId,
    title,
    headingPath,
    canonicalUrl,
    sourceRevision,
    markdown,
    references: [],
  };
}

function toDocumentationLinkReference(
  row: Record<string, unknown>,
): DocumentationLinkReference {
  const { href, startOffset, endOffset, documentId, sectionId } = row;
  if (
    typeof href !== 'string' ||
    typeof startOffset !== 'number' ||
    typeof endOffset !== 'number' ||
    typeof documentId !== 'string' ||
    (sectionId !== null && typeof sectionId !== 'string')
  ) {
    throw new Error('SQLite returned an invalid documentation reference');
  }
  return {
    href,
    startOffset,
    endOffset,
    documentId,
    ...(typeof sectionId === 'string' ? { sectionId } : {}),
  };
}
