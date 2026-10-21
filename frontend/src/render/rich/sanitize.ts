// Sanitizers for the output of the rich renderers (DESIGN §5.14 #7, §6.7). KaTeX (trust off) and
// Mermaid (securityLevel 'strict') already escape what they render; these are the second layer, and
// the only one the app controls. Each returns a DOM fragment, so the sanitized markup is never
// serialized and parsed again (no mutation-XSS window). The note HTML sanitizer in render.ts is
// separate: it forbids `<style>`, which Mermaid's SVG needs.
import DOMPurify from 'dompurify';

type Purifier = ReturnType<typeof DOMPurify>;

const REMOTE = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const CSS_REMOTE_URL = /url\(\s*(['"]?)\s*(?!#|data:image\/(?:png|gif|jpeg|webp);)[^)]*\)/gi;

/** Removes `position: fixed|sticky` and `z-index` (as for note HTML) and remote `url(…)`s. */
function cleanStyleAttribute(node: Element): void {
  const style = node.getAttribute('style');
  if (!style) return;
  const cleaned = style
    .split(';')
    .filter((decl) => {
      const [prop, value = ''] = decl.split(':').map((s) => s.trim().toLowerCase());
      if (prop === 'z-index') return false;
      if (prop === 'position' && /fixed|sticky/.test(value)) return false;
      return decl.trim() !== '';
    })
    .join(';')
    .replace(CSS_REMOTE_URL, 'none');
  if (cleaned) node.setAttribute('style', cleaned);
  else node.removeAttribute('style');
}

let mathPurifier: Purifier | null = null;

/** KaTeX output: HTML and MathML (with KaTeX's inline SVG for stretchy symbols). No links, images or styles. */
export function sanitizeMath(html: string): DocumentFragment {
  if (!mathPurifier) {
    mathPurifier = DOMPurify(window);
    mathPurifier.addHook('afterSanitizeAttributes', cleanStyleAttribute);
  }
  return mathPurifier.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    // KaTeX's MathML keeps the TeX source in <semantics><annotation encoding="application/x-tex">.
    ADD_TAGS: ['semantics', 'annotation'],
    ADD_ATTR: ['encoding'],
    FORBID_TAGS: ['a', 'img', 'image', 'style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'foreignobject', 'use'],
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment;
}

let svgPurifier: Purifier | null = null;

/**
 * Mermaid output: SVG with its scoped `<style>` and, for HTML labels, `<foreignObject>` HTML.
 * Remote references (`<image href="https://…">`, `url(https://…)`) are dropped, so a diagram never
 * fetches from other hosts; `<a>` is unwrapped (strict mode has no links, this makes sure).
 */
export function sanitizeSvg(svg: string): DocumentFragment {
  if (!svgPurifier) {
    svgPurifier = DOMPurify(window);
    svgPurifier.addHook('afterSanitizeAttributes', (node) => {
      if (!(node instanceof Element)) return;
      cleanStyleAttribute(node);
      for (const name of ['href', 'xlink:href', 'src']) {
        const value = node.getAttribute(name);
        if (value !== null && REMOTE.test(value)) node.removeAttribute(name);
      }
    });
    svgPurifier.addHook('uponSanitizeElement', (node, data) => {
      // CSS inside the SVG's own <style>: no remote url(), no @import.
      if (data.tagName === 'style' && node.textContent) {
        node.textContent = node.textContent.replace(/@import[^;]*;?/gi, '').replace(CSS_REMOTE_URL, 'none');
      }
    });
  }
  return svgPurifier.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject', 'style'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: ['a', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'img'],
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment;
}
