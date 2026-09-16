// Editor appearance: a screen-only palette preference (docs/COMMENTS-AND-
// APPEARANCE-HANDOFF.md, feature 2). "Warm paper" tints the sheet, the
// document ink, and the source view; it changes no width, metric, margin,
// or spacing, is not a document attribute (no transaction, no dirty state,
// no export), and is remembered per device under its own storage key.

export type Appearance = 'standard' | 'warm';

export const APPEARANCES: ReadonlyArray<[Appearance, string]> = [
  ['standard', 'Standard'],
  ['warm', 'Warm paper'],
];

/** A new key on purpose: the existing "typeset-*" keys are never renamed. */
const STORAGE_KEY = 'typeset-appearance';

function isAppearance(value: unknown): value is Appearance {
  return value === 'standard' || value === 'warm';
}

/** The stored preference, or Standard when storage is unavailable, empty,
 *  or holds anything unexpected. */
export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isAppearance(raw) ? raw : 'standard';
  } catch {
    return 'standard';
  }
}

export function currentAppearance(): Appearance {
  const value = document.documentElement.dataset.appearance;
  return isAppearance(value) ? value : 'standard';
}

/** Paint the preset (style.css reads `:root[data-appearance]`) and remember
 *  it. Storage failures are silent: the palette still applies this session. */
export function applyAppearance(value: Appearance): void {
  const root = document.documentElement;
  if (value === 'standard') delete root.dataset.appearance;
  else root.dataset.appearance = value;
  try {
    if (value === 'standard') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* a private window or blocked storage: the choice lasts the session */
  }
}
