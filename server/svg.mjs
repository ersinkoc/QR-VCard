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

/** Elements that run, embed or animate content: never needed by a logo. */
const ACTIVE_ELEMENTS = new Set(['iframe', 'embed', 'object', 'audio', 'video', 'animate', 'set', 'handler', 'listener', 'discard']);

/** `ş:Script` → `script`: the part after the last colon, lowercased. */
const localName = (qname) => qname.slice(qname.lastIndexOf(':') + 1).toLowerCase();

/**
 * The reason an SVG is refused, or null when it is plain vector artwork.
 * Deliberately strict: logos exported from design tools never need any of this.
 */
export function unsafeSvg(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return 'doctype';
  // Names are judged by their LOCAL part, whatever the prefix: XML prefixes may
  // use any Unicode letters, and `<ş:script xmlns:ş="…/svg">` IS a script
  // element (`ş:onload=` an event handler). So every element and attribute
  // name in the text is extracted and its part after the last ':' checked —
  // a scan of the whole text, so a '>' inside a quoted value hides nothing.
  for (const m of text.matchAll(/<\s*([^\s<>/!?"'=]+)/gu)) {
    const local = localName(m[1]);
    if (local === 'script') return 'script';
    if (local === 'foreignobject') return 'foreignObject';
    if (ACTIVE_ELEMENTS.has(local)) return 'embed';
  }
  for (const m of text.matchAll(/[\s"']([^\s<>/!?"'=]+)\s*=/gu)) {
    if (localName(m[1]).startsWith('on')) return 'event-handler';
  }
  // Logos are SVG; markup from other vocabularies (XHTML, XSLT, XML Events…) is not.
  if (/http:\/\/www\.w3\.org\/(?:1999\/xhtml|1999\/XSL|2001\/xml-events)/i.test(text)) return 'foreign-namespace';
  if (/<\?xml-stylesheet/i.test(text)) return 'stylesheet-pi';
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
