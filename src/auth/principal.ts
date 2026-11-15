/**
 * The authenticated caller. Every data-layer call receives a Principal, so authorization
 * decisions (masking today, row-level scoping tomorrow) live next to the data, not in tools.
 */
export const ROLES = ['analyst', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  /** Stable user identifier (JWT `sub`, or the configured local user for stdio). */
  readonly subject: string;
  readonly role: Role;
  /** How the identity was established; recorded in the audit log. */
  readonly authMethod: 'stdio' | 'jwt';
}

/** Central permission checks. Add new capabilities here rather than comparing roles ad hoc. */
export const Permissions = {
  viewCustomerPii: (p: Principal): boolean => p.role === 'admin',
} as const;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
