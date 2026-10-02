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
import { focusThisWindow, isNativeShell, reportDocument } from './claerbout';

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
/** A shell bridge on `window`, answering every request the given way. */
function shell(answer: (message: Record<string, unknown>) => Promise<unknown>): void {
  global.window = {
    claerbout: {
      request: (message: Record<string, unknown>) => {
        asked.push(message);
        return answer(message);
      },
      on: () => () => {},
    },
  };
}

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

if (failed) {
  console.error(`\n${failed} claerbout test(s) failed`);
  process.exit(1);
}
console.log('\nall claerbout tests passed');
