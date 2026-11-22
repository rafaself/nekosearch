import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { ZodError } from 'zod';
import { readCatalogOverview, snapshotIdentity } from '../catalog.js';
import {
  CURATED_REMOTE_SNAPSHOT_RECIPES,
  getSnapshotTrackingState,
} from '../remote-snapshots.js';
import { dashboardJobRequestSchema } from './job-contract.js';
import { createDashboardJobs } from './jobs.js';
import { UsageStatsStore, type UsageFilters } from '../usage-stats.js';

const LOOPBACK = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const ASSETS = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/add', 'add.html', 'text/html; charset=utf-8'],
  ['/about', 'about.html', 'text/html; charset=utf-8'],
  ['/usage', 'usage.html', 'text/html; charset=utf-8'],
  ['/details', 'details.html', 'text/html; charset=utf-8'],
  ['/nekosearch.png', 'nekosearch.png', 'image/png'],
  ['/dashboard.css', 'dashboard.css', 'text/css; charset=utf-8'],
  ...[
    'action-dialog.js',
    'catalog.js',
    'add-documentation.js',
    'dashboard.js',
    'dashboard-api.js',
    'navigation.js',
    'snapshot-actions.js',
    'snapshot-details.js',
    'usage.js',
    'usage-metrics.js',
  ].map(
    (file) => [`/${file}`, file, 'text/javascript; charset=utf-8'] as const,
  ),
] as const;

