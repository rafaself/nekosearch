const MAX_SEARCH_EXCERPT_CHARS = 1_000;
const MAX_SEARCH_EXCERPT_BLOCKS = 3;
const TRUNCATION_MARKER = '\n\n… [Excerpt truncated]';

/** Build compact Markdown context from the parts of a section that match a query. */
export function createSearchExcerpt(
  markdown: string,
  queryTerms: readonly string[] = [],
): string {
  const blocks = splitMarkdownBlocks(markdown);
  if (blocks.length === 0) return '';

  const scores = blocks.map((block) => blockQueryScore(block, queryTerms));
  for (let index = 0; index < blocks.length - 1; index += 1) {
    if (
      /^#{1,6}\s/u.test(blocks[index]!) &&
      scores[index + 1]! > 0 &&
      scores[index] === 0
    ) {
      scores[index] = 0.5;
    }
  }
  const rankedBlocks = blocks
    .map((block, index) => ({ block, index, score: scores[index]! }))
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
  const hasQueryMatches = rankedBlocks.some(({ score }) => score > 0);
  const contentLimit = MAX_SEARCH_EXCERPT_CHARS - TRUNCATION_MARKER.length - 18;
  const selected: Array<{ index: number; markdown: string }> = [];
  let contentLength = 0;
  let blockWasTruncated = false;

  for (const candidate of rankedBlocks) {
    if (selected.length === MAX_SEARCH_EXCERPT_BLOCKS) break;
    if (hasQueryMatches && candidate.score === 0) continue;

    const separatorLength = selected.length > 0 ? 2 : 0;
    const available = contentLimit - contentLength - separatorLength;
    if (available <= 0) break;
    if (candidate.block.length <= available) {
      selected.push({ index: candidate.index, markdown: candidate.block });
      contentLength += separatorLength + candidate.block.length;
      continue;
    }

    const clipped = truncateMarkdownBlock(
      candidate.block,
      available,
      queryTerms,
    );
    if (clipped) {
      selected.push({ index: candidate.index, markdown: clipped });
      contentLength += separatorLength + clipped.length;
      blockWasTruncated = true;
    }
  }

  selected.sort((left, right) => left.index - right.index);
  if (selected.length === 0) return '';

  let excerpt = '';
  let previousIndex = -1;
  for (const block of selected) {
    if (previousIndex < 0) {
      if (block.index > 0) excerpt = '…\n\n';
    } else {
      excerpt += block.index === previousIndex + 1 ? '\n\n' : '\n\n…\n\n';
    }
    excerpt += block.markdown;
    previousIndex = block.index;
  }

  const omittedBlocks = selected.length < blocks.length;
  const truncated = blockWasTruncated || omittedBlocks;
  return truncated ? `${excerpt}${TRUNCATION_MARKER}` : excerpt;
}

function splitMarkdownBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: { marker: '`' | '~'; length: number } | undefined;

  const flush = (): void => {
    const block = current.join('\n').trim();
    if (block) blocks.push(block);
    current = [];
  };

  for (const line of lines) {
    const marker = markdownFenceMarker(line);
    if (!fence && !line.trim()) {
      flush();
      continue;
    }

    current.push(line);
    if (!fence && marker) {
      fence = { marker: marker.character, length: marker.length };
    } else if (
      fence &&
      marker?.character === fence.marker &&
      marker.length >= fence.length &&
      !marker.trailing.trim()
    ) {
      fence = undefined;
    }
  }
  flush();
  return blocks;
}

function blockQueryScore(block: string, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0;
  const blockTerms = new Set(
    (block.match(/[\p{L}\p{N}_]+/gu) ?? []).map((term) =>
      term.toLocaleLowerCase('en-US'),
    ),
  );
  return queryTerms.reduce(
    (score, term) =>
      score + (blockTerms.has(term.toLocaleLowerCase('en-US')) ? 1 : 0),
    0,
  );
}

function truncateMarkdownBlock(
  block: string,
  maxLength: number,
  queryTerms: readonly string[],
): string {
  const lines = block.split('\n');
  const firstFence = markdownFenceMarker(lines[0] ?? '');
  const lastFence = markdownFenceMarker(lines.at(-1) ?? '');
  if (
    firstFence &&
    lastFence?.character === firstFence.character &&
    lastFence.length >= firstFence.length &&
    !lastFence.trailing.trim()
  ) {
    return truncateFencedBlock(lines, firstFence, maxLength, queryTerms);
  }

  const truncated = takeWholeLines(lines, maxLength, queryTerms);
  if (truncated) return truncated;
  return takeWordBoundedText(block, maxLength);
}

function truncateFencedBlock(
  lines: string[],
  fence: { character: '`' | '~'; length: number; trailing: string },
  maxLength: number,
  queryTerms: readonly string[],
): string {
  const opening = lines[0]!;
  const closing = lines.at(-1)!;
  const lineBudget = maxLength - opening.length - closing.length - 2;
  if (lineBudget <= 0) return '';

  const body = lines.slice(1, -1);
  const startIndex = bestMatchingLine(body, queryTerms);
  const selectedBody = takeContiguousLines(body, startIndex, lineBudget);
  if (!selectedBody) return '';
  return `${opening}\n${selectedBody}\n${closing}`;
}

function takeWholeLines(
  lines: string[],
  maxLength: number,
  queryTerms: readonly string[],
): string {
  const startIndex = bestMatchingLine(lines, queryTerms);
  return takeContiguousLines(lines, startIndex, maxLength);
}

function bestMatchingLine(
  lines: readonly string[],
  queryTerms: readonly string[],
): number {
  let bestIndex = 0;
  let bestScore = 0;
  for (const [index, line] of lines.entries()) {
    const score = blockQueryScore(line, queryTerms);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestIndex;
}

function takeContiguousLines(
  lines: readonly string[],
  startIndex: number,
  maxLength: number,
): string {
  const target = lines[startIndex];
  if (!target || maxLength <= 0) return '';
  if (target.length > maxLength) return takeWordBoundedText(target, maxLength);

  let firstIndex = startIndex;
  let lastIndex = startIndex;
  let used = target.length;
  for (let count = 0; count < 2 && firstIndex > 0; count += 1) {
    const previousLine = lines[firstIndex - 1]!;
    if (previousLine.length + 1 > maxLength - used) break;
    firstIndex -= 1;
    used += previousLine.length + 1;
  }
  for (let count = 0; count < 2 && lastIndex < lines.length - 1; count += 1) {
    const nextLine = lines[lastIndex + 1]!;
    if (nextLine.length + 1 > maxLength - used) break;
    lastIndex += 1;
    used += nextLine.length + 1;
  }
  return lines.slice(firstIndex, lastIndex + 1).join('\n');
}

function takeWordBoundedText(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  let end = Math.min(value.length, maxLength);
  if (end < value.length) {
    const whitespace = value.lastIndexOf(' ', end);
    if (whitespace > 0) end = whitespace;
  }
  if (end > 0) {
    const before = value.charCodeAt(end - 1);
    const after = value.charCodeAt(end);
    if (
      before >= 0xd800 &&
      before <= 0xdbff &&
      after >= 0xdc00 &&
      after <= 0xdfff
    ) {
      end -= 1;
    }
  }
  return value.slice(0, end).trimEnd();
}

function markdownFenceMarker(
  line: string,
): { character: '`' | '~'; length: number; trailing: string } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  const sequence = match?.[1];
  if (!sequence) return undefined;
  return {
    character: sequence[0] as '`' | '~',
    length: sequence.length,
    trailing: match[2] ?? '',
  };
}
