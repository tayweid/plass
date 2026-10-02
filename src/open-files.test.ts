// The one-window-per-file protocol, between two windows, in node. The
// module keeps one window's state (what it holds, its channel), so the
// two windows are two instances of it — a query string on the import
// makes the second — talking over node's own BroadcastChannel, which
// delivers between instances in one thread the way a browser's does
// between windows and, like it, never to the poster. `window` stands in
// for the browser's timers and for the shell's bridge. A handle here is
// an id, a name and isSameEntry, which is all the module uses of one;
// what the channel carries is its structured clone (the id and the name:
// a method on the prototype is left behind, a function property would
// refuse to clone), as a real handle is cloned between windows.
import type * as OpenFiles from './open-files';

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log('  ok ', name);
  else {
    console.error(' FAIL', name);
    failed++;
  }
}

class Handle {
  constructor(readonly id: string, readonly name: string) {}
  async isSameEntry(other: { id: string }): Promise<boolean> {
    return other.id === this.id;
  }
}
/** A handle whose file is gone: comparing it fails, as a real one's does. */
class Broken extends Handle {
  override async isSameEntry(): Promise<boolean> {
    throw new DOMException('gone', 'InvalidStateError');
  }
}
const handle = (id: string, name: string) => new Handle(id, name);
const asHandle = (h: Handle) => h as unknown as FileSystemFileHandle;

/** The shell: null means a browser tab (no bridge); otherwise how it
 *  answers every request, each of which is kept in `asked`. */
let shellAnswers: (() => Promise<unknown>) | null = null;
const asked: Record<string, unknown>[] = [];
(globalThis as { window?: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (timer: unknown) => clearTimeout(timer as NodeJS.Timeout),
  get claerbout() {
    if (!shellAnswers) return undefined;
    const answer = shellAnswers;
    return {
      request: (message: Record<string, unknown>) => {
        asked.push(message);
        return answer();
      },
      on: () => () => {},
    };
  },
};
// Node's BroadcastChannel holds the process open, and the module never
// closes its own: every channel made here lets the process end.
const NativeChannel = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = class extends NativeChannel {
  constructor(name: string) {
    super(name);
    (this as unknown as { unref(): void }).unref();
  }
} as typeof BroadcastChannel;

const instance = (tag: string) => import(`./open-files.ts?${tag}`) as Promise<typeof OpenFiles>;
const holder = await instance('holder');
const asker = await instance('asker');
const shared = handle('h1', 'Shared.typ');
const other = handle('h2', 'Other.typ');
const focusRequests = () => asked.filter((m) => m.type === 'focus').length;

console.log('open-files: one window per file');

check('nobody holds it: null', (await asker.openInAnotherWindow(asHandle(shared))) === null);

holder.holdOpenFile(asHandle(shared));
const claimed = await asker.openInAnotherWindow(asHandle(shared));
check('the holder claims it by name', claimed?.name === 'Shared.typ');
check('a plain query fronts nobody', claimed?.focused === false && focusRequests() === 0);
check('another file: null', (await asker.openInAnotherWindow(asHandle(other))) === null);

shellAnswers = async () => ({ focused: true });
check('a plain query under a shell still asks it nothing', (await asker.openInAnotherWindow(asHandle(shared)))?.focused === false && focusRequests() === 0);
const fronted = await asker.openInAnotherWindow(asHandle(shared), true);
check('front: the holder asks the shell to focus it', focusRequests() === 1 && JSON.stringify(asked.at(-1)) === '{"type":"focus"}');
check('front: the claim says it was fronted', fronted?.name === 'Shared.typ' && fronted.focused === true);

shellAnswers = () => new Promise((resolve) => setTimeout(() => resolve({ focused: true }), 400));
const slow = await asker.openInAnotherWindow(asHandle(shared), true);
check('front: a holder whose shell takes longer than ANSWER_MS (a minimized window) is still claimed, fronted', slow?.name === 'Shared.typ' && slow.focused === true);

shellAnswers = async () => null;
const older = await asker.openInAnotherWindow(asHandle(shared), true);
check('front under an older shell: asked, not fronted, still claimed', focusRequests() === 3 && older?.name === 'Shared.typ' && older.focused === false);

shellAnswers = null;
const browser = await asker.openInAnotherWindow(asHandle(shared), true);
check('front in a browser tab: claimed, not fronted', focusRequests() === 3 && browser?.name === 'Shared.typ' && browser.focused === false);

holder.holdOpenFile(null);
check('the holder let go: null', (await asker.openInAnotherWindow(asHandle(shared), true)) === null);

holder.holdOpenFile(asHandle(new Broken('h1', 'Broken.typ')));
check('a handle that cannot be compared claims nothing', (await asker.openInAnotherWindow(asHandle(shared))) === null);

holder.holdOpenFile(null);
const started = Date.now();
await asker.openInAnotherWindow(asHandle(shared));
check('silence is bounded', Date.now() - started < 1000);

if (failed) {
  console.error(`\n${failed} open-files test(s) failed`);
  process.exit(1);
}
console.log('\nall open-files tests passed');
