using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    public Task<PartyRestView> ReadPartyRest(string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c => Task.FromResult(PartyRest.View(c)), ct);

    public Task<ActionResponse> RestParty(string id, string token, PartyRestRequest request, CancellationToken ct) =>
        HostCommand(id, token, request.RequestId, request.ExpectedVersion, "party.rest", request,
            c => PartyRest.Apply(c, request.Kind), ct);
}
