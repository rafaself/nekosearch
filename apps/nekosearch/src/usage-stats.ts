import { createHmac, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { getUserDataDirectory } from './catalog.js';

const DATABASE_FILE = 'usage.sqlite';
const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_QUERY_MODE = 'counts';
const DEFAULT_RETENTION_DAYS = 30;

const usageSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  queryMode: z.enum(['counts', 'fingerprint', 'raw']),
  retentionDays: z.union([
    z.literal(7),
    z.literal(30),
    z.literal(90),
    z.null(),
  ]),
});

export type UsageQueryMode = z.infer<typeof usageSettingsSchema>['queryMode'];
export type UsageSettings = z.infer<typeof usageSettingsSchema>;
export type UsageWindow = '24h' | '7d' | '30d' | 'all';

export interface UsageFilters {
  window: UsageWindow;
  selector?: string;
  tool?: 'list_docs' | 'search_docs' | 'fetch_docs';
  limit?: number;
  offset?: number;
}

export const DEFAULT_USAGE_SETTINGS: UsageSettings = {
  enabled: false,
  queryMode: DEFAULT_QUERY_MODE,
  retentionDays: DEFAULT_RETENTION_DAYS,
};

interface ToolCallEvent {
  callId: string;
  timestamp: number;
  durationMs: number;
  tool: 'list_docs' | 'search_docs' | 'fetch_docs';
  success: boolean;
  errorClass: string | null;
  responseBytes: number | null;
  queryLength: number | null;
  queryFingerprint: string | null;
  queryText: string | null;
  queryMode: UsageQueryMode | null;
  resultCount: number | null;
  fetchDocumentId: string | null;
  fetchSectionId: string | null;
  fetchFound: boolean | null;
  fetchSectionCount: number | null;
  fetchReferenceCount: number | null;
  fetchTruncated: boolean | null;
  fetchHasCursor: boolean | null;
  fetchHasNextCursor: boolean | null;
  sources: Array<{ selector: string; resultCount: number | null }>;
  hits: Array<{
    selector: string;
    documentId: string;
    sectionId: string;
    rank: number;
  }>;
}

export interface UsageSummary {
  settings: UsageSettings;
  filters: Required<Pick<UsageFilters, 'window' | 'limit' | 'offset'>> &
    Pick<UsageFilters, 'selector' | 'tool'>;
  totals: {
    calls: number;
    successes: number;
    failures: number;
    averageDurationMs: number;
    maxDurationMs: number;
    averageResponseBytes: number;
    totalResponseBytes: number;
  };
  tools: Array<{
    tool: string;
    calls: number;
    failures: number;
    averageDurationMs: number;
    averageResponseBytes: number;
  }>;
  sources: Array<{
    selector: string;
    calls: number;
    results: number;
  }>;
  topDocuments: Array<{
    selector: string;
    documentId: string;
    searchHits: number;
    searchCalls: number;
    fetchCalls: number;
    foundFetches: number;
  }>;
  topSections: Array<{
    selector: string;
    documentId: string;
    sectionId: string;
    searchHits: number;
    fetchCalls: number;
  }>;
  fetches: {
    calls: number;
    found: number;
    missing: number;
    returnedSections: number;
    references: number;
    truncated: number;
    continuations: number;
  };
  queryLengths: Array<{ characters: number; calls: number }>;
  topQueries: Array<{
    mode: UsageQueryMode;
    query: string;
    fingerprint: string | null;
    calls: number;
  }>;
  recentCalls: Array<{
    callId: string;
    timestamp: string;
    tool: string;
    selectors: string[];
    success: boolean;
    durationMs: number;
    responseBytes: number | null;
    resultCount: number | null;
    queryLength: number | null;
    queryMode: UsageQueryMode | null;
    query: string | null;
    queryFingerprint: string | null;
    fetchDocumentId: string | null;
    fetchSectionId: string | null;
    fetchFound: boolean | null;
    fetchSectionCount: number | null;
    fetchReferenceCount: number | null;
    fetchTruncated: boolean | null;
    fetchHasCursor: boolean | null;
    fetchHasNextCursor: boolean | null;
    errorClass: string | null;
  }>;
  pagination: { total: number; limit: number; offset: number };
}

/** Local-only MCP usage recorder and query service. It creates no file until the user saves settings. */
export class UsageStatsStore {
  private readonly databasePath: string;

  constructor(
    userDataDirectory = getUserDataDirectory(),
    private readonly clock: () => number = Date.now,
    private readonly onStorageError: (error: unknown) => void = () => undefined,
  ) {
    this.databasePath = join(userDataDirectory, DATABASE_FILE);
  }

