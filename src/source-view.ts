// The source view: a second editor for the same rails (SOURCE-VIEW.md).
//
// One truth at a time (decision 1). Entering serializes the ProseMirror
// document once, in the document's own file format (decision 2), and hands
// the text to CodeMirror; leaving parses the text once and installs it as a
// single transaction (one undo step). While the source view is open the
// text IS the document: saves write it verbatim (decision 3), exports parse
// it on demand (decision 9), and the page machinery sleeps behind the hidden
// editor (decision 6). This module owns the mode state and its persistence
// (decision 7); the CodeMirror half lives in source-editor.ts and loads
// lazily on the first toggle.

import type { Node as PMNode } from 'prosemirror-model';
import { Selection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { closeHistory } from 'prosemirror-history';
import { docToTyp } from './typ-serializer';
import { typToDoc } from './typ-parser';
import { normalizeSettings } from './settings';
import { setLayoutSuspended } from './typeset-plugin';
import type { SourceEditor, SourceFormat } from './source-editor';

export type { SourceFormat };

export interface SourceViewHooks {
  view: EditorView;
  /** The page column: the source sheet mounts inside it, over the hidden
   *  editor and page boxes. */
  stack: HTMLElement;
  /** The document's format — its file's (FileManager.format). */
  format: () => SourceFormat;
  /** A source-side edit: the document is dirty and wants autosaving. */
  onChange: () => void;
  /** The mode changed — update the chrome. */
  onMode: (active: boolean) => void;
  message: (text: string) => void;
}

export interface SourceView {
  enter: () => Promise<boolean>;
  exit: () => Promise<boolean>;
  toggle: () => Promise<boolean>;
  isActive: () => boolean;
  /** The typed text when a source view in `format` is open (the save path). */
  textFor: (format: SourceFormat) => string | null;
  /** The document as exporters should see it: parsed from the text in
   *  source mode, the editor's otherwise. */
  currentDoc: () => PMNode;
  /** The words in whichever surface is the truth. */
  wordCount: () => number;
  /** The editor document was replaced under the source view (a file
   *  opened, a disk change reloaded): re-suspend the fresh layout plugin
   *  and show the new document's text. */
  afterSetDoc: () => void;
  /** Land a reloaded tab back in the source it was writing, unparsed. */
  restore: () => Promise<void>;
  /** Snapshot the session synchronously (lifecycle boundaries). */
  persist: () => void;
  /** Focus whichever editor is the truth. */
  focus: () => void;
  /** Test hooks (DEV only): the raw text and caret of the source editor. */
  text: () => string | null;
  setText: (text: string) => void;
  caret: () => number;
  setCaret: (offset: number) => void;
}

/** Per-tab: the unparsed text survives a reload (sibling of the
 *  document's own session key in main.ts; same tab lifetime). */
export const SOURCE_SESSION_KEY = 'typeset-doc-source';
/** Origin-wide: the last mode used per format. Recorded now; applied when
 *  step 4's "mode memory per format" lands — the default stays the page
 *  view for both (decisions taken, 2026-09-02). */
const MODE_MEMORY_KEY = 'typeset-source-mode';

interface SourceSession {
  mode: 'source';
  text: string;
  format: SourceFormat;
}

type MdPair = {
  mdToDoc: (src: string) => { doc: PMNode; warnings: string[] };
  docToMd: (doc: PMNode, warn?: (m: string) => void, offsets?: number[]) => string;
};

interface Active {
  editor: SourceEditor;
  host: HTMLElement;
  format: SourceFormat;
  /** Text offset where each top-level block's serialization begins. */
  offsets: number[];
  /** The page column's painted height before the sheet replaced it. */
  stackHeight: string;
  /** Islands the document had on entry, so the exit toast counts only
   *  what the source round trip produced. */
  islands: { blocks: number; inline: number };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Raw-Typst islands in a document: blocks and inline spans the page view
 *  keeps verbatim because it cannot show them. */
function countIslands(doc: PMNode): { blocks: number; inline: number } {
  let blocks = 0;
  let inline = 0;
  doc.descendants((n) => {
    if (n.type.name === 'code_block' && n.attrs.params === 'typst-raw') blocks++;
    else if (n.type.name === 'typst_inline') inline++;
    return true;
  });
  return { blocks, inline };
}

/** The toast for islands the source round trip produced (decision 8). */
function islandNotice(before: { blocks: number; inline: number }, after: { blocks: number; inline: number }): string | null {
  const blocks = Math.max(0, after.blocks - before.blocks);
  const inline = Math.max(0, after.inline - before.inline);
  const parts: string[] = [];
  if (blocks) parts.push(`${blocks} block${blocks === 1 ? '' : 's'}`);
  if (inline) parts.push(`${inline} inline span${inline === 1 ? '' : 's'}`);
  return parts.length ? `${parts.join(' and ')} kept as raw Typst` : null;
}

/** Which top-level block a caret in the typed text sits in (decision 5).
 *  The parsers report no source positions, so the block starts of the
 *  parsed document's own re-serialization are anchored into the typed
 *  text by each block's first line: exact while the text is the
 *  serializer's, and at worst a block early where a block's prose was
 *  re-normalized (its anchor then fails and the previous one stands). */
function caretBlock(typed: string, normalized: string, offsets: number[], caret: number): number {
  let best = 0;
  let from = 0;
  for (let i = 0; i < offsets.length; i++) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : normalized.length;
    if (end <= offsets[i]) continue; // emits nothing (Markdown front matter)
    const key = normalized.slice(offsets[i], end).split('\n')[0].trimEnd().slice(0, 48);
    if (!key.trim()) continue;
    const at = typed.indexOf(key, from);
    if (at < 0) continue;
    if (at > caret) break;
    best = i;
    from = at + key.length;
  }
  return best;
}

const PREAMBLE_HEAD = '// Exported from Plass';

/** End of the generated `.typ` preamble — everything before the first
 *  block (`offsets[0]`), minus its trailing blank line so the body keeps
 *  its air. Only the serializer's own shape folds; anything else (a
 *  hand-written file, Markdown front matter) is left alone. A restored
 *  session has no offsets: the preamble then runs to its first blank line,
 *  which is where the serializer puts the body. */
function preambleEnd(text: string, format: SourceFormat, offsets: number[] | null): number {
  if (format !== '.typ' || !text.startsWith(PREAMBLE_HEAD)) return 0;
  let to = offsets?.length ? offsets[0] : text.indexOf('\n\n');
  if (to <= 0) return 0;
  while (to > 0 && text.charAt(to - 1) === '\n') to--;
  return to;
}

/** The document position at the start of top-level block `index`. */
function blockStart(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < Math.min(index, doc.childCount); i++) pos += doc.child(i).nodeSize;
  return pos;
}

