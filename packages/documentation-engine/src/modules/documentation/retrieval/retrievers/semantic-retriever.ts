import { isDeepStrictEqual } from 'node:util';
import type { DocumentationSearchResult } from '../../application/contracts/documentation-reader.contract.js';
import {
  DocumentationEmbeddingSpaceSchema,
  type DocumentationEmbeddingSpace,
} from '../../domain/documentation-embedding.schemas.js';
import { SEMANTIC_RETRIEVAL_TOP_K } from '../fusion/reciprocal-rank-fusion.js';

export interface SemanticSearchStore {
  searchByEmbedding(
    queryVector: Float32Array,
    limit: number,
    queryTerms?: readonly string[],
  ): DocumentationSearchResult[];
}

/** Exact vector retriever scoped to one validated documentation snapshot. */
export class SemanticRetriever {
  readonly embeddingSpace: DocumentationEmbeddingSpace;

  constructor(
    private readonly store: SemanticSearchStore,
    snapshotEmbeddingSpace: unknown,
    queryEmbeddingSpace: unknown,
  ) {
    const snapshot = DocumentationEmbeddingSpaceSchema.safeParse(
      snapshotEmbeddingSpace,
    );
    const query =
      DocumentationEmbeddingSpaceSchema.safeParse(queryEmbeddingSpace);
    if (!snapshot.success || !query.success) {
      throw new Error(
        'Semantic retrieval requires supported embedding metadata on both the snapshot and query encoder',
      );
    }
    if (!isDeepStrictEqual(snapshot.data, query.data)) {
      throw new Error(
        'Semantic retrieval cannot compare vectors from different embedding spaces',
      );
    }
    this.embeddingSpace = snapshot.data;
  }

  search(
    queryVector: Float32Array,
    limit = SEMANTIC_RETRIEVAL_TOP_K,
    queryTerms: readonly string[] = [],
  ): DocumentationSearchResult[] {
    validateQueryVector(queryVector, this.embeddingSpace.embeddingDimensions);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Semantic result limit must be a positive integer');
    }
    return this.store.searchByEmbedding(
      queryVector,
      Math.min(limit, SEMANTIC_RETRIEVAL_TOP_K),
      queryTerms,
    );
  }
}

function validateQueryVector(vector: Float32Array, dimensions: number): void {
  if (!(vector instanceof Float32Array) || vector.length !== dimensions) {
    throw new Error(
      `Semantic query embedding must be a ${dimensions}-dimensional Float32Array`,
    );
  }
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error('Semantic query embedding contains a non-finite value');
    }
    squaredNorm += value * value;
  }
  if (Math.abs(Math.sqrt(squaredNorm) - 1) > 1e-3) {
    throw new Error('Semantic query embedding must be L2-normalized');
  }
}
