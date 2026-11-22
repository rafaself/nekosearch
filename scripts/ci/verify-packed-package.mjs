import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { stageNekosearchPackage } from '../release/stage-nekosearch-package.mjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = fileURLToPath(new URL('../../', import.meta.url));

function run(command, args, options = {}) {
  const result = runResult(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? result.signal})\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function runResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function withoutNpmDryRun(environment) {
  const clean = { ...environment };
  delete clean.npm_config_dry_run;
  delete clean.NPM_CONFIG_DRY_RUN;
  return clean;
}

function withoutIndexPathOverrides(environment) {
  const clean = { ...environment };
  delete clean.DOCUMENTATION_INDEX_PATH;
  delete clean.DOCUMENTATION_INDEX_MANIFEST_PATH;
  return clean;
}

async function withTimeout(promise, label, milliseconds = 30_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`${label} timed out after ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyDashboard(project, temporaryDirectory) {
  const cli = join(
    project,
    'node_modules/nekosearch/dist/apps/nekosearch/cli.js',
  );
  const directory = join(temporaryDirectory, 'dashboard-docs');
  const cwd = join(temporaryDirectory, 'dashboard-cwd');
  const configPath = join(temporaryDirectory, 'dashboard-config.yaml');
  await Promise.all([mkdir(directory), mkdir(cwd)]);
  await Promise.all([
    writeFile(
      join(directory, 'index.md'),
      '# Dashboard fixture\n\nAn offline snapshot.\n',
    ),
    writeFile(configPath, 'search:\n  semantic:\n    enabled: false\n'),
  ]);
  const dataHome = join(temporaryDirectory, 'dashboard-data');
  const env = {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    LOCALAPPDATA: dataHome,
    NEKOSEARCH_CONFIG: configPath,
  };
  const child = spawn(process.execPath, [cli, 'ui'], { cwd, env });
  const exited = new Promise((resolve) => child.once('close', resolve));
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    const url = await withTimeout(
      new Promise((resolve, reject) => {
        let stdout = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => {
          stdout += chunk;
          const match = stdout.match(/^Open NekoSearch: (\S+)\n/mu);
          if (match) resolve(new URL(match[1]));
        });
        child.once('error', reject);
        child.once('close', (code) =>
          reject(new Error(`Dashboard exited with code ${code}\n${stderr}`)),
        );
      }),
      'dashboard startup',
    );
    assert.equal(url.hostname, '127.0.0.1');
    const token = new URLSearchParams(url.hash.slice(1)).get('token');
    assert.ok(token, 'the dashboard should generate a launch token');
    const { origin } = url;
    const request = (path, options = {}) =>
      fetch(`${origin}${path}`, {
        ...options,
        signal: AbortSignal.timeout(5_000),
        headers: { Authorization: `Bearer ${token}`, ...options.headers },
      });
    async function getAsset(path, contentType) {
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type').startsWith(contentType));
      return response.text();
    }

    const catalogPage = await getAsset('/', 'text/html');
    assert.match(catalogPage, /href="\/" aria-current="page"\s*>\s*Catalog/u);
    assert.match(catalogPage, /href="\/about"\s*>\s*About\s*<\/a>/u);
    assert.match(catalogPage, /href="\/usage"\s*>\s*Usage\s*<\/a>/u);
    assert.match(
      catalogPage,
      /class="button prominent" href="\/add"\s*>\s*Add documentation/u,
    );
    assert.match(catalogPage, /src="\/navigation.js"/u);
    assert.doesNotMatch(catalogPage, /<form\b/u);
    const usagePage = await getAsset('/usage', 'text/html');
    assert.match(usagePage, /Clear usage data/u);
    assert.doesNotMatch(usagePage, /Keep statistics for|usage-retention/u);
    const addPage = await getAsset('/add', 'text/html');
    assert.match(addPage, /href="\/">\s*Catalog/u);
    assert.match(addPage, /href="\/about"\s*>\s*About\s*<\/a>/u);
    assert.match(addPage, /src="\/navigation.js"/u);
    assert.match(addPage, /<form id="curated-form"/u);
    assert.match(addPage, /<form id="local-form"/u);

    const aboutPage = await getAsset('/about', 'text/html');
    assert.match(aboutPage, /href="\/about" aria-current="page"\s*>\s*About/u);
    assert.match(
      aboutPage,
      /href="https:\/\/github\.com\/rafaself\/nekosearch"/u,
    );
    assert.match(
      aboutPage,
      /href="https:\/\/github\.com\/rafaself\/nekosearch\/issues\/new\/choose"/u,
    );
    assert.match(aboutPage, /href="https:\/\/nekosearch\.pages\.dev\/"/u);
    assert.match(usagePage, /<title>Usage · NekoSearch<\/title>/u);
    assert.match(usagePage, /id="usage-settings"/u);
    assert.match(usagePage, /id="usage-calls"/u);
    const detailsPage = await getAsset('/details', 'text/html');
    assert.match(detailsPage, /id="detail-document-usage-section"/u);
    assert.match(detailsPage, /Usage by document/u);

    for (const page of [catalogPage, addPage, aboutPage, usagePage]) {
      assert.match(page, /rel="icon"[^>]*href="\/nekosearch\.png"/u);
      assert.match(page, /<img\s+src="\/nekosearch\.png"/u);
    }
    const logo = await request('/nekosearch.png');
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await logo.arrayBuffer());
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

    for (const path of [
      '/catalog.js',
      '/add-documentation.js',
      '/dashboard.js',
      '/dashboard-api.js',
      '/navigation.js',
      '/snapshot-details.js',
      '/usage.js',
    ])
      await getAsset(path, 'text/javascript');
    await getAsset('/dashboard.css', 'text/css');
    assert.equal(
      (await request('/api/catalog', { headers: { Authorization: '' } }))
        .status,
      401,
    );
    assert.equal(
      (
        await request('/api/usage/settings', {
          headers: { Authorization: '' },
        })
      ).status,
      401,
    );
    const usageDatabasePath = join(dataHome, 'nekosearch', 'usage.sqlite');
    const defaultUsageSettings = await request('/api/usage/settings');
    assert.equal(defaultUsageSettings.status, 200);
    assert.deepEqual(await defaultUsageSettings.json(), {
      enabled: false,
      queryMode: 'counts',
    });
    assert.equal(existsSync(usageDatabasePath), false);
    const emptyUsage = await request('/api/usage?window=all');
    assert.equal(emptyUsage.status, 200);
    assert.equal((await emptyUsage.json()).totals.calls, 0);
    assert.equal((await request('/api/usage?window=bad')).status, 400);
    const usageSettings = {
      enabled: true,
      queryMode: 'counts',
    };
    const updateUsage = (requestOrigin = origin) =>
      request('/api/usage/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Origin: requestOrigin,
        },
        body: JSON.stringify(usageSettings),
      });
    assert.equal((await updateUsage('https://example.invalid')).status, 403);
    const savedUsageSettings = await updateUsage();
    assert.equal(savedUsageSettings.status, 200);
    assert.deepEqual(await savedUsageSettings.json(), usageSettings);
    const legacyRetentionSettings = await request('/api/usage/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: JSON.stringify({ ...usageSettings, retentionDays: 30 }),
    });
    assert.equal(legacyRetentionSettings.status, 400);
    assert.equal((await stat(usageDatabasePath)).mode & 0o777, 0o600);
    assert.equal(
      (
        await request('/api/usage', {
          method: 'DELETE',
          headers: { Origin: 'https://example.invalid' },
        })
      ).status,
      403,
    );
    const jobRequest = (body, requestOrigin = origin) =>
      request('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: requestOrigin },
        body: JSON.stringify(body),
      });
    const input = {
      operation: 'import-directory',
      selector: 'dashboard-fixture@1',
      directory,
    };
    assert.equal(
      (await jobRequest(input, 'https://example.invalid')).status,
      403,
    );
    assert.equal((await jobRequest({ ...input, directory: '.' })).status, 400);

    async function getCatalog() {
      const response = await request('/api/catalog');
      assert.equal(response.status, 200);
      const catalog = await response.json();
      assert.equal(catalog.readable, true);
      return catalog.entries;
    }

    async function completeJob(input) {
      const response = await jobRequest(input);
      assert.equal(response.status, 202, await response.clone().text());
      const path = response.headers.get('location');
      assert.match(path, /^\/api\/jobs\/[\da-f-]+$/u);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await request(path);
        assert.equal(result.status, 200);
        const job = await result.json();
        if (job.status.state !== 'running') return job.status;
        await delay(100);
      }
      throw new Error(`Dashboard job did not complete: ${input.operation}`);
    }

    assert.ok((await getCatalog()).some((entry) => entry.status === 'bundled'));
    const installed = await completeJob(input);
    assert.equal(installed.state, 'succeeded', installed.error);
    assert.match(
      run(process.execPath, [cli, 'list'], { cwd, env }),
      /dashboard-fixture\t1\t/u,
    );
    const entry = (await getCatalog()).find(
      ({ selector }) => selector === input.selector,
    );
    assert.equal(entry.documentCount, 1);
    assert.equal(entry.databasePath, undefined);
    const removal = {
      operation: 'remove',
      selector: input.selector,
      snapshotKey: entry.snapshotKey,
    };
    const stale = await completeJob({
      ...removal,
      snapshotKey: '0'.repeat(64),
    });
    assert.equal(stale.state, 'failed');
    assert.match(stale.error, /refresh the catalog/u);
    const removed = await completeJob(removal);
    assert.equal(removed.state, 'succeeded', removed.error);
    assert.ok(
      !(await getCatalog()).some(({ selector }) => selector === input.selector),
    );
  } finally {
    child.kill();
    await withTimeout(exited, 'dashboard shutdown');
  }
}

async function verifyCatalogServer(project, temporaryDirectory) {
  const binary = join(project, 'node_modules', '.bin', 'nekosearch');
  const guardPath = join(project, 'network-guard.mjs');
  const networkMarker = join(project, 'network-blocked');
  const mdxExecutionMarker = join(project, 'mdx-executed');
  const xdgDataHome = join(project, 'xdg-data');
  const fixtureDirectory = join(temporaryDirectory, 'fastapi-docs');
  const fixtureSnapshotDirectory = join(temporaryDirectory, 'fastapi-snapshot');
  await mkdir(xdgDataHome);
  await mkdir(fixtureDirectory);
  await mkdir(join(fixtureDirectory, 'reference'));
  await writeFile(
    join(fixtureDirectory, 'index.md'),
    '# FastAPI\n\nFastAPI uses sharedtopic, dependency injection, and the mandacaru fixture token. The offline-link-origin-probe identifies this page.\n\n[Offline target](./reference/guide.mdx#offline-link-target)\n',
  );
  await writeFile(
    join(fixtureDirectory, 'reference', 'guide.mdx'),
    [
      '---',
      'title: Guia de MDX',
      '---',
      '',
      '# Guia de MDX',
      '',
      '<Callout type="note">Jabuticaba and mandacaru appear in this static FastAPI guide.</Callout>',
      '',
      '## Offline Link Target',
      '',
      'offline-link-target-fetch-probe proves the packaged builder resolved this heading.',
      '',
      '{globalThis.__nekosearchMdxExecuted = true}',
      '',
    ].join('\n'),
  );
  const catalogDirectory = join(xdgDataHome, 'nekosearch');
  const catalogFile = join(catalogDirectory, 'catalog.json');
  const guardedEnvironment = withoutIndexPathOverrides({
    ...process.env,
    PATH: process.env.PATH ?? '',
    NODE_OPTIONS: `--import=${pathToFileURL(guardPath).href}`,
    NEKOSEARCH_NETWORK_GUARD_MARKER: networkMarker,
    NEKOSEARCH_MDX_EXECUTION_MARKER: mdxExecutionMarker,
    XDG_DATA_HOME: xdgDataHome,
  });

  const buildOutput = run(
    binary,
    [
      'build',
      fixtureDirectory,
      '--id',
      'fastapi@1',
      '--output',
      fixtureSnapshotDirectory,
    ],
    { cwd: project, env: guardedEnvironment },
  );
  assert.equal(
    buildOutput,
    '',
    'build should keep stdout available to callers',
  );
  const firstBuiltCorpus = JSON.parse(
    await readFile(join(fixtureSnapshotDirectory, 'corpus.json'), 'utf8'),
  );
  assert.ok(
    firstBuiltCorpus.documents
      .flatMap((document) => document.chunks)
      .flatMap((chunk) => chunk.references ?? [])
      .some(
        (reference) =>
          reference.href === './reference/guide.mdx#offline-link-target',
      ),
    'the installed binary build command should resolve the nested MDX link',
  );
  assert.deepEqual((await readdir(fixtureSnapshotDirectory)).sort(), [
    'corpus.json',
    'index.sqlite',
    'manifest.json',
  ]);
  await assert.rejects(readFile(catalogFile), { code: 'ENOENT' });
  await assert.rejects(readFile(networkMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(mdxExecutionMarker), { code: 'ENOENT' });

  const isolatedHome = join(project, 'setup-user-home');
  const setupResult = runResult(binary, ['setup'], {
    cwd: project,
    env: {
      ...guardedEnvironment,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
    },
  });
  assert.equal(
    setupResult.status,
    2,
    'non-TTY setup should exit with guidance',
  );
  assert.match(setupResult.stderr, /needs an interactive terminal/u);
  await assert.rejects(readFile(catalogFile), { code: 'ENOENT' });
  await assert.rejects(readFile(networkMarker), { code: 'ENOENT' });
  assert.ok(
    !(await readdir(project)).includes('setup-user-home'),
    'non-TTY setup must not create or edit client settings',
  );

  const initialCatalog = run(binary, ['list'], {
    cwd: project,
    env: guardedEnvironment,
  });
  assert.match(initialCatalog, /^SOURCE\tVERSION\tREVISION\tSTATUS\n/u);
  assert.match(initialCatalog, /^mcp\t2025-11-25\t2025-11-25\tbundled$/mu);
  assert.doesNotMatch(initialCatalog, /nestjs/iu);

  const mockRevision = 'a'.repeat(40);
  const remoteAdded = run(binary, ['add', 'nestjs@12'], {
    cwd: project,
    env: { ...guardedEnvironment, NEKOSEARCH_MOCK_NEST_SOURCE: '1' },
  });
  assert.match(
    remoteAdded,
    new RegExp(`Added nestjs@12 revision ${mockRevision} \\(installed\\)`),
  );
  await assert.rejects(readFile(networkMarker), { code: 'ENOENT' });

  const fixtureAdded = run(
    binary,
    ['add', '--from', fixtureSnapshotDirectory],
    { cwd: project, env: guardedEnvironment },
  );
  assert.match(fixtureAdded, /Added fastapi@1 revision /u);

  const grokStateAfterConfigure = await verifyGrokConfiguration(
    binary,
    project,
    temporaryDirectory,
    guardedEnvironment,
  );
  const updatedSnapshotDirectory = join(
    temporaryDirectory,
    'fastapi-snapshot-updated',
  );
  await writeFile(
    join(fixtureDirectory, 'index.md'),
    '# FastAPI\n\nThe offline-link-origin-probe now identifies the updated page. The local snapshot preserves the updated mandacaru token.\n\n[Offline target](./reference/guide.mdx#offline-link-target)\n',
  );
  run(
    binary,
    [
      'build',
      fixtureDirectory,
      '--id',
      'fastapi@1',
      '--output',
      updatedSnapshotDirectory,
    ],
    { cwd: project, env: guardedEnvironment },
  );
  const updatedBuiltCorpus = JSON.parse(
    await readFile(join(updatedSnapshotDirectory, 'corpus.json'), 'utf8'),
  );
  assert.ok(
    updatedBuiltCorpus.documents
      .flatMap((document) => document.chunks)
      .flatMap((chunk) => chunk.references ?? [])
      .some(
        (reference) =>
          reference.href === './reference/guide.mdx#offline-link-target',
      ),
    'the updated installed binary build should preserve its nested MDX link',
  );
  const { updateSnapshot } = await import(
    pathToFileURL(join(root, 'apps/nekosearch/dist/apps/nekosearch/catalog.js'))
      .href
  );
  const update = await updateSnapshot(updatedSnapshotDirectory, {
    catalogRoot: join(xdgDataHome, 'nekosearch'),
  });
  assert.equal(update.changed, true);
  const updatedRevision = update.entry.revision;
  assert.match(updatedRevision, /^[a-f0-9]{64}$/u);
  const updatedIndex = new DatabaseSync(update.entry.databasePath, {
    readOnly: true,
  });
  let storedReferenceCount;
  try {
    storedReferenceCount = Number(
      updatedIndex
        .prepare('SELECT COUNT(*) AS count FROM documentation_references')
        .get()?.count,
    );
  } finally {
    updatedIndex.close();
  }
  assert.ok(
    storedReferenceCount > 0,
    'the activated local snapshot should retain its resolved link rows',
  );
  const grokStateAfterSnapshotUpdate = JSON.parse(
    await readFile(grokStateAfterConfigure.stateFile, 'utf8'),
  );
  assert.deepEqual(
    grokStateAfterSnapshotUpdate.registrations,
    grokStateAfterConfigure.registrations,
    'updating a snapshot must preserve the Grok Build server registration',
  );
  assert.equal(
    grokStateAfterSnapshotUpdate.calls.length,
    grokStateAfterConfigure.calls.length,
    'snapshot updates must not invoke provider configuration commands',
  );
  const catalogOutput = run(binary, ['list'], {
    cwd: project,
    env: guardedEnvironment,
  });
  const rows = new Map(
    catalogOutput
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => {
        const [source, version, revision, status] = line.split('\t');
        return [`${source}@${version}`, { source, version, revision, status }];
      }),
  );
  assert.deepEqual(rows.get('mcp@2025-11-25'), {
    source: 'mcp',
    version: '2025-11-25',
    revision: '2025-11-25',
    status: 'bundled',
  });
  assert.equal(rows.get('nestjs@12')?.revision, mockRevision);
  assert.equal(rows.get('nestjs@12')?.status, 'installed');
  assert.match(rows.get('fastapi@1')?.revision ?? '', /^[a-f0-9]{64}$/u);
  assert.equal(rows.get('fastapi@1')?.status, 'installed');
  assert.equal(
    rows.size,
    3,
    'the catalog should show the protocol reference and the two installed snapshots',
  );

  const installedPackage = join(project, 'node_modules', 'nekosearch');
  const catalogRegistry = JSON.parse(
    await readFile(join(xdgDataHome, 'nekosearch', 'catalog.json'), 'utf8'),
  );
  const installedSnapshotKey = catalogRegistry.snapshots.find(
    (snapshot) => snapshot.source === 'nestjs' && snapshot.version === '12',
  )?.directoryKey;
  assert.match(installedSnapshotKey ?? '', /^[a-f0-9]{64}$/u);
  const fixtureSnapshotKey = catalogRegistry.snapshots.find(
    (snapshot) => snapshot.source === 'fastapi' && snapshot.version === '1',
  )?.directoryKey;
  assert.match(fixtureSnapshotKey ?? '', /^[a-f0-9]{64}$/u);
  const indexPaths = [
    join(installedPackage, 'data', 'mcp-protocol', 'index.sqlite'),
    join(
      xdgDataHome,
      'nekosearch',
      'snapshots',
      installedSnapshotKey,
      'index.sqlite',
    ),
    join(
      xdgDataHome,
      'nekosearch',
      'snapshots',
      fixtureSnapshotKey,
      'index.sqlite',
    ),
  ];
  const indexHashes = await Promise.all(
    indexPaths.map(async (path) => sha256(await readFile(path))),
  );

  const transport = new StdioClientTransport({
    command: binary,
    args: ['serve'],
    cwd: project,
    env: guardedEnvironment,
    stderr: 'pipe',
  });
  const transportErrors = [];
  const stderr = [];
  let stdout = '';
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    transport._process?.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
  };
  transport.onerror = (error) => transportErrors.push(error);
  transport.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));
  const client = new Client({
    name: 'nekosearch-package-smoke',
    version: '1.0.0',
  });
  let child;
  try {
    await withTimeout(client.connect(transport), 'NekoSearch initialize').catch(
      (error) => {
        throw new Error(
          `NekoSearch initialize failed; stderr: ${stderr.join('')}; exit code: ${transport._process?.exitCode}`,
          { cause: error },
        );
      },
    );
    child = transport._process;
    assert.ok(transport.pid, 'the installed executable did not start');

    const tools = await withTimeout(client.listTools(), 'NekoSearch listTools');
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ['fetch_docs', 'list_docs', 'search_docs'],
      'the server must expose list_docs, search_docs, and fetch_docs',
    );
    const searchTool = tools.tools.find((tool) => tool.name === 'search_docs');
    const fetchTool = tools.tools.find((tool) => tool.name === 'fetch_docs');
    const listTool = tools.tools.find((tool) => tool.name === 'list_docs');
    assert.deepEqual(
      Object.keys(searchTool.inputSchema.properties).sort(),
      ['limit', 'query', 'sources'],
      'search_docs must require source selectors and expose no filesystem paths',
    );
    assert.deepEqual(
      Object.keys(fetchTool.inputSchema.properties).sort(),
      ['cursor', 'documentId', 'sectionId', 'selector'],
      'fetch_docs must accept one selector and expose no filesystem paths',
    );
    assert.deepEqual(
      Object.keys(listTool.inputSchema.properties),
      [],
      'list_docs should not require arguments',
    );

    const listed = await withTimeout(
      client.callTool({ name: 'list_docs', arguments: {} }),
      'list_docs',
    );
    assert.ok(!listed.isError, 'list_docs should succeed');
    const listedSources = listed.structuredContent.sources;
    assert.deepEqual(
      listedSources.map((source) => source.selector),
      ['fastapi@1', 'mcp@2025-11-25', 'nestjs@12'],
    );
    assert.ok(
      listedSources.every(
        (source) =>
          Object.keys(source).sort().join(',') ===
          'revision,selector,source,version',
      ),
      'list_docs must not expose filesystem paths',
    );

    const protocolSearch = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: {
          sources: ['mcp@2025-11-25'],
          query: 'JSON-RPC messages',
          limit: 3,
        },
      }),
      'MCP protocol search_docs',
    );
    assert.ok(!protocolSearch.isError, 'MCP protocol search should succeed');
    const protocolData = protocolSearch.structuredContent;
    assert.ok(protocolData.totalResults <= 3);
    const protocolGroup = protocolData.groups[0];
    assert.equal(protocolGroup.selector, 'mcp@2025-11-25');
    assert.equal(protocolGroup.source, 'mcp');
    assert.equal(protocolGroup.version, '2025-11-25');
    assert.equal(protocolGroup.revision, '2025-11-25');
    assert.ok(protocolGroup.results.length > 0);
    const protocolHit = protocolGroup.results[0];
    assert.match(
      protocolHit.canonicalUrl,
      /^https:\/\/modelcontextprotocol\.io\//u,
    );

    const localNestSearch = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: {
          sources: ['nestjs@12'],
          query: 'dependency injection providers',
          limit: 3,
        },
      }),
      'installed NestJS search_docs',
    );
    assert.ok(!localNestSearch.isError);
    const localNestData = localNestSearch.structuredContent;
    assert.ok(localNestData.totalResults <= 3);
    assert.equal(localNestData.groups.length, 1);
    const localNestGroup = localNestData.groups[0];
    assert.equal(localNestGroup.selector, 'nestjs@12');
    assert.equal(localNestGroup.source, 'nestjs');
    assert.equal(localNestGroup.version, '12');
    assert.equal(localNestGroup.revision, mockRevision);
    assert.ok(localNestGroup.results.length > 0);
    const localNestHit = localNestGroup.results[0];
    assert.match(localNestHit.documentId, /^nestjs-doc:v12:/u);
    assert.match(localNestHit.canonicalUrl, /^https:\/\/docs\.nestjs\.com/u);

    const emptySources = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: { query: 'dependency injection', sources: [] },
      }),
      'empty search_docs sources',
    );
    assert.ok(emptySources.isError);
    assert.match(emptySources.content[0].text, /Input validation error/u);

    const unknownSource = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: {
          query: 'dependency injection',
          sources: ['nestjs@12', 'missing@1'],
        },
      }),
      'unknown search_docs source',
    );
    assert.ok(unknownSource.isError);
    assert.match(unknownSource.content[0].text, /Call list_docs/u);

    const tooManySources = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: {
          query: 'dependency injection',
          sources: [
            'nestjs@12',
            'fastapi@1',
            'mcp@2025-11-25',
            'source-4@1',
            'source-5@1',
            'source-6@1',
          ],
        },
      }),
      'too many search_docs sources',
    );
    assert.ok(tooManySources.isError);
    assert.match(tooManySources.content[0].text, /Input validation error/u);

    const overBudget = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: {
          query: 'dependency injection',
          sources: ['nestjs@12'],
          limit: 11,
        },
      }),
      'search_docs result budget',
    );
    assert.ok(overBudget.isError);
    assert.match(overBudget.content[0].text, /Input validation error/u);

    const combinedSearch = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: {
          sources: ['nestjs@12', 'fastapi@1'],
          query: 'mandacaru',
          limit: 3,
        },
      }),
      'NestJS and FastAPI search_docs',
    );
    assert.ok(!combinedSearch.isError);
    const combinedData = combinedSearch.structuredContent;
    assert.equal(
      combinedData.totalResults,
      3,
      JSON.stringify(
        combinedData.groups.map(({ selector, results }) => [
          selector,
          results.map(({ documentId, excerpt }) => ({ documentId, excerpt })),
        ]),
      ),
    );
    assert.deepEqual(
      combinedData.groups.map((group) => group.selector),
      ['nestjs@12', 'fastapi@1'],
    );
    assert.deepEqual(
      combinedData.groups.map((group) => group.results.length),
      [1, 2],
    );

    const localFixtureSearch = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: {
          sources: ['fastapi@1'],
          query: 'mandacaru',
          limit: 3,
        },
      }),
      'installed local fixture search_docs',
    );
    assert.ok(!localFixtureSearch.isError);
    const localFixtureData = localFixtureSearch.structuredContent;
    assert.ok(localFixtureData.totalResults <= 3);
    const localFixtureGroup = localFixtureData.groups[0];
    assert.equal(localFixtureGroup.selector, 'fastapi@1');
    assert.equal(localFixtureGroup.source, 'fastapi');
    assert.equal(localFixtureGroup.version, '1');
    assert.match(localFixtureGroup.revision, /^[a-f0-9]{64}$/u);
    assert.ok(localFixtureGroup.results.length > 0);
    const localFixtureHit = localFixtureGroup.results[0];
    assert.match(localFixtureHit.canonicalUrl, /^https:\/\/docs\.example\//u);
    assert.ok(
      localFixtureGroup.results.some((result) =>
        result.excerpt.includes('mandacaru'),
      ),
    );

    const linkOriginSearch = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: {
          sources: ['fastapi@1'],
          query: 'offline-link-origin-probe',
          limit: 1,
        },
      }),
      'installed snapshot link-origin search_docs',
    );
    assert.ok(!linkOriginSearch.isError);
    const linkOriginHit =
      linkOriginSearch.structuredContent.groups[0]?.results[0];
    assert.ok(linkOriginHit, 'the link-origin document should be searchable');
    const linkOriginPage = await withTimeout(
      client.callTool({
        name: 'fetch_docs',
        arguments: {
          selector: 'fastapi@1',
          documentId: linkOriginHit.documentId,
        },
      }),
      'installed snapshot link-origin fetch_docs',
    );
    assert.ok(!linkOriginPage.isError);
    const resolvedReference = linkOriginPage.structuredContent.references.find(
      (reference) =>
        reference.href === './reference/guide.mdx#offline-link-target',
    );
    assert.ok(
      resolvedReference,
      `the installed snapshot should expose its resolved internal link; returned references: ${JSON.stringify(linkOriginPage.structuredContent.references)}; sections: ${JSON.stringify(linkOriginPage.structuredContent.sections)}`,
    );
    assert.match(resolvedReference.documentId, /^documentation:v1:/u);
    assert.ok(
      typeof resolvedReference.sectionId === 'string',
      'the resolved heading should include a fetchable section ID',
    );
    const linkedTarget = await withTimeout(
      client.callTool({
        name: 'fetch_docs',
        arguments: {
          selector: 'fastapi@1',
          documentId: resolvedReference.documentId,
          sectionId: resolvedReference.sectionId,
        },
      }),
      'installed snapshot internal-link target fetch_docs',
    );
    assert.ok(!linkedTarget.isError);
    assert.equal(linkedTarget.structuredContent.found, true);
    assert.ok(
      linkedTarget.structuredContent.sections.some((section) =>
        section.markdown.includes('offline-link-target-fetch-probe'),
      ),
      'the internal link target should be fetchable from the same offline source',
    );

    for (const [sourceGroup, hit] of [
      [protocolGroup, protocolHit],
      [localNestGroup, localNestHit],
      [localFixtureGroup, localFixtureHit],
    ]) {
      const fetched = await withTimeout(
        client.callTool({
          name: 'fetch_docs',
          arguments: {
            selector: sourceGroup.selector,
            documentId: hit.documentId,
            sectionId: hit.chunkId,
          },
        }),
        `${sourceGroup.selector} fetch_docs`,
      );
      assert.ok(!fetched.isError, 'fetch_docs should succeed');
      const document = fetched.structuredContent;
      assert.equal(document.selector, sourceGroup.selector);
      assert.equal(document.source, sourceGroup.source);
      assert.equal(document.version, sourceGroup.version);
      assert.equal(document.revision, sourceGroup.revision);
      assert.equal(document.found, true);
      assert.equal(document.sourceRevision, hit.sourceRevision);
      assert.ok(document.sections.length > 0);
    }

    assert.deepEqual(
      transportErrors,
      [],
      'stdout must remain valid MCP protocol',
    );
    await client.close();
    await withTimeout(waitForClose(child), 'NekoSearch graceful shutdown');
    assert.equal(child.exitCode, 0, 'the server should exit cleanly');
    assert.equal(child.signalCode, null);
    assert.match(stderr.join(''), /NekoSearch MCP server ready on stdio/u);
    assertProtocolStdout(stdout);
    assert.doesNotMatch(stderr.join(''), /NETWORK_BLOCKED/u);
    await assert.rejects(readFile(networkMarker), { code: 'ENOENT' });
    assert.deepEqual(
      await Promise.all(
        indexPaths.map(async (path) => sha256(await readFile(path))),
      ),
      indexHashes,
      'serving the catalog must leave bundled and installed SQLite indexes unchanged',
    );
    console.log('Verified installed NekoSearch catalog and stdio server');
  } finally {
    child ??= transport._process;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForClose(child);
    }
    await client.close().catch(() => {});
  }
}

async function verifyGrokConfiguration(
  binary,
  project,
  temporaryDirectory,
  environment,
) {
  const fakeGrokDirectory = join(temporaryDirectory, 'fake-grok-bin');
  const nodeOnlyDirectory = join(temporaryDirectory, 'node-only-bin');
  const fakeGrok = join(fakeGrokDirectory, 'grok');
  const grokHome = join(temporaryDirectory, 'grok home');
  const stateFile = join(temporaryDirectory, 'grok-state.json');
  await Promise.all([
    mkdir(fakeGrokDirectory),
    mkdir(nodeOnlyDirectory),
    mkdir(grokHome),
    writeFile(stateFile, JSON.stringify({ registrations: [], calls: [] })),
  ]);
  await Promise.all([
    writeFile(
      fakeGrok,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        'const path = require("node:path");',
        'const stateFile = process.env.NEKOSEARCH_GROK_TEST_STATE;',
        'const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));',
        'const args = process.argv.slice(2);',
        'state.calls.push(args);',
        'if (args[0] === "inspect" && args[1] === "--json") {',
        '  fs.writeFileSync(stateFile, JSON.stringify(state));',
        '  process.stdout.write(JSON.stringify({ mcpServers: state.registrations }));',
        '  process.exit(0);',
        '}',
        'if (args[0] !== "mcp") process.exit(2);',
        'if (args[1] === "remove") {',
        '  const name = args.at(-1);',
        '  state.registrations = state.registrations.filter((item) => item.name !== name);',
        '} else if (args[1] === "add") {',
        '  const separator = args.indexOf("--");',
        '  const name = args[separator - 1];',
        '  if (state.registrations.some((item) => item.name === name)) process.exit(3);',
        '  state.registrations.push({ name, origin: path.join(process.env.GROK_HOME, "config.toml"), transport: "stdio", command: args[separator + 1], args: args.slice(separator + 2) });',
        '} else { process.exit(2); }',
        'fs.writeFileSync(stateFile, JSON.stringify(state));',
      ].join('\n') + '\n',
    ),
    symlink(process.execPath, join(nodeOnlyDirectory, 'node')),
  ]);
  await chmod(fakeGrok, 0o755);

  const stateEnvironment = {
    ...environment,
    PATH: `${fakeGrokDirectory}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    GROK_HOME: grokHome,
    NEKOSEARCH_GROK_TEST_STATE: stateFile,
  };
  const missingGrok = runResult(binary, ['mcp', 'configure', 'grok-build'], {
    cwd: project,
    env: { ...environment, PATH: nodeOnlyDirectory },
  });
  assert.equal(missingGrok.status, 1);
  assert.match(missingGrok.stderr, /Grok Build CLI was not detected/u);

  assert.match(
    run(binary, ['mcp', 'configure', 'grok-build'], {
      cwd: project,
      env: stateEnvironment,
    }),
    /Configured grok-build MCP server nekosearch/u,
  );
  let state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.registrations.length, 1);
  assert.ok(
    isAbsolute(state.registrations[0].command),
    'Grok Build must receive an absolute NekoSearch executable path',
  );
  assert.equal(state.registrations[0].command, process.execPath);
  const registeredArgs = state.registrations[0].args;
  assert.deepEqual(registeredArgs, [
    join(project, 'node_modules', 'nekosearch', 'dist/apps/nekosearch/cli.js'),
    'serve',
  ]);
  const registeredCommand = state.registrations[0].command;

  assert.match(
    run(binary, ['mcp', 'configure', 'grok-build'], {
      cwd: project,
      env: stateEnvironment,
    }),
    /already configured/u,
  );
  state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(
    state.calls.filter((args) => args[0] === 'mcp' && args[1] === 'add').length,
    1,
    'repeated configuration must not add a duplicate registration',
  );
  const configuredState = state;

  const conflict = {
    name: 'nekosearch',
    origin: join(grokHome, 'config.toml'),
    transport: 'stdio',
    command: '/other/nekosearch',
    args: ['serve'],
  };
  state = { registrations: [conflict], calls: [] };
  await writeFile(stateFile, JSON.stringify(state));
  const refusedConflict = runResult(
    binary,
    ['mcp', 'configure', 'grok-build'],
    {
      cwd: project,
      env: stateEnvironment,
    },
  );
  assert.equal(refusedConflict.status, 1);
  assert.match(
    refusedConflict.stderr,
    /different nekosearch MCP registration/u,
  );
  state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.deepEqual(state.registrations, [conflict]);
  assert.deepEqual(state.calls, [['inspect', '--json']]);

  state = {
    registrations: [
      {
        name: 'nekosearch',
        origin: join(grokHome, 'project', '.grok', 'config.toml'),
        transport: 'stdio',
        command: registeredCommand,
        args: registeredArgs,
      },
    ],
    calls: [],
  };
  await writeFile(stateFile, JSON.stringify(state));
  const refusedExternal = runResult(binary, ['mcp', 'remove', 'grok-build'], {
    cwd: project,
    env: stateEnvironment,
  });
  assert.equal(refusedExternal.status, 1);
  state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.registrations.length, 1);
  assert.deepEqual(state.calls, [['inspect', '--json']]);

  state = {
    registrations: [
      {
        name: 'nekosearch',
        origin: join(grokHome, 'config.toml'),
        transport: 'stdio',
        command: registeredCommand,
        args: registeredArgs,
      },
    ],
    calls: configuredState.calls,
  };
  await writeFile(stateFile, JSON.stringify(state));
  return {
    stateFile,
    registrations: configuredState.registrations,
    calls: configuredState.calls,
  };
}

