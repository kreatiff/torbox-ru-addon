import { useEffect } from 'react';

const OPEN_CLASS = 'tooltip-open';

/**
 * `[data-tooltip]` tooltips are CSS `:hover` only, so on a touch device they
 * can never be read at all -- the element still advertises itself (a
 * homoglyph's red underline, an episode square) with no way to find out what
 * it is saying. The mobile UI made that gap reachable by many more people.
 *
 * Where the pointer has no hover, treat a tap as the hover: mark the tapped
 * element open, and let the next tap anywhere else close it. Registered once,
 * globally, on `document` rather than per element, so nothing that renders a
 * tooltip needs to know this exists -- including tooltips added later.
 *
 * No-op on anything with a real hover (that includes touch laptops, which
 * report `hover: hover` and already work), so the desktop path is untouched.
 */
export function useTapTooltips(): void {
  useEffect(() => {
    if (window.matchMedia('(hover: hover)').matches) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const tapped =
        event.target instanceof Element ? event.target.closest('[data-tooltip]') : null;

      for (const open of document.querySelectorAll(`.${OPEN_CLASS}`)) {
        if (open !== tapped) {
          open.classList.remove(OPEN_CLASS);
        }
      }
      // Toggle rather than add, so tapping the same element twice dismisses
      // it instead of leaving it stuck open.
      tapped?.classList.toggle(OPEN_CLASS);
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);
}
