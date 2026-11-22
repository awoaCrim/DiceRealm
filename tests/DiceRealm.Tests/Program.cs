using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using DiceRealm.Tests;
using Microsoft.Extensions.Configuration;

if (args.Length == 4 && args[0] == "--read-preload-prepare")
{
    await ReadPreloadAcceptance.Prepare(args[1], args[2], args[3]);
    return 0;
}

if (args.Length == 3 && args[0] == "--read-preload-acceptance")
{
    await ReadPreloadAcceptance.Run(args[1], args[2]);
    return 0;
}

if (args.Length == 4 && args[0] == "--history-semantics-acceptance")
{
    await HistorySemanticsAcceptance.Run(args[1], args[2], args[3]);
    return 0;
}

if (args.Length is 5 or 7 && args[0] == "--prompt-semantics-acceptance")
{
    await PromptSemanticsAcceptance.Run(args[1], args[2], args[3], args[4],
        args.Length == 7 ? args[5] : null, args.Length == 7 ? args[6] : null);
    return 0;
}

if (args.Length == 2 && args[0] == "--quick-retelling-browser")
{
    await QuickRetellingTests.Browser(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--narrative-check-browser")
{
    await NarrativeCheckBrowserFixture.Run(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--dm-overview-browser")
{
    await DmOverviewTests.Browser(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--timeline-browser")
{
    await TimelineBrowserFixture.Run(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--workbench-combat-browser")
{
    await WorkbenchCombatBrowserFixture.Run(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--game-saves-browser")
{
    await GameSaveBrowserFixture.Run(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--knowledge-browser")
{
    await KnowledgeBrowserFixture.Run(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--ruling-clarity-browser")
{
    await RulingBrowserFixture.Run(args[1]);
    return 0;
}

if (args.Length is >= 3 and <= 5 && args[0] == "--map-portrait-browser")
{
    await MapPortraitBrowserFixture.Run(args[1], args[2], args.Length >= 4 ? args[3] : null, args.Length == 5 ? args[4] : null);
    return 0;
}

if (args.Length is >= 3 and <= 5 && args[0] == "--dm-position-browser")
{
    await OpeningBrowserFixture.Run(args[1], args[2], args.Length >= 4 ? args[3] : null, positionAndRolls: true, resumeUrl: args.Length == 5 ? args[4] : null);
    return 0;
}

if (args.Length is 2 or 3 && args[0] == "--play-browser" && (args.Length == 2 || args[2] == "opening"))
{
    await PlayBrowserFixture.Run(args[1], opening: args.Length == 3);
    return 0;
}

if (args.Length is 3 or 4 && args[0] == "--opening-browser")
{
    await OpeningBrowserFixture.Run(args[1], args[2], args.Length == 4 ? args[3] : null);
    return 0;
}

if (args.Length == 2 && args[0] == "--opening-library-local")
{
    await AdventureLibraryTests.OpeningLibraryAcceptance(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--adventure-library-local")
{
    await AdventureLibraryTests.LocalLibraryAcceptance(args[1]);
    return 0;
}

if (args.Length == 3 && args[0] == "--adventure-library-browser")
{
    await AdventureLibraryTests.BrowserFixture(args[1], args[2]);
    return 0;
}

if (args.Length == 2 && args[0] == "--item-search-rules")
{
    await HarnessItemSearchTests.MaintainedPackage(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--supplies-prompt-browser")
{
    await HarnessSupplyTests.BrowserFixture(args[1]);
    return 0;
}
if (args.Length == 2 && args[0] == "--supplies-rules")
{
    await HarnessSupplyTests.MaintainedAliases(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--remaining-ui-browser")
{
    await RemainingUiAcceptanceFixture.Run(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--ux-audit-browser")
{
    await UxAuditFixture.Run(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--equipment-pack-browser")
{
    await EquipmentPackTests.NativeFixture(args[1]);
    return 0;
}

if (args.Length is >= 3 and <= 4 && args[0] == "--experience-browser")
{
    await FullBuildBrowserFixture.Run(args[1], args[2], args.Length == 4 ? args[3] : null, automaticMaps: true, configurationProbe: true);
    return 0;
}

if (args.Length is >= 3 and <= 4 && args[0] == "--room-browser")
{
    await FullBuildBrowserFixture.Run(args[1], args[2], args.Length == 4 ? args[3] : null, automaticMaps: true);
    return 0;
}

if (args.Length is >= 2 and <= 4 && args[0] == "--full-build-browser")
{
    await FullBuildBrowserFixture.Run(args[1], args.Length >= 3 ? args[2] : null, args.Length == 4 ? args[3] : null);
    return 0;
}

if (args.Length == 3 && args[0] == "--resume-player-actions-browser")
{
    await PlayerActionsBrowserFixture.Resume(args[1], args[2]);
    return 0;
}

if (args.Length == 2 && args[0] == "--player-actions-browser")
{
    await PlayerActionsBrowserFixture.Run(args[1]);
    return 0;
}

if (args.Length is >= 2 and <= 4 && args[0] == "--play-combat-browser")
{
    var options = args.Skip(2).ToArray();
    await PlayCombatBrowserFixture.Run(args[1], options.FirstOrDefault(a => a is "wizard" or "caster" or "party") ?? "fighter", options.Contains("random"));
    return 0;
}

if (args.Length == 2 && args[0] == "--standard-browser")
{
    await StandardCombatBrowserFixture.Run(args[1]);
    return 0;
}
if (args.Length == 2 && args[0] == "--natural-browser")
{
    await NaturalBrowserFixture.Run(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--world-scale-browser")
{
    await WorldBrowserFixture.Run(args[1], scale: true);
    return 0;
}
if (args.Length == 2 && args[0] == "--world-browser")
{
    await WorldBrowserFixture.Run(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--growth-browser")
{
    await AdvancementBrowserFixture.Run(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--harness-browser")
{
    await HarnessBrowserFixture.Run(args[1]);
    return 0;
}

if (args.Length == 2 && args[0] == "--local-rules")
{
    CharacterRuleDetailsTests.RealMaintainedPackage(args[1]);
    await HarnessRulesTests.RealMaintainedPackage(args[1]);
    Console.WriteLine("PASS local maintained rules: strict loader and real Pi/MCP complete text");
    return 0;
}

var tests = new (string Name, Func<Task> Run)[]
{
    ("encounter continuation: premature delegate recoverable", EncounterContinuationTests.PrematureDelegateIsRecoverable),
    ("encounter continuation: map failure cancellation and restart", EncounterContinuationTests.MapFailureCancellationAndRestartDoNotRegenerate),
    ("encounter continuation: single attempt across inputs and restart", EncounterContinuationTests.SingleAttemptAcrossInputsAndRestart),
    ("encounter continuation: real Pi waits for map then engages original encounter", EncounterContinuationTests.RealPiWaitsForMapThenEngagesOriginalEncounter),
    ("game saves: future parent call preserves combat return", GameSaveCombatTests.FutureParentCallStillConsumesRestoredCombatReturn),
    ("game saves: missing issued child terminal recovery", GameSaveCombatTests.MissingIssuedChildRestoresTerminalPlaceholder),
    ("game saves: restored map lease refuses late work", GameSaveRecoveryTests.RestoredMapLeaseCannotSendOrComplete),
    ("game saves: restore journal and corrupt payload", GameSaveRecoveryTests.JournalCommitMarkerAndCorruptPayload),
    ("game saves: new admission after restore without timeline", GameSaveTests.NewAdmissionAfterRestoreNeedsNoPriorTimeline),
    ("game saves: authority slots replay and timeline", GameSaveTests.AuthoritySlotsReplayAndTimeline),
    ("game saves: complete cold history maps workspace and current seats", GameSaveTests.CompleteHistoryMapWorkspaceAndCurrentSeats),
    ("game saves: real Pi waiting and rolled result recovery", GameSaveTests.RealPiWaitingRollRestoresWithoutAutomaticCalls),
    ("game saves: unknown call survives load and service restart", GameSaveTests.UnknownCallSurvivesSaveLoadAndServiceRestart),
    ("campaign lifecycle: death rejects actions living players continue", CampaignLifecycleTests.DeathRejectsActionsButLivingPlayersContinue),
    ("campaign lifecycle: empty downed stable and actual death", CampaignLifecycleTests.EmptyDownedStableAndActualDeath),
    ("campaign lifecycle: busy save death before next model slot", CampaignLifecycleTests.BusySaveAndDeathBeforeNextModelSlot),
    ("campaign lifecycle: dead waiting player can only cancel", CampaignLifecycleTests.DeadWaitingPlayerCannotRollOrResumeButCanCancel),
    ("NPC naming: runtime identity hidden names and dice", NpcNamingTests.RuntimeNamesAndHiddenIdentity),
    ("NPC naming: HTTP identity replay and restart", NpcNamingTests.HttpIdentityReplayAndRestart),
    ("NPC naming: combat rename and legacy modes", NpcNamingTests.CombatRenameAndLegacyStart),
    ("NPC naming: pending initiative freezes creation policy", NpcNamingTests.PendingInitiativeKeepsCreationPolicy),
    ("NPC naming: real Pi old and new writes", NpcNamingTests.RealPiOldAndNewNames),
    ("knowledge visibility: recipients across projections and restart", KnowledgeVisibilityTests.ActualRecipientsAcrossEveryProjectionAndRestart),
    ("knowledge visibility: explicit retelling cold source retry", KnowledgeVisibilityTests.ExplicitRetellingColdSourceRetryAndNoImplicitDisclosure),
    ("knowledge visibility: real Pi empty completion and known snapshot", KnowledgeVisibilityTests.RealPiPrivateCompletionAndCurrentKnownInformation),
    ("knowledge visibility: empty opening and nonactor supplement", KnowledgeVisibilityTests.EmptyOpeningAndNonActorSupplementRemainIndependent),
    ("knowledge visibility: exact discovery and no shared map reveal", KnowledgeVisibilityTests.DiscoveryDeliveryIsExactAndRetellingDoesNotRevealMap),
("knowledge visibility: private root later public same run", KnowledgeVisibilityTests.PrivateRootNeverBecomesPublicWhenTheSameRunContinues),
    ("Blank grid: authored fight without map gets one", BlankGridTests.AuthoredFightWithoutMapGetsOneBlankGrid),
    ("Blank grid: none without fight or with image generation", BlankGridTests.NoBlankGridWithoutFightOrWhenImagesCanBeGenerated),
    ("Opening: nearest entry shared once and private real Pi", AdventureOpeningTests.NearestPlaceOneSharedOpeningAndPrivateEntry),
    ("Opening: failed entry discoverable without retry", AdventureOpeningTests.FailedOpeningIsDiscoverableWithoutAutomaticRetry),
    ("Opening: narrative only and public immutable", AdventureOpeningTests.OpeningCannotExecuteActionsOrRewritePublic),
    ("DM question: real Pi restart main input and exact replay", DmQuestionTests.RealPiQuestionRestartAndMainInputAnswer),
    ("Quick retelling: one call publication concurrency restart", QuickRetellingTests.OneCallImmediatePublicationConcurrencyAndRestart),
    ("Quick retelling: failures unknown and Gemini", QuickRetellingTests.FailuresAndUnknownNeverRetryAndGeminiWorks),
    ("Quick retelling: timeline changed during generation", QuickRetellingTests.TimelineChangedDuringGenerationCannotPublishOrResend),
    ("Private sharing: exact source permissions replay and restart", PrivateStorySharingTests.ExactSourcePermissionsReplayAndRestart),
    ("Private sharing: model knowledge freeze old frames and cross campaign", PrivateStorySharingTests.SharedKnowledgeIsFrozenPerModelSlotAndOldFramesStayUnchanged),
    ("Private sharing: waiting roll and ruling revisions", PrivateStorySharingTests.SharingDoesNotInvalidateRollAndChangedRulingIsRejected),
    ("Shared board: hidden history and failed transaction stay private", SharedBoardPrivacyTests.RevealDoesNotPublishHiddenHistory),
    ("Shared board: player movement intent is frozen and confirmed", SharedBoardIntentTests.PlayerIntentIsFrozenAndConfirmed),
    ("Shared board: map version and coordinate boundaries", SharedBoardIntentTests.MapVersionsAndMissingCoordinates),
    ("Shared board: model map race refreshes before write", SharedBoardIntentTests.ModelMapRaceRefreshesBeforeWrite),
    ("Shared board: ruling and complete NPC build boundaries", SharedBoardBoundaryTests.RulingAndBuildBoundaries),
    ("Shared board: state-only commands and legacy history", SharedBoardBoundaryTests.StateOnlyCommandsAndLegacyHistory),
    ("Shared board: actual map encounter and reentry", SharedBoardCombatTests.ActualMapEncounterAndReentry),
    ("Shared board: persistent identity authority and replay", SharedBoardTests.PersistentIdentityAuthorityAndReplay),
    ("Shared board: frozen images reach both providers", SharedBoardTests.FrozenImagesReachBothProviders),
    ("Shared board: real Pi batch refresh and restart", SharedBoardTests.RealPiBatchRefreshAndRestart),
    ("Shared board: legacy activity roots read only and private", SharedBoardIntentTests.LegacyBoardRootsAreReadOnlyAndRemainPrivate),
    ("Item search: ranking normalized fuzzy text and frozen reads", HarnessItemSearchTests.RankedSearchAndFrozenReads),
    ("Item search: grounding self-proof rejection and no partial writes", HarnessItemSearchTests.GroundingRejectsSelfProofWithoutWrites),
    ("Item search: real Pi grounded claim repair and restart", HarnessItemSearchTests.RealPiSearchGroundedClaimAndRestart),
    ("Supplies: atomic stock claims concurrency and restart", HarnessSupplyTests.AtomicStockClaimsAndRestart),
    ("Supplies: first frame same-call stock and final stop through real Pi", HarnessSupplyTests.FirstFrameAndSameCallStockThroughPi),
    ("Supplies: arrival after settled observe and actual travel", HarnessSupplyTests.ArrivalAfterSettledObserveAndTravel),
    ("Supplies: local visibility and catalog boundary", HarnessSupplyTests.LocalVisibilityAndCatalogBoundary),
    ("Story intent: current scene versions variants and travel", StoryIntentContextTests.CurrentSceneVersionsAndTravel),
    ("Story intent: real Pi active skills question scope and replay", StoryIntentContextTests.RealPiUsesActiveSkillsAndQuestionScope),
    ("Story intent: actual Gemini body current arrival only", StoryIntentContextTests.NativeBodyIncludesOnlyCurrentArrival),
    ("flow v28: missing encounter and authored routes reach ruling", HarnessExecutionProtocolTests.MissingEncounterAndAuthoredRoutesLeadToRuling),
    ("flow v28: retrieval prioritizes names and literal targets", DmContextTests.RetrievalPrioritizesPublicNamesAndLiteralTargets),
    ("DM context: large saved frame and bounded recall", DmContextTests.LargeSavedFramesAndRecallRemainReadable),
    ("DM context: preserve quotation attribution and negation", DmContextTests.QuotedEvidencePreservesOutsideNegation),
    ("DM context: objective reveal and legacy bytes", DmContextTests.ObjectiveRevealAndLegacyBytes),
    ("DM context: sourced scene and narrow private boundary", DmContextTests.SceneKnowledgeHasSourcesAndNarrowPrivateBoundary),
    ("DM context: real Pi compact self and optional details", DmContextTests.CompactFrameAndOptionalDetailsThroughPi),
    ("DM context: source rejection atomicity", DmContextTests.AcquisitionSourcesRejectHistoricalAndPrivateReferences),
    ("DM context: continuity persistence and full history", DmContextTests.ContinuityPersistsWithoutChangingFullHistory),
    ("DM context: legacy quotes correction and archive", DmContextTests.LegacyHistoryPreservesQuotesCorrectionsAndArchive),
    ("final narrative: real Pi one save and batch stop", HarnessFinalNarrativeTests.RealPiFinalStopsBatchAndSavesOnce),
    ("final narrative: intermediate continues", HarnessFinalNarrativeTests.IntermediateRecordContinuesWithoutFinalDuplicate),
    ("final narrative: lost journal receipt recovery", HarnessFinalNarrativeTests.AcceptedCompletionSurvivesLostToolJournal),
    ("final narrative: done tool recovers after later game changes", HarnessFinalNarrativeTests.DoneToolRecoversAfterLaterGameChangesWithProviderDisabled),
    ("equipment packs: exact contents merge and sourced weight", EquipmentPackTests.ContentsAndMerge),
    ("equipment packs: identity availability and atomic rejection", EquipmentPackTests.IdentityAndAtomicRejections),
    ("equipment packs: HTTP replay rollback concurrency and restart", EquipmentPackTests.HttpReplayRollbackAndRestart),
    ("equipment packs: other seat cannot unpack owned inventory", EquipmentPackTests.OtherSeatCannotUnpackOwnedInventory),
    ("inventory weight: source identity quantities and carried only", InventoryWeightTests.Projection),
    ("inventory weight: capacity matrix and shared sourced metadata", InventoryWeightTests.CapacityAndMetadata),
    ("character rule details: metadata without text or carried inventory", CharacterRuleDetailsTests.ItemFactsWithoutText),
    ("inventory weight: HTTP authorization pure reads and nullable compatibility", InventoryWeightTests.HttpPureRead),
    ("wearables: ordinary robe exact identity no armor HTTP persistence", WearableEquipmentTests.OrdinaryRobeIdentityNoArmorAndHttpPersistence),
    ("wearables: slots independent instances and availability", WearableEquipmentTests.SlotsInstancesAndAvailability),
    ("wearables: own attunement rest limits transfer and missing inventory", WearableEquipmentTests.AttunementOwnRestLimitTransferAndMissingInventory),
    ("wearables: five actual effects AC sources runtime projection", WearableEquipmentTests.FiveActualEffectsArmorSourcesAndRuntimeProjection),
    ("wearables: death saves and real death", WearableEquipmentTests.DeathSavesAndRealDeath),
    ("wearables: frozen v0-v20 catalogs self and exact rules ID", WearableEquipmentTests.FrozenCatalogsSelfAndExactRulesId),
    ("wearables: HTTP replay concurrency restart permission pure reads", WearableEquipmentTests.HttpReplayConcurrencyRestartPermissionAndPureReads),
    ("wearables: acquisition version boundary replay loss new tool ID", WearableEquipmentTests.AcquisitionVersionBoundaryReplayLossAndNewToolId),
    ("wearables: missing attunement HTTP details self replay restart", WearableEquipmentTests.MissingAttunementHttpDetailsSelfAndRestart),
    ("wearables: real Pi v21 direct wearing own attunement consent", WearableEquipmentTests.RealPiV21WearDirectAttunementOwnConsent),
    ("ready weapons: multiple carried and explicit active weapon", ReadyWeaponsTests.MultipleReadyAndActive),
    ("ready weapons: creation and standard attacks drops", ReadyWeaponsTests.CreationAndStandardCombat),
    ("ready weapons: HTTP replay and restart", ReadyWeaponsTests.HttpReplayAndRestart),
    ("accounts: login logout password and restart", AccountTests.LoginLogoutPasswordAndRestart),
    ("accounts: configured initial admin password", AccountTests.ConfiguredInitialAdminPassword),
    ("accounts: user management revocation and AI operator authorization", AccountTests.ManagementRevocationAndOperatorAuthorization),
    ("accounts: campaign ownership legacy Unity and restart", AccountTests.CampaignOwnershipLegacyAndRestart),
    ("accounts: room fingerprints across sessions restart and legacy", AccountTests.RoomFingerprintAcrossSessionsAndLegacy),
    ("accounts: corrupt records and login limiter", AccountTests.CorruptRecordsAndLoginLimiter),
    ("model request log: recovered retry alerts preserve audit", ModelRequestLogTests.RecoveredRetriesLeaveAlertsButKeepAudit),
    ("model request log: bodies status and masked keys", ModelRequestLogTests.RecordsBodiesStatusAndMasksKeys),
    ("model request log: in-flight entry and bounded retention", ModelRequestLogTests.InFlightEntryVisibleAndRetentionBounded),
    ("model request log: admin global and host campaign boundaries", ModelRequestLogTests.AdminGlobalAndHostCampaignBoundaries),
    ("accounts: list isolation preserves healthy records and ownership", AccountTests.ListIsolationKeepsHealthyAndHidesUnknownRecords),
    ("AI settings: image settings frozen calls and legacy receipts", AiSettingsTests.ImageSettingsAndFrozenCalls),
    ("automatic map public evidence excludes model prose and hidden geography", AutomaticMapTests.PublicEvidenceIsFrozenAndModelProseExcluded),
    ("AI settings: native helper probe narration preparation and snapshot", AiSettingsTests.NativeHelperProtocolAcrossConsumers),
    ("AI settings: operator authorization receipts and restart", AiSettingsTests.HttpAuthorizationAndAtomicReceipts),
    ("AI settings: new calls change without mutating inflight", AiSettingsTests.NewCallsChangeInflightDoesNot),
    ("AI settings: explicit probe helper and actual token accounting", AiSettingsTests.ExplicitProbeAndHelper),
    ("AI settings: preparation acceptance snapshot and legacy endpoint", AiSettingsTests.PreparationFrozenBeforeUnknownAndLegacyEndpoint),
    ("host only: creation routes and empty management", HostOnlyCampaignTests.CreationRoutesAndEmptyManagement),
    ("host only: player authority and full join", HostOnlyCampaignTests.HostCannotPlayAndPlayerCanJoin),
    ("host only: restart and invalid legacy null", HostOnlyCampaignTests.RestartAndInvalidLegacyNull),
    ("host only: initial recruitment and four player capacity", HostOnlyCampaignTests.InitialRecruitmentAndFourPlayerCapacity),
    ("host only: player inventory and story settlement", HostOnlyCampaignTests.ItemsAndStoryBelongToActingPlayer),
    ("full build only: creation gates and no side effects", FullBuildOnlyTests.CreationRequiresCompleteBuild),
    ("full build only: all creation routes", FullBuildOnlyTests.AllCreationRoutesRequireBuild),
    ("full build only: atomic join and replacement", FullBuildOnlyTests.JoinAndReplacementAreAtomic),
    ("full build only: accepted legacy replay and explanation", FullBuildOnlyTests.PreviouslyAcceptedLegacyRequestsStillReplay),
    ("party rest: eligibility team clock and recovery", PartyRestTests.TeamClockEligibilityAndRecovery),
    ("party rest HTTP: permissions own choices concurrent receipts restart", PartyRestTests.HttpOwnChoicesAndRestart),
    ("party rest HTTP: legacy entry rejection and frozen receipt", PartyRestTests.LegacyEntryAndReceipt),
    ("natural actions: sheet effects and recording compatibility", NaturalActionTests.SheetEffectsAndRecordingCompatibility),
    ("standard combat missiles real Pi: plan own consent and restart", StandardCombatPiTests.MissilePlanToOwnConsent),
    ("standard combat missiles HTTP: allocation consent foreign Shield race and restarts", StandardMissileHttpTests.AllocationsAndForeignShieldRestartExactlyOnce),
    ("standard combat missiles: allocation cancel source and dice", StandardMissileTests.AllocationCancellationAndExactDarts),
    ("standard combat missiles: all Shield responses before damage", StandardMissileTests.AllShieldDecisionsPrecedeEveryDamage),
    ("standard combat missiles: simultaneous damage and concentration tail", StandardMissileTests.SimultaneousDamageAndConcentrationTail),
    ("standard combat mastery: Slow adjusts existing Dash gain", StandardMasteryTests.SlowAdjustsAlreadyGrantedDash),
    ("standard combat mastery: Sap and Vex consume and expire", StandardMasteryTests.SapAndVexConsumptionAndExpiry),
    ("standard combat mastery: optional Slow and Topple exact sources", StandardMasteryTests.OptionalSlowAndToppleHaveExactSources),
    ("standard combat mastery: optional opportunity and corrupt effects", StandardMasteryTests.OptionalOpportunityAndCorruptEffects),
    ("standard combat DEX area: cover and blocked point", StandardDexAreaTests.CoverFromCenterAndBlockedPoint),
    ("standard combat DEX area: caster friend Dodge and reopen", StandardDexAreaTests.SphereIncludesCasterAndDodgePersistsThroughWait),
    ("standard combat DEX area: incapacitated automatic failure", StandardDexAreaTests.IncapacitatedDexSaveNeverRolls),
    ("standard combat area HTTP: foreign own wait and restart", StandardSpellHttpTests.AreaForeignWaitAndRestart),
    ("standard combat area: friendly saves and concentration queue", StandardAreaTests.FriendlyAreaWaitsThroughConcentration),
    ("standard combat area: Hadar half damage and reactions", StandardAreaTests.HadarTargetsHalfDamageAndReactionSuppression),
    ("standard combat monsters: exact XMM fortitude and vulnerability", StandardAreaTests.ExactXmmFortitudeCriticalAndVulnerability),
    ("standard combat spells HTTP: cancel foreign race restart and receipt", StandardSpellHttpTests.SpellWaitsCancelConcurrencyRestart),
    ("standard combat spells: shield pauses damage and expires", StandardSpellTests.ShieldPausesDamageAndExpires),
    ("standard combat spells: concentration save replacement and duration", StandardSpellTests.ConcentrationWaitOwnSaveReplacementAndDuration),
    ("standard combat spells: ward failure incapacitation and closed encounter", StandardSpellTests.WardFailureIncapacitationAndClosedEncounter),
    ("standard combat spells: healing source and action economy", StandardSpellTests.HealingSourcesAndActionEconomy),
    ("combat presentation: settled moments dice and waits", CombatPresentationTests.CapturesSettledMomentsWithoutChangingDiceOrWaits),
    ("combat presentation: frozen audience deep copy and old null", CombatPresentationTests.FrozenAudienceDeepCopyAndOldNull),
    ("combat narration: legacy live waiting input keeps contract", CombatNarrationHttpTests.LegacyWaitingInputKeepsContract),
    ("combat narration real Pi: final receipt restart and cold history", CombatNarrationHttpTests.FinalReceiptRestartAndColdHistory),
    ("combat narration real Pi: terminal story before return", CombatNarrationHttpTests.TerminalBeatBeforeReturn),
    ("combat narration real Pi: sequential beats receipts and history", CombatNarrationHttpTests.RealPiSequentialBeatsReceiptsAndHistory),
    ("combat narration real Pi: standalone action keeps fresh input", CombatNarrationHttpTests.StandaloneActionKeepsFreshInput),
    ("combat narration real Pi: direct command automatic continuation", CombatNarrationHttpTests.DirectCommandContinuesWithoutNewInput),
    ("combat narration real Pi: missile plan edits are not narrated", CombatNarrationHttpTests.MissilePlanEditsAreNotNarrated),
    ("combat narration: each unit persists before next unit", CombatNarrationTests.EachUnitWaitsForNarrationAndRestart),
    ("combat narration: idle turns keep audit and death wait", CombatNarrationTests.IdleTurnsKeepAuditAndDeathWait),
    ("combat narration: reactions death and legacy", CombatNarrationTests.ReactionsDeathAndLegacy),
    ("combat narration: Shield concentration and private audience", CombatNarrationTests.ShieldConcentrationAndPrivateAudience),
    ("standard combat: pickup respects hands and training", StandardCombatTests.PickUpHonorsHandsAndTraining),
    ("standard combat real Pi: public context consent and restart", StandardCombatPiTests.PublicContextConsentAndRestart),
    ("DM overview: permissions private data and read-only", DmOverviewTests.PermissionsPrivacyAndReadOnly),
    ("DM overview: empty host and combat coexist", DmOverviewTests.EmptyHostAndCombat),
    ("workbench combat: host-only consent read-only and timeline", WorkbenchCombatTests.HostOnlyConsentAndTimeline),
    ("workbench combat: stale blocked and narrow projection", WorkbenchCombatTests.StaleBlockedAndNarrowProjection),
    ("workbench combat: hidden battle existing visibility", WorkbenchCombatTests.HiddenBattleUsesExistingVisibility),
    ("workbench combat: complete wait text and archived read", WorkbenchCombatTests.CompleteWaitingTextAndArchivedRead),
    ("combat narration real Pi: movement refreshes remaining input", CombatNarrationHttpTests.MovementNarrationRefreshesOriginalInput),
    ("automatic death save real Pi: narration next round and wake", CombatNarrationHttpTests.AutomaticDeathSaveContinuesNarratedBattle),
("automatic death save HTTP: turn request consent restart and next round", StandardCombatHttpTests.AutomaticDeathSaveStillNeedsOwnRoll),
("automatic death save HTTP: fallen seat owns confirmation", StandardCombatHttpTests.AutomaticDeathSaveBelongsToTheFallenSeat),
("standard combat HTTP: consent seats concurrency and restart", StandardCombatHttpTests.ConsentSeatsRestartAndReplay),
    ("standard combat HTTP: authorized corruption preservation", StandardCombatHttpTests.CorruptionIsAuthorizedAndPreserved),
    ("standard combat HTTP: new member after battle and join replay", StandardCombatHttpTests.NewMemberAfterBattleKeepsHistoricalBoardAndJoinReplay),
    ("standard combat: explicit mode cover geometry and frozen v8", StandardCombatTests.ExplicitModeAndGeometry),
    ("standard combat: reaction pauses before movement", StandardCombatTests.ReactionPausesBeforeMovement),
    ("standard combat: lethal damage death saves and stable recovery", StandardCombatTests.LethalDamageDeathAndRecovery),
    ("natural effects: abilities items and frozen commands", NaturalActionTests.AbilitiesItemsAndFrozenCommands),
    ("natural effects: source spells and actual class scaling", NaturalActionTests.SpellsSourcesAndClassScaling),
    ("natural effects: verified consequences stay within root", NaturalActionTests.VerifiedConsequencesStayWithinRoot),
    ("natural effects real Pi: consent concurrency and restart", NaturalActionHttpTests.RealPiConsentConcurrencyAndRestart),
    ("natural effects real Pi: recorded check to world outcome", NaturalActionHttpTests.RealPiRecordedCheckToWorldOutcome),
    ("natural effects HTTP: cancellation stale and story confirmation", NaturalActionHttpTests.CancellationStaleAndStoryConfirmation),
    ("world scale: 8192 indexed records bounded projection and pagination", WorldScaleTests.LargeIndexedWorldAndPaging),
    ("world scale: explicit migration backup rollback and replay", WorldScaleTests.MigrationBackupRollbackAndReplay),
    ("world scale: pending overlay corrections indexes and atomic receipts", WorldScaleTests.OverlayAndAtomicReceipts),
    ("world scale: corruption authorization and frozen v6", WorldScaleTests.CorruptionAuthorizationAndFrozenContract),
    ("world scale real Pi: beyond legacy cursor and restart", WorldScaleTests.RealPiBeyondLegacyCursor),
    ("world maps: automatic public associations and map isolation", WorldMapTests.AutomaticPublicAssociationsAndMapIsolation),
    ("world maps: anchors fail closed and bounded", WorldMapTests.AnchorsFailClosedAndBounded),
    ("world routes: cancel stale and corrupt save preservation", WorldMapTests.WaitingCancellationStaleAndCorruptPreservation),
    ("world routes: pure plans topology and visibility", WorldRouteTests.PurePlansTopologyAndVisibility),
    ("world routes: rejected references and authored locks", WorldRouteTests.RejectedReferencesAndAuthoredLocks),
    ("world routes HTTP: authority waiting receipts and restart", WorldRouteTests.AuthorityWaitingAndAtomicReceipts),
    ("world routes real Pi: confirmation travel and restart", WorldRouteTests.RealPiProposalConfirmTravelAndRestart),
    ("advancement arcanum: replacement preserves consumption and history", AdvancementArcanumTests.ReplacementPreservesSpentUsesAndHistory),
    ("advancement arcanum: invalid choices and corrupt ownership", AdvancementArcanumTests.InvalidChoicesAndCorruptOwnershipAreRejected),
    ("advancement arcanum HTTP: actual growth race and reopen", AdvancementArcanumHttpTests.ActualGrowthReplacementRaceAndReopen),
    ("advancement arcanum: corrupt counters and frozen legacy", AdvancementArcanumTests.CorruptCountersRejectKeepMulticlassAndLegacyReopens),
    ("advancement rest choices Pi: own source confirmation and restart", AdvancementRestChoicePiTests.OfferedSourceWaitsForOwnConfirmation),
    ("advancement rest choices HTTP: own window race and restart", AdvancementRestChoiceHttpTests.OwnWindowRaceAndRestart),
    ("advancement rest choices: lineage sources and one-use rest window", AdvancementRestChoiceTests.LineageRestWindowAndSources),
    ("advancement rest choices: Land replacement and later growth", AdvancementRestChoiceTests.LandReplacementSurvivesLaterGrowth),
    ("advancement rest choices: one mastery spell and independent resistance", AdvancementRestChoiceTests.MasteryOneSpellAndIndependentResistances),
    ("advancement source ownership HTTP: source revocation race and restart", AdvancementSourceOwnershipHttpTests.SourceRevocationPersistsAndReplays),
    ("advancement source ownership: initial order cantrips and replacements", AdvancementSourceOwnershipTests.OrderCantripMovesOnceAndCanBeReplaced),
    ("advancement source ownership: invocation revocation and free routes", AdvancementSourceOwnershipTests.InvocationSourceRevokedAndFreeRoutesPreserved),
    ("advancement source ownership: legacy transfer only on growth", AdvancementSourceOwnershipTests.LegacyTransfersOnlyOnExplicitGrowth),
    ("advancement invocations: repeated bindings and replacement limits", AdvancementInvocationTests.RepeatBindingsAndReplacementLimits),
    ("advancement invocations: current Warlock cantrip eligibility", AdvancementInvocationTests.BindingEligibilityUsesCurrentWarlockCantrips),
    ("advancement invocations: legacy single binding compatibility", AdvancementInvocationTests.LegacySingleBindingRemainsReadable),
    ("advancement lessons HTTP: retired sources replay and corrupt ledger", AdvancementLessonHttpTests.RevocationRegrantReceiptsAndCorruptLedger),
    ("advancement lessons: distinct feats and Tough removal", AdvancementLessonTests.DistinctOriginFeatsAndNegativeToughDelta),
    ("advancement lessons: revoked skills preserve independent class training", AdvancementLessonTests.SkillRevocationKeepsLaterIndependentTraining),
    ("advancement lessons: Magic Initiate routes and retired uses", AdvancementLessonTests.MagicInitiateRevocationAndSpentUses),
    ("advancement lessons: dormant expertise and independent repeatable feat", AdvancementLessonTests.ExpertiseAndIndependentRepeatableFeat),
    ("advancement lessons: tools weapons and corrupt sources", AdvancementLessonTests.ToolsWeaponsAndCorruptSources),
    ("advancement: verified catalogue and pure level 2-20 progression", AdvancementTests.CatalogAndPureProgression),
    ("advancement: multiclass slots and preservation", AdvancementTests.MulticlassAndPreservation),
    ("advancement: all 48 subclass level paths", AdvancementTests.AllSubclassProgressions),
    ("advancement HTTP: authority receipts concurrency and restart", AdvancementHttpTests.AuthorityReceiptsAndRestart),
    ("advancement: higher spell preparation and invalid records", AdvancementHttpTests.HigherPreparationAndInvalidRecords),
    ("advancement: retained spell source choices reject mixed lists", AdvancementRestTests.RetainedSourceChoices),
    ("advancement: multiclass hit dice and level-bounded Arcane Recovery", AdvancementRestTests.MultiClassDiceAndArcaneRecovery),
    ("advancement HTTP: selected hit die consent concurrency and restart", AdvancementRestHttpTests.DeferredPoolSelectionAndRestart),
    ("advancement HTTP: review seats different-ID races and revoked replays", AdvancementAuthorityTests.SeatsReviewRaceAndRevocation),
    ("advancement: pending choices cannot authorize growth", AdvancementAuthorityTests.OutstandingChoiceBlocksPreview),
    ("advancement: acquired mixed proficiencies and energy resistance", AdvancementFeatTests.MixedTrainingAndPermanentResistance),
    ("advancement: repeated Magic Initiate sources and spell routes", AdvancementFeatTests.RepeatedMagicInitiateUsesDifferentListsAndBothCastingRoutes),
    ("advancement: initial Magic Initiate spell replacement and spent uses", AdvancementSpellChangeTests.InitialFeatReplacementPreservesSourcesAndSpentUses),
    ("advancement: repeated feat replacement across class levels", AdvancementSpellChangeTests.RepeatedFeatReplacementIsIndependentOfClassLevel),
    ("advancement: species spells at total character levels", AdvancementSpellChangeTests.SpeciesSpellsFollowCharacterLevelAndOriginalLineage),
    ("advancement: Ranger free uses follow class level", AdvancementSpellChangeTests.RangerUsesFollowClassLevelNotProficiency),
    ("advancement HTTP: spell replacement resources and restart", AdvancementSpellChangeHttpTests.ReplacementReceiptPersistsAndReplays),
    ("advancement: corrupt spell eligibility and subclass history rejected", AdvancementStateTests.RejectsEarlySpellsAndSubclassHistoryChanges),
    ("long memory: semantic paraphrases summaries and 1200 actions", HarnessLongMemoryTests.SemanticParaphrasesSummariesAndScale),
    ("long memory: context reduction preserves original groups", HarnessLongMemoryTests.ContextReductionPreservesOriginalGroups),
    ("long memory: read-only tools and seat isolation", HarnessLongMemoryTests.ReadOnlyToolsAndSeatIsolation),
    ("long memory real Pi: reduction fresh context and exact restart", HarnessLongMemoryTests.RealPiReductionAndExactRestart),
    ("long memory: compacted unknown is never resent and corruption is preserved", HarnessLongMemoryTests.CompactedUnknownAndCorruption),
    ("long memory Gemini: compact native history identity and signatures", HarnessGeminiTests.CompactionNativeHistory),
    ("protected context: real Pi complete native chain and exact restart", HarnessGeminiTests.ProtectedChainThroughRealPiAndRestart),
    ("protected context: transport rejection and frozen retry body", HarnessGeminiTests.ProtectedTransportAndFrozenRetry),
    ("protected context: failure notice preserves settled effects", HarnessGeminiTests.ProtectedFailureNoticeKeepsSettledEffects),
    ("protected context: response usage without preflight or estimates", HarnessGeminiTests.ProtectedResponseUsageWithoutPreflight),
    ("history pipeline: publication and failure keep originals", HarnessHistoryPipelineTests.PublicationAndFailureKeepOriginals),
    ("history pipeline: background publication affects later slots", HarnessHistoryPipelineTests.BackgroundPublicationOnlyChangesLaterSlots),
    ("history summary: layered coverage and source races", HarnessHistorySummaryTests.LayeredCoverageAndSourceRaces),
    ("history summary: mixed ancestor chain avoids partial work", HarnessHistorySummaryTests.MixedAncestorChainDoesNotIssuePartialWork),
            ("history summary: published brief precedes transport", HarnessHistorySummaryTests.PublishedBriefPrecedesTransport),
    ("history summary: persistence restore and frozen Pi slots", HarnessHistorySummaryTests.PublishedHistoryPersistenceAndFrozenPiSlots),
            ("history pipeline: actual usage growth and missing usage", HarnessHistoryPipelineTests.ActualUsageGrowthAndMissingUsage),
    ("history sources: closed source parts and public audience", HarnessHistoryTests.SourcePartsClosureAndPublicAudience),
    ("history sources: story eligibility and exact settled results", HarnessHistoryTests.StoryEligibilityAndExactSettledResults),
    ("history sources: public peer search and exact expansion through Pi", HarnessHistoryTests.PublicPeerSearchAndExactExpansionThroughPi),
    ("runtime rules preflight: strict read-only directory and preserved versions", RuntimeCommandsTests.ReadOnlyRulesPreflight),
    ("harness wire: exact block lines and UTF8 boundaries", HarnessWireTests.ExactBlockLinesAndUtf8Boundaries),
    ("harness parallel: real Pi workers and isolated cancellation", HarnessParallelTests.IndependentRealPiWorkersAndCancellation),
    ("per-map scale: physical subdivision and unknown rejection", MapScaleTests.PhysicalSubdivisionAndUnknown),
    ("per-map scale: same instances across maps and combat", MapScaleTests.SameInstancesAcrossMapsAndCombat),
    ("per-map scale: metadata HTTP restart and replay", MapScaleTests.MetadataHttpRestartAndReplay),
    ("per-map scale: default current-map combat and consent restart", MapScaleTests.DefaultCurrentMapCombatAndConsentRestart),
    ("per-map scale: real Pi selected image and same-instance placement", MapScaleHarnessTests.SelectMapReceiptAndFrozenImage),
    ("per-map scale: local request beside town and restart replay", MapScaleHarnessTests.LocalRequestBesideTownAndReplay),
    ("per-map scale: frozen metadata versions and read-only frames", MapScaleHarnessTests.FrozenMetadataVersions),
    ("DM position v39: party placement without consent, player boundary and replay", DmPositionTests.PartyPlacementAndMovementWithoutConsent),
    ("DM position v39: opening first placement and immutable replay", DmPositionTests.OpeningPlacesOnceBeforeNarrative),
    ("combat prompt v39: missing configuration visible and recovered", HarnessCombatPromptTests.MissingCombatSourceIsVisibleAndRecoverable),
    ("combat prompt v54: built-in and custom real Pi delegation restart replay", HarnessCombatPromptTests.BuiltInSourceDelegatesAndStaysFrozen),
    ("DM helper: authoritative read-only tools", HarnessDmToolsTests.AuthoritativeReadOnlyTools),
    ("DM helper: real Pi direct tools", HarnessDmToolsTests.RealPiDirectTools),
    ("local Chinese rules: strict packages and complete pagination", HarnessRulesTests.StrictPackagesAndCompletePagination),
    ("local Chinese rules: authorized read only and no candidates", HarnessRulesTests.AuthorizedReadOnlyAndNoCandidates),
    ("local Chinese rules real Pi: pinned edition and restart", HarnessRulesTests.RealPiPinnedEditionAndRestart),
    ("local Chinese rules: interrupted reads never rebase", HarnessRulesTests.InterruptedReadsNeverRebase),
    ("local Chinese rules real Pi: frozen catalogs and corrupt bindings", HarnessRulesTests.FrozenCatalogsAndCorruptBindings),
    ("harness world search: public projection pagination and bounds", HarnessWorldSearchTests.PublicSearchPaginationAndBounds),
    ("harness world search: shared authority and atomic rejection", HarnessWorldSearchTests.SharedAuthorityAndAtomicRejection),
    ("harness world search additional: existing candidate authorization stays separate", HarnessWorldSearchTests.SearchPreservesOnlyExistingCandidateAuthorization),
    ("harness world search: reference expiry and cross-run isolation", HarnessWorldSearchTests.ReferenceLeasesExpireAndNeverCrossRuns),
    ("harness world search real Pi: business update and restart", HarnessWorldSearchTests.RealPiBusinessUpdateAndRestart),
    ("harness world search: interrupted read and committed write recovery", HarnessWorldSearchTests.InterruptedReadAndCommittedWriteRecovery),
    ("harness world search real Pi: frozen v2 and corrupt references", HarnessWorldSearchTests.FrozenV2AndCorruptReferencePreservation),
    ("harness recall additional: detail byte budget preserves evidence order", HarnessRecallTests.DetailByteBudgetPreservesEvidenceOrder),
    ("harness recall additional: existing candidate authorization survives retrieval", HarnessRecallTests.RecallPreservesExistingCandidateAuthorization),
    ("harness recall: long history pagination bounds and corrections", HarnessRecallTests.LongHistoryPaginationAndCorrections),
    ("harness recall: authorized read-only boundary", HarnessRecallTests.AuthorizedReadOnlyBoundary),
    ("harness recall real Pi: business history retrieval and restart", HarnessRecallTests.RealPiBusinessRecallAndRestart),
    ("harness recall real Pi: frozen v1 catalog and rejected upgrade", HarnessRecallTests.FrozenCatalogV1AndRejectedUpgrade),
    ("harness efficiency v14 real Pi: compact reads and fresh authorization", HarnessEfficiencyTests.CompactReadsAndFreshAuthorization),
    ("harness efficiency v14: waiting still expires candidates", HarnessEfficiencyTests.WaitingStillExpiresCandidates),
    ("harness efficiency real Pi: legacy tool contract restart", HarnessEfficiencyTests.LegacyToolContractRestart),
    ("harness efficiency: unchanged memory retains provenance", HarnessEfficiencyTests.UnchangedMemoryRetainsProvenance),
    ("harness efficiency: unchanged memory narrative receipt and restart", HarnessEfficiencyTests.UnchangedMemoryNarrativeReceiptAndRestart),
    ("harness Gemini flow: offered tools and native board history", HarnessGeminiTests.CurrentOfferedToolsAndNativeBoardHistory),
    ("harness Gemini flow: board tools through real Pi", HarnessGeminiTests.BoardToolsThroughRealPi),
    ("flow v28: restricted character first placement", SharedBoardIntentTests.RestrictedCharacterCannotDirectlyCreateFirstPlacement),
    ("flow v28: explicit own placement without second consent", SharedBoardIntentTests.ExplicitOwnPlacementExecutesOnceWithoutSecondConsent),
    ("harness Gemini: native transport and private metadata", HarnessGeminiTests.TransportPartsAndPrivateMetadata),
    ("harness Gemini: missing IDs ordered parts and parallel tools", HarnessGeminiTests.MissingNativeIdsAndMultiToolResponses),
    ("harness Gemini: preflight and explicit endpoint configuration", HarnessGeminiTests.PreflightAndExplicitConfiguration),
    ("harness Gemini: strict outputs and safe diagnostics", HarnessGeminiTests.StrictOutputsAndSafeDiagnostics),
    ("harness Gemini real Pi: consent restart and exact replay", HarnessGeminiTests.RealPiConsentRestartAndReplay),
    ("harness Gemini: changed provider and unknown never retry", HarnessGeminiTests.ChangedProviderAndUnknownAreNotRetried),
    ("harness Gemini: malformed credentials never become unknown", HarnessGeminiTests.InvalidCredentialsNeverBecomeUnknown),
    ("business adventure API boundary", AdventureBusinessTests.Run),
    ("harness real Pi: process fault isolation and same-campaign rejection", HarnessPiIsolationTests.ProcessExitReleasesQueueWithoutReplayingUnknown),
    ("harness real Pi: active cancellation and host shutdown isolation", HarnessPiIsolationTests.ActiveCancellationAndHostStopRemainIsolated),
    ("harness discovery: own seat and safe progress", HarnessReadTests.OwnSeatDiscoveryAndSafeProgress),
    ("harness discovery: restart legacy metadata and unknown slots", HarnessReadTests.RestartLegacyMetadataAndUnknownDiscovery),
    ("harness discovery: closed runs and legacy campaigns", HarnessReadTests.ClosedRunsAndLegacyCampaigns),
    ("harness discovery: precise historical progress and read-only restart", HarnessReadTests.HistoricalProgressSurvivesNewRoundsAndRestart),
    ("harness discovery: host safe progress and chat identity", HarnessReadTests.HostProgressAndChatIdentity),
    ("harness discovery: exact step requests results and legacy restart", HarnessReadTests.HostStepRequestsAndResults),
    ("harness inventory: real Pi acquisition persistence and replay", HarnessInventoryTests.AcquisitionsPersistThroughPiAndReplay),
    ("harness inventory: strict boundary and plain narrative", HarnessInventoryTests.StrictAcquisitionBoundaryAndPlainNarrative),
    ("combat prompt: independent source versions replay and restart", HarnessCombatPromptTests.SeparateVersionedSourceAndReplay),
    ("combat session: interrupted second delegation stop and revoked grant", CombatAgentRedelegationTests.MissingFirstInputRecoveryCancellationAndRevocation),
    ("combat session: repeated handoffs renew generation without replay", CombatAgentRedelegationTests.TwoHandoffsKeepReceiptsAndRenewOnlyReturnGeneration),
    ("runtime encounter: personal discovery frames preserve audience", RuntimeEncounterHttpTests.PersonalDiscoveryExecutionFrames),
    ("combat session: persistent child prompts history wait restart and return", CombatAgentSessionTests.DelegationIndependentInputsRestartAndReturn),
    ("combat session: return crash recovery cancellation and original grant", CombatAgentRecoveryTests.ReturnCrashRecoveryCancellationAndOriginalGrant),
    ("combat session: multiplayer consent history and serialized continuation", CombatAgentMultiplayerTests.GroupConsentScopedContinuationAndSerialization),
    ("combat session: bounded native history and message-count compaction", CombatAgentHistoryTests.MessageCountCompactionAndExactNativePairs),
    ("combat session: cumulative native capture and long source paging", CombatAgentRecallTests.BoundedCaptureAndExactLongSourcePaging),
    ("combat session: native Gemini history and first unknown identity", HarnessGeminiTests.CombatChildNativeHistoryAndUnknownIdentity),
    ("harness workspace: revision history has no lifetime cap", HarnessWorkspaceTests.RevisionHistoryHasNoLifetimeCap),
    ("harness workspace: initialization crash never reverts", HarnessWorkspaceTests.InitializationCrashNeverReverts),
    ("harness workspace: lifecycle replay versions and rollback", HarnessWorkspaceTests.LifecycleReplayAndVersionIsolation),
    ("harness workspace: frozen Skills memory activation and restart", HarnessWorkspaceTests.FrozenRunSkillsMemoryAndRestart),
    ("harness workspace: atomic failures and corrupt preservation", HarnessWorkspaceTests.AtomicFailuresAndCorruptPreservation),
    ("harness workspace: memory privacy and export integrity", HarnessWorkspaceTests.MemoryPrivacyAndExportIntegrity),
    ("harness workspace: permissions and old run compatibility", HarnessWorkspaceTests.PermissionsAndLegacyRecord),
    ("harness real Pi: MCP multi-tool roll consent process restart and exact replay", HarnessPiTests.RealSdkMcpConsentRecovery),
    ("harness: default off strict input and no forged candidates", HarnessAuthorityTests.DefaultOffStrictInputsAndForgedActions),
    ("harness: revocation during model wait and concurrent replay", HarnessAuthorityTests.RevokedDuringModelWaitAndSameRequestConcurrency),
    ("harness v14: each state write invalidates offered IDs", HarnessAuthorityTests.WritesInvalidateCandidateIds),
    ("provider options: retry rechecks version and deadline", HarnessProviderOptionsTests.RetryRechecksCurrentVersionAndDeadline),
    ("provider options: readable Unicode thinking frozen history", HarnessProviderOptionsTests.ReadableUnicodeThinkingAndFrozenHistory),
    ("provider options: config defaults overrides validation", HarnessProviderOptionsTests.ConfigurationDefaultsOverridesAndValidation),
    ("provider options: default three incremental retries durable budget", HarnessProviderOptionsTests.DefaultThreeIncreasingRetriesAndDurableBudget),
    ("provider options: historian three retries frozen input and authorization", HarnessProviderOptionsTests.HistorianThreeRetriesFrozenInputAndAuthorization),
    ("provider options: retry classifications cancellation quota", HarnessProviderOptionsTests.RetryClassificationsCancellationAndQuota),
    ("provider options: silent hang times out per attempt and retries", HarnessProviderOptionsTests.SilentHangTimesOutAndRetries),
    ("provider options: real Pi retry single commit and replay", HarnessProviderOptionsTests.RealPiRetryNeverRepeatsCommittedToolAndReplay),
    ("provider options: real Pi exhaustion caps cancellation restart", HarnessProviderOptionsTests.RealPiExhaustionLimitCancellationAndRestart),
    ("harness: provider transport bounds and durable attempt budget", HarnessProviderTests.ExactTransportAndDurableAttempts),
("harness: provider failure diagnostics exclude private values", HarnessProviderTests.SafeFailureDiagnostics),
("harness: provider nullable tools and strict rejection", HarnessProviderTests.NullableToolCallsAndStrictRejections),
("harness budget real quota rejects without sending", HarnessBudgetTests.RealQuotaRejectedWithoutSending),
("harness budget real quota preserves committed effects", HarnessBudgetTests.RealQuotaAfterCommitIsNotUnknown),
("harness budget real endpoint preflight rejection", HarnessBudgetTests.RealPreflightEndpointRejected),
("harness budget real post-send failures remain unknown", HarnessBudgetTests.RealPostSendFailuresStayUnknown),
("harness budget continuation threshold survives waiting restart", HarnessBudgetTests.ContinuationThresholdSurvivesWaitingRestart),
("harness budget completed reply may cross continuation threshold", HarnessBudgetTests.CompletedReplyMayCrossContinuationThreshold),
    ("harness: public model projection private runs and skills", HarnessBoundaryTests.PrivateProjectionAndSeatIsolation),
    ("harness: same request ID across seats and revoked authority", HarnessBoundaryTests.SameRequestIdAcrossSeatsAndRevocation),
    ("harness: version conflict and sibling stop gate", HarnessBoundaryTests.StaleVersionAndMultiToolStop),
    ("harness: exact game receipt recovery across crash window", HarnessBoundaryTests.CommittedReceiptCrashRecovery),
    ("harness: closed receipts do not impose a lifetime run cap", HarnessBoundaryTests.ClosedRunsKeepReplayWithoutLifetimeCap),
    ("harness: cancellation explicitly discloses outstanding consent", HarnessBoundaryTests.CancellingGenerationDisclosesOutstandingConsent),
    ("harness: strict tools and corrupt journal preservation", HarnessBoundaryTests.StrictArgumentsAndCorruptJournal),
    ("harness: consent replay restart and legacy guards", HarnessTests.ConsentReplayAndRestart),
    ("harness: sensitive source and cancelled consent", HarnessTests.SensitiveSourceAndCancelledConsent),
    ("harness: committed effects survive unknown model result", HarnessTests.CommittedToolsSurviveModelFailure),
    ("harness: cancellation limits and nonblocking reads", HarnessTests.LimitsUnknownAndNonblockingReads),
    ("preparation concurrency: one in-flight call, unblocked reads and restart replay", PreparationConcurrencyTests.ConcurrentReceiptAndUnblockedReads),
    ("preparation concurrency: guest and foreign denial without provider or state changes", PreparationConcurrencyTests.GuestAndForeignCannotInspectOrGenerate),
    ("input preparation: public AI context and preserved visibility", PreparationBoundaryTests.PublicKnowledgeContext),
    ("input preparation: duplicate, casing, required fields and missing-place clarification", PreparationBoundaryTests.StrictProviderAndClarification),
    ("input preparation: archived replay and corrupt catalog preservation", PreparationBoundaryTests.ArchivedAndCorruptCatalog),
    ("input preparation: strict provider contract, projection and exact replay", PreparationTests.ContractAndProjection),
    ("input preparation: evidence, references, clarification, consent and offline guards", PreparationTests.ValidationFailuresAndClarification),
    ("input preparation: durable catalog, restart replay, unknown and capacity", PreparationTests.DurabilityCatalogAndRecovery),
    ("input preparation: live adapter transport, mechanical and bounds guards", PreparationTests.ProviderAdapterContract),
    ("input preparation: knowledge seeding, visibility, adoption and unlocated map", PreparationTests.KnowledgeSeedingVisibilityAndAdoption),
    ("input preparation: legacy content fingerprints and optional field validation", PreparationTests.LegacyFingerprintAndValidation),
    ("map markers: permissions, dynamic projection, unpublication and recovery", MapMarkerTests.PermissionsProjectionAndRecovery),    ("map markers: strict validation and campaign isolation", MapMarkerTests.ValidationAndIsolation),
    ("map markers: legacy records, old replay and fail-closed projection", MapMarkerTests.LegacyAndFailClosed),
    ("understanding: clarification, deferred roll, exact replay and restart", ActionUnderstandingTests.ClarifyRollReplayAndRestart),
    ("understanding: source-specific spell, zero preview costs and single-host ruling", ActionUnderstandingTests.SourceSpellAndRuling),
    ("understanding: seat authority, forged fields, stale continuation and cancel", ActionUnderstandingTests.AuthorityStaleAndCancel),
    ("understanding: private drafts across all projections and publication", ActionUnderstandingTests.PrivateUntilPublished),
    ("understanding: invalid model fallback, bounded clarification and offline trials", ActionUnderstandingTests.InvalidInterpretationAndOffline),
    ("private story: harness v16 world_record is actor-only across projections and restart", PrivateStoryTests.HarnessWorldRecord),
    ("private story: DM ruling text is actor-only, validated and never public", PrivateStoryTests.DmRulingPrivateText),
    ("understanding: bounded player-only context excludes private source and facts", ActionUnderstandingTests.BoundedPrivateContext),
    ("understanding: exact prompt transport, strict candidate output and legacy compatibility", ActionUnderstandingTests.ProviderContract),
    ("contextual rolls: defer randomness, exact replay and restart", ContextualRollTests.DeferredActionAndRestart),
    ("contextual rolls: seat authority, stale context, cancellation and input bounds", ContextualRollTests.AuthorityAndCancellation),
    ("contextual rolls: DM request waits for original player and preserves attribution", ContextualRollTests.HostRequestedCheck),
    ("contextual rolls: every party member confirms initiative; rest defers costs", ContextualRollTests.PartyInitiativeAndCosts),
    ("continuity: matched intent target and authoritative travel time", ContinuityTests.MatchedTarget),
    ("continuity: permissions, stale preview, old contexts, seats and indexed activity", ContinuityBoundaryTests.PermissionsAndHistory),
    ("continuity: authored outcome guards and paid item preservation", ContinuityBoundaryTests.OutcomesAndCosts),
    ("continuity: action, check, story preview, route, exact replay and restart", ContinuityTests.Loop),
    ("equipment loadout: slots hands quantity shield", EquipmentLoadoutTests.SlotsHandsQuantityAndShield),
    ("equipment loadout: grip attacks legacy reads", EquipmentLoadoutTests.GripAttacksAndLegacyReads),
    ("equipment loadout: standard dual drop slot pickup", EquipmentLoadoutTests.StandardDualDropAndSlotPickup),
    ("equipment loadout: review regressions and activity", EquipmentLoadoutTests.ReviewRegressionsAndActivity),
    ("equipment loadout: frozen catalogs versioned self", EquipmentLoadoutTests.FrozenCatalogsAndVersionedSelf),
    ("equipment loadout: HTTP zero writes receipts restart", EquipmentLoadoutTests.HttpZeroWritesReceiptsAndRestart),
    ("equipment loadout: real Pi v20 candidate and self", EquipmentLoadoutTests.RealPiV20LoadoutCandidateAndSelf),
    ("character rule details: scoped complete local references", CharacterRuleDetailsTests.Projection),
    ("character rule details: authenticated read and corrupt library notice", CharacterRuleDetailsTests.Http),
    ("character rule details: public peer references authorized pure GET", CharacterRuleDetailsTests.ReferencesHttp),
    ("all-class character sheet, source counters and short/long rest policies", CharacterPlayTests.ProjectionAndResources),
    ("generic owned equipment, source-specific spell use and preparation windows", CharacterPlayTests.EquipmentAndPreparation),
    ("unopposed checks, saving throws and pure allowlisted DM adjustments", CharacterPlayTests.ChecksAndAdjustments),
    ("character commands and DM preview: role isolation, exact replay and restart", CharacterPlayTests.HttpAndDurability),
    ("complete creation catalog and 1920 level-one origin/class combinations", FullCreationTests.CatalogAndCombinations),
    ("full creation authority, incomplete drafts and stale source dependencies", FullCreationTests.AuthorityAndDependencies),
    ("automatic map corrupt receipts fail closed and manual retry stays private", AutomaticMapTests.CorruptReceiptsRefuseReadsAndGeneration),
    ("adventure library adoption authority and restart", AdventureLibraryTests.AdoptionAuthorityAndRestart),
    ("adventure library map package validation and recovery", AdventureLibraryTests.MapPackageValidationAndRecovery),
    ("imported map HTTP authority and replay", ImportedMapTests.HttpAuthorityAndReplay),
    ("imported map public style real Pi missing area", ImportedMapTests.PublicStyleForMissingArea),
    ("initial adventure setup after room creation seats and restart", InitialAdventureTests.SetupAfterRoomCreationPreservesSeatsAndReplays),
    ("initial adventure legacy never converts implicitly", InitialAdventureTests.LegacyBlankNeverImplicitlyConverts),
    ("room reservation failure window restart and missing target", RoomTests.ReservationSurvivesOuterFailureWithoutAdmission),
    ("world record recovery: atomic rejection and corrected proposal", HarnessWorldRecordRecoveryTests.RejectedProposalIsAtomicAndRepairable),
    ("world record recovery: real Pi repair replay and restart", HarnessWorldRecordRecoveryTests.RealPiRepairsWithoutRepeatingAction),
    ("world record recovery: historical v16 and strict game gate", HarnessWorldRecordRecoveryTests.HistoricalV16StillFailsAndGameGateStaysStrict),
    ("self context: OpenAI Gemini wire native history and compaction", HarnessExecutionProtocolTests.ProviderSelfFramesPreserveNativeHistoryAndCompaction),
    ("self context: complete facts and independent spell routes", HarnessCharacterContextTests.FullFactsAndIndependentSpellRoutes),
    ("self context: complete collections and existing size boundary", HarnessCharacterContextTests.CompleteCollectionsAndExistingSizeBoundary),
    ("self context: authorized reads privacy and version shapes", HarnessCharacterContextTests.AuthorizedReadsPrivacyAndVersionShapes),
    ("self context: real Pi first write and confirmation refresh", HarnessCharacterContextTests.RealPiFirstWriteAndConfirmationRefresh),
    ("self context: frozen v18 catalog frames and restart replay", HarnessCharacterContextTests.FrozenV18CatalogFramesAndReplay),
    ("self context: malformed records and version mixing preserved", HarnessCharacterContextTests.MalformedSelfPreservesRunAndRejectsVersionMixing),
    ("character portraits: both joins, image privacy, reuse and restart", CharacterPortraitTests.JoinImagesPrivacyReuseAndRestart),
    ("character portraits: interrupted generation and explicit retry", CharacterPortraitTests.InterruptedGenerationNeedsExplicitRetry),
    ("character portraits: existing image adapter and private prompt", CharacterPortraitTests.ExistingAdapterUsesOneImageRequest),
    ("character portraits: disabled configuration, resubmit and registration recovery", CharacterPortraitTests.DisabledRegistrationResubmitAndIoRecovery),
    ("runtime encounter presentation: real Pi narrative gate restart and failure recovery", EncounterPresentationTests.RealPiNarrationGateAndRecovery),
    ("runtime encounter presentation: revoked discovery and private combat choices", RuntimeEncounterTests.PendingDiscoveriesSurviveRevocationAndHideChoices),
    ("map-independent perception: binding command receipts and restart", MapIndependentPerceptionTests.BindingReceiptAndRestart),
    ("map-independent perception: preparation binding state and real combat", MapIndependentPerceptionTests.PreparationBindingAndState),
    ("map-independent perception: real Pi own consent restart replay and privacy", MapIndependentPerceptionTests.RealPiConsentRestartAndPrivacy),
    ("runtime encounter HTTP: real Pi search group consent restart privacy", RuntimeEncounterHttpTests.RealPiSearchGroupConsentRestartAndPrivacy),
    ("runtime encounter: hidden initiative and real ranged damage", RuntimeEncounterTests.HiddenInitiativeAndActualRangedDamage),
    ("runtime encounter: personal search and Shield restart", RuntimeEncounterTests.HiddenSearchAndShieldRestart),
    ("runtime encounter: immutable source and tactical map", RuntimeEncounterTests.ImmutableSourceAndTacticalMap),
    ("runtime encounter: invalid setup zero mutations", RuntimeEncounterTests.InvalidSetupDoesNotMutate),
    ("runtime encounter: personal sight and combat Search", RuntimeEncounterTests.PersonalSightAndCombatSearch),
    ("runtime encounter: Goblin range and Nimble Escape", RuntimeEncounterTests.GoblinRangeAndEscape),
    ("narrative checks: AI difficulty after local action, consent restart and replay", NarrativeCheckTests.AiDeterminesDifficultyAfterLocalActionAndResumesOnce),
    ("narrative checks: plot save and preserved result after narration failure", NarrativeCheckTests.PlotSaveUsesSavingThrowAndKeepsResultOnNarrativeFailure),
    ("narrative checks: narration before a check stays as its own beat", NarrativeCheckTests.NarrationBeforeCheckStaysAsItsOwnBeat),
    ("narrative checks: new difficulty boundaries, frozen contracts and automatic failure", NarrativeCheckTests.AiDifficultyBoundariesOldContractsAndAutomaticFailure),
    ("narrative checks: authored difficulty and obvious information", NarrativeCheckTests.AuthoredDifficultyAndObviousInformationStayAuthoritative),
    ("flow repair: grounded threshold and paragraph boundaries", HarnessFlowRepairTests.GroundedThresholdAndParagraphBoundaries),
    ("flow repair: check boundaries and passive score", HarnessFlowRepairTests.CheckBoundariesAndPassiveScore),
("flow repair: scene check consent restart and replay", HarnessFlowRepairTests.SceneCheckConsentRestartAndReplay),
("flow repair: natural approach places without second confirmation", HarnessFlowRepairTests.NaturalApproachPlacesWithoutSecondConfirmation),
("flow repair: ruling privacy new legacy and restart", HarnessFlowRepairTests.RulingQuestionNeverPublicIncludingLegacy),
("DM checklist: unspoken intent knowledge reaches real Pi", HarnessDmChecklistTests.RealPiSeparatesUnspokenIntentFromCharacterKnowledge),
("DM checklist: ruling-linked roll pending and settled progress", HarnessDmChecklistTests.RulingRollKeepsExactPendingAndResolvedAssociation),
    ("DM checklist: real Pi reads rejection answer dice progress and replay", HarnessDmChecklistTests.RealPiProgressThroughReadsRejectionAnswerAndDice),
    ("DM checklist: OpenAI Gemini frames native history and compaction", HarnessExecutionProtocolTests.ProviderDmChecklistFramesPreserveNativeHistoryAndCompaction),
    ("read preload: private pinned projections and frozen v55", HarnessReadPreloadTests.PurePinnedPrivateAndFrozen),
    ("read preload: bounded omission and transport fallback", HarnessReadPreloadTests.SizeOmissionAndTransportFallback),
    ("read preload: real Pi batch restart and replay", HarnessReadPreloadTests.RealPiBatchFreezeRestartAndReplay),
    ("execution protocol: pure authority frames and corruption rejection", HarnessExecutionProtocolTests.FrameAuthorityIsReadOnlyAndCorruptionFailsClosed),
 ("execution protocol: provider frames signatures and compaction", HarnessExecutionProtocolTests.ProviderFramesPreserveNativeHistoryAndCompaction),
 ("execution protocol: compact frozen catalog", HarnessExecutionProtocolTests.CatalogIsShortAndFrozen),
 ("execution protocol: real Pi direct action map frames and restart", HarnessExecutionProtocolTests.DirectActionAndMapUseFreshFramesThroughPi),
 ("execution protocol: same batch cannot reuse expired authority", HarnessExecutionProtocolTests.SameBatchCannotReuseExpiredAuthority),
 ("execution protocol: real Pi consent stop and resume refresh", HarnessExecutionProtocolTests.ConsentStopsBatchAndResumeRefreshesWithoutRead),
 ("continuation regression: legacy step version read-only projection", HarnessContinuationRegressionTests.LegacyStepVersionProjectionIsReadOnlyAndBounded),
    ("continuation regression: multi-step failure and legacy restart accept next input", HarnessContinuationRegressionTests.MultiStepFailureAndLegacyRestartAcceptNextAction),
    ("continuation regression v14: real Pi map context refresh recovers after action", AutomaticMapTests.RefreshContextAfterActionRecoversWithoutSideEffects),
    ("automatic map scripted Pi MCP generation publication and restart", AutomaticMapTests.ScriptedPiMapPublishesWithoutHostCommands),
    ("automatic map scene status read-only catalog matrix", SceneMapStatusTests.CatalogStatesAreReadOnly),
    ("automatic map v22 frames and execution boundary", SceneMapStatusTests.PublicReadFramesAndExecutionBoundary),
    ("automatic map public inputs atomic receipts and manual withholding", AutomaticMapTests.PublicInputsAtomicMapReceiptAndManualWithholding),
    ("automatic map disabled and interrupted attempts never rebill", AutomaticMapTests.DisabledAndInterruptedNeverRebill),
    ("room lifecycle password rotation private replay restart and revocation", RoomTests.LifecycleReplayAndRestart),
    ("room atomic rejections concurrent admission and capacity", RoomTests.RejectionsAreAtomicAndConcurrentJoinIsSingle),
    ("room admission body password rate limits and read boundaries", RoomTests.AdmissionBoundariesAndReservations),
    ("expanded character runtime guards, strict HTTP, trial and restart", FullCreationTests.RuntimeAndHttp),
    ("bounded 2024 character choices, derived stats and unsupported input rejection", CharacterCreationTests.RulesAndBounds),
    ("retired simple creation, legacy saved character trial and restart", CharacterCreationTests.HttpPreviewAndDurability),
    ("server-authored action costs, distance and unavailable reasons without mutation", ActionInformationTests.BoardAndResources),
    ("action information HTTP projection never expands execution permissions", ActionInformationTests.HttpContract),
    ("immutable prompt library, explicit rollback, per-call trace and restart", AuthoringTests.VersionsAndTrace),
    ("preflight warnings, isolated durable trial replay and zero provider calls", AuthoringTests.PreflightAndOfflineTrial),
    ("imported prompts reach provider verbatim without built-in system text", ContentTests.PromptTransport),
    ("empty campaign, strict content import, pinned bindings and explicit activation", ContentTests.DraftValidationAndActivation),
    ("imported routes, checks, rewards, prompt revisions, replay and restart", ContentTests.RuntimeReplayAndRestart),
    ("import bounds, no arbitrary state patches and host-only source access", ContentTests.ImportBoundariesAndPermissions),
    ("imported multi-opponent encounter, target selection and save continuity", ContentTests.ImportedEncounters),
    ("same-origin workbench assets, headers and API isolation", WorkbenchTests.Hosting),
    ("2024 ability checks and advantage", Rules),
    ("HTTP create, auth, validation, snapshot", HttpContract),
    ("idempotency, concurrent writes, restart", Durability),
    ("playable adventure and fail-forward routes", AdventureLoop),
    ("AI outage and unsupported action preserve authority", AiFailure),
    ("untrusted AI output schema and intent whitelist", AiBoundary),
    ("map recovery, exact receipts, private images and lease protection", Assets),
    ("reference ownership, authoring and upload HTTP limits", AssetTests.Http),
    ("image generation and reference-edit provider contract", AssetTests.Provider),
    ("explicit map retry without auto-rebilling and private cache reuse", AssetTests.Worker),
    ("retired scene queues remain byte-identical, corrupt legacy isolation and archived map receipts", AssetTests.PassiveLegacyAndArchivedReplay),
    ("map associations, current-place projection, privacy, exact replay and restart", MapContextTests.ContextAndPermissions),
    ("unbound and foreign campaigns cannot invent map location bindings", MapContextTests.UnboundAndForeign),
    ("exploration map visibility and authoritative travel", MapTests.Run),
    ("2024 combat: natural 1/20, GWF, Savage Attacker, Graze", CombatTests.WeaponRules),
    ("combat initiative, budgets, grid and enemy turn", CombatTests.TurnAndGrid),
    ("opportunity attacks, nonlethal KO, recovery, victory and retreat", CombatTests.ReactionsAndRecovery),
    ("combat HTTP authority, concurrency, replay, restart and no AI calls", CombatTests.HttpDurability),
    ("quest fail-forward, NPC rescue, faction branch and rewards", StoryTests.FailedSearchAndWardens),
    ("mutually exclusive quest branch, reward replay and restart", StoryTests.GuildBranchReplayAndRestart),
    ("Wizard template, equipment and verified weapon rules", CharacterTests.TemplateAndEquipment),
    ("spell attack, critical, close-range disadvantage, missiles and slots", CharacterTests.SpellCombat),
    ("Mage Armor duration, Arcane Recovery, short/long rest and clock", CharacterTests.RecoveryAndClock),
    ("caster HTTP authority, retry, restart and no AI", CharacterTests.HttpDurability),
    ("milestone level 2 and Scholar expertise", GrowthTests.Milestones),
    ("Action Surge budgets and sequential short-rest dice", GrowthTests.ActionSurgeAndHitDice),
    ("growth and Tactical Mind retry/restart/authority", GrowthTests.HttpProgressionAndTacticalMind),
    ("world memory automatic narrative replay and restart", WorldMemoryTests.AutomaticMemoryReplayAndRestart),
    ("world memory invalid plans and bounded public context", WorldMemoryTests.InvalidPlansAndBoundedContext),
    ("world memory correction permissions privacy and history", WorldMemoryTests.CorrectionsPermissionsPrivacyAndHistory),
    ("world memory offline director bypass", WorldMemoryTests.OfflineBypassesDirector),
    ("world memory strict provider contract", WorldMemoryTests.StrictProviderContract),
    ("adventure input direct action roll replay and restart", AdventureInputTests.DirectRollReplayAndRestart),
    ("adventure input clarification choice cancellation and legacy", AdventureInputTests.ClarifyChooseCancelAndLegacy),
    ("adventure input resource consent and frozen context", AdventureInputTests.ResourceConsentAndFrozenContext),
    ("character review private history and input resubmit", CharacterReviewTests.PrivateReviewHistoryAndInputResubmit),
    ("character review pre-upgrade legacy receipt", CharacterReviewTests.PreReviewLegacyReceipt),
    ("character review lifecycle and gates", CharacterReviewTests.LifecycleAndGates),
    ("character review restart races and legacy", CharacterReviewTests.RestartRacesAndLegacy),
    ("character review pending seats stay out of combat", CharacterReviewTests.PendingSeatsStayOutOfCombat),
    ("party capabilities, own-character state, scoped retries and revocation", PartyTests.CapabilitiesAndReplay),
    ("single-use invitations, races, revocation and expiry", PartyTests.InviteRacesAndExpiry),
    ("party initiative, independent resources, individual retreat and recovery", PartyTests.TurnsResourcesAndRecovery),
    ("two-seat HTTP combat, permissions, simultaneous retry and restart", PartyTests.CooperativeHttp),
    ("bounded DM checks, actor attribution, no patches and context guards", RulingTests.Rules),
    ("DM HTTP authority, concurrency, replay and restart", RulingTests.Http),
    ("reset history: empty backward windows terminate without writes", JournalTests.ResetHistoryWindowsTerminateWithoutWriting),
    ("large legacy migration, indexed history and receipts beyond 10000", JournalTests.LargeLegacyAndReplay),
    ("atomic archive/state/receipt rollback and invalid migration preservation", JournalTests.AtomicRollbackAndInvalidMigration),
    ("archive permission, deterministic recap, frozen pages and safe transcript export", JournalTests.ArchiveRecapAndExport),
    ("unlimited provider usage remains durable", () => { ResourceTests.UnlimitedUsageRemainsDurable(); return Task.CompletedTask; }),
    ("durable provider quotas, simultaneous reservations, UTC days and lifetime ceiling", ResourceTests.DurableQuotas),
    ("text provider reservation, failed attempts, quota fallback and action authority", ResourceTests.TextProviderAndAuthority),
    ("explicit maps, publication permissions, durable quotas and passive scene compatibility", ResourceTests.MapsPermissionsAndQuota)
};
if (args.Length != 0)
{
    if (args.Length != 2 || args[0] != "--filter") throw new ArgumentException("Use --filter <name substring>");
    tests = tests.Where(t => t.Name.Contains(args[1], StringComparison.OrdinalIgnoreCase)).ToArray();
    if (tests.Length == 0) throw new ArgumentException("No test groups matched the filter.");
}
var failed = 0;
foreach (var test in tests)
{
    try { await test.Run(); Console.WriteLine("PASS " + test.Name); }
    catch (Exception ex) { failed++; Console.Error.WriteLine("FAIL " + test.Name + "\n" + ex); }
}
Console.WriteLine($"{tests.Length - failed}/{tests.Length} test groups passed.");
return failed == 0 ? 0 : 1;

static Task Rules()
{
    Check.Equal(-1, RulesEngine.AbilityModifier(9));
    Check.Equal(3, RulesEngine.AbilityModifier(17));
    var character = StarterCharacter.Create("Arden");
    Check.Equal(12, character.MaxHitPoints);
    Check.Equal(16, character.ArmorClass);
    Check.Equal(54, character.Inventory.Single(i => i.Id == "gold-piece").Quantity);
    var dice = new SequenceDice(1, 20, 4, 17, 4, 17, 11);
    var rules = new RulesEngine(dice);
    Check.True(rules.AbilityCheck(character, "wisdom", "Perception", 4).Success, "Natural 1 not auto failure");
    Check.True(!rules.AbilityCheck(character, "wisdom", "Perception", 30).Success, "Natural 20 not auto success");
    var adv = rules.AbilityCheck(character, "wisdom", "Perception", 15, advantage: true);
    Check.Equal(17, adv.Selected); Check.Equal(20, adv.Total); Check.Equal("advantage", adv.Mode);
    var dis = rules.AbilityCheck(character, "wisdom", "Perception", 15, disadvantage: true);
    Check.Equal(4, dis.Selected); Check.True(!dis.Success);
    var cancelled = rules.AbilityCheck(character, "wisdom", "Perception", 14, true, true);
    Check.Equal(1, cancelled.Rolls.Length); Check.Equal("normal", cancelled.Mode); Check.True(cancelled.Success);
    Check.Equal(7, dice.Count);
    return Task.CompletedTask;
}

static async Task HttpContract()
{
    await using var host = await Host.Start();
    var created = await host.Create();
    var snapshot = created.Snapshot;
    Check.Equal("dnd2024", snapshot.Ruleset); Check.Equal("XPHB", snapshot.Character.Required().Source);
    Check.Equal("harbor", snapshot.Scene.Id); Check.Equal(1, snapshot.Version);
    Check.True(snapshot.SceneAsset.Status == "removed");
    Check.True(snapshot.SceneAsset.FallbackAssetId.StartsWith("builtin:"));
    var json = JsonSerializer.Serialize(snapshot);
    Check.True(!json.Contains(created.AccessToken) && !json.Contains("TokenHash"));
    host.Http.DefaultRequestHeaders.Authorization = null;
    Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync($"/api/v1/campaigns/{snapshot.Id}")).StatusCode);
    host.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", new string('0', 64));
    Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync($"/api/v1/campaigns/{snapshot.Id}")).StatusCode);
    host.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", created.AccessToken);
    var forged = new StringContent(JsonSerializer.Serialize(new
    { requestId = Guid.NewGuid(), expectedVersion = 1, kind = "investigate", dc = 0, hitPoints = 999 }), Encoding.UTF8, "application/json");
    Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsync($"/api/v1/campaigns/{snapshot.Id}/actions", forged)).StatusCode);
    Check.Equal(HttpStatusCode.Conflict, (await host.Send(snapshot.Id, new(Guid.NewGuid().ToString(), 1, "travel", "beacon"))).StatusCode);
    Check.Equal(HttpStatusCode.BadRequest, (await host.Send(snapshot.Id, new(Guid.NewGuid().ToString(), 1, "observe", "", "also heal"))).StatusCode);
    Check.Equal(HttpStatusCode.BadRequest, (await host.Send(snapshot.Id, new(Guid.NewGuid().ToString(), 1, "natural", "", ""))).StatusCode);
    Check.Equal(1, (await host.Get(snapshot.Id))!.Version);
    // Create carries the imported document, so the transport guard moved above the old 16 KiB
    // default (the 1 MiB import ceiling is covered by the content-import HTTP tests). An
    // over-long name inside a legal-size body stays an input-validation failure.
    var tooLarge = new StringContent("{\"name\":\"" + new string('x', 18000) + "\",\"characterName\":\"a\"}", Encoding.UTF8, "application/json");
    Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsync("/api/v1/campaigns", tooLarge)).StatusCode);
    var other = await host.Create("Other");    Check.Equal(HttpStatusCode.NotFound, (await host.Http.GetAsync($"/api/v1/campaigns/{other.Snapshot.Id}/assets/{snapshot.SceneAsset.Id}")).StatusCode);
}

static async Task Durability()
{
    var dice = new SequenceDice(14);
    var host = await Host.Start(dice: dice);
    var created = await host.Create();
    var id = created.Snapshot.Id;
    var request = new ActionRequest(Guid.NewGuid().ToString(), 1, "investigate");
    var results = await Task.WhenAll(host.Send(id, request), host.Send(id, request));
    foreach (var result in results) Check.Equal(HttpStatusCode.OK, result.StatusCode);
    var first = (await results[0].Content.ReadFromJsonAsync<ActionResponse>())!;
    var second = (await results[1].Content.ReadFromJsonAsync<ActionResponse>())!;
    Check.True(first.Replayed != second.Replayed); Check.Equal(1, dice.Count);
    Check.Equal(14, first.Resolution.Check!.Selected); Check.Equal(14, second.Resolution.Check!.Selected);
    Check.Equal(2, second.Snapshot.Version);
    Check.Equal(HttpStatusCode.Conflict, (await host.Send(id, request with { Kind = "observe" })).StatusCode);
    var current = (await host.Get(id))!;
    var competing = await Task.WhenAll(
        host.Send(id, new(Guid.NewGuid().ToString(), current.Version, "observe")),
        host.Send(id, new(Guid.NewGuid().ToString(), current.Version, "observe")));
    Check.Equal(1, competing.Count(r => r.StatusCode == HttpStatusCode.OK));
    Check.Equal(1, competing.Count(r => r.StatusCode == HttpStatusCode.Conflict));
    Check.Equal(3, (await host.Get(id))!.Version);
    var path = host.Root;
    await host.DisposeAsync();
    await using var restarted = await Host.Start(path, dice);
    restarted.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", created.AccessToken);
    var replay = (await (await restarted.Send(id, request)).Content.ReadFromJsonAsync<ActionResponse>())!;
    Check.True(replay.Replayed); Check.Equal(3, replay.Snapshot.Version); Check.Equal(1, dice.Count);
    var events = (await restarted.Http.GetFromJsonAsync<GameEvent[]>($"/api/v1/campaigns/{id}/events?after=1&limit=1"))!;
    Check.Equal(1, events.Length); Check.Equal(2, events[0].Sequence);
    Check.True(!Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(path, "campaigns", id + ".sqlite"))).Contains(created.AccessToken));
}

static async Task AdventureLoop()
{
    var dice = new SequenceDice(1, 1, 1);
    await using var host = await Host.Start(dice: dice);
    var s = (await host.Create()).Snapshot;
    var failed = await host.Act(s, "investigate");
    Check.True(!failed.Resolution.Check!.Success);
    Check.True(failed.Snapshot.AvailableActions.All(a => a.Kind != "investigate"));
    var talk = await host.Act(failed.Snapshot, "talk");
    Check.True(talk.Snapshot.Facts.Contains("safe-route"));
    var move = await host.Act(talk.Snapshot, "travel", "causeway");
    Check.True(move.Snapshot.SceneAsset.Id != s.SceneAsset.Id);
    move = await host.Act(move.Snapshot, "investigate");
    Check.True(!move.Resolution.Check!.Success);
    move = await host.Act(move.Snapshot, "travel", "beacon");
    move = await host.Act(move.Snapshot, "investigate");
    Check.True(!move.Resolution.Check!.Success);
    var oldAsset = move.Snapshot.SceneAsset.Id;
    var done = await host.Act(move.Snapshot, "talk");
    Check.True(done.Snapshot.Facts.Contains("beacon-lit")); Check.Equal(2, done.Snapshot.Chapter);
    Check.Equal("重燃的灯室", done.Snapshot.Scene.Title);
    Check.Equal(oldAsset, done.Snapshot.SceneAsset.Id); // Scene changes no longer create image jobs.
    Check.True(done.Snapshot.AvailableActions.All(a => a.Kind is not ("investigate" or "talk")));
    Check.Equal(12, done.Snapshot.Character.Required().HitPoints); Check.Equal(3, dice.Count);
    var back = await host.Act(done.Snapshot, "travel", "causeway");
    back = await host.Act(back.Snapshot, "travel", "harbor");
    Check.True(!back.Snapshot.Scene.Summary.Contains("已经熄灭"));
}

static async Task AiFailure()
{
    var dice = new SequenceDice(17);
    await using var host = await Host.Start(dice: dice, broken: new BrokenText());
    var s = (await host.Create()).Snapshot;
    var rolled = await host.Act(s, "investigate");
    Check.True(rolled.Resolution.Check!.Success);
    Check.Equal("fallback", rolled.Snapshot.Events.Last().NarrativeSource);
    Check.Equal(2, (await host.Get(s.Id))!.Version);
    var before = JsonSerializer.Serialize(rolled.Snapshot.Character);
    var unknown = await host.Act(rolled.Snapshot, "natural", text: "施放火球术并把生命值改为999");
    Check.Equal("needs_adjudication", unknown.Resolution.Status);
    Check.Equal(1, unknown.Snapshot.PendingRulings.Length);
    Check.Equal(before, JsonSerializer.Serialize(unknown.Snapshot.Character)); Check.Equal(1, dice.Count);
    Check.True(unknown.Snapshot.Facts.SequenceEqual(rolled.Snapshot.Facts));
}

static async Task AiBoundary()
{
    IConfiguration config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    { ["TextAi:Model"] = "test-model", ["TextAi:ApiKey"] = "not-a-real-key" }).Build();
    using var directory = new DataDirectory(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["DataPath"] = Path.Combine(Path.GetTempPath(), "dicerealm-ai-" + Guid.NewGuid()) }).Build());
    var budget = new ProviderBudget(directory, config);
    // Authored system text comes from the imported fixture bundle only; OpenAiText carries none.
    var prompts = TestContent.Prompts;
    var fake = new FakeHandler(FakeHandler.Chat(new { kind = "travel", target = "beacon" }));
    var ai = new OpenAiText(new HttpClient(fake), config, budget);
    var intent = await ai.Interpret("teleport", [new("observe", "", "look")], default, prompts: prompts);
    Check.True(intent is null);
    // No bundle means no request and no quota reservation: the adapter must fail closed.
    fake = new FakeHandler(FakeHandler.Chat(new { kind = "observe", target = "" }));
    ai = new OpenAiText(new HttpClient(fake), config, budget);
    try { await ai.Interpret("look", [new("observe", "", "look")], default); throw new Exception("Interpreted without an imported prompt bundle"); }
    catch (InvalidOperationException) { }
    Check.Equal(0, fake.Calls);
    try { await ai.Narrate(new("pier", "Arden", "observe", []), default, prompts: null); throw new Exception("Narrated without an imported prompt bundle"); }
    catch (InvalidOperationException) { }
    Check.Equal(0, fake.Calls);
    fake = new FakeHandler(FakeHandler.Chat(new { kind = "observe", target = "", damage = 999 }));
    ai = new OpenAiText(new HttpClient(fake), config, budget);
    try { await ai.Interpret("look", [new("observe", "", "look")], default, prompts: prompts); throw new Exception("Accepted mutation"); }
    catch (JsonException) { }
    // Tone and length limits belong to the authored bundle; transport limits belong to the server.
    // Prose is decoration either way: it is never parsed into state (see AiFailure for that).
    fake = new FakeHandler(FakeHandler.Chat(new { text = "你恢复了99点生命。" }));
    ai = new OpenAiText(new HttpClient(fake), config, budget);
    Check.Equal("ai", (await ai.Narrate(new("pier", "Arden", "No mechanical change", []), default, prompts: prompts)).Source);
    // A control character in the AUTHORED bundle is refused before any wire body is built, so the
    // provider is never reached and no quota is reserved.
    var tainted = TestContent.Prompts with { Narration = "越界\u0000叙事" };
    fake = new FakeHandler(FakeHandler.Chat(new { text = "never read" }));
    ai = new OpenAiText(new HttpClient(fake), config, budget);
    try { await ai.Narrate(new("pier", "Arden", "observe", []), default, prompts: tainted); throw new Exception("Accepted a tainted narration bundle"); }
    catch (ArgumentException) { }
    Check.Equal(0, fake.Calls);
    try { await ai.Interpret("look", [new("observe", "", "look")], default, prompts: tainted with { Narration = "ok", Intent = "越界\u0000指令" }); throw new Exception("Accepted a tainted intent bundle"); }
    catch (ArgumentException) { }
    Check.Equal(0, fake.Calls);
    // Authored prose decides wording and length of style; the server only bounds transport and the
    // response shape. Prose stays decoration: state authority is covered by AiFailure.
    fake = new FakeHandler(FakeHandler.Chat(new { text = "你恢复了99点生命。" }));
    ai = new OpenAiText(new HttpClient(fake), config, budget);
    Check.Equal("ai", (await ai.Narrate(new("pier", "Arden", "No mechanical change", []), default, prompts: prompts)).Source);
    fake = new FakeHandler(FakeHandler.Chat(new { text = "潮雾掠过湿冷的石面。", facts = new[] { "beacon-lit" } }));
    ai = new OpenAiText(new HttpClient(fake), config, budget);
    try { await ai.Narrate(new("pier", "Arden", "observe", []), default, prompts: prompts); throw new Exception("Accepted a narrative side channel"); }
    catch (JsonException) { }
    fake = new FakeHandler(FakeHandler.Chat(new { text = new string('雾', 5000) }));
    ai = new OpenAiText(new HttpClient(fake), config, budget);
    try { await ai.Narrate(new("pier", "Arden", "observe", []), default, prompts: prompts); throw new Exception("Accepted unbounded prose"); }
    catch (InvalidDataException) { }
    Check.Equal(1, fake.Calls); // over-length is a response-side transport guard, not a prompt refusal
    fake = new FakeHandler(FakeHandler.Chat(new { text = "潮雾掠过湿冷的石面。" }));
    ai = new OpenAiText(new HttpClient(fake), config, budget);
    Check.Equal("ai", (await ai.Narrate(new("pier", "Arden", "observe", []), default, prompts: prompts)).Source);
}

static Task Assets() => AssetTests.Catalog();
