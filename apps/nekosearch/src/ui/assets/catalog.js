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

    const actions = row.querySelector('.snapshot-actions');
    const details = document.createElement('a');
    details.className = 'button secondary';
    details.href = detailsPath;
    details.setAttribute('aria-label', `Details for ${entry.selector}`);
    details.textContent = 'Details';
    actions.append(details);
    actions.hidden = !actions.childElementCount;
    return row;
  }
}
