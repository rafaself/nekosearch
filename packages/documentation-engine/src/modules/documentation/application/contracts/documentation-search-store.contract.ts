import type { DocumentationSearchResult } from './documentation-reader.contract.js';
import type { DocumentationLinkReference } from '../../domain/documentation.types.js';

export interface DocumentationRow {
  chunkId: string;
  title: string;
  headingPath: string;
  canonicalUrl: string;
  sourceRevision: string;
  markdown: string;
  references: DocumentationLinkReference[];
}

export interface DocumentationSectionReference {
  canonicalUrl: string;
  headingPath: string;
}

export interface DocumentationSearchStore {
  search(
    expression: string,
    limit: number,
    queryTerms?: readonly string[],
  ): DocumentationSearchResult[];
  fetchRows(documentId: string): DocumentationRow[];
  findSection(
    documentId: string,
    sectionId: string,
  ): DocumentationSectionReference | null;
}
