import { expect, type Page } from "@playwright/test";

/** Waits for the H1 and for any loading status to clear. */
export async function settle(page: Page, url: string) {
  await expect(page.getByRole("heading", { level: 1 }), url).toBeVisible();
  // The state gallery shows a loading state on purpose.
  if (!url.startsWith("/design-system/states")) await expect(page.getByRole("status").filter({ hasText: /^Loading/ }), url).toHaveCount(0);
}

/**
 * Runs in the page. Returns one string per layout problem:
 *  - page: the document scrolls sideways
 *  - clipped: a control sits outside a clipping ancestor that is not a scrollable, focusable, named region
 *  - text: a control or heading's text is cut off by overflow hidden
 *  - overlap: two interactive controls cover the same pixels
 *  - target: a control is smaller than 24 by 24 CSS px and fails the WCAG 2.2 SC 2.5.8 exceptions (inline link, spacing)
 *  - region: a scrollable area that overflows has no name, role or keyboard focus
 */
export function auditLayout(): string[] {
  const problems: string[] = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth) problems.push(`page: scrolls sideways by ${doc.scrollWidth - doc.clientWidth}px`);

  // With a modal dialog open, the page behind it is covered and inert: only the dialog is audited.
  const modal = document.querySelector("dialog[open]");
  const inScope = (el: Element) => !modal || modal.contains(el);
  const describe = (el: Element) => {
    const text = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const cls = typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className.split(" ")[0] : "";
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""} "${text}"`;
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || n.getAttribute("aria-hidden") === "true" && n.tagName !== "BODY") return false;
    }
    return true;
  };
  const isScroller = (el: Element) => { const s = getComputedStyle(el); return /(auto|scroll)/.test(s.overflowX); };
  const focusableSel = 'a[href], button, input, select, textarea, summary, [tabindex]';
  const named = (el: Element) => el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby");
  /** A scroll region a keyboard user can reach: named, and focusable itself or holding something focusable. */
  const reachableScroller = (el: Element) => isScroller(el) && named(el) && ((el as HTMLElement).tabIndex >= 0 || !!el.querySelector(focusableSel));

  // Scroll regions that overflow must be reachable from the keyboard and named.
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (!inScope(el) || !isScroller(el) || el.scrollWidth <= el.clientWidth + 1 || !visible(el)) continue;
    if (!reachableScroller(el)) problems.push(`region: scrollable area is not named and reachable by keyboard: ${describe(el)}`);
  }

  const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="link"], [role="checkbox"], [role="switch"], [role="menuitem"]';
  const controls = Array.from(document.querySelectorAll(selector)).filter((el) => !el.closest(".skip-link") && !el.matches(".visually-hidden-focusable:not(:focus), .visually-hidden") && inScope(el) && visible(el) && !(el as HTMLInputElement).disabled);

  const hitRect = (el: Element): DOMRect => {
    // A checkbox or radio is activated through its label, so measure the label too.
    if (el instanceof HTMLInputElement && /^(checkbox|radio)$/.test(el.type)) {
      const label = el.labels?.[0];
      if (label) {
        const a = el.getBoundingClientRect(), b = label.getBoundingClientRect();
        const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top);
        return new DOMRect(left, top, Math.max(a.right, b.right) - left, Math.max(a.bottom, b.bottom) - top);
      }
    }
    return el.getBoundingClientRect();
  };

  for (const el of controls) {
    const r = hitRect(el);
    // Clipped by an ancestor
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const pr = p.getBoundingClientRect();
      const out = r.left < pr.left - 1 || r.right > pr.right + 1 || (s.overflowY !== "visible" && (r.top < pr.top - 1 || r.bottom > pr.bottom + 1));
      if (out) {
        if (!reachableScroller(p)) problems.push(`clipped: ${describe(el)} is cut off by ${describe(p)}`);
        break;
      }
    }
    // Off the page to the left or right (not inside a scroll region)
    if ((r.right > doc.clientWidth + 1 || r.left < -1) && !Array.from(document.querySelectorAll("*")).some((a) => a.contains(el) && a !== el && reachableScroller(a))) problems.push(`clipped: ${describe(el)} sits outside the viewport (${Math.round(r.left)}..${Math.round(r.right)})`);

    // Text cut off
    const hs = el as HTMLElement;
    const s = getComputedStyle(hs);
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    if (!field && /(hidden|clip)/.test(s.overflowX) && hs.scrollWidth > hs.clientWidth + 1 && hs.clientWidth > 0) problems.push(`text: ${describe(el)} is cut off (${hs.scrollWidth} > ${hs.clientWidth})`);
    if (s.textOverflow === "ellipsis" && hs.scrollWidth > hs.clientWidth + 1) problems.push(`text: ${describe(el)} is truncated with an ellipsis`);

    // Target size is checked below, once every control has been measured.
  }

  // Headings and body text that are cut off by overflow hidden
  for (const el of Array.from(document.querySelectorAll("h1, h2, h3, h4, p, th, td, label, li, dt, dd, [class*=badge], [class*=Badge]"))) {
    const hs = el as HTMLElement;
    if (!inScope(el) || !visible(el) || el.closest(".visually-hidden")) continue;
    const s = getComputedStyle(hs);
    if (/(hidden|clip)/.test(s.overflowX) && hs.scrollWidth > hs.clientWidth + 1) problems.push(`text: ${describe(el)} is cut off (${hs.scrollWidth} > ${hs.clientWidth})`);
  }

  // Target size (WCAG 2.2 SC 2.5.8): 24 by 24 CSS px, unless the target is an inline link in a sentence or, the spacing exception,
  // a 24px circle centred on the undersized target meets no other target and no other undersized target's circle.
  const sized = controls.map((el) => ({ el, r: hitRect(el) }));
  const small = sized.filter(({ r }) => r.width < 23.5 || r.height < 23.5);
  for (const a of small) {
    const inlineLink = a.el.tagName === "A" && getComputedStyle(a.el).display === "inline" && !!a.el.parentElement && (a.el.parentElement.textContent ?? "").trim().length > (a.el.textContent ?? "").trim().length + 2;
    if (inlineLink) continue;
    const cx = a.r.left + a.r.width / 2, cy = a.r.top + a.r.height / 2;
    const clash = sized.find((b) => {
      if (b === a || a.el.contains(b.el) || b.el.contains(a.el)) return false;
      // Distance from the circle's centre to the other target's box
      const dx = Math.max(b.r.left - cx, 0, cx - b.r.right), dy = Math.max(b.r.top - cy, 0, cy - b.r.bottom);
      if (Math.hypot(dx, dy) < 12) return true;
      return small.includes(b) && Math.hypot(b.r.left + b.r.width / 2 - cx, b.r.top + b.r.height / 2 - cy) < 24;
    });
    if (clash) problems.push(`target: ${describe(a.el)} is ${Math.round(a.r.width)}x${Math.round(a.r.height)} and too close to ${describe(clash.el)}`);
  }

  // Overlap between controls that are neither nested nor in the same row slot
  const rects = controls.map((el) => ({ el, r: hitRect(el) }));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!, b = rects[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.el instanceof HTMLInputElement && a.el.labels && Array.from(a.el.labels).some((l) => l.contains(b.el))) continue;
      if (b.el instanceof HTMLInputElement && b.el.labels && Array.from(b.el.labels).some((l) => l.contains(a.el))) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 2 && h > 2) problems.push(`overlap: ${describe(a.el)} and ${describe(b.el)} (${Math.round(w)}x${Math.round(h)}px)`);
    }
  }
  return Array.from(new Set(problems));
}
