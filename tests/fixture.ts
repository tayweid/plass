// The test and expect every spec imports. In Chromium this is Playwright's
// own. In the `webkit-app` project (macOS only) each page runs the way it
// does inside Plass.app: WebKit, with the shell's `plass` message handler
// present, so src/native-fs.ts takes over files exactly as in the app. Node
// answers the handler on a temp folder, mirroring FileOps in
// app/Sources/main.swift (a stand-in: the Swift side itself is checked by
// the in-app self-tests, CLAUDE.md). The specs' OPFS setup
// (navigator.storage.getDirectory) gets a native-fs handle on that folder,
// so the same setup code serves both projects.
import { test as base, expect } from 'playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Reply = Record<string, unknown>;
const fail = (name: string, message: string): Reply => ({ error: { name, message } });

function kindOf(p: string): 'file' | 'directory' | null {
  try {
    return fs.statSync(p).isDirectory() ? 'directory' : 'file';
  } catch {
    return null;
  }
}

function answer(root: string, msg: Record<string, unknown>): Reply {
  const p = typeof msg.path === 'string' ? path.normalize(msg.path) : '';
  const granted = p === root || p.startsWith(root + '/');
  const name = path.basename(p);
  if (msg.type === 'permission') return { granted };
  if (msg.type === 'document') return {};
  if (!granted) return fail('NotAllowedError', `Plass was not given access to ${name}`);
  switch (msg.type) {
    case 'stat': {
      const kind = kindOf(p);
      if (!kind) return fail('NotFoundError', `${name} was not found`);
      const st = fs.statSync(p);
      return { kind, size: st.size, modified: Math.floor(st.mtimeMs) };
    }
    case 'read': {
      if (kindOf(p) !== 'file') return fail('NotFoundError', `${name} was not found`);
      const data = fs.readFileSync(p);
      return { data: data.toString('base64'), size: data.length, modified: Math.floor(fs.statSync(p).mtimeMs) };
    }
    case 'write': {
      if (kindOf(p) === 'directory') return fail('TypeMismatchError', `${name} is a folder`);
      if (kindOf(path.dirname(p)) !== 'directory') return fail('NotFoundError', `the folder holding ${name} was not found`);
      const staged = `${p}.plass-${process.pid}`;
      fs.writeFileSync(staged, Buffer.from(String(msg.data), 'base64'));
      fs.renameSync(staged, p);
      const st = fs.statSync(p);
      return { size: st.size, modified: Math.floor(st.mtimeMs) };
    }
    case 'child': {
      const wanted = msg.kind === 'directory' ? 'directory' : 'file';
      const kind = kindOf(p);
      if (kind) return kind === wanted ? { path: p } : fail('TypeMismatchError', `${name} is not a ${wanted}`);
      if (!msg.create) return fail('NotFoundError', `${name} was not found`);
      if (wanted === 'directory') fs.mkdirSync(p);
      else fs.writeFileSync(p, '');
      return { path: p };
    }
    case 'list': {
      if (kindOf(p) !== 'directory') return fail('NotFoundError', `${name} was not found`);
      const entries = fs.readdirSync(p).sort().map((n) => ({ name: n, kind: kindOf(path.join(p, n)) }));
      return { entries: entries.filter((e) => e.kind) };
    }
    case 'rename': {
      const target = path.join(path.dirname(p), String(msg.name));
      if (!kindOf(p)) return fail('NotFoundError', `${name} was not found`);
      if (target !== p && kindOf(target)) return fail('InvalidModificationError', `${String(msg.name)} already exists`);
      fs.renameSync(p, target);
      return { path: target };
    }
  }
  // Panels need a person; a spec that reaches one stubs the picker itself.
  return fail('NotSupportedError', `${String(msg.type)} is not available in tests`);
}

export const test = base.extend({
  context: async ({ context, browserName }, use) => {
    if (browserName !== 'webkit' || test.info().project.name !== 'webkit-app') {
      await use(context);
      return;
    }
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plass-app-')));
    await context.exposeBinding('__plassShell', (_source, msg: Record<string, unknown>) => answer(root, msg));
    await context.addInitScript((rootPath: string) => {
      const w = window as unknown as {
        webkit?: unknown;
        __plassShell: (m: unknown) => Promise<unknown>;
      };
      w.webkit = { messageHandlers: { plass: { postMessage: (m: unknown) => w.__plassShell(m) } } };
      // On the prototype: WebKit can recreate navigator.storage's wrapper,
      // which drops a property set on the instance.
      Object.defineProperty(StorageManager.prototype, 'getDirectory', {
        configurable: true,
        value: async () => {
          // Absolute: an init script has no base URL to resolve /src against.
          const m = await import(`${location.origin}/src/native-fs.ts`);
          return new m.NativeDirectoryHandle(rootPath);
        },
      });
    }, root);
    await use(context);
    fs.rmSync(root, { recursive: true, force: true });
  },
});

export { expect };
export type { Page } from 'playwright/test';
