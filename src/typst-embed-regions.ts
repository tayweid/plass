/** Reserved Typst plumbing for exact executable-embed previews. */
export const TYPST_EMBED_REGION_STATE = 'typeset-plass:embed-regions:v1';
export const TYPST_EMBED_REGION_LABEL = 'typeset-plass-internal-embed-regions-v1';
export const TYPST_EMBED_REGION_KIND = 'typeset-plass-embed-regions-v1';
/** A deliberately reserved serializer identifier. Its preamble closure
 * captures Typst's built-in `state` and `here` before user source can shadow
 * either common name. */
export const TYPST_EMBED_REGION_MARKER = '__typeset_plass_embed_region_marker_v1';

export interface TypstPagePosition {
  /** One-based Typst physical page number. */
  page: number;
  x: number;
  y: number;
}

export interface TypstEmbedRegion {
  index: number;
  start: TypstPagePosition;
  end: TypstPagePosition;
}
