const actionIcons = {
  update: [
    'M20 7v5h-5',
    'M4 17v-5h5',
    'M5.64 9a7 7 0 0 1 11.72-2.6L20 12',
    'M4 12l2.64 5.6A7 7 0 0 0 18.36 15',
  ],
  remove: ['M3 6h18', 'M8 6V4h8v2', 'm19 6-1 14H6L5 6', 'M10 11v5', 'M14 11v5'],
};

export function createSnapshotActionButtons(
  entry,
  dashboard,
  { iconActions = false } = {},
) {
  const buttons = [];
  if (entry.tracking === 'tracked') {
    buttons.push(
      createActionButton(entry, dashboard, 'Check upstream', 'secondary'),
      createActionButton(entry, dashboard, 'Update', 'primary', iconActions),
    );
  }
  if (entry.status === 'installed') {
    buttons.push(
      createActionButton(entry, dashboard, 'Remove', 'quiet', iconActions),
    );
  }
  return buttons;
}

function createActionButton(
  entry,
  dashboard,
  label,
  variation,
  iconOnly = false,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button ${variation}`;
  button.disabled = true;
  button.title = `${label} ${entry.selector}`;
  if (iconOnly && actionIcons[label.toLowerCase()]) {
    button.classList.add('icon-button');
    button.setAttribute('aria-label', `${label} ${entry.selector}`);
    button.append(createIcon(label.toLowerCase()));
  } else {
    button.textContent = label;
  }
  button.addEventListener('click', () => {
    if (label === 'Remove') {
      if (!window.confirm(`Remove ${entry.selector} from the catalog?`)) return;
      void dashboard.startJob({
        operation: 'remove',
        selector: entry.selector,
        snapshotKey: entry.snapshotKey,
      });
      return;
    }
    void dashboard.startJob({
      operation: label === 'Check upstream' ? 'check-upstream' : 'update',
      selector: entry.selector,
      ...(label === 'Update' ? { snapshotKey: entry.snapshotKey } : {}),
    });
  });
  return button;
}

function createIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const pathData of actionIcons[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    svg.append(path);
  }
  return svg;
}
