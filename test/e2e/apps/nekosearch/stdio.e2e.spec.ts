import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { addSnapshot } from '../../../../apps/nekosearch/src/catalog.js';
import { UsageStatsStore } from '../../../../apps/nekosearch/src/usage-stats.js';
import { createDocumentationTestIndex } from '../../../fixtures/documentation-index.js';

const entryPoint = fileURLToPath(
  new URL(
    '../../../../apps/nekosearch/dist/apps/nekosearch/cli.js',
    import.meta.url,
  ),
);

describe('nekosearch serve stdio server', () => {
  it.each(['EOF', 'SIGINT', 'SIGTERM'] as const)(
    'shuts down on %s with only protocol messages on stdout',
    async (shutdown) => {
      const directory = mkdtempSync(join(tmpdir(), 'nekosearch-stdio-'));
      const dataHome = await createSyntheticCatalog(directory);
      const transport = createTransport(dataHome, directory);
      const client = new Client({ name: 'lifecycle-test', version: '0.0.1' });
      const transportErrors: Error[] = [];
      let stdout = '';
      let stderr = '';
      captureStdout(transport, (chunk) => {
        stdout += chunk;
      });
      transport.onerror = (error) => transportErrors.push(error);
      transport.stderr?.on('data', (chunk: string | Buffer) => {
        stderr += chunk.toString();
      });
      const timeout = setTimeout(() => {
        const child = getChildProcess(transport);
        child?.kill('SIGKILL');
      }, 5000);
      let child: ChildProcess | undefined;
      let closed: Promise<unknown[]> | undefined;

      try {
        await withTimeout(
          client.connect(transport).catch((error: unknown) => {
            throw new Error(`stdio MCP initialize failed: ${stderr}`, {
              cause: error,
            });
          }),
          'stdio MCP initialize',
        );
        const runningChild = getChildProcess(transport);
        if (!runningChild)
          throw new Error('stdio server process did not start');
        child = runningChild;
        closed = once(runningChild, 'close');
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
          'fetch_docs',
          'list_docs',
          'search_docs',
        ]);
        const listed = await client.callTool({
          name: 'list_docs',
          arguments: {},
        });
        expect(listed.isError).not.toBe(true);
        expect(listed.structuredContent).toMatchObject({
          sources: [
            { selector: 'mcp@2025-11-25' },
            { selector: 'synthetic-mcp-documentation@12' },
          ],
        });
        if (shutdown === 'EOF') {
          await client.close();
        } else {
          runningChild.kill(shutdown);
        }
        const exit = (await withTimeout(closed, 'stdio server shutdown')) as [
          number | null,
          NodeJS.Signals | null,
        ];
        expect(exit).toEqual([
          shutdown === 'EOF' ? 0 : shutdown === 'SIGINT' ? 130 : 143,
          null,
        ]);
        expect(transportErrors).toEqual([]);
        expect(stderr).toContain('NekoSearch MCP server ready on stdio');
        expectProtocolStdout(stdout);
      } finally {
        clearTimeout(timeout);
        await client.close().catch(() => undefined);
        child ??= getChildProcess(transport);
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          if (closed) await closed;
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
    10000,
  );

  it('writes debug timing to stderr while keeping stdout protocol-only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nekosearch-stdio-'));
    const dataHome = await createSyntheticCatalog(directory);
    const transport = createTransport(dataHome, directory, { DEBUG: '1' });
    const client = new Client({ name: 'timing-test', version: '0.0.1' });
    const transportErrors: Error[] = [];
    let stdout = '';
    let stderr = '';
    captureStdout(transport, (chunk) => {
      stdout += chunk;
    });
    transport.onerror = (error) => transportErrors.push(error);
    transport.stderr?.on('data', (chunk: string | Buffer) => {
      stderr += chunk.toString();
    });
    const timeout = setTimeout(() => {
      const child = getChildProcess(transport);
      child?.kill('SIGKILL');
    }, 5000);
    let child: ChildProcess | undefined;
    let closed: Promise<unknown[]> | undefined;

    try {
      await withTimeout(
        client.connect(transport).catch((error: unknown) => {
          throw new Error(`stdio MCP initialize failed: ${stderr}`, {
            cause: error,
          });
        }),
        'stdio MCP initialize',
      );
      const runningChild = getChildProcess(transport);
      if (!runningChild) throw new Error('stdio server process did not start');
      child = runningChild;
      closed = once(runningChild, 'close');
      const result = await withTimeout(
        client.callTool({
          name: 'search_docs',
          arguments: {
            query: 'ExecutionContext',
            sources: ['synthetic-mcp-documentation@12'],
            limit: 1,
          },
        }),
        'stdio MCP tool call',
      );
      expect(result.isError).not.toBe(true);
      const searchResponse = result.structuredContent as {
        groups: Array<{
          selector: string;
          results: Array<{
            documentId: string;
            chunkId: string;
            sourceRevision: string;
            canonicalUrl: string;
          }>;
        }>;
      };
      const hit = searchResponse.groups[0]?.results[0];
      if (!hit) throw new Error('search_docs returned no result');
      expect(hit).toMatchObject({
        sourceRevision: 'mcp-synthetic-revision',
        canonicalUrl: 'https://docs.example.test/execution-context#api',
      });
      expect(searchResponse.groups[0]?.selector).toBe(
        'synthetic-mcp-documentation@12',
      );
      expect(JSON.stringify(result)).toContain(
        'provides execution-context details',
      );
      const fetched = await client.callTool({
        name: 'fetch_docs',
        arguments: {
          selector: 'synthetic-mcp-documentation@12',
          documentId: hit.documentId,
          sectionId: hit.chunkId,
        },
      });
      expect(fetched.isError).not.toBe(true);
      expect(fetched.structuredContent).toMatchObject({
        selector: 'synthetic-mcp-documentation@12',
        version: '12',
        found: true,
        sourceRevision: 'mcp-synthetic-revision',
      });
      await client.close();
      await withTimeout(closed, 'stdio server shutdown');
      expect(transportErrors).toEqual([]);
      expect(stderr).toMatch(/MCP tool search_docs success in \d+ ms/u);
      expectProtocolStdout(stdout);
    } finally {
      clearTimeout(timeout);
      await client.close().catch(() => undefined);
      child ??= getChildProcess(transport);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        if (closed) await closed;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);

  it('records local tool, source, document and section usage when enabled', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nekosearch-usage-e2e-'));
    const dataHome = await createSyntheticCatalog(directory);
    const usage = new UsageStatsStore(join(dataHome, 'nekosearch'));
    usage.updateSettings({
      enabled: true,
      queryMode: 'counts',
    });
    const transport = createTransport(dataHome, directory);
    const client = new Client({ name: 'usage-test', version: '0.0.1' });
    let closed: Promise<unknown[]> | undefined;

    try {
      await client.connect(transport);
      const child = getChildProcess(transport);
      if (!child) throw new Error('stdio server process did not start');
      closed = once(child, 'close');
      const listed = await client.callTool({
        name: 'list_docs',
        arguments: {},
      });
      expect(listed.isError).not.toBe(true);
      const searched = await client.callTool({
        name: 'search_docs',
        arguments: {
          query: 'ExecutionContext',
          sources: ['synthetic-mcp-documentation@12'],
          limit: 1,
        },
      });
      expect(searched.isError).not.toBe(true);
      const search = searched.structuredContent as {
        groups: Array<{
          selector: string;
          results: Array<{ documentId: string; chunkId: string }>;
        }>;
      };
      const hit = search.groups[0]?.results[0];
      if (!hit) throw new Error('search_docs returned no result');
      const fetched = await client.callTool({
        name: 'fetch_docs',
        arguments: {
          selector: 'synthetic-mcp-documentation@12',
          documentId: hit.documentId,
          sectionId: hit.chunkId,
        },
      });
      expect(fetched.isError).not.toBe(true);

      const summary = usage.getSummary({ window: 'all' });
      expect(summary.totals).toMatchObject({
        calls: 3,
        successes: 3,
        failures: 0,
      });
      expect(summary.tools.map(({ tool }) => tool).sort()).toEqual([
        'fetch_docs',
        'list_docs',
        'search_docs',
      ]);
      expect(summary.sources).toContainEqual({
        selector: 'synthetic-mcp-documentation@12',
        calls: 3,
        results: 2,
      });
      expect(summary.topDocuments).toContainEqual(
        expect.objectContaining({
          selector: 'synthetic-mcp-documentation@12',
          documentId: hit.documentId,
          searchHits: 1,
          fetchCalls: 1,
          foundFetches: 1,
        }),
      );
      expect(summary.topSections).toContainEqual(
        expect.objectContaining({
          selector: 'synthetic-mcp-documentation@12',
          documentId: hit.documentId,
          sectionId: hit.chunkId,
          searchHits: 1,
          fetchCalls: 1,
        }),
      );
      expect(
        summary.recentCalls.find((call) => call.tool === 'search_docs'),
      ).toMatchObject({
        query: null,
        queryLength: 'ExecutionContext'.length,
      });
    } finally {
      await client.close().catch(() => undefined);
      if (closed) await closed;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);
});