  getSettings(): UsageSettings {
    const database = this.openExistingDatabase();
    if (!database) return { ...DEFAULT_USAGE_SETTINGS };
    try {
      return readSettings(database);
    } finally {
      database.close();
    }
  }

  pruneExpired(): void {
    const database = this.openExistingDatabase();
    if (!database) return;
    try {
      database.exec('BEGIN IMMEDIATE');
      const settings = readSettings(database);
      if (settings.retentionDays === null) {
        database.exec('ROLLBACK');
        return;
      }
      pruneExpiredCalls(database, settings.retentionDays, this.clock());
      database.exec('COMMIT');
    } catch (error) {
      rollback(database);
      this.onStorageError(error);
    } finally {
      database.close();
    }
  }

  updateSettings(input: unknown): UsageSettings {
    const settings = usageSettingsSchema.parse(input);
    const database = this.openDatabase(true);
    try {
      database.exec('BEGIN IMMEDIATE');
      database
        .prepare(
          `UPDATE usage_settings
           SET enabled = ?, query_mode = ?, retention_days = ?, updated_at = ?, last_pruned_at = NULL
           WHERE id = 1`,
        )
        .run(
          settings.enabled ? 1 : 0,
          settings.queryMode,
          settings.retentionDays,
          this.clock(),
        );
      pruneExpiredCalls(database, settings.retentionDays, this.clock());
      database.exec('COMMIT');
      return settings;
    } catch (error) {
      rollback(database);
      throw error;
    } finally {
      database.close();
    }
  }

  clear(): number {
    const database = this.openExistingDatabase();
    if (!database) return 0;
    try {
      database.exec('BEGIN IMMEDIATE');
      const callCount = asNumber(
        database.prepare('SELECT count(*) AS count FROM tool_calls').get()
          ?.count,
      );
      database.exec(
        'DELETE FROM search_hits; DELETE FROM call_sources; DELETE FROM tool_calls;',
      );
      database.exec('COMMIT');
      return callCount;
    } catch (error) {
      rollback(database);
      throw error;
    } finally {
      database.close();
    }
  }

  getSummary(filters: UsageFilters): UsageSummary {
    const normalized = normalizeFilters(filters);
    const database = this.openExistingDatabase();
    if (!database) return emptySummary(normalized);
    try {
      return readSummary(database, this.clock(), normalized);
    } finally {
      database.close();
    }
  }

  /** Preserve a tool's return/rejection even when optional usage persistence fails. */
  record<T>(tool: ToolCallEvent['tool'], input: unknown, handler: () => T): T {
    const startedAt = this.clock();
    try {
      const result = handler();
      if (isPromiseLike(result)) {
        return result.then(
          (value) => {
            this.tryRecord(tool, input, startedAt, value, undefined);
            return value;
          },
          (error: unknown) => {
            this.tryRecord(tool, input, startedAt, undefined, error);
            throw error;
          },
        ) as T;
      }
      this.tryRecord(tool, input, startedAt, result, undefined);
      return result;
    } catch (error) {
      this.tryRecord(tool, input, startedAt, undefined, error);
      throw error;
    }
  }

  private tryRecord(
    tool: ToolCallEvent['tool'],
    input: unknown,
    startedAt: number,
    result: unknown,
    error: unknown,
  ): void {
    try {
      const database = this.openExistingDatabase();
      if (!database) return;
      try {
        database.exec('BEGIN IMMEDIATE');
        const settings = readSettings(database);
        pruneIfDue(database, settings, this.clock());
        if (!settings.enabled) {
          database.exec('COMMIT');
          return;
        }
        const event = createEvent(
          tool,
          input,
          result,
          error,
          startedAt,
          this.clock(),
          settings,
          getFingerprintKey(database),
        );
        insertEvent(database, event);
        database.exec('COMMIT');
      } catch (storageError) {
        rollback(database);
        throw storageError;
      } finally {
        database.close();
      }
    } catch (storageError) {
      this.onStorageError(storageError);
    }
  }

