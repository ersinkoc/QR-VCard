import { describe, expect, it } from 'vitest';
import { formatFamilyName, formatGivenName } from './person-name.mjs';
import { validateCardInput, validateUserInput } from './validate.mjs';

describe('person names', () => {
  it('capitalises every given name and writes the family name in capitals, the Turkish way', () => {
    expect(formatGivenName('ayşe gül')).toBe('Ayşe Gül');
    expect(formatGivenName('İSMAİL')).toBe('İsmail');
    expect(formatGivenName('ismail')).toBe('İsmail');
    expect(formatGivenName('ılgaz')).toBe('Ilgaz');
    expect(formatGivenName('ayşe-gül')).toBe('Ayşe-Gül');
    expect(formatGivenName('  ada  ')).toBe('  Ada  ');
    expect(formatFamilyName('yılmaz')).toBe('YILMAZ');
    expect(formatFamilyName('işçi')).toBe('İŞÇİ');
    expect(formatFamilyName('Öztürk')).toBe('ÖZTÜRK');
    expect(formatGivenName(null)).toBeNull();
    expect(formatFamilyName(undefined)).toBeUndefined();
  });

  it('stores cards and accounts in that spelling', () => {
    expect(validateCardInput({ first_name: 'aYŞE gül', last_name: 'yılmaz' }).data).toMatchObject({ first_name: 'Ayşe Gül', last_name: 'YILMAZ' });
    expect(validateUserInput({ first_name: 'ada', last_name: 'lovelace' }, { partial: true }).data).toEqual({ first_name: 'Ada', last_name: 'LOVELACE' });
    // Clearing still clears.
    expect(validateCardInput({ first_name: '', last_name: 'x' }, { partial: true }).data).toEqual({ first_name: null, last_name: 'X' });
  });
});
