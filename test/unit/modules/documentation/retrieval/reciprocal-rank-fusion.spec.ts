import type { DocumentationSearchResult } from '@nestjs-docs/documentation-engine/application/contracts/documentation-reader.contract.js';
import {
  hybridSearchRanking,
  reciprocalRankFusion,
} from '@nestjs-docs/documentation-engine/retrieval/fusion/reciprocal-rank-fusion.js';

describe('reciprocalRankFusion', () => {
  it('adds reciprocal rank contributions from both lists and breaks ties by chunk ID', () => {
    const lexical = [searchResult('z-lexical'), searchResult('shared')];
    const semantic = [searchResult('a-semantic'), searchResult('shared')];

    const fused = reciprocalRankFusion(lexical, semantic);

    expect(fused.map(({ chunkId }) => chunkId)).toEqual([
      'shared',
      'a-semantic',
      'z-lexical',
    ]);
    expect(fused[0]?.score).toBeCloseTo(2 / 61);
    expect(fused[1]?.score).toBeCloseTo(1 / 61);
    expect(fused[2]?.score).toBeCloseTo(1 / 61);
  });

  it('returns unique results within the requested limit deterministically', () => {
    const lexical = [
      searchResult('chunk-c'),
      searchResult('chunk-b'),
      searchResult('chunk-a'),
    ];
    const semantic = [
      searchResult('chunk-a'),
      searchResult('chunk-b'),
      searchResult('chunk-c'),
    ];

    expect(
      reciprocalRankFusion(lexical, semantic, 2).map(({ chunkId }) => chunkId),
    ).toEqual(['chunk-a', 'chunk-c']);
  });

  it('rejects an invalid result limit', () => {
    expect(() => reciprocalRankFusion([], [], 0)).toThrow(/positive integer/u);
  });

  it('keeps an exact decorator match visible after semantic fusion', () => {
    const exactMatch = searchResult(
      'exact-match',
      'The @Injectable() decorator makes this provider available.',
    );
    const sharedResults = Array.from({ length: 5 }, (_, index) =>
      searchResult(`shared-${index}`),
    );
    const lexical = [exactMatch, ...sharedResults];
    const semantic = [...sharedResults];
    const fused = reciprocalRankFusion(lexical, semantic);

    expect(fused[0]?.chunkId).not.toBe(exactMatch.chunkId);
    const hybrid = hybridSearchRanking('@Injectable()', lexical, semantic);

    expect(hybrid[0]?.chunkId).toBe(exactMatch.chunkId);
    expect(hybrid[0]?.score).toBe(
      fused.find(({ chunkId }) => chunkId === exactMatch.chunkId)?.score,
    );
  });

  it.each(['title', 'heading URL'])(
    'keeps an exact identifier found in the %s visible after semantic fusion',
    (matchLocation) => {
      const exactMatch = {
        ...searchResult('exact-heading', 'An API reference for requests.'),
        title: matchLocation === 'title' ? 'ExecutionContext' : 'API reference',
        canonicalUrl:
          matchLocation === 'heading URL'
            ? 'https://docs.example/execution-context#executioncontext-class'
            : 'https://docs.example/execution-context',
      };
      const sharedResults = Array.from({ length: 5 }, (_, index) =>
        searchResult(`shared-${index}`),
      );
      const lexical = [
        ...sharedResults.slice(0, 1),
        exactMatch,
        ...sharedResults.slice(1),
      ];
      const semantic = [...sharedResults];

      const hybrid = hybridSearchRanking('ExecutionContext', lexical, semantic);

      expect(hybrid[0]?.chunkId).toBe(exactMatch.chunkId);
    },
  );

  it('leaves natural-language queries in reciprocal-rank order', () => {
    const lexical = [searchResult('lexical-only'), searchResult('shared')];
    const semantic = [searchResult('semantic-only'), searchResult('shared')];

    expect(
      hybridSearchRanking(
        'How does dependency injection work?',
        lexical,
        semantic,
      ).map(({ chunkId }) => chunkId),
    ).toEqual(
      reciprocalRankFusion(lexical, semantic).map(({ chunkId }) => chunkId),
    );
  });
});

function searchResult(
  chunkId: string,
  excerpt = chunkId,
): DocumentationSearchResult {
  return {
    chunkId,
    documentId: `document-${chunkId}`,
    title: chunkId,
    canonicalUrl: `https://docs.example/${chunkId}`,
    sourceRevision: 'test-revision',
    excerpt,
    score: 1,
  };
}