export async function runDashboard(): Promise<void> {
  const assets = new Map<string, { type: string; body: Buffer }>(
    await Promise.all(
      ASSETS.map(async ([route, file, type]) => {
        const body = await readFile(
          new URL(`./assets/${file}`, import.meta.url),
        );
        return [route, { type, body }] as const;
      }),
    ),
  );
  const jobs = createDashboardJobs();
  const usageStats = new UsageStatsStore(undefined, Date.now, (error) => {
    process.stderr.write(
      `NekoSearch usage statistics could not be stored (${error instanceof Error ? error.name : 'Error'}).\n`,
    );
  });
  const token = randomBytes(32).toString('base64url');
  const authorization = Buffer.from(`Bearer ${token}`);

  const server = createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000 },
    (request, response) => {
      void handle(request, response).catch((error: unknown) => {
        process.stderr.write(
          `NekoSearch dashboard request failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        if (response.headersSent) response.destroy();
        else
          json(response, 500, {
            error:
              'The dashboard request failed. See the terminal for details.',
          });
      });
    },
  );
  server.listen(0, LOOPBACK);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('The dashboard did not bind to a TCP port');
  const origin = new URL(`http://${LOOPBACK}:${address.port}`);
  process.stdout.write(`Open NekoSearch: ${origin.href}#token=${token}\n`);

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    if (request.headers.host !== origin.host) {
      json(response, 403, { error: 'Invalid dashboard host.' });
      return;
    }

    const path = request.url ?? '';
    const requestUrl = new URL(path, origin);
    const assetPath =
      /^\/details\/(?:[a-f0-9]{64}|[a-z][a-z0-9-]{0,127})$/u.test(
        requestUrl.pathname,
      )
        ? '/details'
        : requestUrl.pathname;
    const asset = assets.get(assetPath);
    if (request.method === 'GET' && asset) {
      response.writeHead(200, { 'Content-Type': asset.type });
      response.end(asset.body);
      return;
    }
    if (!requestUrl.pathname.startsWith('/api/')) {
      json(response, 404, { error: 'Page not found.' });
      return;
    }

    const provided = Buffer.from(request.headers.authorization ?? '');
    if (
      provided.length !== authorization.length ||
      !timingSafeEqual(provided, authorization)
    ) {
      json(response, 401, {
        error: 'Open the dashboard using the link printed by NekoSearch.',
      });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/catalog') {
      const { readable, entries, errors } = await readCatalogOverview();
      const catalogEntries = await Promise.all(
        entries.map(async (entry) => {
          const snapshotDirectory = dirname(entry.databasePath);
          const [indexFile, corpusFile, manifestFile] = await Promise.all([
            stat(entry.databasePath),
            stat(join(snapshotDirectory, 'corpus.json')),
            stat(join(snapshotDirectory, 'manifest.json')),
          ]);
          const chunkStats = readChunkStatistics(
            entry.databasePath,
            entry.version,
          );
          const documentCount = entry.manifest.index.documentCount;
          const chunkCount = entry.manifest.index.chunkCount;
          const source = entry.manifest.source;
          return {
            selector: `${entry.source}@${entry.version}`,
            snapshotKey: snapshotIdentity(entry).directoryKey,
            revision: entry.revision,
            status: entry.status,
            tracking: getSnapshotTrackingState(entry),
            documentCount,
            chunkCount,
            averageChunksPerDocument: chunkCount / documentCount,
            averageChunkCharacters: chunkStats.averageChunkCharacters,
            smallestChunkCharacters: chunkStats.smallestChunkCharacters,
            largestChunkCharacters: chunkStats.largestChunkCharacters,
            documentationUrl: chunkStats.documentationUrl,
            sourceRef: source.kind === 'git' ? source.ref : undefined,
            sourceRepositoryUrl: getSourceRepositoryUrl(source),
            installedAt:
              entry.status === 'installed'
                ? manifestFile.mtime.toISOString()
                : undefined,
            indexSizeBytes: indexFile.size,
            corpusSizeBytes: corpusFile.size,
            snapshotSizeBytes:
              indexFile.size + corpusFile.size + manifestFile.size,
            embeddings: entry.manifest.embeddings
              ? {
                  modelId: entry.manifest.embeddings.modelId,
                  dimensions: entry.manifest.embeddings.embeddingDimensions,
                }
              : undefined,
          };
        }),
      );
      json(response, 200, {
        readable,
        errors,
        curatedSources: CURATED_REMOTE_SNAPSHOT_RECIPES.map(
          ({ selector }) => selector,
        ),
        entries: catalogEntries,
      });
      return;
    }
    if (
      request.method === 'GET' &&
      requestUrl.pathname === '/api/usage/settings'
    ) {
      json(response, 200, usageStats.getSettings());
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/usage') {
      const filters = parseUsageFilters(requestUrl.searchParams);
      if (!filters) {
        json(response, 400, {
          error: 'The usage filters are invalid.',
        });
        return;
      }
      json(response, 200, usageStats.getSummary(filters));
      return;
    }
    if (
      request.method === 'PUT' &&
      requestUrl.pathname === '/api/usage/settings'
    ) {
      if (request.headers.origin !== origin.origin) {
        json(response, 403, { error: 'Invalid dashboard origin.' });
        return;
      }
      const body = await readJsonRequest(request, response, 'usage settings');
      if (body === undefined) return;
      try {
        json(response, 200, usageStats.updateSettings(body));
      } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        json(response, 400, {
          error: 'Choose valid usage collection settings.',
        });
      }
      return;
    }
    if (request.method === 'DELETE' && requestUrl.pathname === '/api/usage') {
      if (request.headers.origin !== origin.origin) {
        json(response, 403, { error: 'Invalid dashboard origin.' });
        return;
      }
      json(response, 200, { clearedCalls: usageStats.clear() });
      return;
    }
    if (
      request.method === 'GET' &&
      requestUrl.pathname.startsWith('/api/jobs/')
    ) {
      const job = jobs.get(requestUrl.pathname.slice('/api/jobs/'.length));
      if (job) json(response, 200, job);
      else json(response, 404, { error: 'This job is no longer available.' });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/jobs') {
      if (request.headers.origin !== origin.origin) {
        json(response, 403, { error: 'Invalid dashboard origin.' });
        return;
      }
      const body = await readJsonRequest(request, response, 'operation');
      if (body === undefined) return;
      const parsed = dashboardJobRequestSchema.safeParse(body);
      if (!parsed.success) {
        json(response, 400, {
          error:
            'Invalid documentation operation. Use a source@version selector and an absolute path for folder imports.',
        });
        return;
      }
      const job = jobs.start(parsed.data);
      if (!job) {
        json(response, 409, {
          error: 'Another documentation operation is running.',
        });
        return;
      }
      response.setHeader('Location', `/api/jobs/${job.id}`);
      json(response, 202, job);
      return;
    }
    json(response, 404, { error: 'Route not found.' });
  }
}

function readChunkStatistics(databasePath: string, version: string) {
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: 5000,
  });
  try {
    const summary = database
      .prepare(
        `SELECT avg(length(markdown)) AS averageChunkCharacters,
            min(length(markdown)) AS smallestChunkCharacters,
            max(length(markdown)) AS largestChunkCharacters,
            (SELECT canonical_url FROM documentation_search
             WHERE documentation_version = ?
             ORDER BY document_id COLLATE BINARY, chunk_index ASC
             LIMIT 1) AS documentationUrl
         FROM documentation_search
         WHERE documentation_version = ?`,
      )
      .get(version, version);
    if (
      typeof summary?.averageChunkCharacters !== 'number' ||
      typeof summary.smallestChunkCharacters !== 'number' ||
      typeof summary.largestChunkCharacters !== 'number' ||
      typeof summary.documentationUrl !== 'string'
    ) {
      throw new Error('The documentation index statistics are unavailable.');
    }
    return {
      averageChunkCharacters: summary.averageChunkCharacters,
      smallestChunkCharacters: summary.smallestChunkCharacters,
      largestChunkCharacters: summary.largestChunkCharacters,
      documentationUrl: summary.documentationUrl,
    };
  } finally {
    database.close();
  }
}

