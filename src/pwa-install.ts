// Install UX for the hosted app. Installation is progressive enhancement:
// Chromium exposes beforeinstallprompt, while Safari and other browsers use
// their own menu commands. Plass never installs or starts a local executable.

interface DeferredInstallPrompt extends Event {
  prompt(): Promise<void>;
  readonly userChoice?: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

type InstallStateListener = (installed: boolean) => void;

const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
let installed = window.matchMedia('(display-mode: standalone)').matches
  || standaloneNavigator.standalone === true;
let deferredPrompt: DeferredInstallPrompt | null = null;
const listeners = new Set<InstallStateListener>();

function notify() {
  for (const listener of listeners) listener(installed);
}

window.addEventListener('beforeinstallprompt', (event) => {
  const candidate = event as DeferredInstallPrompt;
  if (typeof candidate.prompt !== 'function') return;
  event.preventDefault();
  deferredPrompt = candidate;
  notify();
});

window.addEventListener('appinstalled', () => {
  installed = true;
  deferredPrompt = null;
  notify();
});

export function isPwaInstalled(): boolean {
  return installed;
}

export function onPwaInstallState(listener: InstallStateListener): () => void {
  listeners.add(listener);
  listener(installed);
  return () => listeners.delete(listener);
}

function manualInstallGuidance(): string {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/i.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS) return 'To install Plass, tap Share, then Add to Home Screen';

  const safari = /Safari/i.test(ua) && !/(?:Chrome|Chromium|CriOS|Edg|OPR|Android)/i.test(ua);
  if (safari) return 'To install Plass in Safari, choose File → Add to Dock';

  return 'Use your browser menu to install Plass; Chrome and Edge provide an Install Plass command';
}

export async function requestPwaInstall(message: (text: string) => void): Promise<void> {
  if (installed) {
    message('Plass is already installed');
    return;
  }

  const prompt = deferredPrompt;
  if (!prompt) {
    message(manualInstallGuidance());
    return;
  }

  // A BeforeInstallPromptEvent may be used only once. A browser can emit a
  // fresh event later; until then the toolbar action falls back to guidance.
  deferredPrompt = null;
  try {
    await prompt.prompt();
    const choice = prompt.userChoice ? await prompt.userChoice : null;
    if (choice?.outcome === 'dismissed') {
      message('Installation canceled; you can try again from your browser menu');
    }
  } catch (error) {
    console.warn('Browser install prompt failed', error);
    message(manualInstallGuidance());
  }
}
