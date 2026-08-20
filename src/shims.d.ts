declare module '*.wasm?url' {
  const url: string;
  export default url;
}

// File System Access API surface not yet in lib.dom
interface FilePickerType {
  description?: string;
  accept: Record<string, string[]>;
}

interface Window {
  showOpenFilePicker?: (opts?: {
    types?: FilePickerType[];
    multiple?: boolean;
    // A handle here opens the dialog where that file or folder lives.
    startIn?: FileSystemHandle;
  }) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (opts?: {
    suggestedName?: string;
    types?: FilePickerType[];
  }) => Promise<FileSystemFileHandle>;
}

interface FileSystemHandle {
  queryPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

declare module 'hypher' {
  interface HypherLanguage {
    patterns: Record<string, string>;
    leftmin: number;
    rightmin: number;
    exceptions?: string;
  }
  export default class Hypher {
    constructor(language: HypherLanguage);
    hyphenate(word: string): string[];
  }
}

declare module 'hyphenated-en-us' {
  const language: {
    id: string;
    patterns: string[];
    exceptions: string[];
  };
  export default language;
}

interface Window {
  showDirectoryPicker?: (opts?: {
    mode?: 'read' | 'readwrite';
    id?: string;
    // A file handle here opens the dialog in that file's own folder.
    startIn?: FileSystemHandle;
  }) => Promise<FileSystemDirectoryHandle>;
}

// Launch Queue (PWA File Handling) — Chromium-only, not yet in lib.dom
interface LaunchParams {
  readonly files: ReadonlyArray<FileSystemFileHandle>;
  readonly targetURL?: string;
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

interface Window {
  launchQueue?: LaunchQueue;
}

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
  resolve(handle: FileSystemHandle): Promise<string[] | null>;
}

declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}
