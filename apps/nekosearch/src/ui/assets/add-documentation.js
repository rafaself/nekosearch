export function createAddDocumentationPage(main, dashboard) {
  const localForm = main.querySelector('#local-form');
  const localFields = main.querySelector('#local-fields');
  const curatedForm = main.querySelector('#curated-form');
  const curatedSelect = main.querySelector('#curated-source');
  const installButton = main.querySelector('#install');
  curatedForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void dashboard.startJob({
      operation: 'install-curated',
      selector: curatedSelect.value,
    });
  });

  localForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const fields = new FormData(localForm);
    void dashboard.startJob({
      operation: 'import-directory',
      selector: fields.get('selector'),
      directory: fields.get('directory'),
    });
  });

  return {
    renderCatalog: ({ entries, curatedSources }) => {
      const installed = new Set(entries.map(({ selector }) => selector));
      const available = curatedSources.filter(
        (selector) => !installed.has(selector),
      );
      const selection = curatedSelect.value;
      curatedSelect.replaceChildren(
        ...available.map((selector) => new Option(selector, selector)),
      );
      if (available.includes(selection)) curatedSelect.value = selection;
      if (available.length === 0)
        curatedSelect.add(new Option('All curated sources installed', ''));
    },
    setControls: ({ canModify }) => {
      curatedSelect.disabled = !canModify || !curatedSelect.value;
      installButton.disabled = curatedSelect.disabled;
      localFields.disabled = !canModify;
    },
    onJobSucceeded: (operation) => {
      if (operation === 'import-directory') localForm.reset();
    },
  };
}
