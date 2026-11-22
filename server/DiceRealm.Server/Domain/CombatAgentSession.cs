using System.Text.Json.Serialization;

namespace DiceRealm.Server.Domain;

// Scene ownership, not another combat rules engine or an unbounded per-input HarnessRun.
// The complete private journals remain in the run store; these are immutable references.
public sealed class CombatAgentSession
{
    public int SchemaVersion { get; init; } = 1;
    public required string Id { get; init; }
    public required string SceneId { get; init; }
    public required string EncounterId { get; init; }
    public required string ParentActorId { get; init; }
    public required string ParentRunId { get; init; }
    public required string ParentIntentId { get; init; }
    // Revocable reference to the credential that actually delegated; never a bearer token.
    public required string ParentCredentialHash { get; init; }
    public required HarnessProfile Profile { get; init; }
    public required int ToolContractVersion { get; init; }
    public string? RulesCatalogVersion { get; init; }
    public required CombatAgentHandoff Handoff { get; init; }
    public required int StartedVersion { get; init; }
    public required string[] Members { get; init; }
    public List<CombatAgentInput> Inputs { get; init; } = [];
    public string Phase { get; set; } = "active";
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? PriorBattleId { get; init; }
    public string? BattleId { get; set; }
    public CombatAgentReturn? Return { get; set; }
    public bool ReturnConsumed { get; set; }
}

// Parent-authored interpretation remains attributed and private to that seat. Neither
// these notes nor the original input become public world facts or new rules authority.
public sealed record CombatAgentHandoff(string OriginalInput, string Reason, NarrativeContinuityEntry[] Continuity,
    int SourceAfter = 0, CombatAgentProgress[]? Progress = null);
public sealed record CombatAgentProgress(int Sequence, string Status, string Kind, string Summary);
public sealed record CombatAgentPerson(string Id, string Name, string Summary, string Audience = "public");
public sealed record CombatAgentUnitResult(string Id, string Name, string Team, int HitPoints, int TemporaryHitPoints,
    string[] Conditions, bool Withdrawn, int X, int Y, string? BoardEntityId, BoardCombatPosition? BoardPosition,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Audience = null);
public sealed record CombatAgentInput(string ActorId, string RunId, string IntentId, string Fingerprint, string Input, int AcceptedVersion,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? ToolContractVersion = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] CombatCommandSource? Command = null);
// A continuation of a committed command, not another player utterance or action request.
public sealed record CombatCommandSource(string RequestId, string BattleId, int Sequence, int RootSequence)
{
    public bool Valid(int version) => Guid.TryParseExact(RequestId, "D", out _) && Guid.TryParseExact(BattleId, "D", out _) &&
        RootSequence >= 1 && RootSequence <= Sequence && Sequence <= version;
}
public sealed record CombatAgentActorResult(string ActorId, int HitPoints, int TemporaryHitPoints, string[] Conditions,
    Resource[] Resources, TimedEffect[]? Effects, ConcentrationEffect? Concentration);
public sealed record CombatAgentLog(CombatEntry Entry, string Audience);
// Source-addressed story data frozen with the return, never commands or current state.
public sealed record CombatAgentStory(string SourceId, int Sequence, string Part, string Revision,
    string ActorId, string Audience, string Kind, string Text);
public sealed record CombatAgentReturn(string Id, string BattleId, string Status, int Version, string SceneId,
    long ElapsedSeconds, CombatAgentActorResult Actor, CombatAgentLog[] Log, CombatAgentInput[] Inputs,
    CombatAgentUnitResult[]? Units = null, BoardCombatLayout? BoardLayout = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] CombatAgentStory[]? Story = null);

public static class CombatAgentSessions
{
    // A prepared runtime encounter is delegated BEFORE the child commits engagement
    // and requests initiative. AvailableEncounter intentionally excludes that stage.
    public static ContentEncounter? DelegatableEncounter(Campaign c, bool includeActive = false)
    {
        if (includeActive && CombatEngine.InCombat(c) && c.Combat is { } battle)
        {
            var existing = RuntimeEncounters.Current(c)?.Definition ?? ContentRuntime.Scene(c)?.Encounter;
            return existing?.Id == battle.DefinitionId ? existing : null;
        }
        return ContentRuntime.AvailableEncounter(c) ??
            (RuntimeEncounters.Current(c) is { EngagementReason: null, Layout: not null } setup && !c.AttemptedEncounters.Contains(setup.Definition.Id)
                ? setup.Definition : null);
    }

    public static CombatAgentSession? Current(Campaign c) => c.CombatAgentSessions?.SingleOrDefault(s => s.Phase != "returned");
    public static CombatAgentSession Require(Campaign c, string id) => c.CombatAgentSessions?.SingleOrDefault(s => s.Id == id)
        ?? throw new GameException("combat_session_unavailable", "战斗子会话不存在；不会另建战斗或重掷。", 409);

