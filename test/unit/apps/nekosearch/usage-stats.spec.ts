import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageStatsStore } from '../../../../apps/nekosearch/src/usage-stats.js';

describe('UsageStatsStore', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'nekosearch-usage-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('defaults to disabled and creates no database until settings are saved', () => {
    const store = new UsageStatsStore(directory);
    expect(store.getSettings()).toEqual({
      enabled: false,
      queryMode: 'counts',
      retentionDays: 30,
    });

    store.record('list_docs', {}, () => ({
      structuredContent: { sources: [] },
    }));

    expect(() => statSync(join(directory, 'usage.sqlite'))).toThrow();
  });

  it('records multi-source search hits, failures, fetch metadata, size and query privacy', async () => {
    let now = 10_000;
    const store = new UsageStatsStore(directory, () => now);
    store.updateSettings({
      enabled: true,
      queryMode: 'counts',
      retentionDays: 30,
    });
    const searchResult = {
      content: [{ type: 'text', text: 'private documentation response' }],
      structuredContent: {
        totalResults: 1,
        groups: [
          {
            selector: 'nestjs@12',
            results: [
              {
                documentId: 'dependency-injection',
                chunkId: 'providers-section',
              },
            ],
          },
          { selector: 'nestjs@11', results: [] },
        ],
      },
    };
    const returned = store.record(
      'search_docs',
      {
        query: 'private search phrase',
        sources: ['nestjs@12', 'nestjs@11'],
      },
      () => searchResult,
    );
    expect(returned).toBe(searchResult);

    now += 12;
    await expect(
      store.record(
        'search_docs',
        { query: 'failed query text', sources: ['nestjs@12'] },
        () =>
          Promise.reject(
            new Error('failed query text must not be saved as an error'),
          ),
      ),
    ).rejects.toThrow('failed query text must not be saved as an error');

    now += 10;
    store.record(
      'fetch_docs',
      {
        selector: 'nestjs@12',
        documentId: 'missing-page',
        sectionId: 'missing-section',
        cursor: 'cursor',
      },
      () => ({
        structuredContent: {
          found: false,
          sections: [],
          references: [],
          truncated: false,
          nextCursor: null,
        },
      }),
    );
    now += 10;
    store.record(
      'fetch_docs',
      {
        selector: 'nestjs@12',
        documentId: 'dependency-injection',
        sectionId: 'providers-section',
      },
      () => ({
        structuredContent: {
          found: true,
          sections: [{}, {}],
          references: [{}, {}, {}],
          truncated: true,
          nextCursor: 'next-page',
        },
      }),
    );

    const summary = store.getSummary({ window: 'all', limit: 25, offset: 0 });
    expect(summary.totals).toMatchObject({
      calls: 4,
      successes: 3,
      failures: 1,
    });
    expect(summary.sources).toEqual(
      expect.arrayContaining([
        { selector: 'nestjs@12', calls: 4, results: 2 },
        { selector: 'nestjs@11', calls: 1, results: 0 },
      ]),
    );
    expect(summary.topDocuments).toContainEqual({
      selector: 'nestjs@12',
      documentId: 'dependency-injection',
      searchHits: 1,
      searchCalls: 1,
      fetchCalls: 1,
      foundFetches: 1,
    });
    expect(summary.topSections).toContainEqual({
      selector: 'nestjs@12',
      documentId: 'dependency-injection',
      sectionId: 'providers-section',
      searchHits: 1,
      fetchCalls: 1,
    });
    expect(summary.fetches).toEqual({
      calls: 2,
      found: 1,
      missing: 1,
      returnedSections: 2,
      references: 3,
      truncated: 1,
      continuations: 1,
    });
    expect(summary.recentCalls[2]).toMatchObject({
      tool: 'search_docs',
      query: null,
      queryLength: 'failed query text'.length,
      errorClass: 'Error',
    });
    expect(summary.recentCalls[3]).toMatchObject({
      tool: 'search_docs',
      query: null,
      queryLength: 'private search phrase'.length,
      responseBytes: Buffer.byteLength(JSON.stringify(searchResult), 'utf8'),
    });
    expect(summary.recentCalls[0]).toMatchObject({
      fetchFound: true,
      fetchHasCursor: false,
      fetchTruncated: true,
      fetchHasNextCursor: true,
    });
    expect(summary.recentCalls[1]).toMatchObject({
      fetchFound: false,
      fetchDocumentId: 'missing-page',
      fetchSectionId: 'missing-section',
      fetchHasCursor: true,
      fetchHasNextCursor: false,
    });
    const filtered = store.getSummary({
      window: 'all',
      selector: 'nestjs@11',
      tool: 'search_docs',
      limit: 1,
      offset: 0,
    });
    expect(filtered.pagination).toEqual({ total: 1, limit: 1, offset: 0 });
    expect(filtered.sources).toEqual([
      { selector: 'nestjs@11', calls: 1, results: 0 },
    ]);
    expect(filtered.topDocuments).toEqual([]);
    expect(statSync(join(directory, 'usage.sqlite')).mode & 0o777).toBe(0o600);
    const database = new DatabaseSync(join(directory, 'usage.sqlite'), {
      readOnly: true,
    });
    try {
      const savedQueries = database
        .prepare('SELECT query_text FROM tool_calls')
        .all();
      expect(savedQueries.every(({ query_text }) => query_text === null)).toBe(
        true,
      );
    } finally {
      database.close();
    }
  });

  it('stores keyed fingerprints or raw queries only when explicitly selected', () => {
    const store = new UsageStatsStore(directory);
    store.updateSettings({
      enabled: true,
      queryMode: 'fingerprint',
      retentionDays: 30,
    });
    const recordSearch = () =>
      store.record(
        'search_docs',
        { query: 'same phrase', sources: ['nestjs@12'] },
        () => ({ structuredContent: { groups: [], totalResults: 0 } }),
      );
    recordSearch();
    recordSearch();
    const fingerprintSummary = store.getSummary({ window: 'all' });
    expect(fingerprintSummary.topQueries).toHaveLength(1);
    expect(fingerprintSummary.topQueries[0]).toMatchObject({
      mode: 'fingerprint',
      query: '',
      calls: 2,
    });
    expect(fingerprintSummary.topQueries[0]?.fingerprint).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(fingerprintSummary.recentCalls[0]?.query).toBeNull();

    store.updateSettings({
      enabled: true,
      queryMode: 'raw',
      retentionDays: 30,
    });
    recordSearch();
    const rawSummary = store.getSummary({ window: 'all' });
    expect(rawSummary.recentCalls[0]?.query).toBe('same phrase');
    expect(rawSummary.topQueries).toContainEqual({
      mode: 'raw',
      query: 'same phrase',
      fingerprint: null,
      calls: 1,
    });
  });

  it('applies retention, keeps unlimited history, and clears calls without changing settings', () => {
    let now = 100_000;
    const store = new UsageStatsStore(directory, () => now);
    store.updateSettings({
      enabled: true,
      queryMode: 'counts',
      retentionDays: 7,
    });
    const recordList = () =>
      store.record('list_docs', {}, () => ({
        structuredContent: { sources: [] },
      }));

    recordList();
    now += 8 * 24 * 60 * 60 * 1000;
    recordList();
    expect(store.getSummary({ window: 'all' }).totals.calls).toBe(1);

    store.updateSettings({
      enabled: true,
      queryMode: 'counts',
      retentionDays: null,
    });
    recordList();
    now += 100 * 24 * 60 * 60 * 1000;
    recordList();
    expect(store.getSummary({ window: 'all' }).totals.calls).toBe(3);
    expect(store.clear()).toBe(3);
    expect(store.getSummary({ window: 'all' }).totals.calls).toBe(0);
    expect(store.getSettings()).toEqual({
      enabled: true,
      queryMode: 'counts',
      retentionDays: null,
    });
  });

  it('prunes expired data when a process starts even before another tool call', () => {
    let now = 5_000;
    const store = new UsageStatsStore(directory, () => now);
    store.updateSettings({
      enabled: true,
      queryMode: 'counts',
      retentionDays: 7,
    });
    store.record('list_docs', {}, () => ({
      structuredContent: { sources: [] },
    }));

    now += 8 * 24 * 60 * 60 * 1000;
    new UsageStatsStore(directory, () => now).pruneExpired();

    expect(store.getSummary({ window: 'all' }).totals.calls).toBe(0);
  });
});
