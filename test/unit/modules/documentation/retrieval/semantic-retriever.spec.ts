import { QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1 } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import { SemanticRetriever } from '@nestjs-docs/documentation-engine/retrieval/retrievers/semantic-retriever.js';
import { jest } from '@jest/globals';

describe('SemanticRetriever', () => {
  it('validates query and snapshot compatibility before searching', () => {
    const store = {
      searchByEmbedding: jest.fn(() => []),
    };
    const incompatibleSpace = {
      ...QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
      queryInstructionVersion: 'different-instruction',
    };

    expect(
      () =>
        new SemanticRetriever(
          store,
          QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
          incompatibleSpace,
        ),
    ).toThrow(/supported embedding metadata/u);
    expect(store.searchByEmbedding).not.toHaveBeenCalled();
  });

  it('passes one normalized query vector and the requested top K to the store', () => {
    const vector = normalizedVector(0, 1);
    const store = {
      searchByEmbedding: jest.fn(() => []),
    };
    const retriever = new SemanticRetriever(
      store,
      QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
      QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
    );

    expect(retriever.search(vector, 17, ['ExecutionContext'])).toEqual([]);
    expect(store.searchByEmbedding).toHaveBeenCalledWith(vector, 17, [
      'ExecutionContext',
    ]);
  });

  it('rejects malformed or non-normalized query vectors', () => {
    const store = { searchByEmbedding: jest.fn(() => []) };
    const retriever = new SemanticRetriever(
      store,
      QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
      QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
    );

    expect(() => retriever.search(new Float32Array(1023))).toThrow(
      /1024-dimensional/u,
    );
    expect(() => retriever.search(new Float32Array(1024))).toThrow(
      /L2-normalized/u,
    );
    expect(store.searchByEmbedding).not.toHaveBeenCalled();
  });
});

function normalizedVector(first: number, second: number): Float32Array {
  const vector = new Float32Array(1024);
  vector[0] = first;
  vector[1] = second;
  return vector;
}
