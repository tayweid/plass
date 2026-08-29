import assert from 'node:assert/strict';
import type { Mark } from 'prosemirror-model';
import { schema } from '../schema';
import { layoutForcedBlock, type ForcedLayoutMeasurer } from './forced-layout';
import { wordSpacingValue } from './line-decorations';
import type { Measurer, TextMeasureInterval } from './measure';
import { layoutBlock, type ForcedBreak, type LayoutOptions, type LineLayout } from './paragraph';

class DeterministicMeasurer implements ForcedLayoutMeasurer {
  rangeReads = 0;
  probePopulations = 0;

  fontFor(marks: readonly Mark[]): string {
    return marks.map((mark) => mark.type.name).sort().join(',');
  }

  private prefix(text: string, end: number, key: string): number {
    let width = 0;
    for (let i = 0; i < end; i++) {
      width += /\s/.test(text[i]) ? 3 : 7;
      if (key.includes('strong')) width += 0.75;
      if (key.includes('em')) width += 0.25;
      if (key.includes('code')) width += 0.5;
    }
    return width;
  }

  segmentWidths(text: string, ends: number[], key: string): number[] {
    if (ends.length) this.probePopulations++;
    let previous = 0;
    return ends.map((end) => {
      this.rangeReads++;
      const width = this.prefix(text, end, key);
      const segment = width - previous;
      previous = width;
      return segment;
    });
  }

  intervalWidths(text: string, intervals: readonly TextMeasureInterval[], key: string): number[] {
    if (!intervals.length) return [];
    this.probePopulations++;
    const offsets = new Set(intervals.flatMap(({ start, end }) => [start, end]).filter((offset) => offset !== 0));
    this.rangeReads += offsets.size;
    return intervals.map(({ start, end }) => this.prefix(text, end, key) - this.prefix(text, start, key));
  }

  intervalWidthsBatch(
    requests: ReadonlyArray<{ text: string; intervals: readonly TextMeasureInterval[]; key: string }>,
  ): number[][] {
    return requests.map(({ text, intervals, key }) => this.intervalWidths(text, intervals, key));
  }

  spaceWidth(): number {
    return 3;
  }

  hyphenWidth(): number {
    return 4;
  }
}

const paragraph = (children: Parameters<typeof schema.nodes.paragraph.create>[1]) =>
  schema.nodes.paragraph.create(null, children);
const atomWidth = () => 9.25;
const normalized = (lines: LineLayout[] | null) =>
  lines?.map((line) => ({
    from: line.from,
    to: line.to,
    breakPos: line.breakPos,
    hyphen: line.hyphen,
    spacing: wordSpacingValue(line.spacing),
  })) ?? null;

function compare(
  label: string,
  node: ReturnType<typeof paragraph>,
  measure: number,
  forced: ForcedBreak[],
  opts: Omit<LayoutOptions, 'forced'> = {},
) {
  const legacyMeasurer = new DeterministicMeasurer();
  const fastMeasurer = new DeterministicMeasurer();
  const legacy = layoutBlock(
    node,
    measure,
    legacyMeasurer as unknown as Measurer,
    atomWidth,
    { ...opts, forced },
  );
  const fast = layoutForcedBlock(node, measure, fastMeasurer, atomWidth, { ...opts, forced });
  assert.deepEqual(normalized(fast), normalized(legacy), label);
  console.log(`  ok  ${label}`);
  return { legacyMeasurer, fastMeasurer, legacy, fast };
}

compare(
  'normal forced spaces preserve ranges and spacing',
  paragraph(schema.text('alpha beta gamma delta')),
  74,
  [{ at: 5, hyphen: false }, { at: 16, hyphen: false }],
);

assert.equal(wordSpacingValue(2.2625 - Number.EPSILON), '2.263');
assert.equal(wordSpacingValue(-2.2625 + Number.EPSILON), '-2.263');
console.log('  ok  CSS spacing serialization is stable at half-thousandths');

compare(
  'injected and glyphless hyphens preserve break semantics',
  paragraph(schema.text('hyphenation state-of-the-art writing')),
  70,
  [{ at: 2, hyphen: true }, { at: 18, hyphen: true }],
);

{
  const strong = schema.marks.strong.create();
  const em = schema.marks.em.create();
  const node = paragraph([
    schema.text('marked '),
    schema.text('strong words', [strong]),
    schema.text(' and '),
    schema.nodes.math_inline.create({ src: 'x' }),
    schema.text(' emphasized ending', [em]),
  ]);
  compare(
    'marks and inline atoms retain child-local measurement',
    node,
    105,
    [{ at: 6, hyphen: false }, { at: 24, hyphen: false }],
  );
}

