import en from '../messages/en.json';
import fr from '../messages/fr.json';
import { getMessages, resolveLocale, translate } from './i18n';

function keys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe('i18n', () => {
  it('French catalog has exactly the same keys as English', () => {
    expect(keys(fr).sort()).toEqual(keys(en).sort());
  });
  it('resolves locale from cookie, then Accept-Language, then default', () => {
    expect(resolveLocale('fr', 'en-US')).toBe('fr');
    expect(resolveLocale(undefined, 'fr-FR,fr;q=0.9,en;q=0.8')).toBe('fr');
    expect(resolveLocale('xx', 'de-DE')).toBe('en');
  });
  it('translates with interpolation and falls back to the key', () => {
    const m = getMessages('fr');
    expect(translate(m, 'dashboard.greeting', { name: 'Awa' })).toBe('Bonjour, Awa');
    expect(translate(m, 'missing.key')).toBe('missing.key');
  });
});
