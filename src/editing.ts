// Input rules and keymap: the Typora feel — markdown-ish syntax renders as
// you type, everything reachable from the keyboard.

import {
  InputRule,
  inputRules,
  smartQuotes,
  emDash,
  ellipsis,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, chainCommands, exitCode, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { goToNextCell } from 'prosemirror-tables';
import type { MarkType } from 'prosemirror-model';
import type { Command, Plugin } from 'prosemirror-state';
import { schema } from './schema';
import { insertMath, mathDisplayRule, mathInlineRule } from './math';
import { eqRefRule } from './equations';
import { exitFigure } from './figures';
import { exitFootnote, footnoteCloseRule, footnoteOpenRules, insertFootnote } from './footnotes';

/**
 * `**bold**`, `_em_`, `` `code` `` style mark input rules.
 * `contentGroup` is the capture group holding the marked text; group 1 is a
 * preserved prefix when contentGroup is 2.
 */
function markInputRule(regexp: RegExp, markType: MarkType, contentGroup = 1): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const content = match[contentGroup];
    if (!content) return null;
    const prefix = contentGroup === 2 ? (match[1] ?? '') : '';
    const from = start + prefix.length;
    const tr = state.tr;
    tr.delete(from, end);
    tr.insertText(content, from);
    tr.addMark(from, from + content.length, markType.create());
    tr.removeStoredMark(markType);
    return tr;
  });
}

export function buildInputRules(): Plugin {
  const rules = [
    ...smartQuotes,
    ellipsis,
    emDash,
    // # / ## / ### headings
    textblockTypeInputRule(/^(#{1,3})\s$/, schema.nodes.heading, (m) => ({ level: m[1].length })),
    // > blockquote
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
    // - or * bullet list
    wrappingInputRule(/^\s*([-*])\s$/, schema.nodes.bullet_list),
    // 1. ordered list
    wrappingInputRule(
      /^(\d+)\.\s$/,
      schema.nodes.ordered_list,
      (m) => ({ order: +m[1] }),
      (m, node) => node.childCount + node.attrs.order === +m[1],
    ),
    // ``` code block
    textblockTypeInputRule(/^```$/, schema.nodes.code_block),
    // marks
    markInputRule(/\*\*([^*]+)\*\*$/, schema.marks.strong),
    markInputRule(/(^|[^*])\*([^*\s][^*]*)\*$/, schema.marks.em, 2),
    markInputRule(/(^|[^_])_([^_\s][^_]*)_$/, schema.marks.em, 2),
    markInputRule(/`([^`]+)`$/, schema.marks.code),
    // math
    mathInlineRule,
    mathDisplayRule,
    // @label equation references
    eqRefRule,
    // ^[ or \footnote{ opens a footnote; ] or } exits its body
    ...footnoteOpenRules,
    footnoteCloseRule,
  ];
  return inputRules({ rules });
}

export function buildKeymap(): Plugin {
  const backToParagraph: Command = setBlockType(schema.nodes.paragraph);
  const keys: Record<string, Command> = {
    'Mod-z': undo,
    'Shift-Mod-z': redo,
    'Mod-y': redo,
    'Mod-b': toggleMark(schema.marks.strong),
    'Mod-i': toggleMark(schema.marks.em),
    'Mod-`': toggleMark(schema.marks.code),
    'Mod-m': insertMath(false),
    'Shift-Mod-m': insertMath(true),
    'Shift-Mod-8': wrapInList(schema.nodes.bullet_list),
    'Shift-Mod-9': wrapInList(schema.nodes.ordered_list),
    'Mod-Alt-0': backToParagraph,
    'Mod-Alt-1': setBlockType(schema.nodes.heading, { level: 1 }),
    'Mod-Alt-2': setBlockType(schema.nodes.heading, { level: 2 }),
    'Mod-Alt-3': setBlockType(schema.nodes.heading, { level: 3 }),
    'Ctrl->': wrapIn(schema.nodes.blockquote),
    'Enter': chainCommands(exitFootnote, exitFigure, splitListItem(schema.nodes.list_item)),
    'Mod-Alt-f': insertFootnote,
    'Tab': chainCommands(goToNextCell(1), sinkListItem(schema.nodes.list_item)),
    'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(schema.nodes.list_item)),
    'Shift-Enter': chainCommands(exitCode, (state, dispatch) => {
      if (dispatch) {
        dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
      }
      return true;
    }),
  };
  return keymap(keys);
}

export const baseKeys = keymap(baseKeymap);
