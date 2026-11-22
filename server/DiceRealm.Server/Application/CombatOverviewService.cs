using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    // Read-only host projection: an ordinary authenticated read that never rolls, saves
    // or moves the acting seat. Non-host seats keep the existing 403 contract.
    public Task<CombatOverviewView> CombatOverview(string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            return Task.FromResult(CombatOverviewProjection.Project(c));
        }, ct);
}
