/**
 * Selector escaping.
 *
 * Every selector-generating path in CBrowser used to interpolate raw values
 * straight into a selector string — `#${el.id}`, `[aria-label="${label}"]`. That
 * is only safe if the value happens to be a valid CSS identifier, and in modern
 * apps it frequently isn't. Verified against a real Chromium:
 *
 *   #:r0:        -> DOMException      (React 18 useId emits exactly this shape)
 *   #2fa-code    -> DOMException      (leading digit is invalid in CSS)
 *   #a.b         -> NO MATCH, no error (parsed as element#a with class b)
 *   [aria-label="He said "hi""] -> DOMException
 *
 * The third is the dangerous one: it throws nothing and quietly matches nothing,
 * so a test reports "element not found" and the selector looks fine in the report.
 *
 * These helpers are pure — no DOM — so they work in Node (where CSS.escape does
 * not exist) as well as inside page.evaluate. (2026-07-29)
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

/**
 * Escape a string for use as a CSS identifier, per the CSSOM spec's serialize-an
 * -identifier algorithm — the same algorithm as the browser's CSS.escape.
 */
export function escapeCssIdent(value: string): string {
  const str = String(value);
  const len = str.length;
  let result = "";
  const firstCode = str.charCodeAt(0);

  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);

    // NULL becomes the replacement character rather than terminating the string.
    if (code === 0x0000) {
      result += "�";
      continue;
    }

    if (
      // Control characters and DEL.
      (code >= 0x0001 && code <= 0x001f) ||
      code === 0x007f ||
      // A leading digit, or a digit right after a leading hyphen.
      (i === 0 && code >= 0x0030 && code <= 0x0039) ||
      (i === 1 && code >= 0x0030 && code <= 0x0039 && firstCode === 0x002d)
    ) {
      result += "\\" + code.toString(16) + " ";
      continue;
    }

    // A lone leading hyphen must be escaped.
    if (i === 0 && len === 1 && code === 0x002d) {
      result += "\\" + str.charAt(i);
      continue;
    }

    // Everything else that is already valid in an identifier passes through.
    if (
      code >= 0x0080 ||
      code === 0x002d ||
      code === 0x005f ||
      (code >= 0x0030 && code <= 0x0039) ||
      (code >= 0x0041 && code <= 0x005a) ||
      (code >= 0x0061 && code <= 0x007a)
    ) {
      result += str.charAt(i);
      continue;
    }

    result += "\\" + str.charAt(i);
  }

  return result;
}

/**
 * Escape a string for use inside a double-quoted attribute selector value.
 * Backslashes first, then the quote that would otherwise close the value early.
 */
export function escapeAttrValue(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** `#id`, safe for ids a framework generated rather than a human wrote. */
export function idSelector(id: string): string {
  return `#${escapeCssIdent(id)}`;
}

/** `[attr="value"]`, safe for values containing quotes or backslashes. */
export function attrSelector(attr: string, value: string): string {
  return `[${attr}="${escapeAttrValue(value)}"]`;
}
