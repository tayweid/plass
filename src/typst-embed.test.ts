import assert from 'node:assert/strict';
import { EditorState, TextSelection } from 'prosemirror-state';
import { typstEmbedMigrationPlugin } from './typst-embed-migration.ts';
import { documentTypstEmbedImagePaths, typstEmbedImagePaths } from './typst-embed-assets.ts';
import {
  TYPST_EMBED_REGION_KIND,
  TYPST_EMBED_REGION_LABEL,
  TYPST_EMBED_REGION_MARKER,
  TYPST_EMBED_REGION_STATE,
} from './typst-embed-regions.ts';
import { migrateLegacyTypstEmbeds, schema } from './schema.ts';
import { typToDoc } from './typ-parser.ts';
import { docToTyp } from './typ-serializer.ts';
import { docToTex } from './tex-serializer.ts';

const { doc, code_block, typst_embed, blockquote } = schema.nodes;
const text = (value: string) => (value ? [schema.text(value)] : []);

// Region instrumentation is an opt-in compile concern. Normal .typ export
// stays clean, while the prepared Proof/PDF/embed source gets exactly one
// ordered start/end pair for every dedicated executable block and one query
// anchor for the whole publication.
{
  const original = doc.create(null, [
    typst_embed.create(null, text('#let shared = 14pt')),
    schema.nodes.paragraph.create(null, text('Between')),
    typst_embed.create(null, text('#rect(width: shared, height: 5pt)')),
  ]);
  const normal = docToTyp(original);
  const instrumented = docToTyp(original, { embedRegions: true });
  assert.ok(!normal.includes(TYPST_EMBED_REGION_STATE));
  assert.ok(!normal.includes(TYPST_EMBED_REGION_LABEL));
  assert.ok(!normal.includes(TYPST_EMBED_REGION_MARKER));
  assert.equal(instrumented.split(`#${TYPST_EMBED_REGION_MARKER}(`).length - 1, 4);
  assert.ok(instrumented.includes(`#${TYPST_EMBED_REGION_MARKER}(0, "start")`));
  assert.ok(instrumented.includes(`#${TYPST_EMBED_REGION_MARKER}(1, "end")`));
  assert.ok(instrumented.includes(`#let ${TYPST_EMBED_REGION_MARKER}(index, edge) = context`));
  assert.ok(instrumented.includes(JSON.stringify(TYPST_EMBED_REGION_STATE)));
  assert.ok(instrumented.includes(JSON.stringify(TYPST_EMBED_REGION_KIND)));
  assert.ok(instrumented.includes(`<${TYPST_EMBED_REGION_LABEL}>`));
  assert.ok(instrumented.includes('#let shared = 14pt'));
  assert.ok(instrumented.includes('#rect(width: shared, height: 5pt)'));
}

// Static VFS discovery is deliberately lossless and conservative: direct
// literal images are deduplicated and decoded, while unsupported escapes are
// not guessed into a different filesystem path.
{
  const source = [
    '#image("figures/result.svg")',
    '#image("figures/result.svg", width: 20pt)',
    '#image("figures/a\\\\b\\\"c.png")',
    '#image("figures/unsupported\\nname.png")',
  ].join('\n');
  assert.deepEqual(typstEmbedImagePaths(source), [
    'figures/result.svg',
    'figures/a\\b"c.png',
  ]);
  const withImages = doc.create(null, [
    typst_embed.create(null, text(source)),
    typst_embed.create(null, text('#image("figures/other.png")')),
  ]);
  assert.deepEqual(documentTypstEmbedImagePaths(withImages), [
    'figures/result.svg',
    'figures/a\\b"c.png',
    'figures/other.png',
  ]);
}

// A language-labelled Typst fence is documentation/source code, not an
// executable preview. Unknown executable Typst remains an explicit embed.
{
  const fenced = typToDoc('```typst\n#rect(width: 10pt)\n```\n').doc.firstChild!;
  assert.equal(fenced.type, code_block);
  assert.equal(fenced.attrs.params, 'typst');
  assert.equal(fenced.textContent, '#rect(width: 10pt)');

  const executable = typToDoc('#rect(width: 10pt)\n').doc.firstChild!;
  assert.equal(executable.type, typst_embed);
  assert.equal(executable.textContent, '#rect(width: 10pt)');
}

// LaTeX cannot execute Typst, but exporting must retain the complete source
// and state the mismatch explicitly instead of falling through and omitting it.
{
  const source = '#let x = 1\n\\end{document}\n#circle(radius: 2pt)';
  const exported = docToTex(doc.create(null, [typst_embed.create(null, text(source))]));
  assert.match(exported, /executable Typst embed has no LaTeX equivalent/);
  for (const line of source.split('\n')) assert.ok(exported.includes(`% ${line}`));
}

