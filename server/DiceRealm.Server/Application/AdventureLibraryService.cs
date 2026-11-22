using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record ActivateLibraryRequest(string RequestId, int ExpectedVersion, string LibraryId, string Hash);
public sealed record AdventureLibraryView(AdventureLibraryEntry[] Adventures, bool CanActivate, string Notice);

public sealed partial class GameService
{
    public Task<AdventureLibraryView> ReadAdventureLibrary(string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            bool available = c.InitialAdventureSetup && !c.ContentActivated && c.SceneId.Length == 0 && !c.Archived;
            return Task.FromResult(new AdventureLibraryView(adventureLibrary.List(), available,
                available ? "选择后一次启用剧本、叙事和随包原图；不调用模型。玩家版原图将进入公开图册，主持版仅主持可见。"
                    : "当前房间不会被替换。要体验其他剧本，请在「我的战役」中新建房间。"));
        }, ct);

    public Task<ActionResponse> ActivateLibrary(string id, string token, ActivateLibraryRequest request, CancellationToken ct) =>
        ChangeContent(id, token, "library", request.RequestId, request.ExpectedVersion, request, c =>
        {
            if (!AssetCatalog.IsHash(request.Hash)) throw new GameException("invalid_input", "需要当前剧本包的版本标识。");
            // All bytes and references are checked before any map write. The normal campaign
            // receipt is checked by ChangeContent first, so completed retries need no package files.
            var package = adventureLibrary.Load(request.LibraryId, request.Hash, images: true);
            InitializeRoom(c, package.Adventure, package.Prompt, []);
            var scenes = package.Adventure.Scenes.Select(s => s.Id).ToArray();
            foreach (var image in package.Images)
            {
                var map = image.Definition;
                string Request(string phase) => new Guid(JsonFiles.Hash("library:" + c.Id + ":" + package.Entry.Hash + ":" + map.File + ":" + phase)[..32]).ToString();
                string mapId = Request("create");
                mapCatalog.CreateLibraryMap(c.Id, new(mapId, map.Specification),
                    new(HarnessMaps.AdventureSource(package.Adventure), package.Entry.Id, package.Entry.Hash, map.File, map.Sha256));
                mapCatalog.Import(c.Id, mapId, new(Request("import"), 1), image.Png);
                mapCatalog.ConfigureScenes(c.Id, mapId, new(Request("scenes"), 2, map.SceneIds), scenes);
            }
            // Keep all images private until every import and scene association succeeded.
            // Map files have their own receipts: an interrupted install is resumed, not deleted
            // or regenerated. This is deliberately not a claimed cross-file transaction.
            foreach (var image in package.Images.Where(i => i.Definition.Specification.Edition == "player"))
            {
                var map = image.Definition;
                string Request(string phase) => new Guid(JsonFiles.Hash("library:" + c.Id + ":" + package.Entry.Hash + ":" + map.File + ":" + phase)[..32]).ToString();
                mapCatalog.Publish(c.Id, Request("create"), new(Request("publish"), 3, true, true));
            }
            foreach (var image in package.Images)
            {
                string mapId = new Guid(JsonFiles.Hash("library:" + c.Id + ":" + package.Entry.Hash + ":" + image.Definition.File + ":create")[..32]).ToString();
                var map = mapCatalog.Get(c.Id, mapId, true);
                if (map.Status != "ready" || map.ContentHash != image.Definition.Sha256 ||
                    image.Definition.Specification.Edition == "player" && !map.Published)
                    throw new GameException("library_map_unavailable", "已安装的原图缺失、损坏或已撤下，本次首次设定未提交；请恢复原图后重试。", 409);
            }
            return $"已启用《{package.Entry.Name}》，载入 {package.Images.Length} 张原图。队员与审核状态保持不变。";
        }, ct);
}
