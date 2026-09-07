// Desktop detection. The preload bridge (window.desktop) exists ONLY inside
// the Electron packing app — never in Chrome/Edge, so web behaviour is
// untouched by every desktop* code path.
import type { DesktopApi } from '../types/desktop';

function getWindow(): { desktop?: DesktopApi } | undefined {
  const w = (globalThis as { window?: { desktop?: DesktopApi } }).window;
  if (w) return w;
  if (typeof window !== 'undefined') return window as unknown as { desktop?: DesktopApi };
  return undefined;
}

export function getDesktopApi(): DesktopApi | null {
  const bridge = getWindow()?.desktop;
  return bridge?.isDesktop === true ? bridge : null;
}

export function isDesktopApp(): boolean {
  return getDesktopApi() !== null;
}
