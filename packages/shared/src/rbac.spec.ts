import { canManageRole, roleHasPermission } from './rbac';
import { registerSchema } from './auth.schemas';
import { textDirection } from './i18n';

describe('RBAC matrix', () => {
  it('viewer is read-only', () => {
    expect(roleHasPermission('VIEWER', 'content.read')).toBe(true);
    expect(roleHasPermission('VIEWER', 'content.write')).toBe(false);
    expect(roleHasPermission('VIEWER', 'ai.use')).toBe(false);
  });
  it('editor cannot approve or manage billing', () => {
    expect(roleHasPermission('EDITOR', 'content.write')).toBe(true);
    expect(roleHasPermission('EDITOR', 'content.approve')).toBe(false);
    expect(roleHasPermission('EDITOR', 'billing.manage')).toBe(false);
  });
  it('only owner can delete the business or manage billing', () => {
    expect(roleHasPermission('ADMIN', 'business.delete')).toBe(false);
    expect(roleHasPermission('ADMIN', 'billing.manage')).toBe(false);
    expect(roleHasPermission('OWNER', 'business.delete')).toBe(true);
    expect(roleHasPermission('OWNER', 'billing.manage')).toBe(true);
  });
  it('role management respects hierarchy', () => {
    expect(canManageRole('ADMIN', 'EDITOR')).toBe(true);
    expect(canManageRole('ADMIN', 'ADMIN')).toBe(false);
    expect(canManageRole('ADMIN', 'OWNER')).toBe(false);
    expect(canManageRole('EDITOR', 'VIEWER')).toBe(true);
    expect(canManageRole('OWNER', 'OWNER')).toBe(true);
  });
});

describe('registerSchema', () => {
  it('normalises email and rejects weak passwords', () => {
    const ok = registerSchema.parse({
      email: '  Alice@Example.COM ',
      password: 'Sup3rSecurePass',
      fullName: 'Alice',
    });
    expect(ok.email).toBe('alice@example.com');
    expect(ok.locale).toBe('en');
    expect(registerSchema.safeParse({ email: 'a@b.co', password: 'short', fullName: 'A' }).success).toBe(false);
    expect(registerSchema.safeParse({ email: 'a@b.co', password: 'alllowercase123', fullName: 'A' }).success).toBe(false);
  });
});

describe('textDirection', () => {
  it('detects RTL locales', () => {
    expect(textDirection('ar')).toBe('rtl');
    expect(textDirection('ar-MA')).toBe('rtl');
    expect(textDirection('fr')).toBe('ltr');
  });
});

import { businessInputSchema } from './business.schemas';

describe('businessInputSchema', () => {
  it('normalises and defaults', () => {
    const v = businessInputSchema.parse({ name: '  Café Awa ', type: 'RESTAURANT', country: 'td', website: '' });
    expect(v).toMatchObject({ name: 'Café Awa', country: 'TD', timezone: 'UTC', currency: 'USD', defaultLocale: 'en' });
    expect(v.website).toBeUndefined();
  });
  it('rejects invalid timezone, website and type', () => {
    expect(businessInputSchema.safeParse({ name: 'Ab', type: 'OTHER', timezone: 'Mars/Base' }).success).toBe(false);
    expect(businessInputSchema.safeParse({ name: 'Ab', type: 'OTHER', website: 'javascript:alert(1)' }).success).toBe(false);
    expect(businessInputSchema.safeParse({ name: 'Ab', type: 'SPACESHIP' }).success).toBe(false);
  });
});
