import { createSnapshotActionButtons } from './snapshot-actions.js';

const numberFormat = new Intl.NumberFormat();

export function createSnapshotDetailsPage(main, path, dashboard) {
  const snapshotKey = path.slice('/details/'.length);
  const title = main.querySelector('#details-title');
  const loading = main.querySelector('#details-loading');
  const missing = main.querySelector('#details-missing');
  const snapshotSection = main.querySelector('#snapshot-section');
  const statisticsSection = main.querySelector('#statistics-section');
  const storageSection = main.querySelector('#storage-section');
  const usageSection = main.querySelector('#usage-section');
  const actions = main.querySelector('#detail-actions');

  return {
    renderCatalog: ({ entries }) => {
      const entry = entries.find(({ snapshotKey: key }) => key === snapshotKey);
      loading.hidden = true;
      missing.hidden = Boolean(entry);
      snapshotSection.hidden = !entry;
      statisticsSection.hidden = !entry;
      storageSection.hidden = !entry;
      usageSection.hidden = !entry;
      actions.replaceChildren();
      actions.hidden = !entry;
      if (!entry) {
        title.textContent = 'Snapshot unavailable';
        return;
      }

      title.textContent = entry.selector;
      actions.setAttribute('aria-label', `Actions for ${entry.selector}`);
      actions.append(...createSnapshotActionButtons(entry, dashboard));
      setText(
        main,
        '#detail-source',
        entry.selector.slice(0, entry.selector.lastIndexOf('@')),
      );
      setText(
        main,
        '#detail-version',
        entry.selector.slice(entry.selector.lastIndexOf('@') + 1),
      );
      setText(
        main,
        '#detail-status',
        entry.status === 'bundled' ? 'Bundled' : 'Installed',
      );
      setText(
        main,
        '#detail-tracking',
        entry.tracking === 'tracked'
          ? 'Tracked upstream'
          : entry.tracking === 'pinned'
            ? 'Pinned revision'
            : 'Local snapshot',
      );
      setOptionalText(main, '#detail-ref-row', '#detail-ref', entry.sourceRef);
      setExternalLink(
        main,
        '#detail-documentation-row',
        '#detail-documentation-link',
        entry.documentationUrl,
        'Open documentation ↗',
      );
      setExternalLink(
        main,
        '#detail-source-reference-row',
        '#detail-source-reference-link',
        entry.sourceRepositoryUrl,
        'View upstream source ↗',
      );
      setOptionalText(
        main,
        '#detail-installed-row',
        '#detail-installed',
        entry.installedAt
          ? new Intl.DateTimeFormat(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(entry.installedAt))
          : undefined,
      );
      setText(main, '#detail-revision', entry.revision);
      setText(
        main,
        '#detail-document-count',
        numberFormat.format(entry.documentCount),
      );
      setText(
        main,
        '#detail-chunk-count',
        numberFormat.format(entry.chunkCount),
      );
      setText(
        main,
        '#detail-average-chunks',
        entry.averageChunksPerDocument.toFixed(1),
      );
      setText(
        main,
        '#detail-chunk-size',
        `${numberFormat.format(entry.smallestChunkCharacters)}–${numberFormat.format(entry.largestChunkCharacters)} characters; ${numberFormat.format(Math.round(entry.averageChunkCharacters))} average`,
      );
      setText(
        main,
        '#detail-embeddings',
        entry.embeddings
          ? `${entry.embeddings.modelId} · ${numberFormat.format(entry.embeddings.dimensions)} dimensions`
          : 'Not generated',
      );
      setText(main, '#detail-index-size', formatBytes(entry.indexSizeBytes));
      setText(main, '#detail-corpus-size', formatBytes(entry.corpusSizeBytes));
      setText(
        main,
        '#detail-snapshot-size',
        formatBytes(entry.snapshotSizeBytes),
      );
      void loadUsage(entry.selector);
    },
    setControls: ({ canModify }) => {
      for (const button of actions.querySelectorAll('button'))
        button.disabled = !canModify;
    },
  };

  async function loadUsage(selector) {
    const loading = main.querySelector('#detail-usage-loading');
    const list = main.querySelector('#detail-usage-list');
    const empty = main.querySelector('#detail-usage-empty');
    const documentUsageSection = main.querySelector(
      '#detail-document-usage-section',
    );
    const documentUsageEmpty = main.querySelector(
      '#detail-document-usage-empty',
    );
    const documentUsageRows = main.querySelector('#detail-document-usage-rows');
    loading.hidden = false;
    list.hidden = true;
    empty.hidden = true;
    documentUsageSection.hidden = true;
    documentUsageEmpty.hidden = true;
    documentUsageRows.replaceChildren();
    try {
      const usage = await dashboard.readUsage({
        window: 'all',
        selector,
        limit: 1,
        offset: 0,
      });
      const calls = usage.totals.calls;
      if (calls === 0) {
        loading.hidden = true;
        empty.hidden = false;
        return;
      }
      renderDocumentUsage(documentUsageRows, usage.topDocuments);
      documentUsageSection.hidden = usage.topDocuments.length === 0;
      documentUsageEmpty.hidden = usage.topDocuments.length > 0;
      const callsByTool = new Map(
        usage.tools.map(({ tool, calls: count }) => [tool, count]),
      );
      setText(main, '#detail-usage-calls', numberFormat.format(calls));
      setText(
        main,
        '#detail-usage-searches',
        numberFormat.format(callsByTool.get('search_docs') ?? 0),
      );
      setText(
        main,
        '#detail-usage-fetches',
        `${numberFormat.format(usage.fetches.calls)} (${numberFormat.format(usage.fetches.found)} found)`,
      );
      setText(
        main,
        '#detail-usage-fetch-content',
        `${numberFormat.format(usage.fetches.returnedSections)} sections · ${numberFormat.format(usage.fetches.references)} references`,
      );
      setText(
        main,
        '#detail-usage-truncated',
        numberFormat.format(usage.fetches.truncated),
      );
      setText(
        main,
        '#detail-usage-failures',
        numberFormat.format(usage.totals.failures),
      );
      setText(
        main,
        '#detail-usage-latency',
        `${numberFormat.format(Math.round(usage.totals.averageDurationMs))} ms`,
      );
      setText(
        main,
        '#detail-usage-response',
        formatBytes(usage.totals.averageResponseBytes),
      );
      setText(
        main,
        '#detail-usage-total-response',
        formatBytes(usage.totals.totalResponseBytes),
      );
      loading.hidden = true;
      list.hidden = false;
    } catch {
      loading.textContent = 'Usage statistics are unavailable.';
    }
  }
}

