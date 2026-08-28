// Static asset discovery for explicit executable Typst embeds.
//
// A browser compiler cannot ask the File System Access API from inside its
// isolated worker, so project-relative files must be copied into the VFS
// before compilation. Structured figures already carry their path in the PM
// node. For embeds, recognize the common, lossless direct-literal form:
//
//   #image("figures/result.svg")
//
// Dynamic paths remain valid in exported .typ source, but cannot be granted
// to the worker without an explicit project manifest.

import type { Node as PMNode } from 'prosemirror-model';

const DIRECT_IMAGE = /\bimage\s*\(\s*"((?:[^"\\]|\\["\\])*)"/g;

function decodePath(value: string): string | null {
  // Typst and JSON share the two escapes that are useful in file paths. Fail
  // closed on every other escape instead of guessing at a different path.
  let decoded = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char !== '\\') {
      decoded += char;
      continue;
    }
    const escaped = value[++index];
    if (escaped !== '"' && escaped !== '\\') return null;
    decoded += escaped;
  }
  return decoded;
}

/** Direct project-image paths referenced by executable Typst source. */
export function typstEmbedImagePaths(source: string): string[] {
  const paths = new Set<string>();
  DIRECT_IMAGE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DIRECT_IMAGE.exec(source))) {
    const path = decodePath(match[1]);
    if (path) paths.add(path);
  }
  return [...paths];
}

/** Direct project-image paths referenced by every Typst embed in a PM doc. */
export function documentTypstEmbedImagePaths(doc: PMNode): string[] {
  const paths = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === 'typst_embed') {
      for (const path of typstEmbedImagePaths(node.textContent)) paths.add(path);
      return false;
    }
    return true;
  });
  return [...paths];
}
