import { Permissions, type Principal } from '../auth/principal.js';

/**
 * PII masking applied inside the data layer.
 *
 * Masking keeps the first character of each name part so analysts can still tell records apart
 * in a list ("J*** S***"), while the full value stays hidden. Lengths are normalised to three
 * asterisks so the mask does not leak name length.
 */
export function maskName(fullName: string): string {
  return fullName
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0)}***`)
    .join(' ');
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.charAt(0)}***@${email.slice(at + 1)}`;
}

/** Bundles the decision and the masking functions so repository code reads clearly. */
export function piiPolicyFor(principal: Principal): {
  masked: boolean;
  name: (v: string) => string;
  email: (v: string) => string;
} {
  const canView = Permissions.viewCustomerPii(principal);
  return {
    masked: !canView,
    name: canView ? (v) => v : maskName,
    email: canView ? (v) => v : maskEmail,
  };
}
