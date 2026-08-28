// PM doc -> Markdown (.md save path).
//
// The mirror of md-parser: standard CommonMark+GFM wherever the model maps
// (which is most of it — the typing syntax IS markdown), and the Plass
// escape hatches where it doesn't:
//
//   - only the standard title/author/date keys ride in YAML frontmatter;
//     document settings are .typ territory (saving warns when non-default)
//   - executable Typst uses the explicit ```typst-exec fence; ordinary
//     ```typst remains ordinary code. The embedded bibliography becomes a
//     ```bibtex fence at the end
//   - display math keeps its label as `$$ {#eq:name}`, citations are
//     pandoc-style [@key], references stay @tag:id
//
// Styling that markdown cannot say (table rules and fills, figure labels)
// is reported through `warn` rather than silently dropped.

import type { Node as PMNode, Mark } from 'prosemirror-model';
import { DEFAULT_SETTINGS, type DocSettings } from './settings';
import { isLegacyTypstRawBlock } from './schema';

export function docToMd(doc: PMNode, warn: (m: string) => void = () => {}): string {
  const out: string[] = [];
  const footnotes: string[] = [];

  // ---------- frontmatter ----------
  {
    const fm: string[] = [];
    doc.forEach((n) => {
      if (n.type.name === 'doc_title' && n.textContent) fm.push(`title: "${n.textContent.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      if (n.type.name === 'doc_authors' && n.textContent) fm.push(`author: "${n.textContent.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      if (n.type.name === 'doc_date' && n.textContent) fm.push(`date: "${n.textContent.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    });
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
      .replace(/([\\`*[\]$])/g, '\\$1')
      // A literal ~~ run would read back as strikethrough.
      .replace(/~(?=~)/g, '\\~')
      .replace(/(^|\s)_/g, '$1\\_')
      .replace(/_(?=\s|$)/g, '\\_');

  // Use a fence longer than any run in the source. This makes executable
  // embeds (and ordinary code) lossless even when their literal text contains
  // a triple-backtick fence of its own.
  const fenced = (info: string, source: string): string => {
    const longest = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}${info}\n${source}\n${fence}`;
  };

  const inline = (node: PMNode): string => {
    let md = '';
    node.forEach((child) => {
      if (child.isText && child.text) {
        let t = '';
        const marks = child.marks;
        const has = (name: string) => marks.some((m: Mark) => m.type.name === name);
        if (has('code')) t = '`' + child.text + '`';
        else {
          t = esc(child.text);
          if (has('strong')) t = `**${t}**`;
          if (has('em')) t = `*${t}*`;
          if (has('strike')) t = `~~${t}~~`;
        }
        const link = marks.find((m: Mark) => m.type.name === 'link');
        if (link) t = `[${t}](${link.attrs.href as string})`;
        md += t;
        return;
      }
      switch (child.type.name) {
        case 'math_inline':
          md += `$${child.attrs.src as string}$`;
          break;
        // Pandoc's raw-attribute syntax: standard markdown that other
        // tools understand as "Typst-only", and round-trips here.
        case 'typst_inline':
          md += `\`${child.attrs.src as string}\`{=typst}`;
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
    return md;
  };

  const table = (node: PMNode): string => {
    if ((node.attrs.params as string) || (node.attrs.caption as string) || (node.attrs.label as string)) {
      warn('table styling/captions are not representable in Markdown — simplified to a plain table');
    }
    const rows: string[][] = [];
    const aligns: Array<string | null> = [];
    node.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => {
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
        // Old persisted documents can be exported before the startup plugin
        // runs. Preserve their exact executable intent using the new explicit
        // representation; never broaden ordinary `typst` language fences.
        return fenced(isLegacyTypstRawBlock(node) ? 'typst-exec' : params, node.textContent);
      }
      case 'typst_embed':
        return fenced('typst-exec', node.textContent);
      case 'blockquote': {
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
          items.push(marker + inner.join(`\n\n${hang}`).replace(/\n(?!\n)/g, `\n${hang}`));
        });
        return items.join('\n');
      }
      case 'figure': {
        const src = node.attrs.src as string;
        if (src.startsWith('data:')) warn('embedded figure written as a data: URL — consider a project folder');
        if (node.attrs.label as string) warn(`figure label @${node.attrs.label as string} is not representable in Markdown`);
        return `![${inline(node)}](${src})`;
      }
      case 'table':
        return table(node);
      case 'horizontal_rule':
        return '---';
      case 'page_break':
        return fenced('typst-exec', '#pagebreak()');
      case 'numbering_restart':
        return fenced('typst-exec', '#pagebreak()\n#set page(numbering: "1")\n#counter(page).update(1)');
      case 'bibliography':
        return ''; // regenerated from the bibtex fence below
      case 'doc_title':
      case 'doc_authors':
      case 'doc_date':
        return ''; // frontmatter
      default:
        warn(`"${node.type.name}" has no Markdown form — kept as Typst`);
        return fenced('typst-exec', '// unsupported block');
    }
  };

  doc.forEach((node) => {
    const text = block(node);
    if (text) out.push(text);
  });

  if (footnotes.length) {
    out.push(footnotes.map((f, i) => `[^${i + 1}]: ${f}`).join('\n'));
  }

  const bib = doc.attrs.bib as { name: string; content: string } | null;
  if (bib?.content) out.push('```bibtex\n' + bib.content.trim() + '\n```');

  return out.filter(Boolean).join('\n\n') + '\n';
}
