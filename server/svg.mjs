/**
 * SVG logos. Images are served from the app's own origin, so an SVG that runs
 * script would be stored XSS the moment someone opens its URL directly. Uploads
 * are therefore refused — not "cleaned" — when they carry anything active, and
 * every SVG response additionally ships a sandboxing CSP (SVG_HEADERS).
 */

/** Response headers for an SVG body: no script, no network, no plugins, even when opened directly. */
export const SVG_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  'X-Content-Type-Options': 'nosniff',
};

/** Whether the buffer is an SVG document (BOM, XML prolog and comments may precede the root). */
export function sniffSvg(buf) {
  let text = buf.subarray(0, 2048).toString('utf8').replace(/^﻿/, '');
  // Prolog, comments, whitespace: everything a real file may put before <svg.
  for (;;) {
    const trimmed = text.replace(/^\s+/, '');
    if (trimmed.startsWith('<?')) text = trimmed.slice(trimmed.indexOf('?>') + 2 || trimmed.length);
    else if (/^<!DOCTYPE/i.test(trimmed)) {
      // Recognised (so unsafeSvg can refuse it by name), internal subset included.
      const subset = trimmed.indexOf('[');
      const close = trimmed.indexOf('>');
      const end = subset >= 0 && subset < close ? trimmed.indexOf(']>') + 2 : close + 1;
      if (end <= 1) return false;
      text = trimmed.slice(end);
    } else if (trimmed.startsWith('<!--')) {
      const end = trimmed.indexOf('-->');
      if (end < 0) return false;
      text = trimmed.slice(end + 3);
    } else {
      text = trimmed;
      break;
    }
  }
  return /^<svg[\s>]/i.test(text);
}

/**
 * The reason an SVG is refused, or null when it is plain vector artwork.
 * Deliberately strict: logos exported from design tools never need any of this.
 */
export function unsafeSvg(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return 'doctype';
  // Every name check allows an XML namespace prefix: `<x:script xmlns:x="…svg">`
  // IS a script element, and `x:onload=` an event handler.
  if (/<(?:[\w.-]+:)?script[\s>/]/i.test(text)) return 'script';
  if (/<(?:[\w.-]+:)?foreignObject[\s>/]/i.test(text)) return 'foreignObject';
  if (/<(?:[\w.-]+:)?(?:iframe|embed|object|audio|video|animate|set|handler|listener)[\s>/]/i.test(text)) return 'embed';
  // Logos are SVG; markup from other vocabularies (XHTML, XSLT, XML Events…) is not.
  if (/http:\/\/www\.w3\.org\/(?:1999\/xhtml|1999\/XSL|2001\/xml-events)/i.test(text)) return 'foreign-namespace';
  if (/<\?xml-stylesheet/i.test(text)) return 'stylesheet-pi';
  if (/\s(?:[\w.-]+:)?on[a-z]+\s*=/i.test(text)) return 'event-handler';
  if (/javascript:|vbscript:/i.test(text)) return 'script-url';
  // Links may only point inside the document or at an inline raster image.
  for (const m of text.matchAll(/(?:[\w.-]+:)?href\s*=\s*(["'])(.*?)\1/gis)) {
    const href = m[2].trim();
    if (!href.startsWith('#') && !/^data:image\/(?:png|jpe?g|gif|webp);/i.test(href)) return 'external-href';
  }
  // CSS can fetch too: url(...) outside the document and @import.
  if (/@import/i.test(text)) return 'css-import';
  for (const m of text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)) {
    const ref = m[2].trim();
    if (!ref.startsWith('#') && !/^data:image\/(?:png|jpe?g|gif|webp);/i.test(ref)) return 'css-url';
  }
  return null;
}
