// Resource limits for data that crosses from user-controlled files/text into
// in-memory parsers. Keep these in one place so picker, launch, restore, and
// editor paths cannot drift apart.

export const INPUT_LIMITS = {
  // Large enough for a legacy document containing one maximum-size embedded
  // image as base64, while rejecting files large enough to exhaust a tab.
  documentBytes: 32 * 1024 * 1024,
  bibliographyBytes: 4 * 1024 * 1024,
  mathMacrosBytes: 64 * 1024,
  importedTableColumns: 100,
  importedTableSpan: 100,
  importedTableCells: 10_000,
} as const;

function mib(bytes: number): string {
  return Number.isInteger(bytes / 1024 / 1024)
    ? `${bytes / 1024 / 1024} MiB`
    : `${Math.ceil(bytes / 1024)} KiB`;
}

export function inputSizeError(bytes: number, limit: number, label: string): string | null {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= limit
    ? null
    : `${label} is larger than Plass's ${mib(limit)} limit`;
}

/** UTF-8 size check without allocating a second giant buffer for obvious
 * rejects. A UTF-16 code unit always contributes at least one UTF-8 byte. */
export function textSizeError(text: string, limit: number, label: string): string | null {
  if (text.length > limit) return `${label} is larger than Plass's ${mib(limit)} limit`;
  return inputSizeError(new TextEncoder().encode(text).byteLength, limit, label);
}

export async function readBoundedText(file: Blob, limit: number, label: string): Promise<string> {
  const error = inputSizeError(file.size, limit, label);
  if (error) throw new InputLimitError(error);
  return file.text();
}

export class InputLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputLimitError';
  }
}
