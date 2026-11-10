/**
 * How a person's name is written everywhere a card shows it: the given name
 * capitalised word by word ("ayşe gül" → "Ayşe Gül"), the family name in
 * capitals ("yılmaz" → "YILMAZ"). Turkish casing rules apply (i ↔ İ, ı ↔ I),
 * since the cards are Turkish first.
 *
 * Pure JavaScript, no Node imports: the browser bundle imports this file too,
 * so names saved by the server and names shown from older rows agree.
 */

const LOCALE = 'tr-TR';

/** "aYŞE-gül" → "Ayşe-Gül": every word (also after a hyphen or apostrophe) gets one capital. */
export function formatGivenName(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .split(/([\s\-'’]+)/u)
    .map((part, i) => (i % 2 === 1 || part === '' ? part : part.charAt(0).toLocaleUpperCase(LOCALE) + part.slice(1).toLocaleLowerCase(LOCALE)))
    .join('');
}

/** "yılmaz" → "YILMAZ", "işçi" → "İŞÇİ". */
export function formatFamilyName(value) {
  if (value === null || value === undefined) return value;
  return String(value).toLocaleUpperCase(LOCALE);
}
