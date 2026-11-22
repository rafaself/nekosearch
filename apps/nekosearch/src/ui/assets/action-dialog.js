let nextDialogId = 0;

export function showAppDialog({
  title,
  description,
  content,
  actions,
  formMethod,
  className = '',
}) {
  const dialog = document.createElement('dialog');
  dialog.className = ['app-dialog', className].filter(Boolean).join(' ');

  const panel = document.createElement(formMethod ? 'form' : 'div');
  panel.className = 'app-dialog__panel';
  if (formMethod) panel.method = formMethod;

  const titleId = `app-dialog-title-${++nextDialogId}`;
  dialog.setAttribute('aria-labelledby', titleId);

  const heading = document.createElement('h2');
  heading.id = titleId;
  heading.textContent = title;
  panel.append(heading);

  const body = document.createElement('div');
  body.className = 'app-dialog__body';
  if (description) {
    const descriptionId = `app-dialog-description-${nextDialogId}`;
    const descriptionElement = document.createElement('p');
    descriptionElement.id = descriptionId;
    descriptionElement.className = 'app-dialog__message';
    descriptionElement.textContent = description;
    body.append(descriptionElement);
    dialog.setAttribute('aria-describedby', descriptionId);
  }
  if (content) body.append(content);
  panel.append(body);

  if (actions) {
    actions.classList.add('app-dialog__actions');
    panel.append(actions);
  }

  dialog.append(panel);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close('cancel');
  });

  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

export function showActionDialog({
  title,
  message,
  actionLabel,
  actionClass = 'primary',
  cancelLabel = 'Cancel',
  onAction,
}) {
  const actions = document.createElement('div');

  const cancelButton = document.createElement('button');
  cancelButton.type = 'submit';
  cancelButton.value = 'cancel';
  cancelButton.className = 'button quiet';
  cancelButton.textContent = cancelLabel;
  cancelButton.autofocus = true;

  const actionButton = document.createElement('button');
  actionButton.type = 'submit';
  actionButton.value = 'confirm';
  actionButton.className = `button ${actionClass}`;
  actionButton.textContent = actionLabel;

  actions.append(cancelButton, actionButton);
  const dialog = showAppDialog({
    title,
    description: message,
    actions,
    formMethod: 'dialog',
  });
  dialog.addEventListener(
    'close',
    () => {
      if (dialog.returnValue === 'confirm') onAction();
    },
    { once: true },
  );
  return dialog;
}