compare(
  'painted prefix and scaled text preserve clamp arithmetic',
  paragraph(schema.text('leading words with a scaled footnote body')),
  92,
  [{ at: 7, hyphen: false }, { at: 18, hyphen: false }],
  { firstLineIndent: 13.25, scale: 0.85 },
);

compare(
  'leading and trailing collapsed whitespace preserve retained runs',
  paragraph(schema.text('  alpha  beta  ')),
  80,
  [{ at: 7, hyphen: false }],
  { firstLineIndent: 8 },
);

// Malformed or structurally impossible authority data safely falls back.
{
  const node = paragraph(schema.text('alpha beta hyphenation'));
  const reject = (forced: ForcedBreak[], opts: Omit<LayoutOptions, 'forced'> = {}) =>
    layoutForcedBlock(node, 100, new DeterministicMeasurer(), atomWidth, { ...opts, forced });
  assert.equal(reject([{ at: 5, hyphen: false }, { at: 5, hyphen: false }]), null);
  assert.equal(reject([{ at: 11, hyphen: true }, { at: 5, hyphen: false }]), null);
  assert.equal(reject([{ at: 999, hyphen: false }]), null);
  assert.equal(reject([{ at: 4, hyphen: false }]), null);
  assert.equal(reject([{ at: 13, hyphen: true }], { hyphenate: false }), null);
  assert.equal(
    layoutForcedBlock(
      paragraph(schema.text('ab😀cd words')),
      100,
      new DeterministicMeasurer(),
      atomWidth,
      { forced: [{ at: 3, hyphen: true }] },
    ),
    null,
  );
  console.log('  ok  malformed forced points return null');
}

// Match layoutBlock's early return: boxless blocks ignore malformed breaks.
assert.deepEqual(
  layoutForcedBlock(paragraph(schema.text('   ')), 100, new DeterministicMeasurer(), atomWidth, {
    forced: [{ at: 999, hyphen: false }],
  }),
  [],
);
console.log('  ok  boxless blocks return before forced validation');

// Correctness fix: the legacy partitioner accidentally merges hard breaks
// after the last forced point. The direct translator always honors them.
{
  const hard = schema.nodes.hard_break.create();
  const node = paragraph([schema.text('aaaa aaaa'), hard, schema.text('bbbb bbbb')]);
  const fast = layoutForcedBlock(node, 100, new DeterministicMeasurer(), atomWidth, { forced: [] });
  assert.deepEqual(normalized(fast), [
    { from: 0, to: 9, breakPos: null, hyphen: false, spacing: '' },
    { from: 10, to: 19, breakPos: null, hyphen: false, spacing: '' },
  ]);
  const legacy = layoutBlock(node, 100, new DeterministicMeasurer() as unknown as Measurer, atomWidth, {
    forced: [],
  });
  assert.equal(legacy?.length, 1);

  const consecutive = paragraph([schema.text('a'), hard, hard, schema.text('b')]);
  assert.deepEqual(
    normalized(layoutForcedBlock(consecutive, 100, new DeterministicMeasurer(), atomWidth, { forced: [] })),
    [
      { from: 0, to: 1, breakPos: null, hyphen: false, spacing: '' },
      { from: 3, to: 4, breakPos: null, hyphen: false, spacing: '' },
    ],
  );
  console.log('  ok  explicit hard breaks always partition final segments');
}

// Performance invariant: direct work scales with forced line/style intervals,
// not every syllable opportunity in a long paragraph.
{
  const words = Array.from({ length: 80 }, (_, i) =>
    ['characteristically', 'institutionalization', 'representation', 'hyphenation'][i % 4],
  );
  const text = words.join(' ');
  const spaces = [...text.matchAll(/ /g)].map((match) => match.index!);
  const forced = spaces.filter((_, i) => i % 8 === 7).map((at) => ({ at, hyphen: false }));
  const { legacyMeasurer, fastMeasurer } = compare(
    'long authoritative paragraph remains output-equivalent',
    paragraph(schema.text(text)),
    620,
    forced,
  );
  assert.ok(legacyMeasurer.rangeReads >= 200, `legacy read count was ${legacyMeasurer.rangeReads}`);
  assert.ok(
    fastMeasurer.rangeReads <= legacyMeasurer.rangeReads * 0.5,
    `fast=${fastMeasurer.rangeReads}, legacy=${legacyMeasurer.rangeReads}`,
  );
  assert.ok(fastMeasurer.probePopulations <= legacyMeasurer.probePopulations);
  console.log(
    `  ok  Range reads reduced ${legacyMeasurer.rangeReads} -> ${fastMeasurer.rangeReads}`,
  );
}

