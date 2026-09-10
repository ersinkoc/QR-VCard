/**
 * Short-code alphabet: base58-style, no 0/O/1/l/I so a code read from a
 * printed QR or typed by hand is unambiguous.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function generateCode(length = 7): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}