function createTransport(
  dataHome: string,
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint, 'serve'],
    cwd,
    env: {
      ...process.env,
      XDG_DATA_HOME: dataHome,
      ...environment,
    },
    stderr: 'pipe',
  });
}

async function createSyntheticCatalog(directory: string): Promise<string> {
  const dataHome = join(directory, 'data');
  const snapshotDirectory = join(directory, 'snapshot');
  mkdirSync(snapshotDirectory);
  createDocumentationTestIndex(join(snapshotDirectory, 'index.sqlite'));
  await addSnapshot(snapshotDirectory, {
    catalogRoot: join(dataHome, 'nekosearch'),
  });
  return dataHome;
}

function getChildProcess(
  transport: StdioClientTransport,
): ChildProcess | undefined {
  return (transport as unknown as { _process?: ChildProcess })._process;
}

function captureStdout(
  transport: StdioClientTransport,
  onData: (chunk: string) => void,
): void {
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    getChildProcess(transport)?.stdout?.on('data', (chunk: Buffer) => {
      onData(chunk.toString());
    });
  };
}

function expectProtocolStdout(stdout: string): void {
  const lines = stdout.trim().split('\n');
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const message = JSON.parse(line) as Record<string, unknown>;
    expect(message['jsonrpc']).toBe('2.0');
    expect(
      typeof message['method'] === 'string' ||
        typeof message['id'] === 'number' ||
        typeof message['id'] === 'string',
    ).toBe(true);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  milliseconds = 10000,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