function getSourceRepositoryUrl(
  source:
    { kind: 'local' } | { kind: 'git'; repository: string; revision: string },
) {
  if (source.kind !== 'git') return undefined;
  let repository: URL;
  try {
    repository = new URL(source.repository);
  } catch {
    return undefined;
  }
  if (
    repository.protocol !== 'https:' ||
    repository.username ||
    repository.password
  ) {
    return undefined;
  }
  if (repository.hostname.toLowerCase() !== 'github.com')
    return repository.href;

  const repositoryPath = repository.pathname
    .replace(/\/+$/u, '')
    .replace(/\.git$/u, '');
  return `${repository.origin}${repositoryPath}/commit/${encodeURIComponent(source.revision)}`;
}

async function readJsonRequest(
  request: IncomingMessage,
  response: ServerResponse,
  resource: string,
) {
  if (
    request.headers['content-type']?.split(';')[0]?.trim() !==
    'application/json'
  ) {
    json(response, 415, {
      error: `Send ${resource} as application/json.`,
    });
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({
    destroyOnReturn: false,
  }) as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      response.setHeader('Connection', 'close');
      json(response, 413, { error: `The ${resource} request is too large.` });
      return;
    }
    chunks.push(chunk);
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    json(response, 400, {
      error: `The ${resource} request contains invalid JSON.`,
    });
    return;
  }
  return input;
}

function parseUsageFilters(
  parameters: URLSearchParams,
): UsageFilters | undefined {
  const window = parameters.get('window') ?? '7d';
  const selector = parameters.get('selector') ?? undefined;
  const tool = parameters.get('tool') ?? undefined;
  const limit = parseIntegerParameter(parameters.get('limit'), 25, 1, 100);
  const offset = parseIntegerParameter(parameters.get('offset'), 0, 0, 100_000);
  if (
    !['24h', '7d', '30d', 'all'].includes(window) ||
    (selector !== undefined &&
      (selector.length < 1 ||
        selector.length > 321 ||
        containsControlCharacters(selector))) ||
    (tool !== undefined &&
      !['list_docs', 'search_docs', 'fetch_docs'].includes(tool)) ||
    limit === undefined ||
    offset === undefined
  ) {
    return undefined;
  }
  return {
    window: window as UsageFilters['window'],
    selector,
    tool: tool as UsageFilters['tool'],
    limit,
    offset,
  };
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function parseIntegerParameter(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === null) return fallback;
  if (!/^(0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}
