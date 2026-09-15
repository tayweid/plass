// PM doc -> Markdown (.md save path).
//
// The mirror of md-parser: standard CommonMark+GFM wherever the model maps
// (which is most of it — the typing syntax IS markdown), and the Plass
// escape hatches where it doesn't:
//
//   - only the standard title/author/date keys ride in YAML frontmatter;
//     document settings are .typ territory (saving warns when non-default)
//   - raw-Typst islands stay ```typst fences; the embedded bibliography
//     becomes a ```bibtex fence at the end
//   - display math keeps its label as `$$ {#eq:name}`, citations are
//     pandoc-style [@key], references stay @tag:id
//
// Styling that markdown cannot say (table rules and fills, figure labels)
// is reported through `warn` rather than silently dropped.

import type { Node as PMNode, Mark } from 'prosemirror-model';
import { DEFAULT_SETTINGS, type DocSettings } from './settings';
import { blockToTypStandalone } from './typ-serializer';

/** Serialize to Markdown. `offsets`, when given, receives the text offset
 *  at which each top-level block's serialization begins (index = position
 *  of the block in `doc`); blocks that produce no Markdown of their own
 *  (title/author/date live in the frontmatter) get the offset of whatever
 *  follows them. Block-level caret mapping for the source view
 *  (SOURCE-VIEW.md, decision 5). */
