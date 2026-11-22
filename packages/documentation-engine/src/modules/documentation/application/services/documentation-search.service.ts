import type { DocumentationIdentity } from '../../domain/documentation.types.js';
import type { DocumentationIndexRuntimeManifest } from '../../domain/documentation-index-manifest.schemas.js';
import type {
  DocumentationReader,
  DocumentationSearchResult,
  FetchedDocumentation,
} from '../contracts/documentation-reader.contract.js';
import type { DocumentationSearchStore } from '../contracts/documentation-search-store.contract.js';
import {
  DEFAULT_SEARCH_RESULT_LIMIT,
  MAX_SEARCH_RESULT_LIMIT,
} from '../../retrieval/search.constants.js';
import {
  buildSearchExpression,
  extractSearchTerms,
  validateDocumentId,
} from '../../retrieval/search-input.js';
import { paginateDocumentation } from '../../retrieval/document-page.js';

export class DocumentationSearchService implements DocumentationReader {
  constructor(
    private readonly store: DocumentationSearchStore,
    private readonly indexManifest: DocumentationIndexRuntimeManifest,
  ) {}

  get documentation(): DocumentationIdentity {
    return this.indexManifest.documentation;
  }

  /** Search indexed sections. FTS operators are not accepted from user input. */
  search(
    query: unknown,
    limit = DEFAULT_SEARCH_RESULT_LIMIT,
  ): DocumentationSearchResult[] {
    const matchExpression = buildSearchExpression(query, limit);
    if (!matchExpression) return [];
    const queryTerms =
      typeof query === 'string' ? extractSearchTerms(query) : [];
    return this.store.search(
      matchExpression,
      Math.min(limit, MAX_SEARCH_RESULT_LIMIT),
      queryTerms,
    );
  }

  /** Fetch one document by its deterministic ingestion identifier. */
  fetchDocument(
    documentId: unknown,
    sectionId?: string,
    cursor?: string,
  ): FetchedDocumentation | null {
    const validatedDocumentId = validateDocumentId(documentId);
    const rows = this.store.fetchRows(validatedDocumentId);
    const first = rows[0];
    if (!first) return null;

    let selectedRows = rows;
    if (sectionId) {
      const match = this.store.findSection(validatedDocumentId, sectionId);
      if (!match) return null;
      selectedRows = rows.filter(
        (row) =>
          row.canonicalUrl === match.canonicalUrl &&
          row.headingPath === match.headingPath,
      );
    }

    return paginateDocumentation(
      this.documentation,
      validatedDocumentId,
      selectedRows,
      sectionId,
      cursor,
    );
  }
}
