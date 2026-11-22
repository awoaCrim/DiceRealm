namespace DiceRealm.Server.Domain;

// Display data only. The image task and visual source remain outside the game aggregate.
public sealed record CharacterPortraitView(string Id, string Status, string ImageUrl, string ContentHash,
    int Width, int Height, string Error, string FailureId = "");
public sealed record RequestCharacterPortrait(string RequestId, string ExpectedPortraitId, string RetryFailureId = "");
public sealed record CharacterPortraitResponse(CharacterPortraitView Portrait, bool Replayed);
public sealed record CharacterPortraitImage(string Path, string ContentHash);