export function docToMd(doc: PMNode, warn: (m: string) => void = () => {}, offsets?: number[]): string {
  let out: string[] = [];
  const footnotes: string[] = [];

  // ---------- frontmatter ----------
  {
    const fm: string[] = [];
    doc.forEach((n) => {
      if (n.type.name === 'doc_title' && n.textContent) fm.push(`title: "${n.textContent.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      if (n.type.name === 'doc_authors' && n.textContent) fm.push(`author: "${n.textContent.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      if (n.type.name === 'doc_date' && n.textContent) fm.push(`date: "${n.textContent.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    });
    // Frontmatter the import had no field for comes back verbatim.
    const extra = ((doc.attrs.frontmatter as string | undefined) ?? '').replace(/^\n+|\n+$/g, '');
    if (extra) fm.push(extra);
    // Markdown stays pure markdown: no app-branded metadata. Settings
    // live in .typ; saying so beats smuggling them into frontmatter.
    const s = doc.attrs.settings as DocSettings;
    if (JSON.stringify(s) !== JSON.stringify(DEFAULT_SETTINGS)) {
      warn('document settings (page, font, numbering) are not stored in Markdown — save as .typ to keep them');
    }
    if (fm.length) out.push(`---\n${fm.join('\n')}\n---`);
  }

  const esc = (text: string): string =>
    text
      .replace(/([\\`*$])/g, '\\$1')
      // Brackets only where they would read as a link, reference, footnote
      // or citation: `[note]` alone is text and stays readable.
      .replace(/\[(?=[@^])/g, '\\[')
      .replace(/\](?=[([])/g, '\\]')
      // A literal ~~ run would read back as strikethrough.
      .replace(/~(?=~)/g, '\\~')
      // Underscores: every one in a run of two or more (a blank to fill in
      // would otherwise be read as emphasis delimiters), and a lone one at
      // a word boundary; snake_case stays bare.
      .replace(/_{2,}/g, (run) => run.replace(/_/g, '\\_'))
      .replace(/(^|\s)_(?!\\)/g, '$1\\_')
      .replace(/(?<!\\)_(?=\s|$)/g, '\\_');

  const inline = (node: PMNode): string => {
    let md = '';
    // Text and inline math sharing strong/em/strike marks form one wrapped
    // run (`**$2$ drinks**`), as the .typ exporter does; other atoms close
    // the run.
    let run = '';
    let sig = '';
    const signature = (child: PMNode) =>
      ['strong', 'em', 'strike'].filter((n) => child.marks.some((m: Mark) => m.type.name === n)).join(',');
    const flush = () => {
      if (run) {
        let t = run;
        if (sig.includes('strong')) t = `**${t}**`;
        if (sig.includes('em')) t = `*${t}*`;
        if (sig.includes('strike')) t = `~~${t}~~`;
        md += t;
      }
      run = '';
    };
    node.forEach((child) => {
      if (child.isText && child.text) {
        const marks = child.marks;
        const has = (name: string) => marks.some((m: Mark) => m.type.name === name);
        const s = signature(child);
        if (s !== sig) {
          flush();
          sig = s;
        }
        let t = has('code') ? '`' + child.text + '`' : esc(child.text);
        const link = marks.find((m: Mark) => m.type.name === 'link');
        if (link) {
          const title = link.attrs.title as string | null;
          t = `[${t}](${link.attrs.href as string}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
        }
        run += t;
        return;
      }
      if (child.type.name === 'math_inline') {
        const s = signature(child);
        if (s !== sig) {
          flush();
          sig = s;
        }
        run += `$${child.attrs.src as string}$`;
        return;
      }
      flush();
      sig = '';
      switch (child.type.name) {
        // Pandoc's raw-attribute syntax: standard markdown that other
        // tools understand as "Typst-only", and round-trips here.
        case 'typst_inline':
          // Inline HTML is the file's own text; raw Typst uses pandoc's
          // raw-attribute form.
          md += child.attrs.lang === 'html' ? (child.attrs.src as string) : `\`${child.attrs.src as string}\`{=typst}`;
          break;
        case 'citation':
          md += `[@${child.attrs.key as string}]`;
          break;
        case 'eq_ref':
          md += `@${child.attrs.label as string}`;
          break;
        case 'hard_break':
          md += '\\\n';
          break;
        case 'image': {
          const src = String(child.attrs.src ?? '');
          const alt = String(child.attrs.alt ?? '').replace(/([\\\[\]])/g, '\\$1');
          const title = String(child.attrs.title ?? '');
          if (src.startsWith('data:')) warn('embedded image written as a data: URL — consider a project folder');
          if (child.attrs.widthPct != null) warn('image size is not stored in Markdown — save as .typ to keep it');
          const destination = src.replace(/([\\()\s])/g, (c) => c === ' ' ? '%20' : `\\${c}`);
          md += `![${alt}](${destination}${title ? ` "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''})`;
          break;
        }
        case 'footnote': {
          const n = footnotes.length + 1;
          footnotes.push(inline(child));
          md += `[^${n}]`;
          break;
        }
        default:
          md += esc(child.textContent);
      }
    });
    flush();
    return md;
  };

  const table = (node: PMNode): string => {
    if ((node.attrs.params as string) || (node.attrs.caption as string) || (node.attrs.label as string) || (node.attrs.density as string) || node.attrs.columnWidths || node.attrs.insetPt != null) {
      warn('table styling/captions are not representable in Markdown — simplified to a plain table');
    }
    const rows: string[][] = [];
    const aligns: Array<string | null> = [];
    node.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => {
        if (cell.attrs.valign || cell.attrs.fill) warn('table cell shading and vertical alignment are not stored in Markdown — save as .typ to keep them');
        let text = '';
        cell.forEach((p) => {
          if (text) text += ' ';
          text += inline(p);
        });
        if ((cell.attrs.colspan as number) > 1 || (cell.attrs.rowspan as number) > 1) {
          warn('merged table cells flattened for Markdown');
        }
        if (rows.length === 0 || aligns.length < cells.length + 1) aligns.push((cell.attrs.align as string) ?? null);
        cells.push(text.replace(/\|/g, '\\|'));
      });
      rows.push(cells);
    });
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r: string[]) => [...r, ...new Array(width - r.length).fill('')];
    const line = (r: string[]) => `| ${pad(r).join(' | ')} |`;
    const sep = `| ${new Array(width)
      .fill(0)
      .map((_, i) => {
        const a = aligns[i];
        return a === 'center' ? ':---:' : a === 'right' || a === 'decimal' ? '---:' : '---';
      })
      .join(' | ')} |`;
    return [line(rows[0]), sep, ...rows.slice(1).map(line)].join('\n');
  };

  const block = (node: PMNode, indent = ''): string => {
    switch (node.type.name) {
      case 'paragraph':
        if (node.attrs.align) warn('text alignment is not stored in Markdown — save as .typ to keep it');
        return inline(node);
      // (inline raw Typst rides inside inline(), as a pandoc raw attribute)
      case 'heading':
        return `${'#'.repeat(node.attrs.level as number)} ${inline(node)}`;
      case 'math_display': {
        const label = (node.attrs.label as string) ? ` {#${node.attrs.label as string}}` : '';
        return `$$\n${node.attrs.src as string}\n$$${label}`;
      }
      case 'code_block': {
        const params = node.attrs.params as string;
        // A Markdown island is the file's own text: back verbatim.
        if (params === 'md-raw') return node.textContent;
        const lang = params === 'typst-raw' ? 'typst' : params;
        return `\`\`\`${lang}\n${node.textContent}\n\`\`\``;
      }
      case 'blockquote': {
        if (node.attrs.kind === 'solution') warn('solution styling is not stored in Markdown — save as .typ to keep it');
        const inner: string[] = [];
        node.forEach((child) => inner.push(block(child, indent)));
        return inner.join('\n>\n').replace(/^/gm, '> ');
      }
      case 'abstract': {
        const inner: string[] = [];
        node.forEach((child, _o, i) => inner.push((i === 0 ? '**Abstract.** ' : '') + block(child, indent)));
        return inner.join('\n>\n').replace(/^/gm, '> ');
      }
      case 'bullet_list':
      case 'ordered_list': {
        const ordered = node.type.name === 'ordered_list';
        const start = (node.attrs.order as number) || 1;
        const items: string[] = [];
        node.forEach((item, _o, i) => {
          const marker = ordered ? `${start + i}. ` : '- ';
          const hang = ' '.repeat(marker.length);
          const inner: string[] = [];
          item.forEach((child) => inner.push(block(child, indent + hang)));
          // Every line after the first hangs under the marker; the blank
          // line between an item's blocks stays blank.
          items.push(marker + inner.join('\n\n').replace(/\n(?!\n)/g, `\n${hang}`));
        });
        // A loose list keeps the blank lines between its items.
        return items.join(node.attrs.tight === false ? '\n\n' : '\n');
      }
      case 'figure': {
        const src = node.attrs.src as string;
        if (src.startsWith('data:')) warn('embedded figure written as a data: URL — consider a project folder');
        if (node.attrs.label as string) warn(`figure label @${node.attrs.label as string} is not representable in Markdown`);
        if (node.attrs.widthPct != null) warn('image size is not stored in Markdown — save as .typ to keep it');
        const title = node.attrs.title as string;
        return `![${inline(node)}](${src}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
      }
      case 'table':
        return table(node);
      case 'grid':
        // Markdown has no grid: the Typst call, in a fence the importer
        // reads back as the native block.
        return '```typst\n' + blockToTypStandalone(node, doc).trimEnd() + '\n```';
      case 'horizontal_rule':
        return '---';
      case 'page_break':
        return '```typst\n#pagebreak()\n```';
      case 'numbering_restart':
        return '```typst\n#pagebreak()\n#set page(numbering: "1")\n#counter(page).update(1)\n```';
      case 'bibliography':
        return ''; // regenerated from the bibtex fence below
      case 'doc_title':
      case 'doc_authors':
      case 'doc_date':
        return ''; // frontmatter
      default:
        warn(`"${node.type.name}" has no Markdown form — kept as Typst`);
        return '```typst\n// unsupported block\n```';
    }
  };

  // Chunks join with a blank line between them — one newline where a
  // Markdown island was tight against its neighbour in the file. A block's
  // offset is where its chunk starts in that joined text, counted the same
  // way the final join lays it out, so the two cannot drift.
  const blockChunks: Array<{ text: string; sepBefore: string }> = [];
  let prevTightAfter = false;
  doc.forEach((node) => {
    const text = block(node);
    const island = node.type.name === 'code_block' && node.attrs.params === 'md-raw';
    const tight = island ? (node.attrs.tight as string) : '';
    const tightBefore = tight === 'before' || tight === 'both';
    blockChunks.push({ text, sepBefore: tightBefore || prevTightAfter ? '\n' : '\n\n' });
    prevTightAfter = island && (tight === 'after' || tight === 'both');
  });
  let body = out.join('\n\n');
  let pos = body.length;
  let emitted = body.length > 0;
  const starts: number[] = [];
  for (const chunk of blockChunks) {
    const start = emitted ? pos + chunk.sepBefore.length : pos;
    starts.push(start);
    if (chunk.text) {
      body += (emitted ? chunk.sepBefore : '') + chunk.text;
      pos = start + chunk.text.length;
      emitted = true;
    }
  }
  if (offsets) {
    offsets.length = 0;
    offsets.push(...starts);
  }
  out = [body];

  if (footnotes.length) {
    out.push(footnotes.map((f, i) => `[^${i + 1}]: ${f}`).join('\n'));
  }

  const bib = doc.attrs.bib as { name: string; content: string } | null;
  if (bib?.content) out.push('```bibtex\n' + bib.content.trim() + '\n```');

  return out.filter(Boolean).join('\n\n') + '\n';
}