    public static void ValidateState(Campaign c)
    {
        if (c.CombatAgentSessions is not { } sessions) return;
        bool Uuid(string? value) => Guid.TryParseExact(value, "D", out _);
        bool Hash(string? value) => value is { Length: 64 } && value.All(char.IsAsciiHexDigit);
        bool Actor(string? value) => value == PartyEngine.HostId || c.PartyMembers.Any(m => m.Id == value);
        bool Strings(string[]? values) => values is not null && values.All(v => v is not null);
        if (sessions.Any(s => s is null || s.SchemaVersion != 1 || !Uuid(s.Id) || !Uuid(s.ParentRunId) || !Uuid(s.ParentIntentId) ||
            !Actor(s.ParentActorId) || !Hash(s.ParentCredentialHash) || string.IsNullOrEmpty(s.SceneId) || string.IsNullOrEmpty(s.EncounterId) ||
            s.StartedVersion < 1 || s.StartedVersion > c.Version || s.ToolContractVersion < 36 || s.Profile is null ||
            s.Handoff is null || s.Handoff.OriginalInput is not { Length: > 0 and <= 1000 } || s.Handoff.Reason is not { Length: > 0 and <= 1000 } ||
            s.Handoff.Continuity is null || s.Handoff.SourceAfter < 0 || s.Handoff.SourceAfter >= s.StartedVersion ||
            s.Handoff.Progress is { } progress && (progress.Length > 8 || progress.Any(p => p is null || p.Sequence <= s.Handoff.SourceAfter ||
                p.Sequence > s.StartedVersion || p.Status is null || p.Kind is null || p.Summary is not { Length: <= 240 })) ||
            s.Members is not { Length: > 0 } || s.Members.Any(a => !Actor(a)) ||
            !s.Members.Contains(s.ParentActorId) || s.Members.Distinct().Count() != s.Members.Length || s.Inputs is not { Count: > 0 } ||
            s.Inputs.Any(i => i is null || !s.Members.Contains(i.ActorId) || !Uuid(i.RunId) || !Uuid(i.IntentId) || !Hash(i.Fingerprint) ||
                i.Input is not { Length: > 0 and <= 1000 } || i.AcceptedVersion < s.StartedVersion || i.AcceptedVersion > c.Version || i.ToolContractVersion is < 49 ||
                i.Command is { } command && (!command.Valid(i.AcceptedVersion) || command.Sequence != i.AcceptedVersion ||
                    command.BattleId != s.BattleId || (i.ToolContractVersion ?? s.ToolContractVersion) < 51 || i == s.Inputs[0])) ||
            s.Inputs.Select(i => (i.ActorId, i.RunId)).Distinct().Count() != s.Inputs.Count ||
            s.Inputs.Where(i => i.Command is not null).Select(i => (i.ActorId, i.Command!.RequestId)).Distinct().Count() != s.Inputs.Count(i => i.Command is not null) ||
            s.PriorBattleId is not null && (s.PriorBattleId.Length == 0 || s.PriorBattleId == s.BattleId) ||
            s.Phase is not ("active" or "return_pending" or "returned") ||
            (s.Phase == "active") != (s.Return is null) || s.ReturnConsumed != (s.Phase == "returned") ||
            s.Return is { } r && (!Uuid(r.Id) || string.IsNullOrEmpty(r.BattleId) || r.BattleId != s.BattleId || r.Version < s.StartedVersion || r.Version > c.Version ||
                string.IsNullOrEmpty(r.SceneId) || r.ElapsedSeconds < 0 || r.Status is not ("victory" or "defeated" or "retreated") ||
                r.Actor is null || r.Actor.ActorId != s.ParentActorId || r.Actor.HitPoints < 0 || r.Actor.TemporaryHitPoints < 0 ||
                !Strings(r.Actor.Conditions) || r.Actor.Resources is null || r.Actor.Resources.Any(x => x is null || x.Name is null || x.Current < 0 || x.Maximum < x.Current) ||
                r.Actor.Effects is { } effects && effects.Any(x => x is null || x.Id is null || x.Name is null) ||
                r.Story is { } story && (s.ToolContractVersion < 45 || story.Any(x => x is null || string.IsNullOrEmpty(x.SourceId) ||
                    x.Sequence < 0 || x.Sequence > r.Version || x.Part is null || !Hash(x.Revision) || x.ActorId is null ||
                    x.Audience != "public" && x.Audience != s.ParentActorId || string.IsNullOrEmpty(x.Kind) || x.Text is null ||
                    x.Revision != PrivateStories.Revision(x.Text))) ||
                r.Inputs is null || !r.Inputs.SequenceEqual(s.Inputs) || r.Log is null || r.Log.Any(x => x is null || x.Audience is not ("public" or "actor") || x.Entry is null || x.Entry.Sequence < 1 || x.Entry.Text is null || x.Entry.Kind is null || x.Entry.ActorId is null) ||
                r.Log.Select(x => x.Entry.Sequence).Distinct().Count() != r.Log.Length ||
                r.Units is { } units && (units.Any(u => u is null || string.IsNullOrEmpty(u.Id) || u.Name is null || u.Team is null ||
                    u.HitPoints < 0 || u.TemporaryHitPoints < 0 || !Strings(u.Conditions) || u.Audience is not (null or "public" or "actor") || s.ToolContractVersion >= 37 && u.Audience is null) || units.Select(u => u.Id).Distinct().Count() != units.Length))) ||
            sessions.Count(s => s.Phase != "returned") > 1 || sessions.Select(s => s.Id).Distinct().Count() != sessions.Count)
            throw Invalid();
        foreach (var session in sessions)
        {
            try
            {
                HarnessProfiles.Validate(session.Profile.Preset, session.Profile.Skills);
                NarrativeContinuities.Validate(session.Handoff.Continuity);
            }
            catch (GameException) { throw Invalid(); }
        }
    }

    private static GameException Invalid() => new("invalid_combat_session", "战斗子会话记录损坏或版本不支持；原记录保留。", 409);
}
