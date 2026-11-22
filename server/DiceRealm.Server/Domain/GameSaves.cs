namespace DiceRealm.Server.Domain;

public sealed record GameSavePartyMember(string ActorId, string Name, int Level, bool Dead);
public sealed record GameSaveView(string Id, string Name, int Revision, DateTimeOffset CreatedAt,
    string SceneTitle, long ElapsedSeconds, int Version, string Kind, GameSavePartyMember[] Party);
public sealed record GameSaveList(GameSaveView[] Entries, bool CanSave, string Reason);
public sealed record SaveGameRequest(string RequestId, int ExpectedVersion, string Name,
    string? SaveId = null, int? ExpectedSaveRevision = null);
public sealed record LoadGameRequest(string RequestId, int ExpectedVersion, int ExpectedSaveRevision);
public sealed record DeleteGameSaveRequest(string RequestId, int ExpectedSaveRevision);
public sealed record RestartGameRequest(string RequestId, int ExpectedVersion);
public sealed record GameSaveResponse(CampaignSnapshot Snapshot, string? SaveId, bool Replayed);
