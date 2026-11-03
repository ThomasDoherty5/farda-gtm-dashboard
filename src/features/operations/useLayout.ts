import { useEffect, useState } from "react";

export type Layout = "mobile" | "tablet" | "desktop";

const MOBILE = "(max-width: 767px)";
const TABLET = "(max-width: 1179px)";

const read = (): Layout => {
  if (typeof window === "undefined" || !window.matchMedia) return "desktop";
  return window.matchMedia(MOBILE).matches ? "mobile" : window.matchMedia(TABLET).matches ? "tablet" : "desktop";
};

/**
 * Which native Figma composition to render. Operations has designs at 390, 1024 and 1440 that differ in content,
 * not just in layout, so the page picks one rather than hiding duplicated markup with CSS.
 */
export function useLayout(): Layout {
  const [layout, setLayout] = useState<Layout>(read);
  useEffect(() => {
    if (!window.matchMedia) return;
    const queries = [window.matchMedia(MOBILE), window.matchMedia(TABLET)];
    const update = () => setLayout(read());
    queries.forEach((q) => q.addEventListener("change", update));
    return () => queries.forEach((q) => q.removeEventListener("change", update));
  }, []);
  return layout;
}
