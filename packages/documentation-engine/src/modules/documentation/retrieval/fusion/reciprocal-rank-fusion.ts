import type { DocumentationSearchResult } from '../../application/contracts/documentation-reader.contract.js';

export const RECIPROCAL_RANK_FUSION_K = 60;
export const LEXICAL_RETRIEVAL_TOP_K = 50;
export const SEMANTIC_RETRIEVAL_TOP_K = 50;

/** Fuse two independent, already ranked result lists from one snapshot. */
export function reciprocalRankFusion(
  lexicalResults: readonly DocumentationSearchResult[],
  semanticResults: readonly DocumentationSearchResult[],
  limit = LEXICAL_RETRIEVAL_TOP_K,
): DocumentationSearchResult[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('RRF result limit must be a positive integer');
  }

  const fused = new Map<
    string,
    { result: DocumentationSearchResult; score: number }
  >();
  addRankedResults(fused, lexicalResults);
  addRankedResults(fused, semanticResults);

  return [...fused.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareStrings(left.result.chunkId, right.result.chunkId),
    )
    .slice(0, limit)
    .map(({ result, score }) => ({ ...result, score }));
}

/** Keep an exact lexical symbol match visible after both retrievers are fused. */
export function hybridSearchRanking(
  query: string,
  lexicalResults: readonly DocumentationSearchResult[],
  semanticResults: readonly DocumentationSearchResult[],
  limit = LEXICAL_RETRIEVAL_TOP_K,
): DocumentationSearchResult[] {
  const fusedResults = reciprocalRankFusion(
    lexicalResults,
    semanticResults,
    limit,
  );
  const identifier = exactIdentifierQuery(query);
  if (!identifier) return fusedResults;

  const exactLexicalResult = lexicalResults.find((result) =>
    containsIdentifier(result, identifier),
  );
  if (!exactLexicalResult) return fusedResults;

  const exactFusedResult = fusedResults.find(
    (result) => result.chunkId === exactLexicalResult.chunkId,
  );
  if (
    !exactFusedResult ||
    fusedResults[0]?.chunkId === exactFusedResult.chunkId
  ) {
    return fusedResults;
  }

  return [
    exactFusedResult,
    ...fusedResults.filter(
      (result) => result.chunkId !== exactFusedResult.chunkId,
    ),
  ].slice(0, limit);
}

function addRankedResults(
  fused: Map<string, { result: DocumentationSearchResult; score: number }>,
  results: readonly DocumentationSearchResult[],
): void {
  const seen = new Set<string>();
  for (const [index, result] of results.entries()) {
    if (seen.has(result.chunkId)) continue;
    seen.add(result.chunkId);
    const existing = fused.get(result.chunkId);
    const contribution = 1 / (RECIPROCAL_RANK_FUSION_K + index + 1);
    if (existing) {
      existing.score += contribution;
    } else {
      fused.set(result.chunkId, { result, score: contribution });
    }
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactIdentifierQuery(query: string): string | undefined {
  const value = query.trim();
  const identifier = value.replace(/^@/u, '').replace(/\(\)$/u, '');
  if (!/^[\p{L}\p{N}_$]+$/u.test(identifier)) return undefined;

  const hasIdentifierSyntax =
    value.startsWith('@') ||
    value.endsWith('()') ||
    identifier.includes('_') ||
    /[a-z][A-Z]/u.test(identifier) ||
    /^[A-Z0-9]{2,}$/u.test(identifier);
  return hasIdentifierSyntax
    ? identifier.toLocaleLowerCase('en-US')
    : undefined;
}

function containsIdentifier(
  result: DocumentationSearchResult,
  identifier: string,
): boolean {
  return [result.title, result.canonicalUrl, result.excerpt].some((text) =>
    (text.match(/[\p{L}\p{N}_$]+/gu) ?? []).some(
      (token) => token.toLocaleLowerCase('en-US') === identifier,
    ),
  );
}
