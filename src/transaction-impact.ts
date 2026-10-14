// Small, transaction-local invalidation helpers. Derived editor state should
// map through ordinary text edits and rebuild only when a node that can alter
// the derivation is inserted, removed, or changed.

import type { Node as PMNode } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';

/**
 * A node whose presence or selected attributes affect derived editor state.
 * `structure` describes descendants whose topology matters while their text
 * content does not. This is useful for containers such as tables: changing a
 * cell's text can map existing decorations, whereas inserting a row, toggling
 * a header cell, or changing a span must rebuild them.
 */
export interface DerivedStructureRule {
  /** Attributes whose exact value affects the derivation. */
  attrs?: readonly string[];
  /** Attributes where only empty/non-empty presence affects the derivation.
   * This keeps edits within an already-present caption cheap while still
   * detecting the boundary that starts or stops consuming a number. */
  attrPresence?: readonly string[];
  structure?: Readonly<Record<string, readonly string[]>>;
}

export type DerivedStructureRules = Readonly<Record<string, DerivedStructureRule>>;

function positionTouches(doc: PMNode, pos: number, names: ReadonlySet<string>): boolean {
  const safe = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(safe);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    if (names.has($pos.node(depth).type.name)) return true;
  }
  return false;
}

function rangeTouches(
  doc: PMNode,
  from: number,
  to: number,
  names: ReadonlySet<string>,
): boolean {
  if (positionTouches(doc, from, names) || positionTouches(doc, to, names)) return true;
  let touched = false;
  doc.nodesBetween(
    Math.max(0, Math.min(from, doc.content.size)),
    Math.max(0, Math.min(Math.max(to, from), doc.content.size)),
    (node) => {
      if (names.has(node.type.name)) touched = true;
      return !touched;
    },
  );
  return touched;
}

/** Whether this transaction changes content capable of altering a derived
 * numbering/index state. Ordinary prose edits return false, allowing the
 * existing decorations to map in O(changed geometry) rather than rebuilding
 * from a full-document scan. */
export function transactionTouchesNodeTypes(
  tr: Transaction,
  nodeNames: ReadonlySet<string>,
): boolean {
  if (!tr.docChanged) return false;
  if (tr.before.attrs !== tr.doc.attrs) return true;

  for (let index = 0; index < tr.steps.length; index++) {
    const oldDoc = tr.docs[index] ?? tr.before;
    const newDoc = tr.docs[index + 1] ?? tr.doc;
    const map = tr.steps[index].getMap();
    let described = false;
    let touched = false;
    map.forEach((oldFrom, oldTo, newFrom, newTo) => {
      described = true;
      if (
        rangeTouches(oldDoc, oldFrom, oldTo, nodeNames) ||
        rangeTouches(newDoc, newFrom, newTo, nodeNames)
      ) {
        touched = true;
      }
    });
    // Attribute/markup steps can be document-changing while exposing an
    // empty map. Rebuild conservatively in that uncommon case.
    if (!described || touched) return true;
  }
  return false;
}

function selectedAttrs(
  node: PMNode,
  names: readonly string[] | undefined,
  presenceNames?: readonly string[],
): string {
  const exact = names?.map((name) => `${name}:${JSON.stringify(node.attrs[name])}`) ?? [];
  const presence = presenceNames?.map((name) => `${name}?:${Boolean(node.attrs[name])}`) ?? [];
  return [...exact, ...presence].join(',');
}

function nodeToken(
  node: PMNode,
  attrs: readonly string[] | undefined,
  attrPresence?: readonly string[],
): string {
  return `${node.type.name}{${selectedAttrs(node, attrs, attrPresence)}}`;
}

/** Structural context at one side of a changed range. The tracked ancestor's
 * own relevant attributes are followed by the table-like topology on the
 * path to the edit. Ordinary text changes therefore compare equal without a
 * container scan; markup changes at a cell boundary do not. */
function structuralContext(doc: PMNode, pos: number, rules: DerivedStructureRules): string[] {
  const safe = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(safe);
  const result: string[] = [];
  for (let depth = 0; depth <= $pos.depth; depth++) {
    const node = $pos.node(depth);
    const rule = rules[node.type.name];
    if (!rule) continue;
    const path = [nodeToken(node, rule.attrs, rule.attrPresence)];
    if (rule.structure) {
      for (let childDepth = depth + 1; childDepth <= $pos.depth; childDepth++) {
        const child = $pos.node(childDepth);
        const attrs = rule.structure[child.type.name];
        if (attrs) path.push(nodeToken(child, attrs));
      }
    }
    result.push(path.join('/'));
  }
  return result;
}

/** Relevant nodes wholly inserted/removed by a range. Ancestors which merely
 * contain the edit are deliberately excluded; their selected attributes and
 * structural path are compared by `structuralContext` instead. */
function structuralTokens(
  doc: PMNode,
  from: number,
  to: number,
  rules: DerivedStructureRules,
): string[] {
  const start = Math.max(0, Math.min(from, doc.content.size));
  const end = Math.max(start, Math.min(to, doc.content.size));
  if (start === end) return [];
  const structure = new Map<string, readonly string[]>();
  for (const rule of Object.values(rules)) {
    for (const [name, attrs] of Object.entries(rule.structure ?? {})) {
      structure.set(name, attrs);
    }
  }
  const result: string[] = [];
  doc.nodesBetween(start, end, (node, pos) => {
    // nodesBetween also visits ancestors overlapping the range. Only a node
    // fully contained by it represents inserted/removed structure.
    if (pos < start || pos + node.nodeSize > end) return true;
    const rule = rules[node.type.name];
    if (rule) result.push(`node:${nodeToken(node, rule.attrs, rule.attrPresence)}`);
    const attrs = structure.get(node.type.name);
    if (attrs) result.push(`structure:${nodeToken(node, attrs)}`);
    return true;
  });
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Whether a transaction changes the identity, relevant attributes, or
 * declared descendant topology of nodes used by a derived-state index.
 *
 * Work is bounded to each step's mapped ranges and ancestor paths. In
 * particular, typing inside a large table does not scan the table or the
 * document, while insertion/deletion, label changes, row/column changes,
 * header toggles, spans, and nested tracked atoms are still detected.
 */
export function transactionChangesDerivedStructure(
  tr: Transaction,
  rules: DerivedStructureRules,
): boolean {
  if (!tr.docChanged) return false;

  for (let index = 0; index < tr.steps.length; index++) {
    const oldDoc = tr.docs[index] ?? tr.before;
    const newDoc = tr.docs[index + 1] ?? tr.doc;
    const map = tr.steps[index].getMap();
    let described = false;
    let changed = false;
    map.forEach((oldFrom, oldTo, newFrom, newTo) => {
      described = true;
      const removed = structuralTokens(oldDoc, oldFrom, oldTo, rules);
      const inserted = structuralTokens(newDoc, newFrom, newTo, rules);
      if (
        // Even a same-shaped wholesale replacement invalidates decorations
        // anchored inside that node. Normal typing changes only text leaves,
        // so neither list contains a tracked structural token.
        removed.length > 0 ||
        inserted.length > 0 ||
        !sameStrings(
          structuralContext(oldDoc, oldFrom, rules),
          structuralContext(newDoc, newFrom, rules),
        ) ||
        !sameStrings(
          structuralContext(oldDoc, oldTo, rules),
          structuralContext(newDoc, newTo, rules),
        )
      ) {
        changed = true;
      }
    });
    // A document-changing step with an empty map is an uncommon custom
    // transform. Rebuild conservatively because it cannot be localized.
    if (!described || changed) return true;
  }
  return false;
}
