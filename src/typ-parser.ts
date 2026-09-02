// Typst (.typ) -> ProseMirror import: the parse half of spec §3.3.
//
// Coverage contract (per the spec): full fidelity for documents our own
// serializer produced, plus a pragmatic subset of hand-written Typst
// (headings, paragraphs with */_/` markup, lists, quotes, fenced code,
// mitex math, images, labels and @references). Anything else — #let, #show,
// unknown directives — is preserved verbatim as a raw-Typst island
// (a code_block with params 'typst-raw'), which the serializer re-emits
// unchanged, so opening and saving a file never destroys what we don't
// understand.

import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { unwrapAligned } from './math-src';
import { DEFAULT_SETTINGS, normalizeSettings, type DocSettings } from './settings';
import { trimSpaceBeforeMarker } from './collapse-spaces';
import { parseBibTeX } from './bibtex';
import { INPUT_LIMITS, textSizeError } from './input-limits';

export interface TypImport {
  doc: PMNode;
  warnings: string[];
}

// Import-scoped state: bibliography data found in the file, used to
// disambiguate inline `@key` (citation vs equation/figure reference).
let importBib: { name: string; content: string } | null = null;
let importBibKeys = new Set<string>();
let preserveImportBibLine = false;

const BIB_LINE = /^#bibliography\(bytes\((".*")\)(?:,\s*title:\s*"[^"]*")?(?:,\s*style:\s*"[^"]*")?\)$/;

export function typToDoc(src: string): TypImport {
  const warnings: string[] = [];
  const settings: DocSettings = { ...DEFAULT_SETTINGS };
  let sawSet = false;
  let sawNumbering = false;

  const lines = src.replace(/\r\n?/g, '\n').split('\n');

  // Prescan for an embedded bibliography so @key can disambiguate.
  importBib = null;
  importBibKeys = new Set();
  preserveImportBibLine = false;
  for (const line of lines) {
    const m = BIB_LINE.exec(line.trim());
    if (m) {
      try {
        const content = JSON.parse(m[1]) as unknown;
        if (typeof content !== 'string') throw new Error('embedded bibliography is not text');
        const sizeError = textSizeError(content, INPUT_LIMITS.bibliographyBytes, 'Embedded bibliography');
        if (sizeError) throw new Error(sizeError);
        importBib = { name: 'references.bib', content };
        importBibKeys = new Set(parseBibTeX(content).map((e) => e.key));
      } catch (error) {
        warnings.push(
          error instanceof Error && error.message.includes("Plass's")
            ? error.message
            : 'could not decode embedded bibliography',
        );
        preserveImportBibLine = true;
      }
      break;
    }
  }

  // Header pass: leading directives we understand become document settings.
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const macroM = /^\/\/ typeset:math-macros (.*)$/.exec(line);
    if (macroM) {
      try {
        const macros = JSON.parse(macroM[1]) as unknown;
        if (typeof macros !== 'string') throw new Error('math macros directive is not text');
        const sizeError = textSizeError(macros, INPUT_LIMITS.mathMacrosBytes, 'Math macros');
        if (sizeError) throw new Error(sizeError);
        settings.mathMacros = macros;
      } catch (error) {
        warnings.push(
          error instanceof Error && error.message.includes("Plass's")
            ? error.message
            : 'could not decode math macros directive',
        );
      }
      i++;
      continue;
    }
    // Body directives (attached to specific blocks) end the header.
    if (/^\/\/ typeset:decimal-columns /.test(line)) break;
    if (!line || line.startsWith('//')) {
      i++;
      continue;
    }
    if (/^#set par\(first-line-indent:/.test(line)) {
      sawSet = true;
      settings.parIndent = true;
      i++;
      continue;
    }
    if (/^#import "@preview\/mitex/.test(line) || /^#set par\(/.test(line)) {
      sawSet = true;
      i++;
      continue;
    }
    // Spacing-parity rules (regenerated from settings on export).
    if (
      /^#set (list|enum)\(spacing:/.test(line) ||
      /^#show heading\.where\(level: \d+\): set (text|block|par)\(/.test(line) ||
      /^#show raw\.where\(block: false\): set text\(/.test(line) ||
      /^#show math\.equation\.where\(block: true\): set block\(/.test(line) ||
      /^#show table: set block\(breakable: false\)$/.test(line)
    ) {
      sawSet = true;
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^#set page\((.*)\)$/.exec(line))) {
      sawSet = true;
      const paper = /paper:\s*"([^"]+)"/.exec(m[1])?.[1];
      if (paper) {
        settings.page =
          ({ 'us-letter': 'letter', a4: 'a4', 'us-legal': 'legal', 'iso-b5': 'b5' } as const)[paper] ?? 'letter';
      }
      if (/flipped:\s*true/.test(m[1])) settings.landscape = true;
      const marginDict = /margin:\s*\(([^)]*)\)/.exec(m[1])?.[1];
      if (marginDict) {
        for (const [key, field] of [
          ['top', 'marginTop'],
          ['right', 'marginRight'],
          ['bottom', 'marginBottom'],
          ['left', 'marginLeft'],
        ] as Array<[string, 'marginTop' | 'marginRight' | 'marginBottom' | 'marginLeft']>) {
          const v = new RegExp(`${key}:\\s*([\\d.]+)in`).exec(marginDict)?.[1];
          if (v) settings[field] = parseFloat(v);
        }
      } else {
        const margin = /margin:\s*([\d.]+)in/.exec(m[1])?.[1];
        if (margin) {
          settings.marginTop = settings.marginRight = settings.marginBottom = settings.marginLeft = parseFloat(margin);
        }
      }
      const numbering = /numbering:\s*"([^"]*)"/.exec(m[1])?.[1];
      if (numbering !== undefined) {
        settings.pageNumShow = true;
        if (numbering === '1' || numbering === '— 1 —' || numbering === 'i' || numbering === '1 / 1') {
          settings.pageNumFormat = numbering;
        }
      } else {
        settings.pageNumShow = false;
      }
      const nAlign = /number-align:\s*(left|center|right)/.exec(m[1])?.[1];
      if (nAlign) settings.pageNumAlign = nAlign as typeof settings.pageNumAlign;
      // Running header: header: [context if(...) {] align(X)[text] [}]
      const header = /header:\s*(context if\(counter\(page\)\.get\(\)\.first\(\) > 1\) \{ )?align\((left|center|right)\)\[(.*?)\](?: \})?(?:,|$)/.exec(m[1]);
      if (header) {
        settings.headerFirstPage = !header[1];
        settings.headerAlign = header[2] as typeof settings.headerAlign;
        settings.headerText = unescapeTypText(
          header[3].replace(/#context counter\(page\)\.display\(\)/g, '{page}'),
        );
      }
      i++;
      continue;
    }
    if ((m = /^#set text\(([^)]*)\)$/.exec(line))) {
      sawSet = true;
      const size = /size:\s*([\d.]+)pt/.exec(m[1])?.[1];
      if (size) settings.sizePt = parseFloat(size);
      // accept both font: "F" and font: ("F", "Fallback")
      const font = /font:\s*\(?\s*"([^"]+)"/.exec(m[1])?.[1];
      if (font) settings.font = font;
      const hyph = /hyphenate:\s*(true|false)/.exec(m[1])?.[1];
      if (hyph) settings.hyphenate = hyph === 'true';
      i++;
      continue;
    }
    if (/^#set math\.equation\(numbering:/.test(line)) {
      sawSet = true;
      sawNumbering = true;
      i++;
      continue;
    }
    if (/^#set heading\(numbering:/.test(line)) {
      sawSet = true;
      settings.numberSections = true;
      i++;
      continue;
    }
    const counterM = /^#counter\(page\)\.update\((\d+)\)$/.exec(line);
    if (counterM) {
      sawSet = true;
      settings.pageNumStart = parseInt(counterM[1], 10);
      i++;
      continue;
    }
    break;
  }
  // Files with a settings header state equation numbering explicitly; bare
  // hand-written files get the default.
  settings.numberEquations = sawSet ? sawNumbering : DEFAULT_SETTINGS.numberEquations;

  restartFormat = null;
  const blocks = parseBlocks(lines.slice(i), warnings);
  if (restartFormat === '1' || restartFormat === '— 1 —' || restartFormat === 'i' || restartFormat === '1 / 1') {
    settings.pageNumFormat = restartFormat;
  }
  if (!blocks.length) blocks.push(schema.nodes.paragraph.create());
  return { doc: schema.nodes.doc.create({ settings: normalizeSettings(settings), bib: importBib }, blocks), warnings };
}

