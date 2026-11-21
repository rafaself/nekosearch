import { createSnapshotActionButtons } from './snapshot-actions.js';

export function createCatalogPage(main, dashboard) {
  const catalog = main.querySelector('#catalog');
  const refreshButton = main.querySelector('#refresh');
  const snapshotRow = main.querySelector('#snapshot-row');
  refreshButton.addEventListener('click', () => void dashboard.refresh());

  return {
    renderCatalog: ({ entries, readable }) => {
      catalog.replaceChildren(...entries.map(renderSnapshot));
      catalog.hidden = entries.length === 0 && !readable;
      if (!catalog.hidden && entries.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty muted';
        empty.textContent = 'No documentation sources yet.';
        catalog.append(empty);
      }
    },
    setControls: ({ canRefresh, canModify }) => {
      refreshButton.disabled = !canRefresh;
      for (const button of catalog.querySelectorAll('button'))
        button.disabled = !canModify;
    },
  };

  function renderSnapshot(entry) {
    const row = snapshotRow.content.cloneNode(true);
    const detailsPath = `/details/${entry.snapshotKey}`;
    const titleLink = row.querySelector('.snapshot-title-link');
    titleLink.href = detailsPath;
    titleLink.setAttribute('aria-label', `View details for ${entry.selector}`);
    titleLink.querySelector('strong').textContent = entry.selector;
    row.querySelector('.snapshot-status').textContent =
      entry.status === 'bundled'
        ? 'Bundled'
        : ({ tracked: 'Tracked', pinned: 'Pinned' }[entry.tracking] ??
          'Imported');
    row.querySelector('.snapshot-detail span').textContent =
      `${entry.documentCount} ${entry.documentCount === 1 ? 'document' : 'documents'}`;
    const revision = row.querySelector('code');
    revision.textContent =
      entry.revision.length > 13
        ? `${entry.revision.slice(0, 10)}…`
        : entry.revision;
    revision.title = entry.revision;

    const actions = row.querySelector('.snapshot-actions');
    actions.role = 'group';
    actions.setAttribute('aria-label', `Actions for ${entry.selector}`);
    const details = document.createElement('a');
    details.className = 'button secondary';
    details.href = detailsPath;
    details.setAttribute('aria-label', `Details for ${entry.selector}`);
    details.textContent = 'Details';
    actions.append(details);
    actions.append(
      ...createSnapshotActionButtons(entry, dashboard, { iconActions: true }),
    );
    actions.hidden = !actions.childElementCount;
    return row;
  }
}
