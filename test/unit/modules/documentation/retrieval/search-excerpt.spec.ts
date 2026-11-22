import { createSearchExcerpt } from '@nestjs-docs/documentation-engine/retrieval/search-excerpt.js';

describe('createSearchExcerpt', () => {
  it('keeps the matching code line inside its Markdown fence and signals clipping', () => {
    const code = [
      '```ts',
      ...Array.from(
        { length: 100 },
        (_, index) => `const unrelated${index} = 'request';`,
      ),
      'const context: ExecutionContext = createContext();',
      '```',
    ].join('\n');

    const excerpt = createSearchExcerpt(`## API\n\n${code}`, [
      'ExecutionContext',
    ]);

    expect(excerpt).toContain('## API');
    expect(excerpt).toContain('```ts\n');
    expect(excerpt).toContain(
      'const context: ExecutionContext = createContext();',
    );
    expect(excerpt).toContain('\n```');
    expect(excerpt.endsWith('… [Excerpt truncated]')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(1_000);
  });
});
