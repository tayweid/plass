// Native structured table editing.
//
// A table has exactly one editable representation: its ProseMirror rows,
// cells, paragraphs, and inline content. The old spreadsheet card copied
// cells into a parallel string grid and compiled a second visual table; that
// made ordinary typing modal and could flatten rich cell content on save.

import type { Node as PMNode, ResolvedPos } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import {
  CellSelection,
  TableMap,
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  mergeCells,
  selectedRect,
  setCellAttr,
  splitCell,
  toggleHeaderRow,
} from 'prosemirror-tables';
import { isHistoryTransaction, redo, undo } from 'prosemirror-history';
import { isPortableCitationKey } from './bibtex';
import { schema } from './schema';
import {
  transactionChangesDerivedStructure,
  type DerivedStructureRules,
} from './transaction-impact';

interface TableContext { pos: number; node: PMNode }

function tableContext(state: Pick<EditorState, 'selection'>): TableContext | null {
  const $pos = state.selection.$anchor;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.spec.tableRole === 'table') return { pos: $pos.before(depth), node };
  }
  return null;
}

function dispatchTableAttrs(view: EditorView, attrs: Record<string, unknown>): boolean {
  const context = tableContext(view.state);
  if (!context) return false;
  view.dispatch(view.state.tr.setNodeMarkup(context.pos, undefined, { ...context.node.attrs, ...attrs }).scrollIntoView());
  return true;
}

export function setTableStyle(style: 'booktabs' | 'grid' | 'plain'): Command {
  return (state, dispatch) => {
    const context = tableContext(state);
    if (!context) return false;
    if (dispatch && context.node.attrs.style !== style) {
      dispatch(state.tr.setNodeMarkup(context.pos, undefined, { ...context.node.attrs, style }));
    }
    return true;
  };
}

export function alignSelectedTableCells(align: 'left' | 'center' | 'right' | null): Command {
  return setCellAttr('align', align);
}

/** Put a native caret in the table at a document position. */
export function focusTable(view: EditorView, pos: number): void {
  const table = view.state.doc.nodeAt(pos);
  if (!table || table.type.spec.tableRole !== 'table') return;
  const firstCell = TableMap.get(table).map[0];
  if (firstCell === undefined) return;
  const cellPos = pos + 1 + firstCell;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(cellPos + 1), 1)).scrollIntoView());
  view.focus();
}

/** Insert a 3 x 3 semantic table and start typing directly in its first cell. */
export function insertStructuredTable(view: EditorView): void {
  const { table, table_row, table_cell, table_header, paragraph } = schema.nodes;
  const cell = (header: boolean, text = '') => (header ? table_header : table_cell).create(
    null,
    paragraph.create(null, text ? schema.text(text) : undefined),
  );
  const node = table.create({ style: 'booktabs' }, [
    table_row.create(null, [cell(true, 'Column 1'), cell(true, 'Column 2'), cell(true, 'Column 3')]),
    table_row.create(null, [cell(false), cell(false), cell(false)]),
    table_row.create(null, [cell(false), cell(false), cell(false)]),
  ]);
  const { $from } = view.state.selection;
  const insertPos = $from.depth > 0 ? $from.after(1) : view.state.selection.to;
  const tr = view.state.tr.insert(insertPos, node);
  const inserted = tr.doc.nodeAt(insertPos);
  if (!inserted) return;
  const firstCell = TableMap.get(inserted).map[0];
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1 + firstCell + 1), 1));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

// The editor enforces the same lossless subset as the Typst serializer.
const TABLE_CELL_MARKS = new Set(['strong', 'em', 'strike', 'code']);
const TABLE_CELL_INLINE = new Set(['text', 'hard_break', 'math_inline', 'eq_ref', 'citation']);

const tableIssueCache = new WeakMap<PMNode, string | null>();

