import type { Visibility } from '@dnd/contracts';
import { canRead, type VisibilitySubject } from './VisibilityPolicy.js';

export interface VisibleResource {
  id: string;
  visibility: Visibility;
  knownBy: string[];
}

export interface ProjectableState {
  facts: VisibleResource[];
}

export class ProjectionService {
  projectFacts(subject: VisibilitySubject, state: ProjectableState): VisibleResource[] {
    return state.facts.filter((fact) => canRead(subject, fact.visibility, fact.knownBy));
  }
}
