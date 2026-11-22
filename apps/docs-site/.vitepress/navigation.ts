import type { DefaultTheme } from 'vitepress';

export const sidebar = [
  {
    collapsed: false,
    text: 'Getting Started',
    items: [
      { text: 'Introduction', link: '/' },
      { text: 'Installation', link: '/getting-started/installation' },
      { text: 'Quick Start', link: '/getting-started/quick-start' },
      { text: 'Interactive Setup', link: '/getting-started/setup' },
    ],
  },
  {
    collapsed: false,
    text: 'Guides',
    items: [
      { text: 'Documentation Sources', link: '/guides/documentation-sources' },
      { text: 'Snapshots', link: '/guides/snapshots' },
      {
        text: 'Local Embeddings & Hybrid Search',
        link: '/guides/hybrid-search',
      },
      { text: 'Custom Documentation', link: '/guides/custom-documentation' },
      { text: 'Updating & Removing', link: '/guides/updating' },
    ],
  },
  {
    collapsed: false,
    text: 'CLI',
    items: [
      { text: 'Overview', link: '/cli/overview' },
      { text: 'Command Reference', link: '/cli/commands' },
    ],
  },
  {
    collapsed: false,
    text: 'MCP',
    items: [
      { text: 'Overview', link: '/mcp/overview' },
      { text: 'Tool Reference', link: '/mcp/tools' },
      { text: 'Client Configuration', link: '/mcp/client-configuration' },
    ],
  },
  {
    collapsed: false,
    text: 'Architecture',
    items: [
      { text: 'Overview', link: '/architecture/overview' },
      {
        text: 'Documentation Engine',
        link: '/architecture/documentation-engine',
      },
      { text: 'Retrieval', link: '/architecture/retrieval' },
      {
        text: 'Retrieval Comparison',
        link: '/architecture/retrieval-comparison',
      },
    ],
  },
  {
    collapsed: false,
    text: 'Development',
    items: [
      { text: 'Contributing', link: '/development/contributing' },
      { text: 'Development Setup', link: '/development/development-setup' },
    ],
  },
] satisfies DefaultTheme.SidebarItem[];
