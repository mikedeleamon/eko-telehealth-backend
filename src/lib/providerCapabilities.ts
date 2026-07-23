/**
 * Capability matrix for appointment-based provider types (Batch 3 Phase 2).
 * Per-type capabilities are enforced here, at the clinical-authoring
 * endpoints — not as a schema fork or a second copy of the doctor machinery.
 */
export type AppointmentProviderType = 'Doctor' | 'Nurse' | 'Therapist';

/** The only provider types that ever land in the `doctors` table. */
export const APPOINTMENT_PROVIDER_TYPES: AppointmentProviderType[] = ['Doctor', 'Nurse', 'Therapist'];

interface ProviderCapabilities {
  canPrescribe: boolean;
  canOrderLabs: boolean;
  canAuthorNotes: boolean;
}

/**
 * Locked-in decision (2026-07-22, conservative option): only Doctor can
 * prescribe or order labs. Nurse and Therapist can still author their own
 * visit notes, same as a Doctor — but writing prescriptions or ordering labs
 * stays Doctor-only until there's a real licensing basis to widen it.
 */
const CAPABILITIES: Record<AppointmentProviderType, ProviderCapabilities> = {
  Doctor: { canPrescribe: true, canOrderLabs: true, canAuthorNotes: true },
  Nurse: { canPrescribe: false, canOrderLabs: false, canAuthorNotes: true },
  Therapist: { canPrescribe: false, canOrderLabs: false, canAuthorNotes: true },
};

export function capabilitiesFor(providerType: AppointmentProviderType): ProviderCapabilities {
  return CAPABILITIES[providerType] ?? CAPABILITIES.Doctor;
}