export function createSourceView(hooks: SourceViewHooks): SourceView {
  const { view, stack } = hooks;
  let active: Active | null = null;
  let busy = false;
  let md: MdPair | null = null;
  let persistTimer = 0;

  const loadMd = async (): Promise<MdPair> => {
    if (!md) {
      const [{ mdToDoc }, { docToMd }] = await Promise.all([import('./md-parser'), import('./md-serializer')]);
      md = { mdToDoc, docToMd };
    }
    return md;
  };

  /** The document in its file format, with block offsets. Markdown's
   *  lossy-save notices surface once here, as they do on save — unless
   *  `quiet` (the exit-side mapping serialization, which nobody sees). */
  const serialize = (doc: PMNode, format: SourceFormat, offsets: number[], quiet = false): string => {
    if (format === '.md') {
      const warned = new Set<string>();
      const text = md!.docToMd(doc, (m) => warned.add(m), offsets);
      if (!quiet) for (const m of warned) hooks.message(m);
      return text;
    }
    return docToTyp(doc, { offsets });
  };

  const parse = (text: string, format: SourceFormat): PMNode => {
    const parsed = format === '.md' ? md!.mdToDoc(text).doc : typToDoc(text).doc;
    return withBaseAttrs(parsed, view.state.doc, format);
  };

  const persistSession = () => {
    clearTimeout(persistTimer);
    if (!active) return;
    try {
      const session: SourceSession = { mode: 'source', text: active.editor.text(), format: active.format };
      sessionStorage.setItem(SOURCE_SESSION_KEY, JSON.stringify(session));
    } catch (e) {
      console.warn('Source session save failed.', e);
    }
  };

  const rememberMode = (format: SourceFormat, mode: 'source' | 'page') => {
    try {
      const memory = JSON.parse(localStorage.getItem(MODE_MEMORY_KEY) ?? '{}') as Record<string, string>;
      memory[format] = mode;
      localStorage.setItem(MODE_MEMORY_KEY, JSON.stringify(memory));
    } catch {
      /* private mode, quota — the memory is a convenience */
    }
  };

  const mount = async (text: string | null, format: SourceFormat): Promise<void> => {
    const [{ mountSourceEditor }] = await Promise.all([
      import('./source-editor'),
      format === '.md' ? loadMd() : Promise.resolve(),
    ]);
    if (active) return;
    const offsets: number[] = [];
    // Serialize AFTER the imports: the document may have changed meanwhile.
    const initial = text ?? serialize(view.state.doc, format, offsets);
    const islands = countIslands(view.state.doc);
    // The caret's top-level block, carried over by block (decision 5) —
    // only when the text is this document's serialization (not a
    // restored session, whose offsets are unknown).
    const caretOffset =
      text === null && offsets.length ? offsets[Math.min(view.state.selection.$from.index(0), offsets.length - 1)] : -1;
    // Sleep first, then hide: no pass may measure the editor once hidden.
    setLayoutSuspended(view, true);
    stack.classList.add('source-mode');
    const stackHeight = stack.style.height;
    stack.style.height = '';
    const host = document.createElement('div');
    host.id = 'source';
    stack.appendChild(host);
    const editor = mountSourceEditor(host, {
      text: initial,
      format,
      preambleEnd: preambleEnd(initial, format, text === null ? offsets : null),
      onChange() {
        clearTimeout(persistTimer);
        persistTimer = window.setTimeout(persistSession, 400);
        hooks.onChange();
      },
    });
    active = { editor, host, format, offsets, stackHeight, islands };
    persistSession();
    rememberMode(format, 'source');
    hooks.onMode(true);
    editor.focus();
    if (caretOffset >= 0) editor.setCaret(caretOffset);
  };

  const enter = async (): Promise<boolean> => {
    if (active || busy) return active !== null;
    busy = true;
    try {
      await mount(null, hooks.format());
      return true;
    } finally {
      busy = false;
    }
  };

  const exit = async (): Promise<boolean> => {
    if (!active || busy) return active === null;
    busy = true;
    try {
      const { editor, host, format, stackHeight, islands } = active;
      const text = editor.text();
      const caret = editor.caret();
      let doc: PMNode;
      try {
        doc = parse(text, format);
      } catch (e) {
        // The text is never lost: the writer stays in the source to fix it.
        hooks.message(`Could not read the source — ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      // The caret's block, found through the parsed document's own
      // serialization (see caretBlock); its start is the page position.
      const newOffsets: number[] = [];
      const normalized = serialize(doc, format, newOffsets, true);
      const target = blockStart(doc, caretBlock(text, normalized, newOffsets, caret));
      editor.destroy();
      host.remove();
      active = null;
      clearTimeout(persistTimer);
      sessionStorage.removeItem(SOURCE_SESSION_KEY);
      rememberMode(format, 'page');
      stack.classList.remove('source-mode');
      stack.style.height = stackHeight;
      // ONE transaction, its own undo step, while the layout still sleeps:
      // the wake-up pass below is then the only pass, and it sees the new
      // document. An unchanged document installs nothing — no history
      // entry, no dirty flag, no re-normalization.
      const changed = !doc.eq(view.state.doc);
      let tr = view.state.tr;
      if (changed) {
        tr = tr.replaceWith(0, view.state.doc.content.size, doc.content);
        for (const name of Object.keys(doc.attrs)) {
          if (doc.attrs[name] !== view.state.doc.attrs[name]) tr = tr.setDocAttribute(name, doc.attrs[name]);
        }
        closeHistory(tr);
      }
      tr = tr.setSelection(Selection.near(tr.doc.resolve(Math.min(target + 1, tr.doc.content.size)), 1)).scrollIntoView();
      view.dispatch(tr);
      setLayoutSuspended(view, false);
      hooks.onMode(false);
      view.focus();
      // The wake-up pass (next frame) re-imposes page gaps under the caret;
      // scroll follows the caret once they are in place.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!active && !view.isDestroyed) view.dispatch(view.state.tr.scrollIntoView());
        }),
      );
      const notice = changed ? islandNotice(islands, countIslands(doc)) : null;
      if (notice) hooks.message(notice);
      return true;
    } finally {
      busy = false;
    }
  };

  return {
    enter,
    exit,
    toggle: () => (active ? exit() : enter()),
    isActive: () => active !== null,
    textFor: (format) => (active && active.format === format ? active.editor.text() : null),
    currentDoc() {
      if (!active) return view.state.doc;
      try {
        return parse(active.editor.text(), active.format);
      } catch (e) {
        console.warn('Source text did not parse; exporting the page document.', e);
        return view.state.doc;
      }
    },
    wordCount() {
      const text = active
        ? active.editor.text()
        : view.state.doc.textBetween(0, view.state.doc.content.size, ' ', ' ');
      return text.split(/\s+/).filter(Boolean).length;
    },
    afterSetDoc() {
      if (!active) return;
      // A fresh editor state means a fresh layout plugin, awake and about
      // to measure the hidden editor on its first frame: sleep it now.
      setLayoutSuspended(view, true);
      const format = hooks.format();
      if (format !== active.format) {
        // The new document is in the other format: remount in it.
        const { editor, host } = active;
        editor.destroy();
        host.remove();
        active = null;
        stack.classList.remove('source-mode');
        void mount(null, format);
        return;
      }
      active.editor.setText(serialize(view.state.doc, format, active.offsets));
      persistSession();
      active.editor.focus();
    },
    async restore() {
      let session: SourceSession | null = null;
      try {
        const raw = sessionStorage.getItem(SOURCE_SESSION_KEY);
        if (raw) session = JSON.parse(raw) as SourceSession;
      } catch (e) {
        console.warn('Could not restore the source view.', e);
      }
      if (session?.mode !== 'source' || typeof session.text !== 'string') return;
      // Sleep and hide synchronously: the first layout pass must not run
      // against a document whose truth is the text being restored.
      setLayoutSuspended(view, true);
      stack.classList.add('source-mode');
      busy = true;
      try {
        await mount(session.text, session.format === '.md' ? '.md' : '.typ');
      } finally {
        busy = false;
      }
    },
    persist: persistSession,
    focus: () => (active ? active.editor.focus() : view.focus()),
    text: () => active?.editor.text() ?? null,
    setText(text) {
      active?.editor.setText(text);
    },
    caret: () => active?.editor.caret() ?? -1,
    setCaret(offset) {
      active?.editor.setCaret(offset);
    },
  };
}

/** The parsed document with the editor's own attrs where the text carries
 *  nothing different: Markdown never carries settings, and a `.typ` whose
 *  settings and bibliography parse back equal keeps the editor's objects so
 *  an untouched round trip is the identity (`doc.eq`). */
function withBaseAttrs(parsed: PMNode, base: PMNode, format: SourceFormat): PMNode {
  const settings =
    format === '.md' || sameJson(normalizeSettings(parsed.attrs.settings), normalizeSettings(base.attrs.settings))
      ? base.attrs.settings
      : parsed.attrs.settings;
  const bib = sameJson(parsed.attrs.bib, base.attrs.bib) ? base.attrs.bib : parsed.attrs.bib;
  if (settings === parsed.attrs.settings && bib === parsed.attrs.bib) return parsed;
  return parsed.type.create({ ...parsed.attrs, settings, bib }, parsed.content);
}
