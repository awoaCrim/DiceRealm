/**
 * Future promotion seams are re-exported from the shared contract so server
 * callers depend on a stable port without introducing long-term SQL tables in
 * this task.
 */
export type {
  ActorKnowledgeRepository,
  ActorKnowledgeUpdateProposal,
  RuntimeFactPromotionCommand,
  RuntimeFactPromotionResult,
  RuntimeFactRepository,
} from '@dnd/contracts';

export type {
  CandidateNarrativeFact,
  NarrativeFactExtractionInput,
  NarrativeFactExtractor,
  RoundCloseContributor,
  RoundCloseContributorInput,
} from '@dnd/contracts';
