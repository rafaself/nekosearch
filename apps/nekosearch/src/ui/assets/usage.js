import { showActionDialog, showAppDialog } from './action-dialog.js';
import { renderMetricCards } from './usage-metrics.js';

const numberFormat = new Intl.NumberFormat();
const pageSize = 25;

export function createUsagePage(main, dashboard) {
  const settingsTemplate = main.querySelector('#usage-settings-template');
  const settingsOpenButton = main.querySelector('#usage-settings-open');
  const filterForm = main.querySelector('#usage-filters');
  const reportInfoButton = main.querySelector('#usage-report-info');
  const reportHint = main.querySelector('#usage-report-hint');
  const notice = main.querySelector('#usage-notice');
  const selectorFilter = main.querySelector('#usage-selector');
  const previousButton = main.querySelector('#usage-previous');
  const nextButton = main.querySelector('#usage-next');
  let offset = 0;
  let report;
  let loading = false;
  let reloadRequested = false;
  let reportHintOpen = false;
  let activeSettingsDialog;

  reportInfoButton.addEventListener('click', () => {
    setReportHintOpen(!reportHintOpen);
  });
  document.addEventListener('click', (event) => {
    if (
      !reportHintOpen ||
      !(event.target instanceof Node) ||
      reportInfoButton.contains(event.target) ||
      reportHint.contains(event.target)
    )
      return;
    setReportHintOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !reportHintOpen) return;
    event.preventDefault();
    setReportHintOpen(false);
    reportInfoButton.focus();
  });
  settingsOpenButton.addEventListener('click', () => {
    void openSettings();
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
  return {
    onShow: () => {
      setReportHintOpen(false);
      void loadReport();
    },
  };

  function setReportHintOpen(isOpen) {
    reportHintOpen = isOpen;
    reportHint.hidden = !isOpen;
    reportInfoButton.setAttribute('aria-expanded', String(isOpen));
  }

  async function loadReport() {
    if (loading) {
      reloadRequested = true;
      return;
    }
    loading = true;
    setNotice('Loading local usage statistics…');
    try {
      const [settings, result] = await Promise.all([
        dashboard.readUsageSettings(),
        dashboard.readUsage({ ...readFilters(), limit: pageSize, offset }),
      ]);
      if (reloadRequested) return;
      renderReport(result);
      setNotice(
        settings.enabled && !result.totals.calls
          ? 'No calls have been recorded in this period.'
          : '',
      );
    } catch (error) {
      setNotice(error.message, true);
    } finally {
      loading = false;
      if (reloadRequested) {
        reloadRequested = false;
        void loadReport();
      }
    }
  }

  async function openSettings() {
    if (activeSettingsDialog?.open) return;

    const form = settingsTemplate.content
      .querySelector('#usage-settings-form')
      .cloneNode(true);
    const actions = document.createElement('div');
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'button quiet';
    cancelButton.textContent = 'Cancel';
    cancelButton.autofocus = true;

    const saveButton = document.createElement('button');
    saveButton.type = 'submit';
    saveButton.className = 'button prominent';
    saveButton.textContent = 'Save';
    saveButton.setAttribute('form', form.id);
    actions.append(cancelButton, saveButton);

    const dialog = showAppDialog({
      title: 'Usage settings',
      content: form,
      actions,
      className: 'app-dialog--wide',
    });
    activeSettingsDialog = dialog;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void saveSettings(form, saveButton, dialog);
    });
    form.querySelector('#usage-clear').addEventListener('click', () => {
      confirmClearUsage(form, saveButton);
    });
    cancelButton.addEventListener('click', () => dialog.close('cancel'));
    dialog.addEventListener(
      'close',
      () => {
        if (activeSettingsDialog !== dialog) return;
        activeSettingsDialog = undefined;
      },
      { once: true },
    );

    setSettingsControlsDisabled(form, saveButton, true);
    setSettingsStatus(form, 'Loading usage settings…');
    let settingsLoaded = false;
    try {
      const settings = await dashboard.readUsageSettings();
      if (!form.isConnected) return;
      renderSettings(form, settings);
      setSettingsStatus(form, '');
      settingsLoaded = true;
    } catch (error) {
      if (form.isConnected) setSettingsStatus(form, error.message, true);
    } finally {
      setSettingsControlsDisabled(form, saveButton, false);
      if (!settingsLoaded) saveButton.disabled = true;
    }
  }

  function confirmClearUsage(form, saveButton) {
    showActionDialog({
      title: 'Clear usage statistics?',
      message:
        'This permanently clears all locally retained usage statistics. This cannot be undone.',
      actionLabel: 'Clear statistics',
      onAction: () => void clearUsage(form, saveButton),
    });
  }

  async function saveSettings(formElement, saveButton, dialog) {
    setSettingsStatus(formElement, '');
    try {
      const form = new FormData(formElement);
      setSettingsControlsDisabled(formElement, saveButton, true);
      const settings = await dashboard.updateUsageSettings({
        enabled: form.get('enabled') === 'on',
        queryMode: form.get('queryMode'),
      });
      renderSettings(formElement, settings);
      dialog.close('saved');
      await loadReport();
    } catch (error) {
      setSettingsStatus(formElement, error.message, true);
    } finally {
      setSettingsControlsDisabled(formElement, saveButton, false);
    }
  }

  async function clearUsage(form, saveButton) {
    setSettingsControlsDisabled(form, saveButton, true);
    setSettingsStatus(form, '');
    try {
      const result = await dashboard.clearUsage();
      offset = 0;
      await loadReport();
      setSettingsStatus(
        form,
        `Cleared ${numberFormat.format(result.clearedCalls)} recorded calls.`,
      );
    } catch (error) {
      setSettingsStatus(form, error.message, true);
    } finally {
      setSettingsControlsDisabled(form, saveButton, false);
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

  function renderSettings(form, settings) {
    form.querySelector('#usage-enabled').checked = settings.enabled;
    form.querySelector('#usage-query-mode').value = settings.queryMode;
  }

  function renderReport(data) {
    report = data;
    renderSourceFilter(data.sources.map(({ selector }) => selector));
    const range = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      ...(data.filters.window === '24h' ? { timeStyle: 'short' } : {}),
    });
    main.querySelector('#usage-date-range').textContent =
      data.filters.window === 'all' && !data.totals.calls
        ? ''
        : range.formatRange(data.timeline.start, data.timeline.end);
    renderMetricCards(
      main.querySelector('#usage-totals'),
      [
        ['calls', 'Calls'],
        ['successes', 'Succeeded'],
        ['failures', 'Failed'],
        [
          'averageDurationMs',
          'Average latency',
          formatDuration,
          (value) => `${numberFormat.format(value)} ms`,
          0.1,
        ],
        [
          'maxDurationMs',
          'Slowest call',
          formatDuration,
          (value) => `${numberFormat.format(value)} ms`,
          0.1,
        ],
        [
          'averageResponseBytes',
          'Average response',
          formatBytes,
          formatChartBytes,
        ],
        [
          'totalResponseBytes',
          'Total response data',
          formatBytes,
          formatChartBytes,
        ],
      ],
      'totals',
      data.totals,
      data.timeline,
    );
    renderMetricCards(
      main.querySelector('#usage-fetch-metrics'),
      [
        ['calls', 'Fetch calls'],
        ['found', 'Found'],
        ['missing', 'Not found'],
        ['returnedSections', 'Sections returned'],
        ['references', 'References returned'],
        ['truncated', 'Truncated responses'],
        ['continuations', 'Continuation requests'],
      ],
      'fetches',
      data.fetches,
      data.timeline,
    );
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
    const available = current
      ? [
          ...new Set([
            ...Array.from(selectorFilter.options, ({ value }) => value).filter(
              Boolean,
            ),
            ...selectors,
          ]),
        ].sort()
      : selectors;
    for (const selector of available)
      fragment.append(new Option(selector, selector));
    selectorFilter.replaceChildren(fragment);
    selectorFilter.value = current;
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
        ? 'The current setting stores query length only. Raw queries captured under a previous setting remain until you clear usage data.'
        : data.settings.queryMode === 'fingerprint'
          ? 'The current setting groups repeat queries by a keyed fingerprint. Raw queries captured under a previous setting remain until you clear usage data.'
          : 'Raw query collection is enabled for new calls. Previously captured raw queries remain until you clear usage data.';
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

  function setSettingsStatus(form, message, isError = false) {
    const status = form.querySelector('#usage-settings-status');
    status.textContent = message;
    status.hidden = !message;
    status.dataset.kind = isError ? 'error' : 'info';
  }

  function setSettingsControlsDisabled(form, saveButton, disabled) {
    for (const control of form.querySelectorAll('input, select, button'))
      control.disabled = disabled;
    saveButton.disabled = disabled;
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

function formatChartBytes(bytes) {
  return formatBytes(bytes).replace(' bytes', ' B');
}
