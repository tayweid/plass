// focusThisWindow: the page's side of the shell's `focus` request. Its
// answer is what lets a launch window close itself and leave the file to
// the window that has it (main.ts openLaunched), so what counts as
// "fronted" is pinned here: only a shell that answers {focused: true}. An
// older shell (null to anything it does not know), a bridge that fails,
// an answer without the field, and no shell at all are all "no".
//
// reportDocument: the page's side of the shell's `document` request, which
// keeps the shell's window → file map right for a page that holds files by
// handle (the window's represented file, the project its autosave record
// follows). The handle's name always goes; the path only when the preload's
// `pathOf` knows it (a File from a handle has none, and the shell matches
// the name to the file the handle touched). A handle that cannot be read
// reports nothing; a shell without `pathOf` and no shell at all are told
// nothing. It resolves to the file's path as the shell answers it, which
// the page keeps to show the document's folder in the bar.
//
// A rewind (the shell's history view): `save {id}` is answered `{type:
// 'saved', id, ok: true}` once the document is on disk, or `ok: false`
// with why, which refuses the rewind; `reload {paths, to, app?}` reads the
// file again only when this window's path is among the paths, however
// /private spells it.
//
// Closing with unsaved work (shell 0.2.8): `unsaved` reports go when their
// values change, label and detail only when given; a shell that answers
// {guarded: true} guards the close, and an older one's null stops the
// reports for good; a report the bridge failed goes again. The shell's
// `save` hands the page its reason and, for a close, whether the writer
// chose Save in the dialog.
//
// The History page in the room: the tile asks `{type: 'history', action:
// 'open', inline: <the room's box>}`, and only `{opened: true, inline:
// true}` is the page in the room; `{opened: true}` alone is an older shell
// that opened its window instead; anything else, no history view. `bounds`
// and `close` carry what they should, and the shell's `history` events
// reach the page as inline open/closed and toggle, nothing else.
import { closeHistory, focusThisWindow, isNativeShell, moveHistory, onHistoryView, onShellReload, onShellSave, openHistory, reportDocument, rewoundText, samePath, unsavedReporter, type HistoryViewEvent, type ShellSaveAsk, type UnsavedReport } from './claerbout';

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log('  ok ', name);
  else {
    console.error(' FAIL', name);
    failed++;
  }
}

const asked: Record<string, unknown>[] = [];
const global = globalThis as { window?: unknown };
/** The page's listeners for the shell's events, as the preload keeps them. */
const listeners = new Map<string, Set<(detail: unknown) => void>>();
/** The shell sends an event to this window. */
const fire = (event: string, detail: unknown) => listeners.get(event)?.forEach((listener) => listener(detail));
/** A shell bridge on `window`, answering every request the given way. */
function shell(answer: (message: Record<string, unknown>) => Promise<unknown>): void {
  listeners.clear();
  global.window = {
    claerbout: {
      request: (message: Record<string, unknown>) => {
        asked.push(message);
        return answer(message);
      },
      on: (event: string, listener: (detail: unknown) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
        return () => listeners.get(event)?.delete(listener);
      },
    },
  };
}
/** Every pending answer settled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

console.log('focusThisWindow');

delete global.window;
check('no shell: not in the app, nothing to ask', !isNativeShell() && (await focusThisWindow()) === false);

shell(async () => ({ focused: true }));
check('the shell is present', isNativeShell());
check('a shell that fronted the window: true', (await focusThisWindow()) === true);
check('what it was asked', JSON.stringify(asked.at(-1)) === '{"type":"focus"}');

shell(async () => null);
check('an older shell answers null: false', (await focusThisWindow()) === false);

shell(async () => ({}));
check('an answer without focused: false', (await focusThisWindow()) === false);

shell(async () => ({ focused: false }));
check('a shell that could not: false', (await focusThisWindow()) === false);

shell(() => Promise.reject(new Error('the bridge is down')));
check('a failing bridge: false, never a rejection', (await focusThisWindow()) === false);

console.log('reportDocument');

/** A shell bridge whose preload knows a File's path (the autosave record's). */
function shellWithPaths(pathOf: (file: File) => string): void {
  shell(async () => ({ path: null }));
  (global.window as { claerbout: Record<string, unknown> }).claerbout.pathOf = pathOf;
}
/** A handle whose File the shell maps to `path` (the File itself carries it
 *  here), 7 bytes, modified at a fixed moment. */
const handleAt = (path: string, readable = true) =>
  ({
    kind: 'file',
    name: path.slice(path.lastIndexOf('/') + 1),
    getFile: () =>
      readable
        ? Promise.resolve({ name: path.slice(path.lastIndexOf('/') + 1), size: 7, lastModified: 1_700_000_000_000, __path: path } as unknown as File)
        : Promise.reject(new Error('gone')),
  }) as unknown as FileSystemFileHandle;
