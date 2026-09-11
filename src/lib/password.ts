/** Unambiguous characters: a generated password is often read out or typed by hand. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export function generatePassword(length = 14): string {
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out.push(ALPHABET[b % ALPHABET.length]!);
    }
  }
  return out.join('');
}
