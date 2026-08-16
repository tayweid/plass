/** Fonts bundled with the app and preloaded into the isolated compiler. */
export const TYPST_FONT_FILES = [
  'NewCM10-Regular.otf',
  'NewCM10-Italic.otf',
  'NewCM10-Bold.otf',
  'NewCM10-BoldItalic.otf',
  'STIXTwoText-Regular.otf',
  'STIXTwoText-Italic.otf',
  'STIXTwoText-Bold.otf',
  'STIXTwoText-BoldItalic.otf',
  'LibertinusSerif-Regular.otf',
  'LibertinusSerif-Italic.otf',
  'LibertinusSerif-Bold.otf',
  'LibertinusSerif-BoldItalic.otf',
  'texgyrepagella-regular.otf',
  'texgyrepagella-italic.otf',
  'texgyrepagella-bold.otf',
  'texgyrepagella-bolditalic.otf',
  'NewCMMath-Regular.otf',
  'DejaVuSansMono.ttf',
];

/** Fonts guaranteed to exist in the compiler; used as #set text fallback. */
export const FONT_FALLBACK = ['New Computer Modern', 'STIX Two Text', 'Libertinus Serif'];