// Transactional migration preserves a caret inside the literal source. This
// is the path used by old persisted documents, imports and toolbar commands.
{
  const initial = EditorState.create({
    schema,
    doc: doc.create(null, [schema.nodes.paragraph.create(null, text('initial'))]),
    plugins: [typstEmbedMigrationPlugin()],
  });
  const legacy = code_block.create(
    { params: 'typst-raw' },
    text('#let answer = 42'),
  );
  let tr = initial.tr.replaceWith(0, initial.doc.content.size, legacy);
  tr = tr.setSelection(TextSelection.create(tr.doc, 7));
  const applied = initial.applyTransaction(tr);
  assert.equal(applied.state.doc.firstChild?.type, typst_embed);
  assert.equal(applied.state.selection.from, 7);
  assert.equal(applied.transactions.length, 2, 'migration should append exactly one transaction');
  assert.equal(applied.transactions[1].getMeta('addToHistory'), false);
}

// Migration is deliberately exact-marker-only and preserves every source
// byte represented by the PM text node. It is also idempotent.
{
  const legacySource = '#let answer = 42\n#show heading: set text(blue)';
  const original = doc.create(null, [
    code_block.create({ params: 'typst-raw' }, text(legacySource)),
    code_block.create({ params: 'typst' }, text('#rect(width: 10pt)')),
    code_block.create({ params: 'typescript' }, text('const answer = 42;')),
  ]);
  const migrated = migrateLegacyTypstEmbeds(original);

  assert.notEqual(migrated, original);
  assert.equal(migrated.child(0).type, typst_embed);
  assert.equal(migrated.child(0).textContent, legacySource);
  assert.equal(migrated.child(1).type, code_block);
  assert.equal(migrated.child(1).attrs.params, 'typst');
  assert.equal(migrated.child(2).type, code_block);
  assert.equal(original.child(0).type, code_block, 'pure migration must not mutate its input');
  assert.equal(migrateLegacyTypstEmbeds(migrated), migrated, 'migration should retain an unchanged doc identity');
}

// Explicit line-count boundaries preserve blank lines, trailing newlines, and
// marker-like source without wrapping the executable code in another scope.
{
  const source = [
    '#let values = (',
    '  first: 1,',
    '',
    '  second: 2,',
    ')',
    '// typeset:typst-embed-lines 999',
    '#rect(width: 10pt)',
    '',
  ].join('\n');
  const original = doc.create(null, [typst_embed.create(null, text(source))]);
  const exported = docToTyp(original);
  assert.match(exported, /\/\/ typeset:typst-embed-lines 8\n/);

  const imported = typToDoc(exported).doc;
  const restored = imported.content.content.find((node) => node.type === typst_embed);
  assert.ok(restored);
  assert.equal(restored.textContent, source);
}

// Surrounding block indentation is added for valid Typst and removed by the
// existing quote parser, without changing the embed's stored source.
{
  const source = '#let x = 1\n\n#rect(width: 5pt)';
  const original = doc.create(null, [blockquote.create(null, [typst_embed.create(null, text(source))])]);
  const restored = typToDoc(docToTyp(original)).doc.firstChild!;
  assert.equal(restored.type, blockquote);
  assert.equal(restored.firstChild?.type, typst_embed);
  assert.equal(restored.firstChild?.textContent, source);
}

// The legacy serializer path remains lossless before startup migration, while
// all ordinary code—including Typst code—stays fenced and inert.
{
  const source = '#circle(radius: 4pt)';
  const legacy = doc.create(null, [code_block.create({ params: 'typst-raw' }, text(source))]);
  const legacyExport = docToTyp(legacy);
  assert.match(legacyExport, /\/\/ typeset:typst-embed-lines 1\n#circle/);
  assert.equal(typToDoc(legacyExport).doc.firstChild?.type, typst_embed);

  const ordinary = doc.create(null, [code_block.create({ params: 'typst' }, text(source))]);
  const ordinaryExport = docToTyp(ordinary);
  assert.match(ordinaryExport, /\/\/ typeset:code-block-params "typst"/);
  assert.match(ordinaryExport, /#raw\("#circle\(radius: 4pt\)", block: true\)/);
  assert.doesNotMatch(ordinaryExport, /typeset:typst-embed-lines/);
  const restored = typToDoc(ordinaryExport).doc.firstChild!;
  assert.equal(restored.type, code_block);
  assert.equal(restored.attrs.params, 'typst');
  assert.equal(restored.textContent, source);
}

console.log('typst embed tests passed');
