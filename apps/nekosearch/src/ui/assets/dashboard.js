import { createDashboardApi } from './dashboard-api.js';

const activeJobKey = 'nekosearch-active-job';
const phases = {
  starting: 'Starting operation…',
  checking: 'Checking the upstream revision…',
  resolving: 'Resolving the source revision…',
  downloading: 'Downloading documentation…',
  indexing: 'Indexing documentation…',
  validating: 'Validating the snapshot…',
  installing: 'Installing the snapshot…',
  removing: 'Removing the snapshot…',
};

export function createDashboard() {
  const api = createDashboardApi();
  let currentPage;
  let started = false;
  let catalog;
  let busy = false;
  let catalogReadable = false;
  let restartNeeded = false;
  let noticeMessage = 'Loading the catalog…';
  let noticeKind = 'info';

  window.addEventListener('pageshow', (event) => {
    if (event.persisted && started) initialize();
  });

  return {
    showPage,
    refresh,
    startJob,
    readUsageSettings: () => requireApi().readUsageSettings(),
    readUsage: (filters) => requireApi().readUsage(filters),
    updateUsageSettings: (settings) =>
      requireApi().updateUsageSettings(settings),
    clearUsage: () => requireApi().clearUsage(),
  };

  function showPage(page) {
    currentPage = page;
    page.onShow?.();
    if (catalog) page.renderCatalog?.(catalog);
    updateControls();
    updateNotice();
    if (!started && page.renderCatalog) {
      started = true;
      initialize();
    }
  }

  function initialize() {
    if (!api) {
      showNotice(
        'Open the dashboard using the link printed by NekoSearch.',
        'error',
      );
      return;
    }
    const activeJob = sessionStorage.getItem(activeJobKey);
    if (activeJob) void runTask(() => watchJob(activeJob));
    else void refresh();
  }

  function refresh() {
    return runTask(async () => {
      showNotice(await loadCatalog(), 'error');
    });
  }

  function startJob(input) {
    if (!catalogReadable) return;
    const onJobSucceeded = currentPage.onJobSucceeded;
    return runTask(async () => {
      showNotice(phases.starting);
      const { id } = await api.startJob(input);
      sessionStorage.setItem(activeJobKey, id);
      await watchJob(id, input.operation, onJobSucceeded);
    });
  }

  async function watchJob(id, operation, onJobSucceeded) {
    try {
      let { status } = await api.readJob(id);
      while (status.state === 'running') {
        showNotice(phases[status.phase] ?? 'Working…');
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        ({ status } = await api.readJob(id));
      }

      if (status.state === 'succeeded') {
        const { result } = status;
        restartNeeded ||= result.catalogChanged;
        onJobSucceeded?.(operation);
        showNotice([result.message, result.warning].filter(Boolean).join(' '));
      } else {
        showNotice(status.error, 'error');
      }
    } catch (error) {
      showNotice(error.message, 'error');
    } finally {
      if (sessionStorage.getItem(activeJobKey) === id)
        sessionStorage.removeItem(activeJobKey);
    }

    if (operation === 'check-upstream') return;
    const warning = await loadCatalog();
    if (warning) showNotice(warning, 'error');
  }

  async function loadCatalog() {
    catalogReadable = false;
    catalog = await api.readCatalog();
    currentPage.renderCatalog?.(catalog);
    catalogReadable = catalog.readable;
    return catalogReadable
      ? ''
      : catalog.errors.join(' ') || 'The catalog could not be read.';
  }

  async function runTask(task) {
    if (!api || busy) return;
    busy = true;
    updateControls();
    try {
      await task();
    } catch (error) {
      showNotice(error.message, 'error');
    } finally {
      busy = false;
      updateControls();
    }
  }

  function updateControls() {
    currentPage.setControls?.({
      canRefresh: Boolean(api) && !busy,
      canModify: catalogReadable && !busy,
    });
  }

  function showNotice(message, kind = 'info') {
    noticeMessage = message;
    noticeKind = kind;
    updateNotice();
  }

  function updateNotice() {
    const notice = currentPage.main.querySelector('#notice');
    if (notice) {
      if (notice.textContent !== noticeMessage)
        notice.textContent = noticeMessage;
      notice.hidden = !noticeMessage;
      notice.dataset.kind = noticeKind;
    }
    const restart = currentPage.main.querySelector('#restart');
    if (restart) restart.hidden = !restartNeeded;
  }

  function requireApi() {
    if (!api)
      throw new Error(
        'Open the dashboard using the link printed by NekoSearch.',
      );
    return api;
  }
}