function tableCellIssue(table: PMNode): string | null {
  const cached = tableIssueCache.get(table);
  if (cached !== undefined || tableIssueCache.has(table)) return cached ?? null;
  let issue: string | null = null;
  table.descendants((node) => {
    if (issue) return false;
    if (node.type.spec.tableRole !== 'cell' && node.type.spec.tableRole !== 'header_cell') return true;
    node.forEach((block) => {
      if (issue) return;
      if (block.type.name !== 'paragraph') {
        issue = `${block.type.name} blocks are not losslessly supported in table cells`;
        return;
      }
      if (block.attrs.keep || block.attrs.align) {
        issue = 'paragraph layout attributes are not losslessly supported in table cells';
        return;
      }
      block.descendants((inline) => {
        if (issue) return false;
        if (!TABLE_CELL_INLINE.has(inline.type.name)) {
          issue = `${inline.type.name} is not losslessly supported inside table cells`;
          return false;
        }
        const marks = inline.marks.map((mark) => mark.type.name);
        const unsupported = marks.find((mark) => !TABLE_CELL_MARKS.has(mark));
        if (unsupported) {
          issue = `${unsupported} marks are not losslessly supported inside table cells`;
          return false;
        }
        if (!inline.isText && marks.length) {
          issue = `marks on ${inline.type.name} are not losslessly supported inside table cells`;
          return false;
        }
        if (marks.includes('code') && marks.length > 1) {
          issue = 'code combined with another mark is not losslessly supported inside table cells';
          return false;
        }
        const source = inline.isText ? inline.text ?? '' : inline.type.name === 'math_inline' ? String(inline.attrs.src ?? '') : '';
        if (/[\r\n]/.test(source)) {
          issue = 'multiline inline content is not losslessly supported inside table cells';
          return false;
        }
        if (inline.type.name === 'citation') {
          const key = String(inline.attrs.key ?? '');
          if (!isPortableCitationKey(key)) {
            issue = `citation ${JSON.stringify(key)} is not portable Typst syntax`;
            return false;
          }
        }
        return true;
      });
    });
    return false;
  });
  tableIssueCache.set(table, issue);
  return issue;
}

let noticeTimer = 0;
function announceTableConstraint(issue: string): void {
  if (typeof document === 'undefined') return;
  document.querySelector('.native-table-notice')?.remove();
  const notice = document.createElement('div');
  notice.className = 'native-table-notice';
  notice.setAttribute('role', 'status');
  notice.textContent = `${issue}. The edit was not applied, so table export remains lossless.`;
  document.body.appendChild(notice);
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => notice.remove(), 4200);
}

function tablesTouchedBy(transaction: Transaction): Map<PMNode, number> {
  const touched = new Map<PMNode, number>();
  const size = transaction.doc.content.size;
  transaction.mapping.maps.forEach((stepMap, index) => {
    stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      // Map early-step coordinates through the remaining steps so the range
      // addresses the transaction's final document.
      const rest = transaction.mapping.slice(index + 1);
      const mappedStart = rest.map(newStart, -1);
      const mappedEnd = rest.map(newEnd, 1);
      const from = Math.max(0, Math.min(mappedStart, mappedEnd) - 1);
      const to = Math.min(size, Math.max(mappedStart, mappedEnd) + 1);
      if (to < from) return;
      transaction.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.spec.tableRole === 'table') {
          touched.set(node, pos);
          return false;
        }
        return true;
      });
    });
  });
  // Attribute-only and selection-preserving structural commands can expose a
  // zero-width map. The selected table is the exact cheap fallback target.
  const selected = tableContext({ selection: transaction.selection });
  if (selected) touched.set(selected.node, selected.pos);
  return touched;
}

