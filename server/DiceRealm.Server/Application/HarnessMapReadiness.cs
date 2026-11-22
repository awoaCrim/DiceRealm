using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    // Run callbacks await this outside the campaign gate. The queue receipt stays frozen;
    // only the owning Run step persists this eventual tool output.
    internal async Task<HarnessToolOutcome> AwaitHarnessMap(string id, string token, string actor, int version,
        string commandId, string fingerprint, CancellationToken ct, CombatRunAuthority? authority = null)
    {
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            AutomaticMapResponse response = await AccessHarness(id, token, false, c =>
            {
                HarnessContext(c, actor, version);
                var progress = mapCatalog.AutomaticProgress(c.Id, actor, commandId, fingerprint, c.SceneId, "tactical")
                    ?? throw HarnessJson.Conflict("harness_tool_unknown");
                if (progress.Version != version) throw HarnessJson.Conflict("stale_version");
                return Task.FromResult(progress);
            }, ct, authority);
            if (response.Map.Status is "pending" or "generating")
            {
                await Task.Delay(250, ct);
                continue;
            }
            if (response.Map.Status is not ("ready" or "failed" or "withheld" or "unavailable"))
                throw new InvalidDataException("Invalid automatic map progress.");
            var outcome = new HarnessToolOutcome(response.Version,
                new(HarnessJson.Serialize(response), IsError: response.Map.Status != "ready"));
            return HarnessExecutionProtocol.Describe(outcome, version);
        }
    }
}