// Path-independence regression: given IDENTICAL break offsets, the live KP
// path and both forced translators must emit identical spacing — the settled
// oracle confirming the live breaks must be a repaint no-op, never a
// justification shimmer.
{
  const pathCases: Array<{
    label: string;
    node: ReturnType<typeof paragraph>;
    measure: number;
    opts: Omit<LayoutOptions, 'forced'>;
  }> = [
    {
      label: 'plain prose',
      node: paragraph(schema.text('alpha beta gamma delta epsilon zeta eta theta iota kappa')),
      measure: 74,
      opts: {},
    },
    {
      label: 'hyphenating words',
      node: paragraph(schema.text('hyphenation state-of-the-art characteristically writing')),
      measure: 70,
      opts: {},
    },
    {
      label: 'painted prefix and scale',
      node: paragraph(schema.text('leading words with a scaled footnote body and more words to wrap')),
      measure: 92,
      opts: { firstLineIndent: 13.25, scale: 0.85 },
    },
  ];
  for (const { label, node, measure, opts } of pathCases) {
    const live = layoutBlock(node, measure, new DeterministicMeasurer() as unknown as Measurer, atomWidth, opts);
    assert.ok(live && live.length > 1, `${label}: live layout wraps`);
    const derived = live.flatMap((line) => (line.oracleBreak ? [line.oracleBreak] : []));
    assert.equal(derived.length, live.length - 1, `${label}: every non-final line reports its break`);
    const forcedLegacy = layoutBlock(
      node,
      measure,
      new DeterministicMeasurer() as unknown as Measurer,
      atomWidth,
      { ...opts, forced: derived },
    );
    // Same translator, same items: raw spacing must be bit-identical.
    assert.deepEqual(forcedLegacy, live, `${label}: forced layoutBlock equals live layoutBlock`);
    const forcedFast = layoutForcedBlock(node, measure, new DeterministicMeasurer(), atomWidth, {
      ...opts,
      forced: derived,
    });
    // Different measurement grouping: identical at painted CSS precision.
    assert.deepEqual(
      normalized(forcedFast),
      normalized(live),
      `${label}: direct forced translator equals live layoutBlock`,
    );
    console.log(`  ok  live and forced spacing agree for identical breaks (${label})`);
  }
}

// Glyphless punctuation splits: authoritative breaks with no space before
// them and no injected hyphen glyph — a break carrying an em-dash to the
// next line, or a '/'-boundary inside a link. Typst renders these as plain
// Normal breakpoints; only the direct translator can represent them (the
// legacy partitioner has no item at those offsets and declines by design).
{
  const structural = (lines: LineLayout[] | null) =>
    lines?.map((line) => ({ from: line.from, to: line.to, breakPos: line.breakPos, hyphen: line.hyphen })) ?? null;

  // 'alpha conclusive' is 16 chars; the em-dash sits at offset 16.
  const emDash = paragraph(schema.text('alpha conclusive—overwhelming end'));
  const beforeDash = layoutForcedBlock(emDash, 120, new DeterministicMeasurer(), atomWidth, {
    forced: [{ at: 16, hyphen: true }],
  });
  assert.deepEqual(structural(beforeDash), [
    { from: 0, to: 16, breakPos: 16, hyphen: false },
    { from: 16, to: 33, breakPos: null, hyphen: false },
  ]);
  assert.equal(
    layoutBlock(emDash, 120, new DeterministicMeasurer() as unknown as Measurer, atomWidth, {
      forced: [{ at: 16, hyphen: true }],
    }),
    null,
    'legacy partitioner declines a break before an em-dash',
  );

  // 'alpha input/' is 12 chars; the split lands after the '/'.
  const slash = paragraph(schema.text('alpha input/output end'));
  const afterSlash = layoutForcedBlock(slash, 90, new DeterministicMeasurer(), atomWidth, {
    forced: [{ at: 12, hyphen: true }],
  });
  assert.deepEqual(structural(afterSlash), [
    { from: 0, to: 12, breakPos: 12, hyphen: false },
    { from: 12, to: 22, breakPos: null, hyphen: false },
  ]);

  // Glyphless splits are not hyphenation: they stay valid with it disabled.
  const dashOff = layoutForcedBlock(emDash, 120, new DeterministicMeasurer(), atomWidth, {
    forced: [{ at: 17, hyphen: true }],
    hyphenate: false,
  });
  assert.deepEqual(structural(dashOff), [
    { from: 0, to: 17, breakPos: 17, hyphen: false },
    { from: 17, to: 33, breakPos: null, hyphen: false },
  ]);

  // SHY carries a glyph the glyphless contract cannot express: decline.
  const shy = paragraph(schema.text('alpha conti\u00adnuation end'));
  assert.equal(
    layoutForcedBlock(shy, 90, new DeterministicMeasurer(), atomWidth, {
      forced: [{ at: 12, hyphen: true }],
    }),
    null,
  );
  console.log('  ok  glyphless punctuation splits translate without a glyph');
}

console.log('\nall forced-layout tests passed');
