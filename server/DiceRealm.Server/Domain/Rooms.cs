namespace DiceRealm.Server.Domain;

// Only CampaignStore persists these credentials; public views never serialize RoomSettings.
public sealed record RoomSettings(string Number, bool Enabled, string Salt, string PasswordHash);
public sealed record RoomJoinReceipt(string RequestId, string Fingerprint);
public sealed record RoomView(string RoomNumber, bool Enabled, int Version);
public sealed record ConfigureRoomRequest(string RequestId, int ExpectedVersion, bool Enabled, string Password = "");
public sealed record JoinRoomRequest(string RoomNumber, string Password, string RequestId, string AccessToken, CharacterBuild? Build);
