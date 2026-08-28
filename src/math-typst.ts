/**
 * Encode user-authored LaTeX as an inert Typst string before handing it to
 * mitex. Backtick raw literals are not safe for arbitrary math source: one
 * legitimate backtick would close the literal and turn the remainder into
 * Typst syntax. JSON string syntax is also Typst string syntax, and `raw`
 * reconstructs the exact bytes mitex expects without an executable boundary.
 */
function latexRaw(source: string, block: boolean): string {
  return `raw(${JSON.stringify(source)}, block: ${block})`;
}

export function inlineMathToTypst(source: string): string {
  return `#mi(${latexRaw(source, false)})`;
}

export function displayMathToTypst(source: string): string {
  return `#mitex(${latexRaw(source, true)})`;
}
