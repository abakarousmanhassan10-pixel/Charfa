/**
 * Role-based access control shared by the API (enforcement) and the web app (UI hints only).
 * The API is the single source of truth: the UI must never be relied on for authorization.
 */
export const BUSINESS_ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

export const PERMISSIONS = [
  'business.read',
  'business.update',
  'business.delete',
  'members.read',
  'members.manage',
  'catalog.read',
  'catalog.write',
  'content.read',
  'content.write',
  'content.approve',
  'publication.schedule',
  'social.read',
  'social.manage',
  'inbox.read',
  'inbox.reply',
  'analytics.read',
  'billing.read',
  'billing.manage',
  'ai.use',
  'audit.read',
  'media.read',
  'media.write',
  'knowledge.read',
  'knowledge.write',
  'knowledge.verify',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  'business.read',
  'members.read',
  'catalog.read',
  'content.read',
  'social.read',
  'inbox.read',
  'analytics.read',
  'media.read',
  'knowledge.read',
];

const EDITOR: Permission[] = [
  ...VIEWER,
  'catalog.write',
  'content.write',
  'inbox.reply',
  'ai.use',
  'media.write',
  'knowledge.write',
];

const ADMIN: Permission[] = [
  ...EDITOR,
  'business.update',
  'members.manage',
  'content.approve',
  'publication.schedule',
  'social.manage',
  'billing.read',
  'audit.read',
  // Verifying knowledge = approving facts the AI may state to customers: a management decision.
  'knowledge.verify',
];

const OWNER: Permission[] = [...ADMIN, 'business.delete', 'billing.manage'];

export const ROLE_PERMISSIONS: Readonly<Record<BusinessRole, ReadonlySet<Permission>>> = {
  VIEWER: new Set(VIEWER),
  EDITOR: new Set(EDITOR),
  ADMIN: new Set(ADMIN),
  OWNER: new Set(OWNER),
};

export function roleHasPermission(role: BusinessRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

const ROLE_RANK: Record<BusinessRole, number> = { VIEWER: 0, EDITOR: 1, ADMIN: 2, OWNER: 3 };

/** True when `actor` may assign/modify a member holding `target` role. Only higher ranks can manage lower ones. */
export function canManageRole(actor: BusinessRole, target: BusinessRole): boolean {
  if (actor === 'OWNER') return true;
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

export const PLATFORM_ROLES = ['USER', 'SUPPORT', 'SUPER_ADMIN'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