function renderDocumentUsage(tbody, documents) {
  const fragment = document.createDocumentFragment();
  for (const documentUsage of documents) {
    const row = document.createElement('tr');
    const values = [
      documentUsage.documentId,
      numberFormat.format(documentUsage.searchCalls),
      numberFormat.format(documentUsage.searchHits),
      `${numberFormat.format(documentUsage.foundFetches)} / ${numberFormat.format(documentUsage.fetchCalls)}`,
    ];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    fragment.append(row);
  }
  tbody.replaceChildren(fragment);
}

function setText(main, selector, value) {
  main.querySelector(selector).textContent = value;
}

function setOptionalText(main, rowSelector, valueSelector, value) {
  const row = main.querySelector(rowSelector);
  row.hidden = value === undefined;
  if (value !== undefined) setText(main, valueSelector, value);
}

function setExternalLink(main, rowSelector, linkSelector, href, label) {
  const row = main.querySelector(rowSelector);
  const link = main.querySelector(linkSelector);
  let url;
  try {
    url = new URL(href);
  } catch {
    row.hidden = true;
    link.removeAttribute('href');
    return;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    row.hidden = true;
    link.removeAttribute('href');
    return;
  }
  row.hidden = false;
  link.href = url.href;
  link.textContent = label;
}

function formatBytes(bytes) {
  const units = ['bytes', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const digits = unitIndex === 0 ? 0 : 1;
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
  }).format(value)} ${units[unitIndex]}`;
}