function assertProtocolStdout(stdout) {
  const lines = stdout.trim().split('\n');
  assert.ok(
    lines.length > 0 && lines[0],
    'MCP protocol stdout should not be empty',
  );
  for (const line of lines) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0');
    assert.ok(
      typeof message.method === 'string' ||
        typeof message.id === 'number' ||
        typeof message.id === 'string',
      'stdout must contain only MCP protocol messages',
    );
  }
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolveClose) => child.once('close', resolveClose));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function main() {
  const { values } = parseArgs({
    options: {
      'pack-destination': { type: 'string', default: process.cwd() },
    },
  });
  const destination = resolve(values['pack-destination']);

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'nestjs-docs-packed-package-'),
  );
  const npmEnvironment = {
    ...withoutNpmDryRun(process.env),
    npm_config_cache: join(temporaryDirectory, 'npm-cache'),
  };
  try {
    const packDirectory = join(temporaryDirectory, 'packed');
    const project = join(temporaryDirectory, 'isolated-project');
    const stage = join(temporaryDirectory, 'package');
    await stageNekosearchPackage(stage, npmEnvironment);
    await Promise.all([mkdir(packDirectory), mkdir(project)]);

    const report = JSON.parse(
      run(
        'npm',
        [
          'pack',
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          packDirectory,
        ],
        { cwd: stage, env: npmEnvironment },
      ),
    );
    assert.ok(
      report && typeof report === 'object',
      'npm pack must report tarball metadata',
    );
    // npm 11 reports an array; npm 12 keys the same metadata by package name.
    const packed = Array.isArray(report) ? report : Object.values(report);
    assert.equal(packed.length, 1, 'npm pack should produce one tarball');
    const files = new Set(packed[0].files.map((file) => file.path));
    assert.ok(
      [...files].every(
        (path) => !/\.(?:onnx|onnx_data|safetensors|gguf)$/iu.test(path),
      ),
      'the npm tarball must not contain model weights',
    );
    for (const path of [
      'data/mcp-protocol/corpus.json',
      'data/mcp-protocol/index.sqlite',
      'data/mcp-protocol/manifest.json',
      'README.md',
      'LICENSE',
      'THIRD-PARTY-NOTICES.md',
      'licenses/nestjs-docs-v11-LICENSE',
      'licenses/nestjs-docs-v12-LICENSE',
      'dist/apps/nekosearch/cli.js',
      'dist/apps/nekosearch/mcp-command.js',
      'dist/apps/nekosearch/setup.js',
      'dist/apps/nekosearch/setup-clients.js',
      'dist/apps/nekosearch/install-transformers-runtime.js',
      'dist/apps/nekosearch/semantic-runtime-lock.json',
      'dist/apps/nekosearch/providers/provider-runner.js',
      'dist/apps/nekosearch/providers/provider-registry.js',
      'dist/apps/nekosearch/providers/adapters/grok.adapter.js',
      'dist/apps/nekosearch/providers/adapters/codex.adapter.js',
      'dist/apps/nekosearch/providers/adapters/claude-code.adapter.js',
      'dist/apps/nekosearch/providers/adapters/cursor.adapter.js',
      'dist/apps/nekosearch/serve.js',
      'dist/apps/nekosearch/build.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/build/documentation-build-config.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/build/build-documentation-snapshot.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/build/build-local-documentation.js',
      'dist/apps/nekosearch/sources/nestjs/documentation.integration.js',
      'dist/apps/nekosearch/sources/nestjs/github/documentation-source.js',
      'dist/apps/nekosearch/sources/nestjs/nestjs-documentation-transformer.js',
      'dist/apps/nekosearch/sources/nestjs/source-recipes.js',
      'dist/apps/nekosearch/sources/nestjs/version/documentation-version.js',
      'dist/apps/nekosearch/catalog.js',
      'dist/apps/nekosearch/remote-snapshots.js',
      'dist/apps/nekosearch/catalog-contract.js',
      'dist/apps/nekosearch/mcp/contracts/documentation-tools.contract.js',
      'dist/apps/nekosearch/mcp/documentation-tool-handlers.js',
      'dist/apps/nekosearch/mcp/presenters/documentation.presenter.js',
      'dist/apps/nekosearch/package-metadata.js',
      'node_modules/@nestjs-docs/documentation-engine/package.json',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/sqlite-documentation-store.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/runtime-index.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/application/services/documentation-ingestion.service.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/filesystem/documentation-discovery.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/markdown/document-normalizer.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/markdown/documentation-link-resolver.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/markdown/markdown-parser.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/retrieval/documentation-input.error.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/index-corpus.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/index-integrity.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/index-writer.js',
    ]) {
      assert.ok(files.has(path), `the npm tarball must include ${path}`);
    }
    assert.ok(
      [...files].every(
        (path) =>
          !/^data\/documentation-v(?:11|12)\./u.test(path) &&
          path !== 'data/manifest.json',
      ),
      'the npm tarball must not contain NestJS indexes, corpus files, or bundle manifests',
    );
    const buildEngineFiles = new Set([
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/markdown/document-normalizer.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/markdown/documentation-link-resolver.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/markdown/markdown-parser.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/filesystem/documentation-discovery.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/index-corpus.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/index-integrity.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/index-writer.js',
    ]);
    for (const path of files) {
      assert.ok(
        !path.startsWith('dist/apps/mcp-server/') &&
          !path.startsWith('dist/apps/docs-indexer/') &&
          !path.startsWith('dist/apps/nekosearch/build-runtime/') &&
          !path.startsWith('dist/apps/nekosearch/maintenance/') &&
          (!path.startsWith(
            'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/markdown/',
          ) ||
            buildEngineFiles.has(path)) &&
          (!path.startsWith(
            'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/filesystem/',
          ) ||
            buildEngineFiles.has(path)) &&
          (!path.startsWith(
            'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/',
          ) ||
            buildEngineFiles.has(path)) &&
          !path.endsWith('/documentation.tools.js') &&
          !path.endsWith('/documentation-mcp.module.js'),
        `the npm tarball should exclude HTTP and build-only code: ${path}`,
      );
    }
    for (const path of files) {
      assert.ok(
        !path.startsWith('apps/') &&
          !path.startsWith('packages/documentation-engine/') &&
          !path.startsWith('test/'),
        `the npm tarball should not expose workspace sources: ${path}`,
      );
    }
    const tarballPath = resolve(packDirectory, packed[0].filename);
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({
        name: 'nekosearch-package-smoke',
        version: '1.0.0',
        private: true,
        dependencies: {
          nekosearch: `file:${tarballPath}`,
        },
      }),
    );
    const networkGuard = `import * as net from 'node:net';
import tls from 'node:tls';
import * as dgram from 'node:dgram';
import { writeFileSync } from 'node:fs';
function block(operation) {
  const marker = process.env.NEKOSEARCH_NETWORK_GUARD_MARKER;
  if (marker) writeFileSync(marker, operation);
  throw new Error('NETWORK_BLOCKED: ' + operation);
}
net.Server.prototype.listen = function () { return block('net.Server.listen'); };
net.Socket.prototype.connect = function () { return block('net.Socket.connect'); };
tls.connect = function () { return block('tls.connect'); };
dgram.Socket.prototype.bind = function () { return block('dgram.Socket.bind'); };
globalThis.fetch = async function (input) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (process.env.NEKOSEARCH_MOCK_NEST_SOURCE === '1') {
    if (url === 'https://api.github.com/repos/nestjs/docs.nestjs.com/commits/master') {
      return Response.json({ sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    }
    const rawPrefix = 'https://raw.githubusercontent.com/nestjs/docs.nestjs.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
    if (url.startsWith(rawPrefix)) {
      const path = url.slice(rawPrefix.length);
      const files = new Map([
        ['src/app/shared/nav/nav-items.ts', "export const NAV_ITEMS: NavItem[] = [{ path: '/' }];"],
        ['tools/generate-llms-txt.ts', "const CONTENT_ALIASES: Record<string, string> = {\\n  '/': 'introduction',\\n};"],
        ['content/migration.md', '# Migration guide\\n\\nThis article walks you through migrating from NestJS version 11 to version 12.'],
        ['content/introduction.md', '# NestJS package smoke\\n\\nA modular framework uses dependency injection and providers around sharedtopic and mandacaru.'],
      ]);
      const body = files.get(path);
      return new Response(body ?? 'Not Found', { status: body ? 200 : 404 });
    }
  }
  const marker = process.env.NEKOSEARCH_NETWORK_GUARD_MARKER;
  if (marker) writeFileSync(marker, 'fetch');
  throw new Error('NETWORK_BLOCKED: fetch ' + url);
};
process.once('exit', () => {
  const marker = process.env.NEKOSEARCH_MDX_EXECUTION_MARKER;
  if (marker && globalThis.__nekosearchMdxExecuted) {
    writeFileSync(marker, 'executed');
  }
});
`;
    const guardPath = join(project, 'network-guard.mjs');
    await writeFile(guardPath, networkGuard);
    run(
      'npm',
      [
        'install',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
      ],
      { cwd: project, env: npmEnvironment },
    );

    const installedPackage = join(project, 'node_modules', 'nekosearch');
    const [
      cliSource,
      providerRunnerSource,
      serveSource,
      setupSource,
      remoteSnapshotSource,
      buildSource,
    ] = await Promise.all([
      readFile(join(installedPackage, 'dist/apps/nekosearch/cli.js'), 'utf8'),
      readFile(
        join(
          installedPackage,
          'dist/apps/nekosearch/providers/provider-runner.js',
        ),
        'utf8',
      ),
      readFile(join(installedPackage, 'dist/apps/nekosearch/serve.js'), 'utf8'),
      readFile(join(installedPackage, 'dist/apps/nekosearch/setup.js'), 'utf8'),
      readFile(
        join(installedPackage, 'dist/apps/nekosearch/remote-snapshots.js'),
        'utf8',
      ),
      readFile(join(installedPackage, 'dist/apps/nekosearch/build.js'), 'utf8'),
    ]);
    assert.match(cliSource, /import\('\.\/remote-snapshots\.js'\)/u);
    assert.match(cliSource, /import\('\.\/build\.js'\)/u);
    assert.match(cliSource, /import\('\.\/setup-clients\.js'\)/u);
    assert.match(cliSource, /import\('\.\/setup\.js'\)/u);
    assert.doesNotMatch(cliSource, /^import .*remote-snapshots/mu);
    assert.doesNotMatch(cliSource, /^import .*build\.js/mu);
    assert.doesNotMatch(cliSource, /^import .*setup\.js/mu);
    assert.match(providerRunnerSource, /spawn\(/u);
    assert.doesNotMatch(providerRunnerSource, /shell:\s*true/u);
    assert.doesNotMatch(
      serveSource,
      /remote-snapshots|setup|@clack\/prompts|markdown-parser|document-normalizer|docs-indexer|build-runtime/u,
    );
    assert.match(setupSource, /@clack\/prompts/u);
    assert.doesNotMatch(
      remoteSnapshotSource,
      /markdown-parser|document-normalizer|docs-indexer/u,
    );
    assert.match(
      buildSource,
      /@nestjs-docs\/documentation-engine\/build\/build-local-documentation\.js/u,
    );
    assert.doesNotMatch(buildSource, /@mdx-js\/mdx|remark-gfm/u);
    const installedEngine = join(
      installedPackage,
      'node_modules',
      '@nestjs-docs',
      'documentation-engine',
    );
    await readFile(join(installedEngine, 'package.json'));
    for (const runtimePath of [
      'dist/infrastructure/sqlite/sqlite-documentation-store.js',
      'dist/infrastructure/sqlite/runtime-index.js',
      'dist/domain/documentation.schemas.js',
      'dist/infrastructure/markdown/markdown-parser.js',
      'dist/infrastructure/markdown/document-normalizer.js',
      'dist/infrastructure/filesystem/documentation-discovery.js',
      'dist/infrastructure/sqlite/indexing/index-writer.js',
      'dist/infrastructure/sqlite/indexing/index-integrity.js',
      'dist/infrastructure/sqlite/indexing/index-corpus.js',
      'dist/application/services/documentation-ingestion.service.js',
    ]) {
      await readFile(join(installedEngine, runtimePath));
    }
    const dependencyTree = JSON.parse(
      run('npm', ['ls', '--all', '--omit=dev', '--json'], {
        cwd: project,
        env: npmEnvironment,
      }),
    );
    const installedDependencyNames = collectDependencyNames(dependencyTree);
    for (const optionalModelDependency of [
      '@huggingface/transformers',
      '@huggingface/tokenizers',
      'onnxruntime-node',
      'onnxruntime-web',
      'sharp',
    ]) {
      assert.ok(
        !installedDependencyNames.has(optionalModelDependency),
        `${optionalModelDependency} must not be installed for lexical-only use`,
      );
    }
    assert.ok(
      [...installedDependencyNames].every(
        (name) => !name.startsWith('@nestjs/'),
      ),
      'NestJS framework packages must be absent from the production dependency tree',
    );
    for (const excludedPackage of [
      '@modelcontextprotocol/client',
      'eventsource',
      'eventsource-parser',
      'express',
      'reflect-metadata',
      'rxjs',
      'jest',
      'typescript',
      'eslint',
      'jsonc-parser',
      'smol-toml',
    ]) {
      assert.ok(
        !installedDependencyNames.has(excludedPackage),
        `${excludedPackage} must be absent from the production dependency tree`,
      );
    }
    for (const requiredBuildDependency of ['@mdx-js/mdx', 'remark-gfm']) {
      assert.ok(
        installedDependencyNames.has(requiredBuildDependency),
        `${requiredBuildDependency} must be installed for the offline build command`,
      );
    }
    assert.ok(
      installedDependencyNames.has('json5'),
      'the curated source parser must be available to the on-demand builder',
    );
    for (const requiredSetupDependency of ['@clack/prompts']) {
      assert.ok(
        installedDependencyNames.has(requiredSetupDependency),
        `${requiredSetupDependency} must be installed for interactive setup`,
      );
    }
    for (const developmentOnlyPackage of [
      'typescript',
      'jest',
      '@modelcontextprotocol/client',
    ]) {
      try {
        await readFile(
          join(project, 'node_modules', developmentOnlyPackage, 'package.json'),
        );
        throw new Error(
          `${developmentOnlyPackage} was installed in the production-only project`,
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    await verifyCatalogServer(project, temporaryDirectory);
    await verifyDashboard(project, temporaryDirectory);
    await mkdir(destination, { recursive: true });
    await copyFile(tarballPath, join(destination, packed[0].filename));
    console.log(join(destination, packed[0].filename));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function collectDependencyNames(tree, names = new Set()) {
  for (const [name, dependency] of Object.entries(tree.dependencies ?? {})) {
    if (Object.keys(dependency).length > 0 && dependency.missing !== true) {
      names.add(name);
    }
    collectDependencyNames(dependency, names);
  }
  return names;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
