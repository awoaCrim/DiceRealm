using System.Text.Json.Serialization;

namespace DiceRealm.Server.Application;

public sealed record AccountUser(string Id, string Username, bool IsAdmin, bool Disabled);
public sealed record AccountLoginRequest(string Username, string Password);
public sealed record AccountLoginResponse(string AccessToken, AccountUser User);
public sealed record CreateAccountRequest(string Username, string Password);
public sealed record AccountStatusRequest(bool Disabled);
public sealed record AccountPasswordRequest(string Password);
public sealed record ChangeAccountPasswordRequest(string CurrentPassword, string Password);
// A damaged or unsupported record is reported as an entry the workbench must not open. Healthy
// summaries keep their exact previous shape; only an unavailable record carries the flag.
public sealed record AccountCampaign(string Id, string Name, bool Archived, string? OwnerUserId, string? OwnerUsername,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool Unavailable = false);
