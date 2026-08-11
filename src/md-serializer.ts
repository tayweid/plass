// PM doc -> Markdown (.md save path).
//
// The mirror of md-parser: standard CommonMark+GFM wherever the model maps
// (which is most of it — the typing syntax IS markdown), and the Plass
// escape hatches where it doesn't:
//
//   - document settings that differ from defaults ride in YAML frontmatter
//     as a `plass:` JSON object; title/author/date as standard keys
//   - raw-Typst islands stay ```typst fences; the embedded bibliography
//     becomes a ```bibtex fence at the end
//   - display math keeps its label as `$$ {#eq:name}`, citations are
//     pandoc-style [@key], references stay @tag:id
//
// Styling that markdown cannot say (table rules and fills, figure labels)
// is reported through `warn` rather than silently dropped.

import type { Node as PMNode, Mark } from 'prosemirror-model';
import { schema } from './schema';
import { DEFAULT_SETTINGS, type DocSettings } from './settings';

export function docToMd(doc: PMNode, warn: (m: string) => void = () => {}): string {
  const out: string[] = [];
  const footnotes: string[] = [];

  // ---------- frontmatter ----------
  {
    const fm: string[] = [];
    doc.forEach((n) => {
      if (n.type.name === 'doc_title' && n.textContent) fm.push(`title: "${n.textContent.replace(/"/g, '\\"')}"`);
      if (n.type.name === 'doc_authors' && n.textContent) fm.push(`author: "${n.textContent.replace(/"/g, '\\"')}"`);
      if (n.type.name === 'doc_date' && n.textContent) fm.push(`date: "${n.textContent.replace(/"/g, '\\"')}"`);
    });
    const s = doc.attrs.settings as DocSettings;
    const diff: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof DocSettings>) {
      if (JSON.stringify(s[key]) !== JSON.stringify(DEFAULT_SETTINGS[key])) diff[key] = s[key];
    }
    if (Object.keys(diff).length) fm.push(`plass: ${JSON.stringify(diff)}`);
    if (fm.length) out.push(`---\n${fm.join('\n')}\n---`);
  }

  const esc = (text: string): string =>
    text
      .replace(/([\\`*[\]$])/g, '\\$1')
      .replace(/(^|\s)_/g, '$1\\_')
      .replace(/_(?=\s|$)/g, '\\_');

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
        return inline(node);
      case 'heading':
        return `${'#'.repeat(node.attrs.level as number)} ${inline(node)}`;
      case 'math_display': {
        const label = (node.attrs.label as string) ? ` {#${node.attrs.label as string}}` : '';
        return `$$\n${node.attrs.src as string}\n$$${label}`;
      }
      case 'code_block': {
        const params = node.attrs.params as string;
        const lang = params === 'typst-raw' ? 'typst' : params;
        return `\`\`\`${lang}\n${node.textContent}\n\`\`\``;
      }
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
