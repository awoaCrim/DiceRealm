using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record DmOverviewView(string CampaignId, string TimelineId, int Version,
    PartyMemberView[] Party, DmSceneView Scene, object Encounter, BoardView? Board);
public sealed record DmSceneView(string Id, string Title, string Summary, NpcView[] Npcs,
    WorldMemoryEntry[] Records, ContentEncounter? AuthoredEncounter);

public sealed partial class GameService
{
    public Task<DmOverviewView> DmOverview(string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            var scene = Adventure.Current(c);
            var party = ProjectPortraits(c, PartyEngine.Snapshot(c)).Members.Where(m => !m.Revoked).ToArray();
            // Use the current indexed records, including host-only corrections. Do not use
            // the AI working-context selection, which deliberately limits private evidence.
            var records = WorldMemories.Read(c, host: true, scenes: [c.SceneId], limit: int.MaxValue).Entries;
            var npcs = (c.Adventure?.Npcs ?? []).Select(n => ContentRuntime.ProjectNpc(c, n))
                .Where(n => n.SceneId == c.SceneId).ToArray();
            var maps = mapCatalog.List(c.Id, true, false, currentSceneId: c.SceneId).Maps
                .Where(m => m.CurrentScene && m.Status == "ready").ToArray();
            string? mapId = CombatEngine.InCombat(c) ? c.Combat?.BoardLayout?.MapId : SharedBoard.SelectedMapId(c);
            mapId ??= RuntimeEncounters.Current(c)?.Layout?.MapId ?? RuntimeEncounters.Current(c)?.ObservationMapId;
            var map = maps.FirstOrDefault(m => m.Id == mapId) ?? maps.FirstOrDefault(m => m.Edition == "player") ?? maps.FirstOrDefault();
            var board = map is null ? null : ProjectPortraits(c, SharedBoard.Project(c, map));
            return Task.FromResult(new DmOverviewView(c.Id, c.TimelineId ?? "", c.Version, party,
                new(scene.Id, scene.Title, scene.Summary, npcs, records, ContentRuntime.Scene(c)?.Encounter),
                EncounterRead(c, HarnessTools.CurrentVersion), board));
        }, ct);
}
