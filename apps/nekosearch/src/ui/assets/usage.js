const numberFormat = new Intl.NumberFormat();
const pageSize = 25;

export function createUsagePage(main, dashboard) {
  const settingsForm = main.querySelector('#usage-settings');
  const filterForm = main.querySelector('#usage-filters');
  const notice = main.querySelector('#usage-notice');
  const selectorFilter = main.querySelector('#usage-selector');
  const previousButton = main.querySelector('#usage-previous');
  const nextButton = main.querySelector('#usage-next');
  let offset = 0;
  let report;
  let loading = false;

  settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSettings();
  });
  filterForm.addEventListener('change', () => {
    offset = 0;
    void loadReport();
  });
  main.querySelector('#usage-refresh').addEventListener('click', () => {
    void loadReport();
  });
  previousButton.addEventListener('click', () => {
    offset = Math.max(0, offset - pageSize);
    void loadReport();
  });
  nextButton.addEventListener('click', () => {
    if (report && offset + pageSize < report.pagination.total) {
      offset += pageSize;
      void loadReport();
    }
  });
  main.querySelector('#usage-clear').addEventListener('click', () => {
    if (!window.confirm('Clear all locally stored usage statistics?')) return;
    void clearUsage();
  });

  return { onShow: () => void loadReport() };

  async function loadReport() {
    if (loading) return;
    loading = true;
    setNotice('Loading local usage statistics…');
    try {
      const [settings, result] = await Promise.all([
        dashboard.readUsageSettings(),
        dashboard.readUsage({ ...readFilters(), limit: pageSize, offset }),
      ]);
      renderSettings(settings);
      renderReport(result);
      setNotice(
        settings.enabled
          ? result.totals.calls
            ? ''
            : 'No calls have been recorded in this period.'
          : 'Collection is off. Enable it above to record future MCP calls. Existing retained statistics remain available.',
      );
    } catch (error) {
      setNotice(error.message, true);
    } finally {
      loading = false;
    }
  }

  async function saveSettings() {
    setButtonsDisabled(true);
    try {
      const form = new FormData(settingsForm);
      const retentionValue = form.get('retentionDays');
      const settings = await dashboard.updateUsageSettings({
        enabled: form.get('enabled') === 'on',
        queryMode: form.get('queryMode'),
        retentionDays:
          retentionValue === 'never' ? null : Number(retentionValue),
      });
      renderSettings(settings);
      setNotice('Usage collection settings saved.');
      await loadReport();
    } catch (error) {
      setNotice(error.message, true);
    } finally {
      setButtonsDisabled(false);
    }
  }

  async function clearUsage() {
    setButtonsDisabled(true);
    try {
      const result = await dashboard.clearUsage();
      offset = 0;
      setNotice(
        `Cleared ${numberFormat.format(result.clearedCalls)} recorded calls.`,
      );
      await loadReport();
    } catch (error) {
      setNotice(error.message, true);
    } finally {
      setButtonsDisabled(false);
    }
  }

  function readFilters() {
    const form = new FormData(filterForm);
    return {
      window: form.get('window'),
      tool: form.get('tool') || undefined,
      selector: form.get('selector') || undefined,
    };
  }

  function renderSettings(settings) {
    main.querySelector('#usage-enabled').checked = settings.enabled;
    main.querySelector('#usage-query-mode').value = settings.queryMode;
    main.querySelector('#usage-retention').value =
      settings.retentionDays === null
        ? 'never'
        : String(settings.retentionDays);
  }

  function renderReport(data) {
    report = data;
    renderSourceFilter(data.sources.map(({ selector }) => selector));
    renderTotals(data.totals);
    renderFetchMetrics(data.fetches);
    renderTable('#usage-tools', data.tools, (row) => [
      row.tool,
      numberFormat.format(row.calls),
      numberFormat.format(row.failures),
      formatDuration(row.averageDurationMs),
      formatBytes(row.averageResponseBytes),
    ]);
    renderTable('#usage-sources', data.sources, (row) => [
      row.selector,
      numberFormat.format(row.calls),
      numberFormat.format(row.results),
    ]);
    renderTable('#usage-documents', data.topDocuments, (row) => [
      row.selector,
      row.documentId,
      numberFormat.format(row.searchHits),
      `${numberFormat.format(row.foundFetches)} / ${numberFormat.format(row.fetchCalls)}`,
    ]);
    renderTable('#usage-sections', data.topSections, (row) => [
      row.selector,
      row.documentId,
      row.sectionId,
      numberFormat.format(row.searchHits),
      numberFormat.format(row.fetchCalls),
    ]);
    renderQueryTable(data);
    renderRecentCalls(data);
  }

  function renderSourceFilter(selectors) {
    const current = selectorFilter.value;
    const fragment = document.createDocumentFragment();
    fragment.append(new Option('All sources', ''));
    for (const selector of selectors)
      fragment.append(new Option(selector, selector));
    selectorFilter.replaceChildren(fragment);
    if (selectors.includes(current)) selectorFilter.value = current;
  }

  function renderTotals(totals) {
    const items = [
      ['Calls', numberFormat.format(totals.calls)],
      ['Succeeded', numberFormat.format(totals.successes)],
      ['Failed', numberFormat.format(totals.failures)],
      ['Average latency', formatDuration(totals.averageDurationMs)],
      ['Slowest call', formatDuration(totals.maxDurationMs)],
      ['Average response', formatBytes(totals.averageResponseBytes)],
      ['Total response data', formatBytes(totals.totalResponseBytes)],
    ];
    const fragment = document.createDocumentFragment();
    for (const [label, value] of items) {
      const wrapper = document.createElement('div');
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = value;
      wrapper.append(term, description);
      fragment.append(wrapper);
    }
    main.querySelector('#usage-totals').replaceChildren(fragment);
  }

  function renderFetchMetrics(fetches) {
    const items = [
      ['Fetch calls', fetches.calls],
      ['Found', fetches.found],
      ['Not found', fetches.missing],
      ['Sections returned', fetches.returnedSections],
      ['References returned', fetches.references],
      ['Truncated responses', fetches.truncated],
      ['Continuation requests', fetches.continuations],
    ];
    const fragment = document.createDocumentFragment();
    for (const [label, value] of items) {
      const wrapper = document.createElement('div');
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = numberFormat.format(value);
      wrapper.append(term, description);
      fragment.append(wrapper);
    }
    main.querySelector('#usage-fetch-metrics').replaceChildren(fragment);
  }

  function renderQueryTable(data) {
    const body = main.querySelector('#usage-queries');
    const note = main.querySelector('#usage-query-note');
    const rows = [
      ...data.queryLengths.map(({ characters, calls }) => [
        `Length only · ${numberFormat.format(characters)} characters`,
        numberFormat.format(calls),
      ]),
      ...data.topQueries.map(({ mode, query, fingerprint, calls }) => [
        mode === 'raw'
          ? `Raw · ${query}`
          : `Fingerprint · ${fingerprint?.slice(0, 16) ?? ''}`,
        numberFormat.format(calls),
      ]),
    ];
    note.textContent =
      data.settings.queryMode === 'counts'
        ? 'The current setting stores query length only. Raw queries captured under a previous setting remain until retention expires or you clear usage data.'
        : data.settings.queryMode === 'fingerprint'
          ? 'The current setting groups repeat queries by a keyed fingerprint. Raw queries captured under a previous setting remain until retention expires or you clear usage data.'
          : 'Raw query collection is enabled for new calls. Previously captured raw queries remain until retention expires or you clear usage data.';
    renderRows(body, rows);
  }

  function renderRecentCalls(data) {
    const rows = data.recentCalls.map((call) => {
      const queryOrTarget =
        call.tool === 'search_docs'
          ? (call.query ??
            (call.queryFingerprint
              ? `Fingerprint ${call.queryFingerprint.slice(0, 16)}`
              : `${numberFormat.format(call.queryLength ?? 0)} characters`))
          : call.tool === 'fetch_docs'
            ? [call.fetchDocumentId, call.fetchSectionId]
                .filter(Boolean)
                .join(' · ')
            : '—';
      const fetchDetails =
        call.tool === 'fetch_docs'
          ? [
              `${numberFormat.format(call.fetchSectionCount ?? 0)} sections`,
              `${numberFormat.format(call.fetchReferenceCount ?? 0)} references`,
              call.fetchTruncated ? 'truncated' : '',
              call.fetchHasCursor ? 'continued' : '',
              call.fetchHasNextCursor ? 'more available' : '',
            ]
              .filter(Boolean)
              .join(' · ')
          : '—';
      return [
        call.callId,
        new Intl.DateTimeFormat(undefined, {
          dateStyle: 'short',
          timeStyle: 'medium',
        }).format(new Date(call.timestamp)),
        call.tool,
        call.selectors.join(', ') || '—',
        queryOrTarget || '—',
        call.resultCount === null ? '—' : numberFormat.format(call.resultCount),
        fetchDetails,
        call.responseBytes === null ? '—' : formatBytes(call.responseBytes),
        formatDuration(call.durationMs),
        call.success
          ? 'Success'
          : `Failed${call.errorClass ? ` · ${call.errorClass}` : ''}`,
      ];
    });
    renderRows(main.querySelector('#usage-calls'), rows);
    const total = data.pagination.total;
    const first = total ? data.pagination.offset + 1 : 0;
    const last = Math.min(
      data.pagination.offset + data.pagination.limit,
      total,
    );
    main.querySelector('#usage-page-status').textContent =
      `${numberFormat.format(first)}–${numberFormat.format(last)} of ${numberFormat.format(total)}`;
    previousButton.disabled = data.pagination.offset === 0;
    nextButton.disabled = data.pagination.offset + pageSize >= total;
  }

  function renderTable(selector, data, cells) {
    renderRows(
      main.querySelector(selector),
      data.map((row) => cells(row)),
    );
  }

  function renderRows(body, rows) {
    const fragment = document.createDocumentFragment();
    for (const values of rows) {
      const row = document.createElement('tr');
      for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      fragment.append(row);
    }
    if (rows.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = body.closest('table').querySelectorAll('thead th').length;
      cell.textContent = 'No data for this period.';
      row.append(cell);
      fragment.append(row);
    }
    body.replaceChildren(fragment);
  }

  function setNotice(message, isError = false) {
    notice.textContent = message;
    notice.hidden = !message;
    notice.dataset.kind = isError ? 'error' : 'info';
  }

  function setButtonsDisabled(disabled) {
    for (const button of settingsForm.querySelectorAll('button'))
      button.disabled = disabled;
    main.querySelector('#usage-clear').disabled = disabled;
  }
}

function formatDuration(milliseconds) {
  if (milliseconds < 1) return '<1 ms';
  return `${numberFormat.format(Math.round(milliseconds))} ms`;
}

function formatBytes(bytes) {
  const units = ['bytes', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: unitIndex ? 1 : 0,
  }).format(value)} ${units[unitIndex]}`;
}
