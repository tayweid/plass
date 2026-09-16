// ProseMirror-facing state contract for the layout translator. Keeping this
// small and dependency-light lets layout helpers share the plugin key and
// metadata types without importing the layout coordinator.

import { PluginKey } from 'prosemirror-state';
import type { DecorationSet } from 'prosemirror-view';
import type { DisplayPage } from './page-geometry';

export interface TypesetStats {
  ms: number;
  paragraphs: number;
  lines: number;
}

export interface PageInfo {
  count: number;
  pageW: number;
  /** The PRINT page height. A displayed sheet may be taller (`pages`). */
  pageH: number;
  gap: number;
  /** Displayed sheet geometry, one per page (page-geometry.ts). */
  pages: DisplayPage[];
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

export interface TypesetState {
  decos: DecorationSet;
}

export type TypesetMeta = { type: 'decos'; decos: DecorationSet };

export const typesetKey = new PluginKey<TypesetState>('typeset');