function keepsUnsupportedTablesVerbatim(before: PMNode, transaction: Transaction): { ok: boolean; issue?: string } {
  // An undo/redo transaction can legitimately reinsert an unsupported legacy
  // table that was already part of this editor session. Such content never
  // entered history through this guard (the introducing edit would have been
  // rejected), so restoring it is safe and must not make undo lie about
  // succeeding while leaving the document changed.
  if (isHistoryTransaction(transaction)) return { ok: true };
  const changedUnsupported: Array<{ node: PMNode; issue: string }> = [];
  for (const table of tablesTouchedBy(transaction).keys()) {
    const issue = tableCellIssue(table);
    if (issue) changedUnsupported.push({ node: table, issue });
  }
  if (!changedUnsupported.length) return { ok: true };

  // Slow path only for a transaction that actually contains unsupported cell
  // content. Unchanged legacy tables retain node identity and may be moved or
  // deleted; a newly introduced or edited unsupported table is rejected.
  const priorTables = new Set<PMNode>();
  before.descendants((node) => {
    if (node.type.spec.tableRole === 'table') {
      priorTables.add(node);
      return false;
    }
    return true;
  });
  const changed = changedUnsupported.find(({ node }) => !priorTables.has(node));
  return changed ? { ok: false, issue: changed.issue } : { ok: true };
}

interface NativeTablePluginState {
  decorations: DecorationSet;
  /** Changes only when controls-relevant metadata or topology changes. */
  controlsRevision: number;
}

const tableControlsKey = new PluginKey<NativeTablePluginState>('native-table-controls');

// Table text is intentionally absent. A character edit leaves every command,
// select, and metadata field unchanged, so the plugin view can retain its
// semantic UI and defer only a possible geometry adjustment. Structural
// commands and table metadata remain explicit, transaction-local revisions.
const TABLE_CONTROL_STRUCTURE: DerivedStructureRules = {
  table: {
    attrs: ['style', 'params', 'caption', 'label', 'fontSize'],
    structure: {
      table_row: [],
      table_cell: ['colspan', 'rowspan', 'colwidth', 'align'],
      table_header: ['colspan', 'rowspan', 'colwidth', 'align'],
    },
  },
};

interface CaptionDecorationSpec {
  nativeTableCaptionWidget: true;
  id: string;
  caption: string;
  label: string;
  number: number;
}

interface CaptionOwnerDecorationSpec {
  nativeTableCaptionOwner: true;
  id: string;
}

let nextTableCaptionId = 1;

function captionWidget(pos: number, caption: string, label: string, number: number, id: string): Decoration {
  const text = caption ? `Table ${number}: ${caption}` : `Table ${number}`;
  const spec: CaptionDecorationSpec = { nativeTableCaptionWidget: true, id, caption, label, number };
  return Decoration.widget(pos, () => {
    const element = document.createElement('div');
    element.className = 'native-table-caption';
    element.id = id;
    element.setAttribute('role', 'note');
    element.contentEditable = 'false';
    element.textContent = text;
    return element;
  }, { side: -1, key: `table-caption-${id}-${text}`, ...spec });
}

function captionDecorationPair(
  pos: number,
  table: PMNode,
  caption: string,
  label: string,
  number: number,
  id = `native-table-caption-${nextTableCaptionId++}`,
): Decoration[] {
  const end = pos + table.nodeSize;
  const owner: CaptionOwnerDecorationSpec = { nativeTableCaptionOwner: true, id };
  return [
    Decoration.node(pos, end, { 'aria-describedby': id }, owner),
    captionWidget(end, caption, label, number, id),
  ];
}

function captionDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  let tableNumber = 0;
  doc.descendants((node, pos) => {
    if (node.type.spec.tableRole !== 'table') return true;
    const caption = String(node.attrs.caption ?? '');
    const label = String(node.attrs.label ?? '');
    if (caption || label) {
      tableNumber++;
      decorations.push(...captionDecorationPair(pos, node, caption, label, tableNumber));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function tableNumberAt(doc: PMNode, targetPos: number): number {
  let number = 0;
  doc.descendants((node, pos) => {
    if (pos > targetPos) return false;
    if (node.type.spec.tableRole !== 'table') return true;
    if (node.attrs.caption || node.attrs.label) number++;
    return false;
  });
  return number;
}

function updateCaptionDecorations(
  transaction: Transaction,
  decorations: DecorationSet,
  oldState: EditorState,
  newState: EditorState,
): DecorationSet {
  let mapped = decorations.map(transaction.mapping, transaction.doc);
  const before = tableContext(oldState);
  const after = tableContext({ selection: transaction.selection });
  const touched = tablesTouchedBy(transaction);
  const beforeCaptioned = before && (before.node.attrs.caption || before.node.attrs.label) ? 1 : 0;
  const afterCaptioned = [...touched.keys()].filter((node) => node.attrs.caption || node.attrs.label).length;

  // Adding/removing a numbered table changes every later table number. Those
  // metadata/structure operations are rare, so rebuild then; ordinary typing
  // only maps and checks the one touched table instead of scanning the doc.
  if (beforeCaptioned !== afterCaptioned || (beforeCaptioned && !after) || touched.size > 1) {
    return captionDecorations(newState.doc);
  }

  for (const [table, pos] of touched) {
    const end = pos + table.nodeSize;
    const caption = String(table.attrs.caption ?? '');
    const label = String(table.attrs.label ?? '');
    const existing = mapped.find(
      Math.max(0, end - 1),
      Math.min(newState.doc.content.size, end + 1),
      (spec) => (spec as Partial<CaptionDecorationSpec>).nativeTableCaptionWidget === true,
    );
    const current = existing[0]?.spec as Partial<CaptionDecorationSpec> | undefined;
    if (current?.caption === caption && current.label === label) continue;
    if (current?.id) {
      const pair = mapped.find(
        Math.max(0, pos),
        Math.min(newState.doc.content.size, end + 1),
        (spec) =>
          (spec as Partial<CaptionDecorationSpec | CaptionOwnerDecorationSpec>).id === current.id,
      );
      if (pair.length) mapped = mapped.remove(pair);
    } else if (existing.length) {
      mapped = mapped.remove(existing);
    }
    if (caption || label) {
      const number = current?.number ?? tableNumberAt(newState.doc, pos);
      mapped = mapped.add(
        newState.doc,
        captionDecorationPair(pos, table, caption, label, number, current?.id),
      );
    }
  }
  return mapped;
}

function cellPosition($pos: ResolvedPos): number {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const role = $pos.node(depth).type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell') return $pos.before(depth);
  }
  return -1;
}

/** Selection identity at the granularity which changes table commands. A
 * caret moving while text is inserted in one cell keeps this signature; a
 * cell selection, row/column move, or table transition does not. */
function tableControlSelectionSignature(state: EditorState, context: TableContext): string {
  const selection = state.selection;
  if (selection instanceof CellSelection) {
    return `${context.pos}:cells:${selection.$anchorCell.pos}:${selection.$headCell.pos}`;
  }
  return `${context.pos}:text:${cellPosition(selection.$anchor)}:${cellPosition(selection.$head)}`;
}

type ButtonSpec = { button: HTMLButtonElement; command: Command };

class NativeTableControls {
  private readonly root: HTMLDivElement;
  private readonly styleSelect: HTMLSelectElement;
  private readonly fontSelect: HTMLSelectElement;
  private readonly captionInput: HTMLInputElement;
  private readonly labelInput: HTMLInputElement;
  private readonly advanced: HTMLSpanElement;
  private readonly commandButtons: ButtonSpec[] = [];
  private readonly alignButtons = new Map<string, HTMLButtonElement>();
  private currentTable: HTMLElement | null = null;
  private detailsOpen = false;
  private controlsRevision = -1;
  private selectionSignature = '';
  private positionFrame = 0;
  private positionAfterPaint = false;
  private positionGeneration = 0;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.root = document.createElement('div');
    this.root.className = 'native-table-toolbar';
    this.root.hidden = true;
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'Table controls');
    const main = document.createElement('div');
    main.className = 'native-table-toolbar-main';
    this.root.appendChild(main);

    const group = (label: string) => {
      const element = document.createElement('div');
      element.className = 'native-table-toolbar-group';
      element.setAttribute('role', 'group');
      element.setAttribute('aria-label', label);
      main.appendChild(element);
      return element;
    };
    const commandButton = (parent: HTMLElement, label: string, title: string, command: Command, danger = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = title;
      button.setAttribute('aria-label', title);
      if (danger) button.classList.add('is-danger');
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => this.run(command));
      parent.appendChild(button);
      this.commandButtons.push({ button, command });
      return button;
    };

    const structure = group('Rows and columns');
    commandButton(structure, '↑ Row', 'Add row above', addRowBefore);
    commandButton(structure, '↓ Row', 'Add row below', addRowAfter);
    commandButton(structure, '− Row', 'Delete selected row', deleteRow);
    commandButton(structure, '← Col', 'Add column before', addColumnBefore);
    commandButton(structure, 'Col →', 'Add column after', addColumnAfter);
    commandButton(structure, '− Col', 'Delete selected column', deleteColumn);
    const cells = group('Cells');
    commandButton(cells, 'Merge', 'Merge selected cells', mergeCells);
    commandButton(cells, 'Split', 'Split merged cell', splitCell);
    commandButton(cells, 'Header', 'Toggle selected row as header', toggleHeaderRow);
    const alignment = group('Cell alignment');
    for (const [value, label] of [['left', 'L'], ['center', 'C'], ['right', 'R']] as const) {
      const button = commandButton(alignment, label, `Align selected cells ${value}`, alignSelectedTableCells(value));
      button.classList.add('native-table-align');
      this.alignButtons.set(value, button);
    }

    const appearance = group('Table appearance');
    this.styleSelect = document.createElement('select');
    this.styleSelect.className = 'native-table-style';
    this.styleSelect.title = 'Table rule style';
    this.styleSelect.setAttribute('aria-label', 'Table rule style');
    for (const [value, label] of [['booktabs', 'Booktabs'], ['grid', 'Grid'], ['plain', 'Plain']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.styleSelect.appendChild(option);
    }
    this.styleSelect.addEventListener('change', () => this.run(setTableStyle(this.styleSelect.value as 'booktabs' | 'grid' | 'plain'), false));
    appearance.appendChild(this.styleSelect);

    this.fontSelect = document.createElement('select');
    this.fontSelect.className = 'native-table-size';
    this.fontSelect.title = 'Table text size';
    this.fontSelect.setAttribute('aria-label', 'Table text size');
    for (const [value, label] of [['', '100%'], ['0.9em', '90%'], ['0.85em', '85%'], ['0.8em', '80%'], ['0.75em', '75%']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.fontSelect.appendChild(option);
    }
    this.fontSelect.addEventListener('change', () => {
      dispatchTableAttrs(this.view, { fontSize: this.fontSelect.value });
    });
    appearance.appendChild(this.fontSelect);

    const detailsButton = document.createElement('button');
    detailsButton.type = 'button';
    detailsButton.textContent = 'Details';
    detailsButton.title = 'Caption and reference label';
    detailsButton.setAttribute('aria-expanded', 'false');
    detailsButton.addEventListener('mousedown', (event) => event.preventDefault());
    detailsButton.addEventListener('click', () => {
      this.detailsOpen = !this.detailsOpen;
      this.root.classList.toggle('show-details', this.detailsOpen);
      detailsButton.setAttribute('aria-expanded', String(this.detailsOpen));
      this.schedulePosition(false);
    });
    appearance.appendChild(detailsButton);
    commandButton(appearance, 'Delete', 'Delete table', deleteTable, true);

    const details = document.createElement('div');
    details.className = 'native-table-toolbar-details';
    this.root.appendChild(details);
    const field = (label: string, placeholder: string) => {
      const wrapper = document.createElement('label');
      const text = document.createElement('span');
      text.textContent = label;
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = placeholder;
      input.spellcheck = label === 'Caption';
      wrapper.append(text, input);
      details.appendChild(wrapper);
      return input;
    };
    this.captionInput = field('Caption', 'Optional table caption');
    this.labelInput = field('Label', 'tab:results');
    this.labelInput.maxLength = 128;
    this.labelInput.pattern = '[A-Za-z0-9][A-Za-z0-9:._-]{0,127}';
    this.labelInput.title = 'Letters and numbers, followed by letters, numbers, colon, dot, underscore, or hyphen';
    this.captionInput.addEventListener('input', () => dispatchTableAttrs(this.view, { caption: this.captionInput.value }));
    this.labelInput.addEventListener('input', () => {
      const normalized = this.labelInput.value
        .replace(/[^A-Za-z0-9:._-]/g, '-')
        .replace(/^[^A-Za-z0-9]+/, '')
        .slice(0, 128);
      if (normalized !== this.labelInput.value) this.labelInput.value = normalized;
      dispatchTableAttrs(this.view, { label: normalized });
    });
    for (const input of [this.captionInput, this.labelInput]) input.addEventListener('keydown', (event) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const isUndo = mod && key === 'z' && !event.shiftKey;
      const isRedo = mod && ((key === 'z' && event.shiftKey) || key === 'y');
      if (!isUndo && !isRedo) return;
      event.preventDefault();
      if (!this.run(isRedo ? redo : undo, false)) return;
      const context = tableContext(this.view.state);
      if (context) this.syncMetadataInputs(context, true);
    });
    this.advanced = document.createElement('span');
    this.advanced.className = 'native-table-advanced';
    this.advanced.textContent = 'Custom Typst options are exact in Proof/export; native cells show the base style';
    details.appendChild(this.advanced);

    document.body.appendChild(this.root);
    window.addEventListener('resize', this.scheduleViewportPosition);
    document.addEventListener('scroll', this.scheduleViewportPosition, true);
    this.update(view);
  }

  update = (view: EditorView, prevState?: EditorState): void => {
    const context = tableContext(view.state);
    if (!context) {
      this.currentTable = null;
      this.selectionSignature = '';
      this.controlsRevision = -1;
      this.root.hidden = true;
      return;
    }
    const pluginState = tableControlsKey.getState(view.state);
    const revision = pluginState?.controlsRevision ?? 0;
    const selectionSignature = tableControlSelectionSignature(view.state, context);
    const refreshControls =
      !this.currentTable ||
      revision !== this.controlsRevision ||
      selectionSignature !== this.selectionSignature;

    // An ordinary text transaction can change the table's rendered height,
    // but it cannot change any control semantics. Retain every control DOM
    // value and move the optional geometry read past the first text paint.
    if (!refreshControls) {
      if (prevState && prevState.doc !== view.state.doc) this.schedulePosition(true);
      return;
    }
    const dom = view.nodeDOM(context.pos);
    const element = dom instanceof HTMLElement
      ? dom.matches('table') ? dom : dom.querySelector<HTMLElement>('table')
      : dom?.parentElement?.closest<HTMLElement>('table') ?? null;
    if (!element) {
      this.root.hidden = true;
      return;
    }
    this.currentTable = element;
    this.controlsRevision = revision;
    this.selectionSignature = selectionSignature;
    this.root.hidden = false;
    this.styleSelect.value = String(context.node.attrs.style || 'booktabs');
    this.fontSelect.value = String(context.node.attrs.fontSize || '');
    this.syncMetadataInputs(context);
    this.advanced.hidden = !String(context.node.attrs.params ?? '').trim();
    for (const { button, command } of this.commandButtons) button.disabled = !command(view.state);

    let alignment: string | null = null;
    try {
      const rect = selectedRect(view.state);
      const offset = rect.map.map[rect.top * rect.map.width + rect.left];
      alignment = (rect.table.nodeAt(offset)?.attrs.align as string | null) ?? null;
    } catch { alignment = null; }
    for (const [value, button] of this.alignButtons) {
      button.disabled = false;
      button.classList.toggle('is-active', alignment === value);
      button.setAttribute('aria-pressed', String(alignment === value));
    }
    this.schedulePosition(false);
  };

  private syncMetadataInputs(context: TableContext, force = false): void {
    if (force || document.activeElement !== this.captionInput) {
      this.captionInput.value = String(context.node.attrs.caption ?? '');
    }
    if (force || document.activeElement !== this.labelInput) {
      this.labelInput.value = String(context.node.attrs.label ?? '');
    }
  }

  private run(command: Command, focus = true): boolean {
    const handled = command(this.view.state, this.view.dispatch, this.view);
    if (focus) this.view.focus();
    return handled;
  }

  /** Queue geometry outside ProseMirror's dispatch. Text edits take the
   * two-frame path: the character gets one rendering opportunity before the
   * contextual chrome reads layout and publishes its next position. */
  private schedulePosition(afterPaint: boolean): void {
    if (this.destroyed) return;
    if (!afterPaint) {
      if (this.positionFrame) cancelAnimationFrame(this.positionFrame);
      this.positionAfterPaint = false;
      const generation = ++this.positionGeneration;
      this.positionFrame = requestAnimationFrame(() => {
        this.positionFrame = 0;
        if (generation !== this.positionGeneration) return;
        this.positionNow();
      });
      return;
    }
    if (this.positionAfterPaint) return;
    if (this.positionFrame) cancelAnimationFrame(this.positionFrame);
    this.positionAfterPaint = true;
    const generation = ++this.positionGeneration;
    this.positionFrame = requestAnimationFrame(() => {
      this.positionFrame = 0;
      // A task posted from rAF runs after that rendering opportunity. This is
      // the same paint boundary used by the editor's latency probes and keeps
      // contextual chrome out of the frame which presents the character.
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        if (generation !== this.positionGeneration || this.destroyed) return;
        this.positionAfterPaint = false;
        this.positionNow();
      };
      channel.port2.postMessage(null);
    });
  }

  private scheduleViewportPosition = (): void => {
    // ProseMirror may scroll a selection as part of the same native input
    // transaction. Do not let that scroll event promote a post-paint table
    // update back into the first-frame lane.
    this.schedulePosition(this.positionAfterPaint);
  };

  private positionNow(): void {
    if (this.root.hidden || !this.currentTable) return;
    const rect = this.currentTable.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      this.root.style.visibility = 'hidden';
      return;
    }
    this.root.style.visibility = 'hidden';
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + (rect.width - width) / 2));
    const top = rect.top > height + 18 ? rect.top - height - 8 : Math.min(window.innerHeight - height - 12, rect.bottom + 8);
    this.root.style.left = `${Math.round(left)}px`;
    this.root.style.top = `${Math.round(Math.max(12, top))}px`;
    this.root.style.visibility = 'visible';
  }

  destroy(): void {
    this.destroyed = true;
    this.positionGeneration++;
    if (this.positionFrame) cancelAnimationFrame(this.positionFrame);
    window.removeEventListener('resize', this.scheduleViewportPosition);
    document.removeEventListener('scroll', this.scheduleViewportPosition, true);
    this.root.remove();
  }
}