  private openExistingDatabase(): DatabaseSync | undefined {
    if (!existsSync(this.databasePath)) return undefined;
    const database = new DatabaseSync(this.databasePath, { timeout: 5000 });
    try {
      configureDatabase(database);
      if (!hasUsageSchema(database)) {
        database.close();
        return undefined;
      }
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private openDatabase(create: boolean): DatabaseSync {
    if (create) {
      mkdirSync(dirname(this.databasePath), {
        recursive: true,
        mode: 0o700,
      });
      if (!existsSync(this.databasePath)) {
        try {
          const descriptor = openSync(this.databasePath, 'wx', 0o600);
          closeSync(descriptor);
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
        }
      }
      chmodSync(this.databasePath, 0o600);
    }
    const database = new DatabaseSync(this.databasePath, { timeout: 5000 });
    try {
      configureDatabase(database);
      initializeSchema(database);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
}

function createEvent(
  tool: ToolCallEvent['tool'],
  input: unknown,
  result: unknown,
  error: unknown,
  startedAt: number,
  endedAt: number,
  settings: UsageSettings,
  fingerprintKey: string,
): ToolCallEvent {
  const inputObject = asObject(input);
  const output = asObject(asObject(result)?.structuredContent);
  const succeeded = error === undefined;
  const query =
    tool === 'search_docs' ? (asString(inputObject?.query) ?? null) : null;
  const groups = Array.isArray(output?.groups) ? output.groups : [];
  const outputSources = Array.isArray(output?.sources) ? output.sources : [];
  const sources =
    tool === 'search_docs'
      ? succeeded
        ? groups.map((group) => {
            const source = asObject(group);
            const hits = Array.isArray(source?.results) ? source.results : [];
            return {
              selector: asString(source?.selector) ?? '',
              resultCount: hits.length,
            };
          })
        : strings(inputObject?.sources).map((selector) => ({
            selector,
            resultCount: 0,
          }))
      : tool === 'list_docs' && succeeded
        ? outputSources
            .map((source) => asString(asObject(source)?.selector))
            .filter((selector): selector is string => Boolean(selector))
            .map((selector) => ({ selector, resultCount: null }))
        : tool === 'fetch_docs'
          ? [
              {
                selector: asString(inputObject?.selector) ?? '',
                resultCount: output?.found === true ? 1 : 0,
              },
            ]
          : [];
  const hits: ToolCallEvent['hits'] = [];
  if (tool === 'search_docs' && succeeded) {
    for (const group of groups) {
      const source = asObject(group);
      const selector = asString(source?.selector);
      if (!selector || !Array.isArray(source?.results)) continue;
      source.results.forEach((rawHit, index) => {
        const hit = asObject(rawHit);
        const documentId = asString(hit?.documentId);
        const sectionId = asString(hit?.chunkId);
        if (documentId && sectionId)
          hits.push({ selector, documentId, sectionId, rank: index + 1 });
      });
    }
  }

  const fetchInput = tool === 'fetch_docs' ? inputObject : undefined;
  const fetchOutput = tool === 'fetch_docs' && succeeded ? output : undefined;
  const sections = Array.isArray(fetchOutput?.sections)
    ? fetchOutput.sections
    : [];
  const references = Array.isArray(fetchOutput?.references)
    ? fetchOutput.references
    : [];
  const serialized = succeeded ? safeJson(result) : null;
  const queryFingerprint =
    query && settings.queryMode === 'fingerprint'
      ? createHmac('sha256', fingerprintKey).update(query).digest('hex')
      : null;
  return {
    callId: randomUUID(),
    timestamp: startedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    tool,
    success: succeeded,
    errorClass: succeeded ? null : errorClass(error),
    responseBytes:
      serialized === null ? null : Buffer.byteLength(serialized, 'utf8'),
    queryLength: query === null ? null : [...query].length,
    queryFingerprint,
    queryText: query && settings.queryMode === 'raw' ? query : null,
    queryMode: query === null ? null : settings.queryMode,
    resultCount:
      tool === 'search_docs'
        ? asNumberOrNull(output?.totalResults)
        : tool === 'list_docs'
          ? outputSources.length
          : tool === 'fetch_docs'
            ? fetchOutput?.found === true
              ? 1
              : 0
            : null,
    fetchDocumentId: asString(fetchInput?.documentId) ?? null,
    fetchSectionId: asString(fetchInput?.sectionId) ?? null,
    fetchFound:
      typeof fetchOutput?.found === 'boolean' ? fetchOutput.found : null,
    fetchSectionCount: fetchOutput ? sections.length : null,
    fetchReferenceCount: fetchOutput ? references.length : null,
    fetchTruncated:
      typeof fetchOutput?.truncated === 'boolean'
        ? fetchOutput.truncated
        : null,
    fetchHasCursor: fetchInput ? Boolean(fetchInput.cursor) : null,
    fetchHasNextCursor:
      typeof fetchOutput?.nextCursor === 'string'
        ? fetchOutput.nextCursor.length > 0
        : fetchOutput
          ? false
          : null,
    sources: sources.filter((source) => source.selector.length > 0),
    hits,
  };
}

function insertEvent(database: DatabaseSync, event: ToolCallEvent): void {
  database
    .prepare(
      `INSERT INTO tool_calls (
        call_id, timestamp, duration_ms, tool, success, error_class,
        response_bytes, query_length, query_fingerprint, query_text, query_mode,
        result_count, fetch_document_id, fetch_section_id, fetch_found,
        fetch_section_count, fetch_reference_count, fetch_truncated,
        fetch_has_cursor, fetch_has_next_cursor
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.callId,
      event.timestamp,
      event.durationMs,
      event.tool,
      event.success ? 1 : 0,
      event.errorClass,
      event.responseBytes,
      event.queryLength,
      event.queryFingerprint,
      event.queryText,
      event.queryMode,
      event.resultCount,
      event.fetchDocumentId,
      event.fetchSectionId,
      boolToInteger(event.fetchFound),
      event.fetchSectionCount,
      event.fetchReferenceCount,
      boolToInteger(event.fetchTruncated),
      boolToInteger(event.fetchHasCursor),
      boolToInteger(event.fetchHasNextCursor),
    );
  const insertSource = database.prepare(
    'INSERT INTO call_sources (call_id, selector, result_count) VALUES (?, ?, ?)',
  );
  for (const source of event.sources)
    insertSource.run(event.callId, source.selector, source.resultCount);
  const insertHit = database.prepare(
    'INSERT INTO search_hits (call_id, selector, document_id, section_id, rank) VALUES (?, ?, ?, ?, ?)',
  );
  for (const hit of event.hits)
    insertHit.run(
      event.callId,
      hit.selector,
      hit.documentId,
      hit.sectionId,
      hit.rank,
    );
}

function readSummary(
  database: DatabaseSync,
  now: number,
  filters: ReturnType<typeof normalizeFilters>,
): UsageSummary {
  const settings = readSettings(database);
  if (!hasUsageSchema(database)) return emptySummary(filters, settings);
  const { where, parameters } = buildCallFilter(now, filters);
  const sourceWhere = filters.selector
    ? `${where} AND sources.selector = ?`
    : where;
  const sourceParameters = filters.selector
    ? [...parameters, filters.selector]
    : parameters;
  const hitWhere = filters.selector ? `${where} AND hits.selector = ?` : where;
  const hitParameters = filters.selector
    ? [...parameters, filters.selector]
    : parameters;
  const totalsRow = database
    .prepare(
      `SELECT count(*) AS calls,
          sum(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successes,
          sum(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures,
          avg(duration_ms) AS averageDurationMs,
          max(duration_ms) AS maxDurationMs,
          avg(response_bytes) AS averageResponseBytes,
          sum(response_bytes) AS totalResponseBytes
       FROM tool_calls calls ${where}`,
    )
    .get(...parameters);
  const toolRows = database
    .prepare(
      `SELECT tool, count(*) AS calls,
          sum(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures,
          avg(duration_ms) AS averageDurationMs,
          avg(response_bytes) AS averageResponseBytes
       FROM tool_calls calls ${where} GROUP BY tool ORDER BY calls DESC, tool`,
    )
    .all(...parameters);
  const sourceRows = database
    .prepare(
      `SELECT sources.selector AS selector, count(*) AS calls,
          sum(COALESCE(sources.result_count, 0)) AS results
       FROM call_sources sources JOIN tool_calls calls USING (call_id)
       ${sourceWhere}
       GROUP BY sources.selector ORDER BY calls DESC, sources.selector`,
    )
    .all(...sourceParameters);
  const searchHitRows = database
    .prepare(
      `SELECT hits.selector, hits.document_id AS documentId,
          count(*) AS searchHits, count(DISTINCT hits.call_id) AS searchCalls
       FROM search_hits hits JOIN tool_calls calls USING (call_id)
       ${hitWhere}
       GROUP BY hits.selector, hits.document_id
       ORDER BY searchHits DESC, hits.selector, hits.document_id LIMIT 20`,
    )
    .all(...hitParameters);
  const fetchRows = database
    .prepare(
      `SELECT sources.selector AS selector,
          calls.fetch_document_id AS documentId,
          count(*) AS fetchCalls,
          sum(CASE WHEN fetch_found = 1 THEN 1 ELSE 0 END) AS foundFetches
       FROM tool_calls calls JOIN call_sources sources USING (call_id)
       ${where} AND calls.tool = 'fetch_docs'
          AND fetch_document_id IS NOT NULL
       GROUP BY sources.selector, calls.fetch_document_id`,
    )
    .all(...parameters);
  const sectionRows = database
    .prepare(
      `SELECT hits.selector, hits.document_id AS documentId,
          hits.section_id AS sectionId, count(*) AS searchHits
       FROM search_hits hits JOIN tool_calls calls USING (call_id)
       ${hitWhere}
       GROUP BY hits.selector, hits.document_id, hits.section_id
       ORDER BY searchHits DESC, hits.selector, hits.document_id, hits.section_id
       LIMIT 20`,
    )
    .all(...hitParameters);
  const fetchSectionRows = database
    .prepare(
      `SELECT sources.selector AS selector,
          calls.fetch_document_id AS documentId,
          calls.fetch_section_id AS sectionId,
          count(*) AS fetchCalls
       FROM tool_calls calls JOIN call_sources sources USING (call_id)
       ${where} AND calls.tool = 'fetch_docs' AND calls.fetch_section_id IS NOT NULL
       GROUP BY sources.selector, calls.fetch_document_id, calls.fetch_section_id`,
    )
    .all(...parameters);
  const fetchSummary = database
    .prepare(
      `SELECT count(*) AS calls,
          sum(CASE WHEN fetch_found = 1 THEN 1 ELSE 0 END) AS found,
          sum(CASE WHEN fetch_found = 0 THEN 1 ELSE 0 END) AS missing,
          sum(COALESCE(fetch_section_count, 0)) AS returnedSections,
          sum(COALESCE(fetch_reference_count, 0)) AS referenceCount,
          sum(CASE WHEN fetch_truncated = 1 THEN 1 ELSE 0 END) AS truncated,
          sum(CASE WHEN fetch_has_cursor = 1 THEN 1 ELSE 0 END) AS continuations
       FROM tool_calls calls ${where} AND calls.tool = 'fetch_docs'`,
    )
    .get(...parameters);
  const queryLengthRows = database
    .prepare(
      `SELECT query_length AS characters, count(*) AS calls
       FROM tool_calls calls ${where} AND query_length IS NOT NULL
          AND query_mode = 'counts'
       GROUP BY query_length ORDER BY calls DESC, characters LIMIT 20`,
    )
    .all(...parameters);
  const queryRows = database
    .prepare(
      `SELECT query_mode AS mode, query_text AS query,
          query_fingerprint AS fingerprint,
          count(*) AS calls
       FROM tool_calls calls ${where} AND query_mode IN ('fingerprint', 'raw')
          AND (query_text IS NOT NULL OR query_fingerprint IS NOT NULL)
       GROUP BY query_mode, query_text, query_fingerprint
       ORDER BY calls DESC LIMIT 20`,
    )
    .all(...parameters);
  const callCount = asNumber(totalsRow?.calls);
  const recentRows = database
    .prepare(
      `SELECT calls.call_id AS callId, calls.timestamp, calls.tool,
          group_concat(sources.selector, char(10)) AS selectors,
          calls.success, calls.duration_ms AS durationMs,
          calls.response_bytes AS responseBytes,
          calls.result_count AS resultCount, calls.query_length AS queryLength,
          calls.query_mode AS queryMode, calls.query_text AS query,
          calls.query_fingerprint AS queryFingerprint,
          calls.fetch_document_id AS fetchDocumentId,
          calls.fetch_section_id AS fetchSectionId,
          calls.fetch_found AS fetchFound,
          calls.fetch_section_count AS fetchSectionCount,
          calls.fetch_reference_count AS fetchReferenceCount,
          calls.fetch_truncated AS fetchTruncated,
          calls.fetch_has_cursor AS fetchHasCursor,
          calls.fetch_has_next_cursor AS fetchHasNextCursor,
          calls.error_class AS errorClass
       FROM tool_calls calls
       LEFT JOIN call_sources sources USING (call_id)
       ${where}
       GROUP BY calls.call_id
       ORDER BY calls.timestamp DESC, calls.call_id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...parameters, filters.limit, filters.offset);

  return {
    settings,
    filters,
    totals: {
      calls: callCount,
      successes: asNumber(totalsRow?.successes),
      failures: asNumber(totalsRow?.failures),
      averageDurationMs: asNumber(totalsRow?.averageDurationMs),
      maxDurationMs: asNumber(totalsRow?.maxDurationMs),
      averageResponseBytes: asNumber(totalsRow?.averageResponseBytes),
      totalResponseBytes: asNumber(totalsRow?.totalResponseBytes),
    },
    tools: toolRows.map((row) => ({
      tool: asString(row.tool) ?? '',
      calls: asNumber(row.calls),
      failures: asNumber(row.failures),
      averageDurationMs: asNumber(row.averageDurationMs),
      averageResponseBytes: asNumber(row.averageResponseBytes),
    })),
    sources: sourceRows.map((row) => ({
      selector: asString(row.selector) ?? '',
      calls: asNumber(row.calls),
      results: asNumber(row.results),
    })),
    topDocuments: mergeDocumentRows(searchHitRows, fetchRows),
    topSections: mergeSectionRows(sectionRows, fetchSectionRows),
    fetches: {
      calls: asNumber(fetchSummary?.calls),
      found: asNumber(fetchSummary?.found),
      missing: asNumber(fetchSummary?.missing),
      returnedSections: asNumber(fetchSummary?.returnedSections),
      references: asNumber(fetchSummary?.referenceCount),
      truncated: asNumber(fetchSummary?.truncated),
      continuations: asNumber(fetchSummary?.continuations),
    },
    queryLengths: queryLengthRows.map((row) => ({
      characters: asNumber(row.characters),
      calls: asNumber(row.calls),
    })),
    topQueries: queryRows.map((row) => ({
      mode: row.mode === 'raw' ? 'raw' : 'fingerprint',
      query: asString(row.query) ?? '',
      fingerprint: asString(row.fingerprint) ?? null,
      calls: asNumber(row.calls),
    })),
    recentCalls: recentRows.map((row) => ({
      callId: asString(row.callId) ?? '',
      timestamp: new Date(asNumber(row.timestamp)).toISOString(),
      tool: asString(row.tool) ?? '',
      selectors: (asString(row.selectors) ?? '').split('\n').filter(Boolean),
      success: asNumber(row.success) === 1,
      durationMs: asNumber(row.durationMs),
      responseBytes: asNumberOrNull(row.responseBytes),
      resultCount: asNumberOrNull(row.resultCount),
      queryLength: asNumberOrNull(row.queryLength),
      queryMode:
        row.queryMode === 'counts' ||
        row.queryMode === 'fingerprint' ||
        row.queryMode === 'raw'
          ? row.queryMode
          : null,
      query: asString(row.query) ?? null,
      queryFingerprint: asString(row.queryFingerprint) ?? null,
      fetchDocumentId: asString(row.fetchDocumentId) ?? null,
      fetchSectionId: asString(row.fetchSectionId) ?? null,
      fetchFound: integerToBool(row.fetchFound),
      fetchSectionCount: asNumberOrNull(row.fetchSectionCount),
      fetchReferenceCount: asNumberOrNull(row.fetchReferenceCount),
      fetchTruncated: integerToBool(row.fetchTruncated),
      fetchHasCursor: integerToBool(row.fetchHasCursor),
      fetchHasNextCursor: integerToBool(row.fetchHasNextCursor),
      errorClass: asString(row.errorClass) ?? null,
    })),
    pagination: {
      total: callCount,
      limit: filters.limit,
      offset: filters.offset,
    },
  };
}

function mergeDocumentRows(
  searchRows: Record<string, SQLOutputValue>[],
  fetchRows: Record<string, SQLOutputValue>[],
) {
  const documents = new Map<
    string,
    {
      selector: string;
      documentId: string;
      searchHits: number;
      searchCalls: number;
      fetchCalls: number;
      foundFetches: number;
    }
  >();
  const getDocument = (selector: string, documentId: string) => {
    const key = `${selector}\u0000${documentId}`;
    let document = documents.get(key);
    if (!document) {
      document = {
        selector,
        documentId,
        searchHits: 0,
        searchCalls: 0,
        fetchCalls: 0,
        foundFetches: 0,
      };
      documents.set(key, document);
    }
    return document;
  };
  for (const row of searchRows) {
    const document = getDocument(
      asString(row.selector) ?? '',
      asString(row.documentId) ?? '',
    );
    document.searchHits = asNumber(row.searchHits);
    document.searchCalls = asNumber(row.searchCalls);
  }
  for (const row of fetchRows) {
    const document = getDocument(
      asString(row.selector) ?? '',
      asString(row.documentId) ?? '',
    );
    document.fetchCalls = asNumber(row.fetchCalls);
    document.foundFetches = asNumber(row.foundFetches);
  }
  return [...documents.values()]
    .sort(
      (left, right) =>
        right.searchHits + right.fetchCalls - left.searchHits - left.fetchCalls,
    )
    .slice(0, 20);
}

function mergeSectionRows(
  searchRows: Record<string, SQLOutputValue>[],
  fetchRows: Record<string, SQLOutputValue>[],
) {
  const sections = new Map<
    string,
    {
      selector: string;
      documentId: string;
      sectionId: string;
      searchHits: number;
      fetchCalls: number;
    }
  >();
  const getSection = (
    selector: string,
    documentId: string,
    sectionId: string,
  ) => {
    const key = `${selector}\u0000${documentId}\u0000${sectionId}`;
    let section = sections.get(key);
    if (!section) {
      section = {
        selector,
        documentId,
        sectionId,
        searchHits: 0,
        fetchCalls: 0,
      };
      sections.set(key, section);
    }
    return section;
  };
  for (const row of searchRows) {
    const section = getSection(
      asString(row.selector) ?? '',
      asString(row.documentId) ?? '',
      asString(row.sectionId) ?? '',
    );
    section.searchHits = asNumber(row.searchHits);
  }
  for (const row of fetchRows) {
    const section = getSection(
      asString(row.selector) ?? '',
      asString(row.documentId) ?? '',
      asString(row.sectionId) ?? '',
    );
    section.fetchCalls = asNumber(row.fetchCalls);
  }
  return [...sections.values()]
    .sort(
      (left, right) =>
        right.searchHits + right.fetchCalls - left.searchHits - left.fetchCalls,
    )
    .slice(0, 20);
}

function buildCallFilter(
  now: number,
  filters: ReturnType<typeof normalizeFilters>,
) {
  const conditions: string[] = [];
  const parameters: (number | string)[] = [];
  const windowMs: Partial<Record<UsageWindow, number>> = {
    '24h': DAY_MS,
    '7d': 7 * DAY_MS,
    '30d': 30 * DAY_MS,
  };
  const duration = windowMs[filters.window];
  if (duration !== undefined) {
    conditions.push('calls.timestamp >= ?');
    parameters.push(now - duration);
  }
  if (filters.tool) {
    conditions.push('calls.tool = ?');
    parameters.push(filters.tool);
  }
  if (filters.selector) {
    conditions.push(
      'EXISTS (SELECT 1 FROM call_sources filter_sources WHERE filter_sources.call_id = calls.call_id AND filter_sources.selector = ?)',
    );
    parameters.push(filters.selector);
  }
  return {
    where: conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : 'WHERE 1 = 1',
    parameters,
  };
}

function normalizeFilters(filters: UsageFilters) {
  return {
    window: filters.window,
    selector: filters.selector,
    tool: filters.tool,
    limit: Math.min(100, Math.max(1, Math.floor(filters.limit ?? 25))),
    offset: Math.min(100_000, Math.max(0, Math.floor(filters.offset ?? 0))),
  };
}

function emptySummary(
  filters: ReturnType<typeof normalizeFilters>,
  settings: UsageSettings = { ...DEFAULT_USAGE_SETTINGS },
): UsageSummary {
  return {
    settings,
    filters,
    totals: {
      calls: 0,
      successes: 0,
      failures: 0,
      averageDurationMs: 0,
      maxDurationMs: 0,
      averageResponseBytes: 0,
      totalResponseBytes: 0,
    },
    tools: [],
    sources: [],
    topDocuments: [],
    topSections: [],
    fetches: {
      calls: 0,
      found: 0,
      missing: 0,
      returnedSections: 0,
      references: 0,
      truncated: 0,
      continuations: 0,
    },
    queryLengths: [],
    topQueries: [],
    recentCalls: [],
    pagination: { total: 0, limit: filters.limit, offset: filters.offset },
  };
}

function initializeSchema(database: DatabaseSync): void {
  const version = asNumber(
    database.prepare('PRAGMA user_version').get()?.user_version,
  );
  if (version > SCHEMA_VERSION)
    throw new Error(
      'Usage statistics database version is newer than supported.',
    );
  if (version === SCHEMA_VERSION) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS usage_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        query_mode TEXT NOT NULL CHECK (query_mode IN ('counts', 'fingerprint', 'raw')),
        retention_days INTEGER CHECK (retention_days IS NULL OR retention_days IN (7, 30, 90)),
        fingerprint_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        last_pruned_at INTEGER
      );
      INSERT OR IGNORE INTO usage_settings (
        id, enabled, query_mode, retention_days, fingerprint_key, updated_at
      ) VALUES (1, 0, 'counts', 30, '${randomUUID()}${randomUUID()}', 0);
      CREATE TABLE IF NOT EXISTS tool_calls (
        call_id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        tool TEXT NOT NULL CHECK (tool IN ('list_docs', 'search_docs', 'fetch_docs')),
        success INTEGER NOT NULL CHECK (success IN (0, 1)),
        error_class TEXT,
        response_bytes INTEGER,
        query_length INTEGER,
        query_fingerprint TEXT,
        query_text TEXT,
        query_mode TEXT CHECK (query_mode IS NULL OR query_mode IN ('counts', 'fingerprint', 'raw')),
        result_count INTEGER,
        fetch_document_id TEXT,
        fetch_section_id TEXT,
        fetch_found INTEGER CHECK (fetch_found IS NULL OR fetch_found IN (0, 1)),
        fetch_section_count INTEGER,
        fetch_reference_count INTEGER,
        fetch_truncated INTEGER CHECK (fetch_truncated IS NULL OR fetch_truncated IN (0, 1)),
        fetch_has_cursor INTEGER CHECK (fetch_has_cursor IS NULL OR fetch_has_cursor IN (0, 1)),
        fetch_has_next_cursor INTEGER CHECK (fetch_has_next_cursor IS NULL OR fetch_has_next_cursor IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS call_sources (
        call_id TEXT NOT NULL REFERENCES tool_calls(call_id) ON DELETE CASCADE,
        selector TEXT NOT NULL,
        result_count INTEGER,
        PRIMARY KEY (call_id, selector)
      );
      CREATE TABLE IF NOT EXISTS search_hits (
        call_id TEXT NOT NULL REFERENCES tool_calls(call_id) ON DELETE CASCADE,
        selector TEXT NOT NULL,
        document_id TEXT NOT NULL,
        section_id TEXT NOT NULL,
        rank INTEGER NOT NULL,
        PRIMARY KEY (call_id, selector, rank)
      );
      CREATE INDEX IF NOT EXISTS tool_calls_timestamp_idx ON tool_calls(timestamp DESC);
      CREATE INDEX IF NOT EXISTS tool_calls_tool_idx ON tool_calls(tool);
      CREATE INDEX IF NOT EXISTS call_sources_selector_idx ON call_sources(selector);
      CREATE INDEX IF NOT EXISTS search_hits_document_idx ON search_hits(selector, document_id);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    database.exec('COMMIT');
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
}

function hasUsageSchema(database: DatabaseSync): boolean {
  return (
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'usage_settings'",
      )
      .get()?.present === 1
  );
}

function readSettings(database: DatabaseSync): UsageSettings {
  if (!hasUsageSchema(database)) return { ...DEFAULT_USAGE_SETTINGS };
  const row = database
    .prepare(
      'SELECT enabled, query_mode AS queryMode, retention_days AS retentionDays FROM usage_settings WHERE id = 1',
    )
    .get();
  const parsed = usageSettingsSchema.safeParse({
    enabled: asNumber(row?.enabled) === 1,
    queryMode: row?.queryMode,
    retentionDays: row?.retentionDays ?? null,
  });
  return parsed.success ? parsed.data : { ...DEFAULT_USAGE_SETTINGS };
}

function getFingerprintKey(database: DatabaseSync): string {
  const key = database
    .prepare(
      'SELECT fingerprint_key AS fingerprintKey FROM usage_settings WHERE id = 1',
    )
    .get()?.fingerprintKey;
  if (typeof key === 'string' && key.length > 20) return key;
  const replacement = `${randomUUID()}${randomUUID()}`;
  database
    .prepare('UPDATE usage_settings SET fingerprint_key = ? WHERE id = 1')
    .run(replacement);
  return replacement;
}

function pruneIfDue(
  database: DatabaseSync,
  settings: UsageSettings,
  now: number,
): void {
  if (settings.retentionDays === null) return;
  const lastPrunedAt = database
    .prepare(
      'SELECT last_pruned_at AS lastPrunedAt FROM usage_settings WHERE id = 1',
    )
    .get()?.lastPrunedAt;
  if (typeof lastPrunedAt === 'number' && now - lastPrunedAt < DAY_MS) return;
  pruneExpiredCalls(database, settings.retentionDays, now);
}

function pruneExpiredCalls(
  database: DatabaseSync,
  retentionDays: number | null,
  now: number,
): void {
  if (retentionDays !== null) {
    database
      .prepare('DELETE FROM tool_calls WHERE timestamp < ?')
      .run(now - retentionDays * DAY_MS);
  }
  database
    .prepare('UPDATE usage_settings SET last_pruned_at = ? WHERE id = 1')
    .run(now);
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // The transaction may already have rolled back after a SQLite error.
  }
}

function safeJson(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : '';
  } catch {
    return null;
  }
}

function errorClass(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  const name = error.name.replace(/[^A-Za-z0-9_.$]/gu, '').slice(0, 100);
  return name || 'Error';
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integerToBool(value: unknown): boolean | null {
  return typeof value === 'number' ? value === 1 : null;
}

function boolToInteger(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

function isPromiseLike<T>(value: T): value is T & PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EEXIST'
  );
}
