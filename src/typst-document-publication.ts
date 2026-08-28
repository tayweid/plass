import type { TypstEmbedRegion } from './typst-embed-regions';
import type { TypstLayoutRegion } from './typst-layout-regions';
import type { TypstPreviewRegion } from './typst-preview-regions';

/** One immutable result from the instrumented whole-document SVG task.
 * Additional exact-layout metadata belongs beside `regions`; consumers share
 * this publication rather than issuing feature-specific document compiles. */
export interface TypstDocumentSvgPublication {
  svg: string;
  regions: TypstEmbedRegion[];
  /** Optional for injected/older producers; the product worker always emits
   * it. Missing or invalid targets make only those contextual blocks native. */
  layoutRegions?: TypstLayoutRegion[];
  /** Exact editor-paint geometry for math and bibliography nodes. */
  previewRegions?: TypstPreviewRegion[];
}
