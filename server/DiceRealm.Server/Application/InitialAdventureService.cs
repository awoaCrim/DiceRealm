using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record CreateRoomRequest(string Name);
public sealed record InitializeRoomAdventureRequest(string RequestId, int ExpectedVersion, AdventureDocument Adventure, string Prompt, AdventureMethod[] Methods);

public sealed partial class GameService
{
    // Explicit new-room endpoint: legacy /campaigns creation and all old saves stay unchanged.
    public CreatedCampaign CreateRoom(CreateRoomRequest request, string? accountToken = null) =>
        CreateCore(new(request.Name), initialSetup: true, ownerUserId: accountToken is null ? null : store.RequireAccountOwner(accountToken));

    public Task<ActionResponse> InitializeRoomAdventure(string id, string token, InitializeRoomAdventureRequest request, CancellationToken ct) =>
        ChangeContent(id, token, "initial-adventure", request.RequestId, request.ExpectedVersion, request, c =>
        {
            InitializeRoom(c, request.Adventure, request.Prompt, request.Methods);
            return "首次设定已启用。队员审核通过后可开始冒险；后续叙事修改在叙事设定中独立保存、发布和启用。";
        }, ct);

    private void InitializeRoom(Campaign c, AdventureDocument adventure, string prompt, AdventureMethod[] methods)
    {
            if (!c.InitialAdventureSetup || !c.HostOnlySeat || c.ContentActivated || c.SceneId.Length != 0 || c.Harness is not null)
                throw new GameException("content_locked", "此战役不能初始化；已开始与旧版战役不会被转换或重置。", 409);
            if (!configuration.GetValue("Harness:Enabled", false)) throw HarnessJson.Conflict("harness_disabled");
            ContentValidator.Validate(adventure);
            if (methods is null || methods.Any(m => m is null))
                throw new GameException("invalid_harness_profile", "需要有效的工作方法列表；没有方法时请提交空列表。");
            var skills = methods.Select(m => new HarnessSkill(m.Id, m.Description, m.Content)).ToArray();
            var preset = new HarnessPreset("primary", 1, prompt);
            HarnessProfiles.Validate(preset, skills);
            c.Adventure = adventure;
            c.Harness = new(preset, HarnessJson.ProfileHash(preset, skills), skills);
            Activate(c); // Explicit first setup confirmation; no provider call or actor creation.
            c.InitialAdventureSetup = false;
    }
}
