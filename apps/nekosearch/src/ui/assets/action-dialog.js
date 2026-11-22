let nextDialogId = 0;

export function showActionDialog({
  title,
  message,
  actionLabel,
  actionClass = 'primary',
  cancelLabel = 'Cancel',
  onAction,
}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'app-dialog';

  const form = document.createElement('form');
  form.method = 'dialog';
  form.className = 'app-dialog__form';

  const titleId = `app-dialog-title-${++nextDialogId}`;
  const messageId = `app-dialog-message-${nextDialogId}`;
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.setAttribute('aria-describedby', messageId);

  const heading = document.createElement('h2');
  heading.id = titleId;
  heading.textContent = title;

  const description = document.createElement('p');
  description.id = messageId;
  description.className = 'app-dialog__message';
  description.textContent = message;

  const actions = document.createElement('div');
  actions.className = 'app-dialog__actions';

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
  form.append(heading, description, actions);
  dialog.append(form);

  dialog.addEventListener(
    'close',
    () => {
      const confirmed = dialog.returnValue === 'confirm';
      dialog.remove();
      if (confirmed) onAction();
    },
    { once: true },
  );
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close('cancel');
  });

  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