/**
 * Reverse the decimal-column split: merge each (int, frac) sub-column pair
 * back into one 'decimal'-aligned logical column, shrink spanning cells,
 * and un-expand any width tuple carried in params.
 */
function fuseDecimalColumns(table: PMNode, logicalDecimals: number[]): PMNode {
  // Logical index d sits at expanded index d + (#decimals before d).
  const expanded = logicalDecimals.map((d, i) => d + i);
  const rows: PMNode[] = [];
  table.forEach((row) => {
    const cells: PMNode[] = [];
    let col = 0;
    let skipNext = 0;
    row.forEach((cell) => {
      if (skipNext > 0) {
        skipNext--;
        col += (cell.attrs.colspan as number) ?? 1;
        return;
      }
      const span = (cell.attrs.colspan as number) ?? 1;
      if (expanded.includes(col)) {
        if (span >= 2) {
          // Header / non-numeric spanning cell: shrink back to one column.
          cells.push(cell.type.create({ ...cell.attrs, colspan: span - 1, align: 'decimal' }, cell.content));
        } else {
          // Numeric pair: join this cell's text with the next (fraction) cell.
          skipNext = 1;
          let cellIdx = -1;
          row.forEach((c2, _o, idx2) => {
            if (cellIdx < 0 && c2 === cell) cellIdx = idx2;
          });
          const after = cellIdx >= 0 && cellIdx + 1 < row.childCount ? row.child(cellIdx + 1) : null;
          const joined = (cell.textContent + (after ? after.textContent : '')).trim();
          cells.push(
            cell.type.create(
              { ...cell.attrs, colspan: 1, align: 'decimal' },
              [schema.nodes.paragraph.create(null, joined ? [schema.text(joined)] : [])],
            ),
          );
        }
      } else {
        const coveredPairs = expanded.filter((e) => e > col && e < col + span).length;
        if (coveredPairs > 0) {
          cells.push(cell.type.create({ ...cell.attrs, colspan: span - coveredPairs }, cell.content));
        } else {
          cells.push(cell);
        }
      }
      col += span;
    });
    rows.push(row.type.create(row.attrs, cells));
  });
  // Un-expand a width tuple in params: drop the auto that followed each pair.
  let params = (table.attrs.params as string) || '';
  params = params.replace(/table\.vline\(\s*x\s*:\s*(\d+)/g, (_, x: string) => {
    const n = parseInt(x, 10);
    // Reverse the expansion: subtract one per decimal pair left of it.
    let logical = n;
    for (const e of expanded) if (e < n) logical--;
    return `table.vline(x: ${logical}`;
  });
  params = params.replace(/columns\s*:\s*\(([^)]*)\)/, (_, tuple: string) => {
    const widths = tuple.split(',').map((w: string) => w.trim());
    // Walk logical columns, skipping the extra auto that followed each pair.
    const fused: string[] = [];
    let idx = 0;
    let logical = 0;
    while (idx < widths.length) {
      fused.push(widths[idx]);
      idx += logicalDecimals.includes(logical) ? 2 : 1;
      logical++;
    }
    return `columns: (${fused.join(', ')})`;
  });
  return table.type.create({ ...table.attrs, params }, rows);
}

