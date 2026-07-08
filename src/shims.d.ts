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
  }
  export default class Hypher {
    constructor(language: HypherLanguage);
    hyphenate(word: string): string[];
  }
}

declare module 'hyphenation.en-us' {
  const language: {
    patterns: Record<string, string>;
    leftmin: number;
    rightmin: number;
  };
  export default language;
}

interface Window {
  showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;
}

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
  resolve(handle: FileSystemHandle): Promise<string[] | null>;
}
