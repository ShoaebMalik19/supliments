export const ROLES = ["owner", "admin", "member", "designer", "read_only"] as const;
export type Role = (typeof ROLES)[number];

const PERMISSIONS = {
  "org:read": ROLES,
  "org:update": ["owner", "admin"],
  "members:manage": ["owner", "admin"],
  "brand:write": ["owner", "admin", "member"],
  "label:write": ["owner", "admin", "member", "designer"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