function unescapeTypText(t: string): string {
  // Table captions use the table-cell-safe text encoder, which also protects
  // literal tildes and Typst comment openers.
  return t.replace(/\\([\\#$*_`@<>\[\]~\/])/g, '$1');
}

/** Body numbering format captured from a numbering-restart marker. */
let restartFormat: string | null = null;

function parseBlocks(lines: string[], warnings: string[]): PMNode[] {
  const out: PMNode[] = [];
  const n = lines.length;
  let i = 0;
  let pendingDecimals: number[] | null = null;

  while (i < n) {
    const line = lines[i];
    const t = line.trim();
    const dm = /^\/\/ typeset:decimal-columns ([\d,]+)$/.exec(t);
    if (dm) {
      pendingDecimals = dm[1].split(',').map(Number);
      i++;
      continue;
    }
    if (!t || t.startsWith('//')) {
      i++;
      continue;
    }

    // Keep-together paragraph: #block(breakable: false)[...]
    const keepM = /^#block\(breakable: false\)\[(.*)\]$/.exec(t);
    if (keepM) {
      out.push(schema.nodes.paragraph.create({ keep: true }, parseInline(keepM[1])));
      i++;
      continue;
    }

    // fenced code block
    let m = /^```(.*)$/.exec(t);
    if (m) {
      const params = m[1].trim();
      const body: string[] = [];
      i++;
      while (i < n && lines[i].trim() !== '```') body.push(lines[i++]);
      i++; // closing fence
      const text = body.join('\n');
      out.push(schema.nodes.code_block.create({ params }, text ? [schema.text(text)] : []));
      continue;
    }

    // Per-equation numbering override (set/restore form): a bare
    // #set math.equation(...) line, the mitex block, then the restore line.
    {
      const nm = /^#set math\.equation\(numbering: (none|"\(1\)")\)$/.exec(t);
      if (nm && lines[i + 1]?.trim() === '#mitex(`') {
        const numbered = nm[1] !== 'none';
        const body: string[] = [];
        let label = '';
        i += 2;
        while (i < n) {
          const close = /^`\)\s*(?:<([^>]+)>)?\s*$/.exec(lines[i].trim());
          if (close) {
            label = close[1] ?? '';
            i++;
            break;
          }
          body.push(lines[i++]);
        }
        if (/^#set math\.equation\(numbering: /.test(lines[i]?.trim() ?? '')) i++;
        out.push(schema.nodes.math_display.create({ src: unwrapAligned(body.join('\n').trim()), label, numbered }));
        continue;
      }
    }

    // Per-equation numbering override: #[#set math.equation(numbering: X)
    // followed by the mitex block and a closing ] (legacy form).
    {
      const nm = /^#\[#set math\.equation\(numbering: (none|"\(1\)")\)$/.exec(t);
      if (nm && lines[i + 1]?.trim() === '#mitex(`') {
        const numbered = nm[1] !== 'none';
        const body: string[] = [];
        let label = '';
        i += 2;
        while (i < n) {
          const close = /^`\)\s*(?:<([^>]+)>)?\s*$/.exec(lines[i].trim());
          if (close) {
            label = close[1] ?? '';
            i++;
            break;
          }
          body.push(lines[i++]);
        }
        if (lines[i]?.trim() === ']') i++;
        out.push(schema.nodes.math_display.create({ src: unwrapAligned(body.join('\n').trim()), label, numbered }));
        continue;
      }
    }

    // display math: #mitex(` … `) <label>
    if (t === '#mitex(`') {
      const body: string[] = [];
      let label = '';
      i++;
      while (i < n) {
        const close = /^`\)\s*(?:<([^>]+)>)?\s*$/.exec(lines[i].trim());
        if (close) {
          label = close[1] ?? '';
          i++;
          break;
        }
        body.push(lines[i++]);
      }
      out.push(schema.nodes.math_display.create({ src: unwrapAligned(body.join('\n').trim()), label }));
      continue;
    }

    // front matter: title, then (position-gated) authors and date
    {
      const tm = /^#align\(center, text\(size: 1\.55em, weight: 700\)\[(.*)\]\)$/.exec(t);
      if (tm) {
        out.push(schema.nodes.doc_title.create(null, parseInline(tm[1])));
        i++;
        continue;
      }
      const prev = out.length ? out[out.length - 1].type.name : '';
      const am = /^#align\(center\)\[(.*)\]$/.exec(t);
      if (am && prev === 'doc_title') {
        out.push(schema.nodes.doc_authors.create(null, parseInline(am[1])));
        i++;
        continue;
      }
      const dm2 = /^#align\(center, text\(style: "italic"\)\[(.*)\]\)$/.exec(t);
      if (dm2 && (prev === 'doc_title' || prev === 'doc_authors')) {
        out.push(schema.nodes.doc_date.create(null, parseInline(dm2[1])));
        i++;
        continue;
      }
    }

    // abstract: label line + padded body
    if (t === '#align(center, text(weight: 600)[Abstract])' && i + 1 < n && lines[i + 1].trim() === '#pad(x: 1.8em)[') {
      const body: string[] = [];
      i += 2;
      while (i < n && lines[i].trim() !== ']') body.push(lines[i++].replace(/^  /, ''));
      i++;
      const inner = parseBlocks(body, warnings).filter((b) => b.type.name === 'paragraph');
      out.push(schema.nodes.abstract.create(null, inner.length ? inner : [schema.nodes.paragraph.create()]));
      continue;
    }

    // a bare ~ is an empty paragraph (one blank line of space)
    if (t === '~') {
      out.push(schema.nodes.paragraph.create());
      i++;
      continue;
    }

    // blockquote
    if (t === '#quote(block: true)[') {
      const body: string[] = [];
      i++;
      while (i < n && lines[i].trim() !== ']') body.push(lines[i++].replace(/^  /, ''));
      i++; // closing bracket
      const inner = parseBlocks(body, warnings);
      out.push(schema.nodes.blockquote.create(null, inner.length ? inner : [schema.nodes.paragraph.create()]));
      continue;
    }

    // aligned paragraph — the MULTI-line #align form the serializer emits;
    // the single-line #align(center)[…] right after a title is the authors
    // line, and #align(center, …) calls are title/rule/table furniture.
    {
      const alignM = /^#align\((center|right)\)\[$/.exec(t);
      if (alignM) {
        const body: string[] = [];
        i++;
        while (i < n && lines[i].trim() !== ']') body.push(lines[i++].replace(/^  /, ''));
        i++; // closing bracket
        const inner = parseBlocks(body, warnings);
        if (!inner.length) out.push(schema.nodes.paragraph.create({ align: alignM[1] }));
        for (const b of inner) {
          out.push(
            b.type.name === 'paragraph'
              ? schema.nodes.paragraph.create({ ...b.attrs, align: alignM[1] }, b.content)
              : b,
          );
        }
        continue;
      }
    }

    // heading (with optional trailing <label>)
    m = /^(={1,3})\s+(.*)$/.exec(t);
    if (m && t === line.trimEnd()) {
      let text = m[2];
      let label = '';
      const lm = /\s*<([a-zA-Z0-9:._-]+)>$/.exec(text);
      if (lm) {
        label = lm[1];
        text = text.slice(0, lm.index);
      }
      out.push(schema.nodes.heading.create({ level: m[1].length, label }, parseInline(text)));
      i++;
      continue;
    }

    // manual page break
    {
      const nm = /^#set page\(numbering: "([^"]*)"\)$/.exec(t);
      if (nm && lines[i + 1]?.trim() === '#counter(page).update(1)') {
        out.push(schema.nodes.numbering_restart.create());
        // The marker line carries the BODY numbering format; the doc-level
        // set page held the roman front-matter format.
        restartFormat = nm[1];
        i += 2;
        continue;
      }
    }
    if (t === '#pagebreak()') {
      out.push(schema.nodes.page_break.create());
      i++;
      continue;
    }

    // horizontal rule
    if (/^#line\(/.test(t)) {
      out.push(schema.nodes.horizontal_rule.create());
      i++;
      continue;
    }

    // embedded bibliography (content captured in the prescan)
    if (BIB_LINE.test(t)) {
      if (importBib && !preserveImportBibLine) {
        out.push(schema.nodes.bibliography.create());
      } else {
        out.push(schema.nodes.code_block.create({ params: 'typst-raw' }, [schema.text(line)]));
      }
      i++;
      continue;
    }

    // table: #align(center, [text(size…, )]table(…)) or bare #table(…)
    const centered = t.startsWith('#align(center, table(') || t.startsWith('#align(center, text(size:');
    if (centered || t.startsWith('#table(')) {
      let whole = line;
      const callOpen = whole.indexOf('(');
      i++;
      while (i < n && matchParen(whole, callOpen) < 0) whole += `\n${lines[i++]}`;
      let src = whole;
      let tableSize = '';
      if (centered) {
        src = src.trim();
        const sized = /^#align\(center,\s*text\(size:\s*([\d.]+em),\s*table\(/.exec(src);
        if (sized) {
          tableSize = sized[1];
          src = '#table(' + src.slice(sized[0].length).replace(/\)\)\)$/, ')');
        } else {
          src = src.replace(/^#align\(center,\s*table\(/, '#table(').replace(/\)\)$/, ')');
        }
      }
      let table = parseTable(src);
      if (table && tableSize) table = table.type.create({ ...table.attrs, fontSize: tableSize }, table.content);
      if (table) {
        out.push(pendingDecimals ? fuseDecimalColumns(table, pendingDecimals) : table);
        pendingDecimals = null;
      } else {
        warnings.push('kept as raw Typst: #table(…) (unrecognized form)');
        out.push(schema.nodes.code_block.create({ params: 'typst-raw' }, [schema.text(whole)]));
      }
      continue;
    }

    // lists (marker at line start; continuation lines indented two spaces)
    m = /^([-+]) /.exec(line);
    if (m) {
      const marker = m[1];
      const itemRe = new RegExp(`^\\${marker} (.*)$`);
      const items: PMNode[] = [];
      while (i < n) {
        const im = itemRe.exec(lines[i]);
        if (!im) break;
        const body: string[] = [im[1]];
        i++;
        while (
          i < n &&
          (/^  /.test(lines[i]) || (lines[i].trim() === '' && /^  /.test(lines[i + 1] ?? '')))
        ) {
          body.push(lines[i++].replace(/^  /, ''));
        }
        const inner = parseBlocks(body, warnings);
        const content =
          inner.length && inner[0].type === schema.nodes.paragraph
            ? inner
            : [schema.nodes.paragraph.create(), ...inner];
        items.push(schema.nodes.list_item.create(null, content));
      }
      const type = marker === '-' ? schema.nodes.bullet_list : schema.nodes.ordered_list;
      out.push(type.create(null, items));
      continue;
    }

    // captioned table: #figure(\n  table(…),\n  caption: […],\n) <label>
    if (/^#figure\(\s*$/.test(t) || /^#figure\(\s*table\(/.test(t)) {
      let whole = line;
      const figureOpen = whole.indexOf('(');
      i++;
      while (i < n && matchParen(whole, figureOpen) < 0) whole += `\n${lines[i++]}`;
      const figSize = /text\(size:\s*([\d.]+em),\s*table\(/.exec(whole)?.[1] ?? '';
      const tStart = whole.indexOf('table(', whole.indexOf('(') + 1);
      if (tStart >= 0) {
        // Content-block parens are visible text, not call delimiters.
        const tEnd = matchParen(whole, tStart + 'table'.length);
        if (tEnd > 0) {
          const capM = /caption:\s*\[/.exec(whole.slice(tEnd));
          let caption = '';
          if (capM) {
            const capStart = tEnd + capM.index + capM[0].length - 1;
            const capEnd = matchBracket(whole, capStart);
            if (capEnd > 0) caption = whole.slice(capStart + 1, capEnd);
          }
          const label = /<([a-zA-Z0-9:._-]+)>\s*$/.exec(whole)?.[1] ?? '';
          let table = parseTable('#' + whole.slice(tStart, tEnd + 1));
          if (table && pendingDecimals) {
            table = fuseDecimalColumns(table, pendingDecimals);
            pendingDecimals = null;
          }
          if (table) {
            out.push(
              table.type.create(
                { ...table.attrs, caption: unescapeTypText(caption), label, fontSize: figSize },
                table.content,
              ),
            );
            continue;
          }
        }
      }
      warnings.push('kept as raw Typst: #figure(table…) (unrecognized form)');
      out.push(schema.nodes.code_block.create({ params: 'typst-raw' }, [schema.text(whole)]));
      continue;
    }

    // figure: #figure(image("src"), caption: [ … ]) <label>
    m = /^#figure\(image\("([^"]*)"\)\s*,\s*caption:\s*\[/.exec(t);
    if (m) {
      const capStart = m[0].length - 1; // index of '['
      const capEnd = matchBracket(t, capStart);
      if (capEnd > 0) {
        const caption = t.slice(capStart + 1, capEnd);
        const rest = t.slice(capEnd + 1);
        const label = /^\)\s*<([^>]+)>/.exec(rest)?.[1] ?? '';
        out.push(schema.nodes.figure.create({ src: m[1], label }, parseInline(caption)));
        i++;
        continue;
      }
    }

    // standalone image
    m = /^#image\("([^"]+)"\)$/.exec(t);
    if (m) {
      out.push(schema.nodes.paragraph.create(null, [schema.nodes.image.create({ src: m[1] })]));
      i++;
      continue;
    }

    // unknown directive / scripting: preserve verbatim as a raw island
    if (t.startsWith('#')) {
      const body: string[] = [];
      while (i < n && lines[i].trim() !== '') body.push(lines[i++]);
      warnings.push(`kept as raw Typst: ${body[0].trim().slice(0, 48)}`);
      out.push(schema.nodes.code_block.create({ params: 'typst-raw' }, [schema.text(body.join('\n'))]));
      continue;
    }

    // paragraph: consume until a blank line or the start of another construct
    const para: string[] = [];
    while (i < n) {
      const pt = lines[i].trim();
      if (!pt || /^(```|={1,3} |[-+] |#)/.test(pt)) break;
      para.push(lines[i++]);
    }
    out.push(schema.nodes.paragraph.create(null, parseParagraph(para)));
  }
  return out;
}

/** Paragraph lines -> inline nodes, handling ` \` hard breaks and line joins. */
function parseParagraph(lines: string[]): PMNode[] {
  const out: PMNode[] = [];
  lines.forEach((raw, idx) => {
    let text = raw.trim();
    let hardBreak = false;
    // A trailing ` \` is a Typst line break (but `\\` is an escaped backslash).
    if (/ \\$/.test(text) && !/\\\\$/.test(text)) {
      hardBreak = true;
      text = text.slice(0, -2).trimEnd();
    }
    scanInline(text, [], out);
    if (hardBreak) out.push(schema.nodes.hard_break.create());
    else if (idx < lines.length - 1) out.push(schema.text(' '));
  });
  return out;
}

export function parseInline(text: string): PMNode[] {
  const out: PMNode[] = [];
  scanInline(text, [], out);
  return out;
}

interface ParsedCell {
  content: string;
  colspan: number;
  rowspan: number;
  header: boolean;
  align: string | null;
}

export interface TableSourceParts {
  /** Non-cell positional/named arguments, without their trailing commas. */
  args: string[];
  /** Cell and table.header arguments, without their trailing commas. */
  rows: string[];
}

/** Skip a quoted Typst string or raw string, returning its closing index. */
function quotedEnd(src: string, open: number): number {
  const quote = src[open];
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '\\') {
      i++;
      continue;
    }
    if (src[i] === quote) return i;
  }
  return src.length - 1;
}

interface ParsedRawMathCall {
  src: string;
  /** First source offset after the two closing call parentheses. */
  end: number;
}

/** Parse only the inert inline-math shape emitted for certified table cells. */
function parseRawMathCall(source: string, start: number): ParsedRawMathCall | null {
  const prefix = '#mi(raw(';
  if (!source.startsWith(prefix, start)) return null;
  const quote = start + prefix.length;
  if (source[quote] !== '"') return null;
  const end = quotedEnd(source, quote);
  if (end <= quote || source[end] !== '"') return null;
  const suffix = /^,\s*block:\s*false\)\)/.exec(source.slice(end + 1));
  if (!suffix) return null;
  try {
    const decoded = JSON.parse(source.slice(quote, end + 1)) as unknown;
    return typeof decoded === 'string'
      ? { src: decoded, end: end + 1 + suffix[0].length }
      : null;
  } catch {
    return null;
  }
}

/** Matching `)` for a Typst call. Content blocks are opaque to parens. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '"' || c === '`') {
      i = quotedEnd(src, i);
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i + 2);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (c === '[') {
      const end = matchBracket(src, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a Typst argument list at depth-0 commas. */
function splitTopArgs(inner: string): string[] {
  const args: string[] = [];
  let parens = 0;
  let braces = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '"' || c === '`') {
      i = quotedEnd(inner, i);
      continue;
    }
    if (c === '/' && inner[i + 1] === '/') {
      const nl = inner.indexOf('\n', i + 2);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (c === '[') {
      const end = matchBracket(inner, i);
      if (end < 0) return [];
      i = end;
      continue;
    }
    if (c === '(') parens++;
    else if (c === ')') parens--;
    else if (c === '{') braces++;
    else if (c === '}') braces--;
    else if (c === ',' && parens === 0 && braces === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  args.push(inner.slice(start));
  return args.map((a) => a.trim()).filter(Boolean);
}

/** Parse one positional cell argument: [content] or table.cell(args)[content]. */
function parseCellArg(arg: string, header: boolean): ParsedCell | null {
  if (arg.startsWith('[')) {
    const end = matchBracket(arg, 0);
    if (end !== arg.length - 1) return null;
    return { content: arg.slice(1, end), colspan: 1, rowspan: 1, header, align: null };
  }
  if (arg.startsWith('table.cell(')) {
    const argsStart = 'table.cell('.length;
    const argsEnd = matchParen(arg, argsStart - 1);
    const bracket = arg.indexOf('[', argsEnd);
    if (argsEnd < 0 || bracket < 0) return null;
    const end = matchBracket(arg, bracket);
    if (end !== arg.length - 1) return null;
    const a = arg.slice(argsStart, argsEnd);
    return {
      content: arg.slice(bracket + 1, end),
      colspan: parseInt(/colspan:\s*(\d+)/.exec(a)?.[1] ?? '1', 10),
      rowspan: parseInt(/rowspan:\s*(\d+)/.exec(a)?.[1] ?? '1', 10),
      header,
      align: /align:\s*(left|center|right)/.exec(a)?.[1] ?? null,
    };
  }
  return null;
}

const CELL_ARG_RE = /^(?:\[|table\.cell\(|table\.header\()/;

/** Extract the balanced table call from generated source, excluding any
 * surrounding centered/figure wrapper and tolerating visible cell parens. */
export function extractTableSourceParts(src: string): TableSourceParts | null {
  let at = 0;
  let call = -1;
  while ((at = src.indexOf('table(', at)) >= 0) {
    const prev = src[at - 1] ?? '';
    if (!/[\w.]/.test(prev)) {
      call = at;
      break;
    }
    at += 'table('.length;
  }
  if (call < 0) return null;
  const open = call + 'table'.length;
  const close = matchParen(src, open);
  if (close < 0) return null;
  const top = splitTopArgs(src.slice(open + 1, close));
  if (!top.length) return null;
  return {
    args: top.filter((arg) => !CELL_ARG_RE.test(arg)),
    rows: top.filter((arg) => CELL_ARG_RE.test(arg)),
  };
}

/** Table cells are a lossless paragraph-only subset of the broader schema. */
function parseTableCellContent(content: string): PMNode[] | null {
  const trimmed = content.trim();
  if (!trimmed) return [schema.nodes.paragraph.create()];
  const chunks = trimmed.split(/\n[ \t]*\n/);
  const paragraphs: PMNode[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const first = lines[0]?.trim() ?? '';
    if (/^(?:```|={1,3}\s|[-+]\s|#(?:pagebreak|line|quote|align|block)\b)/.test(first)) return null;
    if (
      first === '// typeset:empty-table-paragraph' &&
      lines.slice(1).every((line) => !line.trim() || line.trim() === '~')
    ) {
      paragraphs.push(schema.nodes.paragraph.create());
      continue;
    }
    paragraphs.push(schema.nodes.paragraph.create(null, parseParagraph(lines)));
  }
  return paragraphs.length ? paragraphs : [schema.nodes.paragraph.create()];
}

/**
 * Parse our emitted #table form into a table node; null if unrecognized
 * (the caller preserves the source verbatim as a raw island). Named
 * arguments we don't model are kept on the table (full-control escape
 * hatch) and re-emitted verbatim.
 */
export function parseTable(src: string): PMNode | null {
  const open = src.indexOf('(');
  if (open < 0) return null;
  const close = matchParen(src, open);
  if (close < 0) return null;

  const args = splitTopArgs(src.slice(open + 1, close));
  let columns = 0;
  let strokeNone = false;
  let alignTuple: string | null = null;
  let hlines = 0;
  const userHlines: string[] = [];
  const customParams: string[] = [];
  const cells: ParsedCell[] = [];

  for (const arg of args) {
    if (/^columns\s*:/.test(arg)) {
      const num = /^columns\s*:\s*(\d+)$/.exec(arg);
      if (num) {
        columns = parseInt(num[1], 10);
      } else {
        const tup = /^columns\s*:\s*\((.*)\)$/s.exec(arg);
        if (!tup) return null;
        columns = splitTopArgs(tup[1]).length;
        customParams.push(arg); // non-numeric column spec round-trips verbatim
      }
    } else if (/^align\s*:/.test(arg)) {
      const tup = /^align\s*:\s*\(([^)]*)\)$/.exec(arg);
      const vals = tup ? tup[1].split(',').map((s) => s.trim()) : null;
      if (vals && vals.every((v) => ['left', 'center', 'right', 'auto'].includes(v))) alignTuple = tup![1];
      else customParams.push(arg);
    } else if (/^stroke\s*:\s*none$/.test(arg)) {
      strokeNone = true;
    } else if (arg.startsWith('table.hline(')) {
      // Explicit-position rules (y:) are user midrules — carried in params;
      // bare rules are the style preset's own.
      if (/[(,]\s*y\s*:/.test(arg)) userHlines.push(arg);
      else hlines++;
    } else if (arg.startsWith('table.vline(')) {
      // Column rules with an explicit position round-trip via params.
      if (/[(,]\s*x\s*:/.test(arg)) userHlines.push(arg);
      else return null;
    } else if (arg.startsWith('table.header(')) {
      const hEnd = arg.lastIndexOf(')');
      if (hEnd < 0) return null;
      for (const inner of splitTopArgs(arg.slice('table.header('.length, hEnd))) {
        const cell = parseCellArg(inner, true);
        if (!cell) return null;
        cells.push(cell);
      }
    } else if (arg.startsWith('[') || arg.startsWith('table.cell(')) {
      const cell = parseCellArg(arg, false);
      if (!cell) return null;
      cells.push(cell);
    } else if (/^[a-zA-Z_][\w.-]*\s*:/.test(arg)) {
      customParams.push(arg); // unknown named arg → full-control passthrough
    } else {
      return null; // unknown positional construct (vline, …) → raw island
    }
  }

  if (
    !(columns > 0) ||
    columns > INPUT_LIMITS.importedTableColumns ||
    !cells.length ||
    cells.length > INPUT_LIMITS.importedTableCells ||
    cells.some((cell) =>
      cell.colspan < 1 ||
      cell.colspan > INPUT_LIMITS.importedTableSpan ||
      cell.rowspan < 1 ||
      cell.rowspan > INPUT_LIMITS.importedTableSpan
    )
  ) return null;
  const hasHeader = cells.some((c) => c.header);

  // Style detection with fidelity guards: nonstandard rule layouts can't be
  // reconstructed from presets, so those tables stay raw. Custom params are
  // additive and coexist with presets.
  let style = 'grid';
  if (strokeNone) {
    style = hlines ? 'booktabs' : 'plain';
  } else if (hlines > 0) {
    return null;
  } else if (customParams.some((a) => /^stroke\s*:/.test(a))) {
    // A custom stroke without preset markers: keep style neutral.
    style = 'plain';
  }
  const params = [...customParams, ...userHlines].join(',\n');

  const colAligns: Array<string | null> = new Array(columns).fill(null);
  if (alignTuple) {
    alignTuple.split(',').forEach((a, i) => {
      const v = a.trim();
      if (i < columns && (v === 'left' || v === 'center' || v === 'right')) colAligns[i] = v;
    });
  }

  // Chunk the flat cell list into rows, honoring col/rowspans.
  const { table, table_row, table_cell, table_header } = schema.nodes;
  const rows: PMNode[] = [];
  const pending = new Array<number>(columns).fill(0); // rows still occupied by rowspans
  let idx = 0;
  while (idx < cells.length) {
    const rowCells: PMNode[] = [];
    let col = 0;
    while (col < columns) {
      if (pending[col] > 0) {
        pending[col]--;
        col++;
        continue;
      }
      const c = cells[idx++];
      if (!c) break;
      const type = c.header ? table_header : table_cell;
      const content = parseTableCellContent(c.content);
      if (!content) return null;
      rowCells.push(
        type.create({ colspan: c.colspan, rowspan: c.rowspan, align: c.align ?? colAligns[col] }, content),
      );
      for (let k = col; k < Math.min(columns, col + c.colspan); k++) {
        if (c.rowspan > 1) pending[k] += c.rowspan - 1;
      }
      col += c.colspan;
    }
    if (rowCells.length) {
      rows.push(table_row.create(null, rowCells));
    } else {
      // The flat Typst stream can advance through a row fully occupied by a
      // prior rowspan; this subset has no lossless delimiter for that row.
      return null;
    }
  }
  if (!rows.length || idx !== cells.length || pending.some((remaining) => remaining > 0)) return null;
  // Booktabs fidelity: the bare positional rules must be exactly the
  // preset's own — top, bottom, and the header midrule — minus any the
  // user replaced with an explicit y: rule at that boundary.
  if (style === 'booktabs') {
    // Only FULL-width rules replace a preset rule; partial rules (with a
    // start/end range) coexist with it.
    const replaced = new Set(
      userHlines
        .filter((r) => r.startsWith('table.hline(') && !/[(,]\s*(?:start|end)\s*:/.test(r))
        .map((r) => +(/y\s*:\s*(\d+)/.exec(r)?.[1] ?? -1)),
    );
    const expected =
      (replaced.has(0) ? 0 : 1) +
      (replaced.has(rows.length) ? 0 : 1) +
      (hasHeader && !replaced.has(1) ? 1 : 0);
    if (hlines !== expected) return null;
  }
  try {
    return table.create({ style, params }, rows);
  } catch {
    return null;
  }
}

/** Index of the `]` matching the `[` at `open`, honoring Typst literals. */
function matchBracket(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '"' || c === '`') {
      j = quotedEnd(src, j);
      continue;
    }
    if (c === '/' && src[j + 1] === '/') {
      const nl = src.indexOf('\n', j + 2);
      if (nl < 0) return -1;
      j = nl;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Find the next unescaped occurrence of `ch` at or after `from`. */
function findClose(src: string, from: number, ch: string): number {
  for (let j = from; j < src.length; j++) {
    if (src[j] === '\\') {
      j++;
      continue;
    }
    if (src[j] === ch) return j;
  }
  return -1;
}

/**
 * Length of the Typst code expression starting at `start` (a '#'), or 0 if
 * what follows isn't one. Covers `#name`, `#name(args)`, `#name[body]`, and
 * chains of them, counting nested delimiters so inner parens/brackets come
 * along. The identifier must start with a LETTER: "#3" in prose is text.
 */
function typstExprLength(src: string, start: number): number {
  let i = start + 1;
  if (!/[A-Za-z]/.test(src[i] ?? '')) return 0;
  while (i < src.length && /[A-Za-z0-9_.-]/.test(src[i])) i++;
  // A trailing '.' or '-' belongs to the sentence, not the identifier.
  while (i > start + 1 && /[.-]/.test(src[i - 1])) i--;
  for (;;) {
    const open = src[i];
    if (open !== '(' && open !== '[') break;
    const close = open === '(' ? ')' : ']';
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      if (src[j] === '\\') {
        j++;
        continue;
      }
      if (src[j] === open) depth++;
      else if (src[j] === close) {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return 0; // unbalanced — not an expression we can trust
    i = j + 1;
  }
  return i - start;
}

function scanInline(src: string, marks: Mark[], out: PMNode[]) {
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) {
      // Typst collapses consecutive markup spaces to one; the document
      // must hold what actually prints, or the breaker and the compiled
      // truth lay out different text and fight forever. Mixed nbsp+space
      // runs (browser artifacts round-tripped as "~ ~") collapse too;
      // pure nbsp runs are intentional glue.
      out.push(schema.text(buf.replace(/[ \u00a0]{2,}/g, (run) => (run.includes(' ') ? ' ' : run)), marks));
      buf = '';
    }
  };

  while (i < src.length) {
    const ch = src[i];

    // Typst's ~ is a non-breaking space.
    if (ch === '~') {
      buf += '\u00a0';
      i++;
      continue;
    }
    // Typst dash shorthands (unescaped): --- em, -- en, and a hyphen
    // before a digit after whitespace prints as a minus sign. The
    // document holds the printed characters.
    if (ch === '-') {
      if (src.startsWith('---', i)) {
        buf += '\u2014';
        i += 3;
        continue;
      }
      if (src.startsWith('--', i)) {
        buf += '\u2013';
        i += 2;
        continue;
      }
      const prev = buf ? buf[buf.length - 1] : ' ';
      if (/\d/.test(src[i + 1] ?? '') && /\s/.test(prev)) {
        buf += '\u2212';
        i++;
        continue;
      }
    }
    if (ch === '\\' && i + 1 < src.length) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (src.startsWith('(#ref(<', i) || src.startsWith('#ref(<', i)) {
      const re = src[i] === '('
        ? /^\(#ref\(<([^>]+)>,\s*supplement:\s*none\)\)/
        : /^#ref\(<([^>]+)>,\s*supplement:\s*none\)/;
      const m = re.exec(src.slice(i));
      if (m) {
        flush();
        out.push(schema.nodes.eq_ref.create({ label: m[1] }));
        i += m[0].length;
        continue;
      }
    }
    if (src.startsWith('#footnote[', i)) {
      const open = i + '#footnote'.length;
      const end = matchBracket(src, open);
      if (end > 0) {
        flush();
        trimSpaceBeforeMarker(out);
        out.push(schema.nodes.footnote.create(null, parseInline(src.slice(open + 1, end))));
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith('#strike[', i)) {
      const open = i + '#strike'.length;
      const end = matchBracket(src, open);
      if (end > 0) {
        flush();
        scanInline(src.slice(open + 1, end), [...marks, schema.marks.strike.create()], out);
        i = end + 1;
        continue;
      }
    }
    const safeMath = parseRawMathCall(src, i);
    if (safeMath) {
      flush();
      out.push(schema.nodes.math_inline.create({ src: safeMath.src }));
      i = safeMath.end;
      continue;
    }
    // Legacy inline math remains supported for existing Plass documents.
    if (src.startsWith('#mi(`', i)) {
      const end = src.indexOf('`)', i + 5);
      if (end >= 0) {
        flush();
        out.push(schema.nodes.math_inline.create({ src: src.slice(i + 5, end) }));
        i = end + 2;
        continue;
      }
    }
    if (src.startsWith('#image("', i)) {
      const end = src.indexOf('")', i + 8);
      if (end >= 0) {
        flush();
        out.push(schema.nodes.image.create({ src: src.slice(i + 8, end) }));
        i = end + 2;
        continue;
      }
    }
    // A certified code-marked table cell containing a literal backtick uses
    // the unambiguous inline raw string form.
    if (src.startsWith('#raw("', i)) {
      const quote = i + '#raw('.length;
      const end = quotedEnd(src, quote);
      const suffix = /^,\s*block:\s*false\)/.exec(src.slice(end + 1));
      if (end > quote && suffix) {
        try {
          const value = JSON.parse(src.slice(quote, end + 1)) as unknown;
          if (typeof value === 'string') {
            flush();
            out.push(schema.text(value, [...marks, schema.marks.code.create()]));
            i = end + 1 + suffix[0].length;
            continue;
          }
        } catch {
          // Let the generic raw-Typst preservation path handle malformed calls.
        }
      }
    }
    if (ch === '@') {
      const m = /^@([a-zA-Z0-9:._-]+)/.exec(src.slice(i));
      if (m) {
        // Typst-style: a trailing period/colon belongs to the sentence.
        const label = m[1].replace(/[.:]+$/, '');
        if (label) {
          flush();
          out.push(
            importBibKeys.has(label)
              ? schema.nodes.citation.create({ key: label })
              : schema.nodes.eq_ref.create({ label }),
          );
          i += 1 + label.length;
          continue;
        }
      }
    }
    // Generic inline raw Typst — anything the specific handlers above
    // didn't claim. Plain-text '#' is escaped on export, so an unescaped
    // one here is genuinely code (in imported files too).
    if (ch === '#') {
      const len = typstExprLength(src, i);
      if (len > 0) {
        flush();
        out.push(schema.nodes.typst_inline.create({ src: src.slice(i, i + len) }));
        i += len;
        continue;
      }
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push(schema.text(src.slice(i + 1, end), [...marks, schema.marks.code.create()]));
        i = end + 1;
        continue;
      }
    }
    if (ch === '$') {
      const end = findClose(src, i + 1, '$');
      if (end > i + 1) {
        flush();
        out.push(schema.nodes.math_inline.create({ src: src.slice(i + 1, end) }));
        i = end + 1;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      const end = findClose(src, i + 1, ch);
      if (end > i + 1) {
        flush();
        const mark = ch === '*' ? schema.marks.strong.create() : schema.marks.em.create();
        scanInline(src.slice(i + 1, end), [...marks, mark], out);
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
}