const pathOfFile = (file: File) => (file as unknown as { __path?: string }).__path ?? '';
const stamped = ',"size":7,"modified":1700000000000}';

delete global.window;
asked.length = 0;
await reportDocument(handleAt('/p/a.typ'));
check('no shell: nothing to tell', asked.length === 0);

shell(async () => null);
await reportDocument(handleAt('/p/a.typ'));
check('a shell without pathOf (older than the record): nothing asked', asked.length === 0);

shellWithPaths(pathOfFile);
await reportDocument(handleAt('/p/a.typ'));
check('a handle with a path: {type: document, path, name, size, modified}', JSON.stringify(asked.at(-1)) === `{"type":"document","path":"/p/a.typ","name":"a.typ"${stamped}`);
await reportDocument(null);
check('no handle: {type: document, path: null}', JSON.stringify(asked.at(-1)) === '{"type":"document","path":null}');
await reportDocument(handleAt('/p/b.typ'));
check('another handle: its path and name', JSON.stringify(asked.at(-1)) === `{"type":"document","path":"/p/b.typ","name":"b.typ"${stamped}`);

asked.length = 0;
shellWithPaths(() => '');
await reportDocument(handleAt('/p/c.typ'));
check('a File the shell has no path for (one from a handle): name, size and modified, for the shell to match', JSON.stringify(asked.at(-1)) === `{"type":"document","path":null,"name":"c.typ"${stamped}`);

asked.length = 0;
shellWithPaths(pathOfFile);
await reportDocument(handleAt('/p/d.typ', false));
check('a handle that cannot be read: nothing asked, no rejection', asked.length === 0);

asked.length = 0;
shellWithPaths(() => {
  throw new Error('no bridge');
});
let threw = false;
await reportDocument(handleAt('/p/e.typ')).catch(() => {
  threw = true;
});
check('a pathOf that throws: nothing asked, and the promise still settles', !threw && asked.length === 0);

// The path the shell answers with is the page's to keep: the bar shows
// its folder. What the shell took or matched; null for a match of
// nothing, a refusal, a bridge that fails, or anything not a path.
asked.length = 0;
shell(async (message) => ({ path: (message as { name?: string }).name === 'f.typ' ? '/Users/someone/papers/f.typ' : null }));
(global.window as { claerbout: Record<string, unknown> }).claerbout.pathOf = () => '';
check('the shell matched the report: its path comes back', (await reportDocument(handleAt('/p/f.typ'))) === '/Users/someone/papers/f.typ');
check('the shell matched nothing: null', (await reportDocument(handleAt('/p/g.typ'))) === null);
check('no handle: null', (await reportDocument(null)) === null);
shell(async () => ({ path: 'relative/f.typ' }));
(global.window as { claerbout: Record<string, unknown> }).claerbout.pathOf = () => '';
check('an answer that is not an absolute path: null', (await reportDocument(handleAt('/p/f.typ'))) === null);
shell(() => Promise.reject(new Error('the bridge is down')));
(global.window as { claerbout: Record<string, unknown> }).claerbout.pathOf = () => '';
check('a failing bridge: null, never a rejection', (await reportDocument(handleAt('/p/f.typ'))) === null);
delete global.window;
check('a browser tab: null', (await reportDocument(handleAt('/p/f.typ'))) === null);

console.log('save (a rewind saves first)');

const saved = () => asked.filter((message) => message.type === 'saved');
delete global.window;
listeners.clear();
check('no shell: nothing to listen to', typeof onShellSave(async () => null) === 'function' && listeners.size === 0);

shell(async () => null);
asked.length = 0;
let saves = 0;
const stopSave = onShellSave(async () => {
  saves++;
  return null;
});
fire('save', { id: 'a1', reason: 'rewind' });
await settle();
check('on disk: {type: saved, id, ok: true}', saves === 1 && JSON.stringify(saved().at(-1)) === '{"type":"saved","id":"a1","ok":true}');
fire('save', { reason: 'rewind' });
fire('save', null);
await settle();
check('a save without an id: nothing written, nothing answered', saves === 1 && saved().length === 1);
stopSave();
fire('save', { id: 'a2', reason: 'rewind' });
await settle();
check('unsubscribed: not heard', saves === 1 && saved().length === 1);

shell(async () => null);
asked.length = 0;
onShellSave(async () => 'it changed on disk outside Plass, and Plass is keeping its own copy until you choose');
fire('save', { id: 'b1', reason: 'rewind' });
await settle();
check('could not: {ok: false, error} in words, which refuses the rewind', JSON.stringify(saved().at(-1)) === '{"type":"saved","id":"b1","ok":false,"error":"it changed on disk outside Plass, and Plass is keeping its own copy until you choose"}');

