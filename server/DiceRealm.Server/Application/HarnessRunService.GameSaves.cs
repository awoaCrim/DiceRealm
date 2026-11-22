using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class HarnessRunService
{
    // Every operation takes scheduling before the real campaign gate. A worker cannot
    // start between the busy decision and capture/replacement. Finished/waiting journals
    // are ordinary persisted data; no AI or replay is started by a save operation.
    private async Task<T> GameSaveGate<T>(string campaign, Func<string, bool, Task<T>> operation, CancellationToken ct)
    {
        campaign = JsonFiles.CampaignId(campaign);
        await scheduling.WaitAsync(ct);
        try { return await operation(campaign, stopping || CampaignExecuting(campaign)); }
        finally { scheduling.Release(); }
    }
    public Task<GameSaveList> GameSaves(string campaign, string token, CancellationToken ct) =>
        GameSaveGate(campaign, (id, busy) => game.ListGameSaves(id, token, busy, ct), ct);
    public Task<GameSaveResponse> SaveGame(string campaign, string token, SaveGameRequest request, CancellationToken ct) =>
        GameSaveGate(campaign, (id, busy) => game.SaveGame(id, token, request, busy, runs, ct), ct);
    public Task<GameSaveResponse> LoadGame(string campaign, string token, string saveId, LoadGameRequest request, CancellationToken ct) =>
        GameSaveGate(campaign, (id, busy) => game.LoadGame(id, token, saveId, request, busy, runs, ct), ct);
    public Task<GameSaveResponse> DeleteGameSave(string campaign, string token, string saveId, DeleteGameSaveRequest request, CancellationToken ct) =>
        GameSaveGate(campaign, (id, _) => game.DeleteGameSave(id, token, saveId, request, ct), ct);
    public Task<GameSaveResponse> RestartGame(string campaign, string token, RestartGameRequest request, CancellationToken ct) =>
        GameSaveGate(campaign, (id, busy) => game.RestartGame(id, token, request, busy, runs, ct), ct);
}
