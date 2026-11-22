const numbers = new Intl.NumberFormat();
const axisNumbers = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const timeLabels = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const dateLabels = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});
const svgNamespace = 'http://www.w3.org/2000/svg';
const chartWidth = 360;
const chartHeight = 96;

export function renderMetricCards(container, metrics, type, totals, timeline) {
  const cards = document.createDocumentFragment();
  for (const [
    key,
    label,
    format = numbers.format,
    axisFormat = axisNumbers.format,
    minimumStep = 1,
  ] of metrics) {
    const card = document.createElement('div');
    const term = document.createElement('dt');
    const value = document.createElement('dd');
    const values = timeline.buckets.map((bucket) => bucket[type][key]);
    term.textContent = label;
    const summary = document.createElement('span');
    summary.className = 'usage-metric-value';
    summary.textContent = format(totals[key]);
    value.append(summary);
    value.append(
      totals.calls > 0 && values.some((point) => point !== null)
        ? renderChart(label, values, timeline, axisFormat, minimumStep)
        : renderEmptyChart(),
    );
    card.append(term, value);
    cards.append(card);
  }
  container.replaceChildren(cards);
}

function renderEmptyChart() {
  const placeholder = document.createElement('span');
  placeholder.className = 'usage-chart-empty';
  const plot = svg('svg', {
    viewBox: `0 0 ${chartWidth} ${chartHeight}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
  });
  const curve =
    'M0 41 C16 36 25 50 42 46 S64 48 78 53 S101 48 114 52 S130 62 143 50 S162 19 177 32 S198 56 216 52 S233 55 249 46 S270 50 285 43 S305 34 316 49 S332 70 343 58 S353 42 360 38';
  plot.append(
    svg('path', { class: 'usage-chart-empty-fill', d: `${curve} V96 H0 Z` }),
    svg('path', { class: 'usage-chart-empty-line', d: curve }),
  );
  const label = document.createElement('span');
  label.textContent = 'No data';
  placeholder.append(plot, label);
  return placeholder;
}

function renderChart(label, values, timeline, format, minimumStep) {
  const chart = document.createElement('span');
  chart.className = 'usage-chart';

  const present = values.filter((value) => value !== null);
  const max = Math.max(...present);
  const step = tickStep(max, minimumStep);
  const ceiling = step * 3;
  chart.setAttribute('role', 'img');
  chart.setAttribute(
    'aria-label',
    `${label} over time, from ${format(Math.min(...present))} to ${format(max)} per interval`,
  );

  const scale = document.createElement('span');
  scale.className = 'usage-chart-scale';
  scale.setAttribute('aria-hidden', 'true');
  for (let tick = 3; tick >= 0; tick--) {
    const text = document.createElement('span');
    text.textContent = format(step * tick);
    scale.append(text);
  }

  const plot = svg('svg', {
    viewBox: `0 0 ${chartWidth} ${chartHeight}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
  });
  const gradientId = `usage-chart-fill-${label.toLowerCase().replaceAll(' ', '-')}`;
  const gradient = svg('linearGradient', { id: gradientId, x2: '0', y2: '1' });
  gradient.append(
    svg('stop', {
      offset: 0,
      'stop-color': 'currentColor',
      'stop-opacity': 0.23,
    }),
  );
  gradient.append(
    svg('stop', {
      offset: 1,
      'stop-color': 'currentColor',
      'stop-opacity': 0.02,
    }),
  );
  plot.append(gradient);

  for (let tick = 0; tick <= 3; tick++) {
    const y = (chartHeight * tick) / 3;
    plot.append(
      svg('path', { class: 'usage-chart-guide', d: `M0 ${y} H${chartWidth}` }),
    );
  }

  const span = timeline.end - timeline.start;
  let points = [];
  values.forEach((value, index) => {
    const start = index * timeline.bucketMs;
    const end = Math.min(span, start + timeline.bucketMs);
    if (value !== null) {
      const x = ((start + end) / 2 / span) * chartWidth;
      const y = chartHeight * (1 - value / ceiling);
      points.push([x, y]);
    }
    if (value === null || index === values.length - 1) {
      appendSeries(plot, points, gradientId);
      points = [];
    }
  });

  const times = document.createElement('span');
  times.className = 'usage-chart-times';
  times.setAttribute('aria-hidden', 'true');
  const timeFormat = span <= 24 * 60 * 60 * 1000 ? timeLabels : dateLabels;
  for (const fraction of [0, 0.5, 1]) {
    const time = document.createElement('span');
    time.textContent = timeFormat.format(timeline.start + span * fraction);
    times.append(time);
  }
  chart.append(scale, plot, times);
  return chart;
}

function appendSeries(plot, points, gradientId) {
  if (points.length === 0) return;
  const [firstX, firstY] = points[0];
  if (points.length === 1) {
    plot.append(
      svg('circle', { cx: firstX, cy: firstY, r: 2.5, fill: 'currentColor' }),
    );
    return;
  }
  const [lastX] = points.at(-1);
  const line = `M${points.map((point) => point.join(' ')).join(' L')}`;
  plot.append(
    svg('path', {
      d: `${line} L${lastX} ${chartHeight} H${firstX} Z`,
      fill: `url(#${gradientId})`,
    }),
  );
  plot.append(svg('path', { class: 'usage-chart-line', d: line }));
}

function tickStep(max, minimum) {
  const rough = Math.max(max / 3, minimum);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find((factor) => factor * magnitude >= rough);
  return step * magnitude;
}

function svg(name, attributes) {
  const node = document.createElementNS(svgNamespace, name);
  for (const [key, value] of Object.entries(attributes))
    node.setAttribute(key, value);
  return node;
}
