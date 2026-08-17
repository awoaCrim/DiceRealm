import { markStateChangeValidated, type ProposedStateChange, type ValidatedStateChange } from '@dnd/contracts';

/**
 * Server-owned construction seam for the opaque ValidatedStateChange brand.
 * Contract parsing alone is never enough to call a materializer.
 */
export function createValidatedStateChange(change: ProposedStateChange): ValidatedStateChange {
  return markStateChangeValidated(change);
}
