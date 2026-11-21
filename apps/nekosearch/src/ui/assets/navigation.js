import { createAddDocumentationPage } from './add-documentation.js';
import { createCatalogPage } from './catalog.js';
import { createDashboard } from './dashboard.js';
import { createSnapshotDetailsPage } from './snapshot-details.js';
import { createUsagePage } from './usage.js';

const pageFactories = new Map([
  ['/', createCatalogPage],
  ['/add', createAddDocumentationPage],
  ['/usage', createUsagePage],
  ['/about', null],
]);
const dashboard = createDashboard();
const navigationLinks = document.querySelectorAll('.site-nav a');
const initialPath = window.location.pathname;
const initialPage = createPage(
  document.querySelector('main'),
  document.title,
  initialPath,
);
const pages = new Map([[initialPath, Promise.resolve(initialPage)]]);
let currentPage = initialPage;
let navigationId = 0;

dashboard.showPage(currentPage);
for (const path of pageFactories.keys()) {
  if (path === initialPath) continue;
  void getPage(path).catch(() => {
    // A later click can retry the optional preload.
  });
}

document.addEventListener('click', (event) => {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !(event.target instanceof Element)
  )
    return;

  const link = event.target.closest('a[href]');
  if (
    !link ||
    (link.target && link.target !== '_self') ||
    link.hasAttribute('download') ||
    link.origin !== window.location.origin ||
    link.search ||
    link.hash ||
    !getPageFactory(link.pathname)
  )
    return;

  event.preventDefault();
  void navigate(link.pathname, true);
});

window.addEventListener('popstate', () => {
  if (getPageFactory(window.location.pathname))
    void navigate(window.location.pathname, false);
});

function getPage(path) {
  if (!pages.has(path)) {
    pages.set(
      path,
      loadPage(path).catch((error) => {
        pages.delete(path);
        throw error;
      }),
    );
  }
  return pages.get(path);
}

async function loadPage(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('The dashboard page could not be loaded.');
  const parsed = new DOMParser().parseFromString(
    await response.text(),
    'text/html',
  );
  const main = parsed.querySelector('main');
  if (!main) throw new Error('The dashboard page is missing its content.');
  return createPage(document.adoptNode(main), parsed.title, path);
}

function createPage(main, title, path) {
  const createPageContent = getPageFactory(path);
  return {
    main,
    title,
    path,
    ...createPageContent?.(main, dashboard, path),
  };
}

function getPageFactory(path) {
  if (pageFactories.has(path)) return pageFactories.get(path);
  if (/^\/details\/(?:[a-f0-9]{64}|[a-z][a-z0-9-]{0,127})$/u.test(path))
    return (main, dashboard) =>
      createSnapshotDetailsPage(main, path, dashboard);
  return undefined;
}

async function navigate(path, push) {
  const id = ++navigationId;
  if (path === currentPage.path) return;

  let nextPage;
  try {
    nextPage = await getPage(path);
  } catch {
    if (id === navigationId) window.location.assign(path);
    return;
  }
  if (id !== navigationId) return;

  if (push) window.history.pushState(null, '', path);
  dashboard.showPage(nextPage);
  nextPage.main.classList.add('page-enter');
  currentPage.main.replaceWith(nextPage.main);
  currentPage = nextPage;
  document.title = nextPage.title;
  for (const link of navigationLinks) {
    if (link.pathname === path) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (push) window.scrollTo(0, 0);
  nextPage.main.querySelector('h1').focus({ preventScroll: true });
}
