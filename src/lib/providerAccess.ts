import type { AccountType } from './jwt';

/**
 * Whether an account is any kind of provider — Doctor (legacy) or the
 * generic Provider bucket every other provider type uses. The SPECIFIC
 * domain type (Therapist, Nurse, Pharmacy, ...) is never on `accountType`
 * itself — it lives on `providerApplications.type` and, once approved, the
 * entity created for it. See db/schema.ts's users.accountType doc comment.
 */
export function isProviderAccountType(accountType: AccountType): accountType is 'Doctor' | 'Provider' {
  return accountType === 'Doctor' || accountType === 'Provider';
}
