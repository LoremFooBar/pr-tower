import { useEffect, useRef } from "preact/hooks";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The four things a modal owes a keyboard: it takes focus, it keeps focus, it
 * closes on Escape, and it gives focus back to whatever opened it. The page
 * behind it also stops scrolling. This is the whole reason to reach for a
 * component library — and the whole of what that library would do here.
 */
export function useModal<T extends HTMLElement>(onClose: () => void, active = true) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;

    const opener = document.activeElement as HTMLElement | null;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    const previousOverflow = document.body.style.overflow;
    const previousPadding = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    // Compensating for the scrollbar keeps the board from jumping sideways as
    // the dialog opens.
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;

    const first = node.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node).focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !node) return;

      const stops = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null,
      );
      if (stops.length === 0) return;
      const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
      if (document.activeElement === edge) {
        event.preventDefault();
        (event.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPadding;
      opener?.focus?.();
    };
  }, [active, onClose]);

  return ref;
}