shell(async () => null);
asked.length = 0;
onShellSave(() => Promise.reject(new Error('the disk is full')));
fire('save', { id: 'c1', reason: 'rewind' });
await settle();
check('a save that throws: still answered, ok: false with its message', JSON.stringify(saved().at(-1)) === '{"type":"saved","id":"c1","ok":false,"error":"the disk is full"}');

shell(() => Promise.reject(new Error('the bridge is down')));
onShellSave(async () => null);
let unhandled = false;
const onUnhandled = () => {
  unhandled = true;
};
process.on('unhandledRejection', onUnhandled);
fire('save', { id: 'd1', reason: 'rewind' });
await settle();
await settle();
process.off('unhandledRejection', onUnhandled);
check('a bridge that fails the answer: no unhandled rejection', !unhandled);

shell(async () => null);
const saveAsks: ShellSaveAsk[] = [];
onShellSave(async (ask) => {
  saveAsks.push(ask);
  return null;
});
fire('save', { id: 'e1', reason: 'close', choose: true });
fire('save', { id: 'e2', reason: 'close' });
fire('save', { id: 'e3', reason: 'close', choose: 'yes' });
fire('save', { id: 'e4' });
await settle();
check(
  'the reason and the choice reach the page: choose only when true, a save without a reason is a rewind’s',
  JSON.stringify(saveAsks) === '[{"reason":"close","choose":true},{"reason":"close","choose":false},{"reason":"close","choose":false},{"reason":"rewind","choose":false}]',
);

console.log('unsaved (closing with unsaved work)');

const unsavedSent = () => asked.filter((message) => message.type === 'unsaved');
const blank: UnsavedReport = { unsaved: false, name: 'Plass.md', save: 'choose' };
delete global.window;
check('no shell: nothing sent, nothing guarded', (await unsavedReporter()(blank)) === false);

shell(async (message) => (message.type === 'unsaved' ? { guarded: true } : null));
asked.length = 0;
const report = unsavedReporter();
check('a shell from 0.2.8 guards the close', (await report(blank)) === true);
check('what it was sent', JSON.stringify(unsavedSent().at(-1)) === '{"type":"unsaved","unsaved":false,"name":"Plass.md","save":"choose"}');
check('the same values again: nothing sent, still guarded', (await report({ ...blank })) === true && unsavedSent().length === 1);
await report({ unsaved: true, name: 'Close.typ', save: 'none', detail: 'Close.typ was changed outside Plass.' });
check('a detail goes when given, a label when given', JSON.stringify(unsavedSent().at(-1)) === '{"type":"unsaved","unsaved":true,"name":"Close.typ","save":"none","detail":"Close.typ was changed outside Plass."}');
await report({ unsaved: true, name: 'Close.typ', save: 'choose', label: 'Save to a Folder…', detail: '' });
check('an empty detail is none', JSON.stringify(unsavedSent().at(-1)) === '{"type":"unsaved","unsaved":true,"name":"Close.typ","save":"choose","label":"Save to a Folder…"}');

shell(async () => null);
asked.length = 0;
const older = unsavedReporter();
check('an older shell answers null: not guarded', (await older(blank)) === false);
await older({ ...blank, unsaved: true });
check('and nothing more is sent to it', unsavedSent().length === 1);

let bridgeDown = true;
shell(async () => {
  if (bridgeDown) throw new Error('the bridge is down');
  return { guarded: true };
});
asked.length = 0;
const flaky = unsavedReporter();
check('a failing bridge: not guarded, never a rejection', (await flaky(blank)) === false);
bridgeDown = false;
check('the report it failed goes again with the next call', (await flaky(blank)) === true && unsavedSent().length === 2);
delete global.window;

console.log('reload (a rewind wrote the file)');

check('the same path', samePath('/Users/t/p/a.typ', '/Users/t/p/a.typ'));
check('/private/var is /var, either way round', samePath('/private/var/folders/x/docs/a.typ', '/var/folders/x/docs/a.typ') && samePath('/var/folders/x/a.typ', '/private/var/folders/x/a.typ'));
check('/private/tmp is /tmp', samePath('/tmp/w/a.typ', '/private/tmp/w/a.typ'));
check('another file is not', !samePath('/Users/t/p/a.typ', '/Users/t/p/b.typ') && !samePath('/private/Users/a.typ', '/Users/a.typ') && !samePath('/private/tmpx/a.typ', '/tmpx/a.typ'));

delete global.window;
listeners.clear();
check('no shell: nothing to listen to', typeof onShellReload(() => '/p/a.typ', () => {}) === 'function' && listeners.size === 0);

