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
  /** `exact` is a fresh full-document Typst answer. `held` is that answer's
   * mapped page starts while its replacement compiles. `continuous` makes no
   * finite-page claim: callers must paint neither sheets nor folios. */
  mode: 'exact' | 'held' | 'continuous';
  /** Human-readable provenance/failure detail for status chrome. */
  reason?: string;
  count: number;
  pageW: number;
  pageH: number;
  gap: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

export interface ExactPageBasis {
  provenance: 'exact';
  pageCount: number;
  geometryEpoch: number;
  editorWidth: number;
}

export interface TypesetState {
  decos: DecorationSet;
  /** Zero-width markers created only by a successful full-document Typst
   * compile. ProseMirror may map them through edits while the replacement is
   * pending; they are cleared as soon as that exact provenance is abandoned. */
  pageMarks: DecorationSet;
  pageBasis: ExactPageBasis | null;
}

export type TypesetMeta =
  | {
      type: 'decos';
      decos: DecorationSet;
      pageMarks?: DecorationSet;
      pageBasis?: ExactPageBasis | null;
    }
  | { type: 'pageMarks'; pageMarks: DecorationSet; pageBasis: ExactPageBasis | null };

export const typesetKey = new PluginKey<TypesetState>('typeset');
