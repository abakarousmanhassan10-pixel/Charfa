import { randomBytes } from 'crypto';

/** URL-safe slug with a random suffix: unique without revealing how many businesses exist. */
export function businessSlug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const suffix = randomBytes(4).toString('hex').slice(0, 6);
  return `${base || 'business'}-${suffix}`;
}
