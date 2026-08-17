// ProseMirror-facing state contract for the layout translator. Keeping this
// small and dependency-light lets layout helpers share the plugin key and
// metadata types without importing the layout coordinator.

import { PluginKey } from 'prosemirror-state';
import type { DecorationSet } from 'prosemirror-view';

export interface TypesetStats {
  ms: number;
  paragraphs: number;
  lines: number;
}

export interface PageInfo {
  count: number;
  pageW: number;
  pageH: number;
  gap: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

export interface TypesetState {
  decos: DecorationSet;
  /** Zero-width markers at the last oracle page starts. ProseMirror maps them
   * through edits to retain stale-but-stable pagination while Typst compiles. */
  pageMarks: DecorationSet;
}

export type TypesetMeta =
  | { type: 'decos'; decos: DecorationSet; pageMarks?: DecorationSet }
  | { type: 'pageMarks'; pageMarks: DecorationSet };

export const typesetKey = new PluginKey<TypesetState>('typeset');