/** Contextual controls, captions, and the lossless table-cell guard. */
export function structuredTablePlugin(): Plugin {
  return new Plugin<NativeTablePluginState>({
    key: tableControlsKey,
    state: {
      init: (_config, state) => ({
        decorations: captionDecorations(state.doc),
        controlsRevision: 0,
      }),
      apply: (transaction, value, oldState, newState) => {
        if (!transaction.docChanged) return value;
        return {
          decorations: updateCaptionDecorations(
            transaction,
            value.decorations,
            oldState,
            newState,
          ),
          controlsRevision:
            value.controlsRevision +
            (transactionChangesDerivedStructure(transaction, TABLE_CONTROL_STRUCTURE) ? 1 : 0),
        };
      },
    },
    filterTransaction(transaction, state) {
      if (!transaction.docChanged) return true;
      const result = keepsUnsupportedTablesVerbatim(state.doc, transaction);
      if (!result.ok) announceTableConstraint(result.issue ?? 'That content');
      return result.ok;
    },
    props: { decorations: (state) => tableControlsKey.getState(state)?.decorations ?? null },
    view: (view) => new NativeTableControls(view),
  });
}

export {
  CellSelection,
  addColumnAfter,
  addRowAfter,
  deleteColumn,
  deleteRow,
  deleteTable,
  mergeCells,
  splitCell,
  toggleHeaderRow,
};