shell(async () => null);
const reloads: Array<{ to: string | null; app: string | null }> = [];
let mine: string | null = '/private/var/folders/x/docs/a.typ';
onShellReload(() => mine, (rewound) => reloads.push(rewound));
const sha = 'f00dfeed'.repeat(5);
fire('reload', { id: 'r1', paths: ['/var/folders/x/docs/b.typ', '/var/folders/x/docs/a.typ'], reason: 'rewind', to: sha });
check('its path among the paths: reloaded, with the commit', reloads.length === 1 && reloads[0].to === sha && reloads[0].app === null);
fire('reload', { id: 'r2', paths: ['/var/folders/x/docs/b.typ'], reason: 'rewind', to: sha });
check('its path not among them: nothing', reloads.length === 1);
fire('reload', { id: sha, paths: ['/private/var/folders/x/docs/a.typ'], reason: 'rewind', to: sha, app: 'knuth' });
check('another app\u2019s rewind: reloaded, with the app', reloads.length === 2 && reloads[1].app === 'knuth');
mine = null;
fire('reload', { id: 'r3', paths: ['/var/folders/x/docs/a.typ'], reason: 'rewind', to: sha });
check('a window whose file the shell does not know: nothing', reloads.length === 2);
mine = '/var/folders/x/docs/a.typ';
fire('reload', { id: 'r4', paths: '/var/folders/x/docs/a.typ', reason: 'rewind', to: sha });
fire('reload', null);
check('paths that are not a list, or no detail: nothing', reloads.length === 2);
check('the reload asks the shell nothing', !asked.some((message) => message.type === 'reload'));

check('what the window says: Rewound to the first seven', rewoundText({ to: sha, app: null }) === 'Rewound to f00dfee');
check('another app\u2019s: Rewound by Knuth', rewoundText({ to: sha, app: 'knuth' }) === 'Rewound by Knuth');
check('neither known: Rewound', rewoundText({ to: null, app: null }) === 'Rewound');

console.log('openHistory, moveHistory, closeHistory (the History page in the room)');

const room = { x: 44, y: 44, width: 828, height: 668 };
delete global.window;
check('no shell: null', (await openHistory(room)) === null);
moveHistory(room);
closeHistory();

shell(async () => ({ opened: true, inline: true }));
check('the shell laid the page over the room: inline', (await openHistory(room)) === 'inline');
check('what it was asked: open with the room\u2019s box', JSON.stringify(asked.at(-1)) === '{"type":"history","action":"open","inline":{"x":44,"y":44,"width":828,"height":668}}');
moveHistory({ ...room, width: 900 });
check('bounds carries the new box', JSON.stringify(asked.at(-1)) === '{"type":"history","action":"bounds","inline":{"x":44,"y":44,"width":900,"height":668}}');
closeHistory();
check('close carries nothing else', JSON.stringify(asked.at(-1)) === '{"type":"history","action":"close"}');

shell(async () => ({ opened: true }));
check('a shell from before the room opened its window: window', (await openHistory(room)) === 'window');

shell(async () => null);
check('a shell without the history view answers null: null', (await openHistory(room)) === null);

shell(async () => ({ opened: false, error: 'inline must be the room\u2019s box' }));
check('a refused box: null', (await openHistory(room)) === null);

shell(async () => ({}));
check('an answer without opened: null', (await openHistory(room)) === null);

shell(() => Promise.reject(new Error('the bridge is down')));
check('a failing bridge: null, never a rejection', (await openHistory(room)) === null);
moveHistory(room);
closeHistory();
await settle();
check('bounds and close on a failing bridge reject nothing', true);

console.log('onHistoryView (the shell\u2019s history events to a document page)');
delete global.window;
const heard: HistoryViewEvent[] = [];
onHistoryView((event) => heard.push(event))();
shell(async () => null);
const stop = onHistoryView((event) => heard.push(event));
fire('history', { kind: 'inline', state: 'open' });
fire('history', { kind: 'toggle' });
fire('history', { kind: 'inline', state: 'closed' });
fire('history', { kind: 'inline', state: 'half' });
fire('history', { kind: 'commit', sha: 'f00' });
fire('history', null);
check('inline open, toggle, inline closed, and nothing else', JSON.stringify(heard) === '[{"kind":"inline","open":true},{"kind":"toggle"},{"kind":"inline","open":false}]');
stop();
fire('history', { kind: 'toggle' });
check('the unsubscribe stops it', heard.length === 3);
delete global.window;

if (failed) {
  console.error(`\n${failed} claerbout test(s) failed`);
  process.exit(1);
}
console.log('\nall claerbout tests passed');
