// Remote images are a privacy boundary: merely opening an untrusted document
// must not contact hosts named by that document. A user may grant one HTTPS
// origin access for the current browser session; editor display, background
// Typst compilation, and PDF export all share this policy and byte cache.

import { sanitizedTypstSvg } from './safe-svg';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

const MIME_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
]);

export interface RemoteImageStatus {
  remote: true;
  allowed: boolean;
  url: URL | null;
  origin: string | null;
  host: string;
  reason: string | null;
}

export interface RemoteImageAsset {
  data: Uint8Array;
  extension: string;
  mime: string;
  objectUrl: string;
}

const allowedOrigins = new Set<string>();
const listeners = new Set<(origin: string) => void>();
const cache = new Map<string, Promise<RemoteImageAsset>>();
const failed = new Set<string>();
let cachedBytes = 0;

export function isRemoteSource(src: string): boolean {
  return /^https?:/i.test(src.trim());
}

function forbiddenHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  ) return true;

  // Literal IPv6 targets are uncommon for document images and difficult to
  // classify correctly in a browser (mapped and zone-scoped forms included).
  // Hostnames that resolve to IPv6 remain usable; literal addresses stay out
  // of this document-controlled request path.
  if (host.includes(':')) return true;

  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return true;
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function validateRemoteUrl(src: string): { url: URL | null; reason: string | null } {
  let url: URL;
  try {
    url = new URL(src.trim());
  } catch {
    return { url: null, reason: 'Invalid remote image URL' };
  }
  if (url.protocol !== 'https:') {
    return { url: null, reason: 'Remote images must use HTTPS' };
  }
  if (url.username || url.password) {
    return { url: null, reason: 'Remote image URLs cannot contain credentials' };
  }
  if (forbiddenHostname(url.hostname)) {
    return { url: null, reason: 'Local and private-network image hosts are blocked' };
  }
  url.hash = '';
  return { url, reason: null };
}

export function remoteImageStatus(src: string): RemoteImageStatus | null {
  if (!isRemoteSource(src)) return null;
  const { url, reason } = validateRemoteUrl(src);
  return {
    remote: true,
    allowed: !!url && allowedOrigins.has(url.origin),
    url,
    origin: url?.origin ?? null,
    host: url?.host ?? (() => {
      try {
        return new URL(src.trim()).host || 'remote host';
      } catch {
        return 'remote host';
      }
    })(),
    reason,
  };
}

/** Grant one validated origin. This must only be called from a user action. */
export function allowRemoteImageOrigin(src: string): RemoteImageStatus {
  const status = remoteImageStatus(src);
  if (!status) throw new Error('Not a remote image URL');
  if (!status.url || !status.origin) return status;
  if (!allowedOrigins.has(status.origin)) {
    allowedOrigins.add(status.origin);
    for (const listener of listeners) listener(status.origin);
  }
  return { ...status, allowed: true };
}

export function onRemoteImagePermissionChange(listener: (origin: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error('Remote image is larger than 15 MB');
  }
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > MAX_IMAGE_BYTES) throw new Error('Remote image is larger than 15 MB');
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new Error('Remote image is larger than 15 MB');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

/** Strip scripts, event handlers, and external subresources from any SVG
 * image before it is handed to an <img> or Typst's virtual filesystem. */
export function sanitizeSvgImage(data: Uint8Array): Uint8Array {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  const fragment = sanitizedTypstSvg(text);
  const svg = fragment.querySelector('svg');
  if (!svg) throw new Error('Remote SVG has no valid SVG root');
  return new TextEncoder().encode(new XMLSerializer().serializeToString(svg));
}

async function fetchRemoteImage(url: URL): Promise<RemoteImageAsset> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Reject redirects: otherwise approving one visible origin could silently
    // send a request to a second, unapproved (or local) destination.
    const response = await fetch(url.href, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      mode: 'cors',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Remote image returned HTTP ${response.status}`);
    const mime = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    const extension = MIME_EXTENSIONS.get(mime);
    if (!extension) throw new Error('Remote response is not a supported image type');
    let data = await readBounded(response);
    if (mime === 'image/svg+xml') data = sanitizeSvgImage(data);
    if (cachedBytes + data.byteLength > MAX_CACHE_BYTES) {
      throw new Error('Remote image cache limit reached (64 MB)');
    }
    cachedBytes += data.byteLength;
    const objectUrl = URL.createObjectURL(new Blob([data.slice().buffer], { type: mime }));
    return { data, extension, mime, objectUrl };
  } finally {
    window.clearTimeout(timer);
  }
}

/** Fetch a previously approved image once and share the inert result. */
export function loadRemoteImage(src: string): Promise<RemoteImageAsset> {
  const status = remoteImageStatus(src);
  if (!status?.url || !status.origin) {
    return Promise.reject(new Error(status?.reason ?? 'Invalid remote image URL'));
  }
  if (!status.allowed) return Promise.reject(new Error(`Permission required for ${status.host}`));
  const key = status.url.href;
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = fetchRemoteImage(status.url).catch((error) => {
    // Keep a rejected promise cached so background pagination cannot hammer a
    // failing host after each edit. Only a visible user retry clears it.
    failed.add(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

export function retryRemoteImage(src: string): void {
  const status = remoteImageStatus(src);
  const key = status?.url?.href;
  if (!key || !failed.has(key)) return;
  failed.delete(key);
  cache.delete(key);
}
