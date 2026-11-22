using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessCombatPromptTests
{
    public static async Task BuiltInSourceDelegatesAndStaysFrozen()
    {
        foreach (string? custom in new string?[] { null, "  自定义战斗主持原文\r\n保持不变。\t " })
        {
            string expected = custom ?? HarnessCombatPrompts.Default;
            var model = new Model((call, request) =>
            {
                var agent = HarnessExecutionProtocolTests.Frame(request).GetProperty("agent");
                if (call == 1)
                {
                    Check.Equal(Preset.SystemPrompt, request.System);
                    Check.True(agent.GetProperty("combatPromptReady").GetBoolean());
                    return Tool("combat_delegate", new CombatDelegateArgs(agent.GetProperty("encounterId").GetString()!, "承接当前交锋。", []));
                }
                Check.Equal(2, call);
                Check.Equal(expected, request.System);
                Check.Equal("combat", agent.GetProperty("role").GetString());
                return Tool("ask_player", new { question = "要对哪个目标行动？" });
            });
            var configure = Configure(model, extra: b =>
            { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
            var dice = new SequenceDice();
            var h = await Host.Start(dice: dice, configure: configure);
            try
            {
                var created = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("内置战斗回归", "Arden",
                    StandardCombatTests.Document(), Preset with { CombatSystemPrompt = custom }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
                Check.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
                var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!;
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                string id = owner.Snapshot.Id;
                var settings = (await h.Http.GetFromJsonAsync<AdventureSettingsView>($"/api/v1/campaigns/{id}/adventure/settings"))!;
                Check.Equal(HarnessCombatPrompts.Default, settings.DefaultCombatPrompt);
                Check.Equal(custom, settings.Active.CombatPrompt);
                Check.Equal(owner.Snapshot.Version, (await h.Get(id))!.Version);
                Check.Equal(0, model.Calls); Check.Equal(0, dice.Count);
                var input = new HarnessInputRequest(Id(), owner.Snapshot.Version, "继续当前交锋");
                var parent = await Post<HarnessRunView>(h, id, "harness/runs", input);
                parent = await Settled(h, id, parent.Id, 3000);
                Check.Equal("delegated", parent.Status);
                Task<CombatAgentSession> Session() => h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false,
                    c => Task.FromResult(c.CombatAgentSessions!.Single()), default);
                var session = await Session();
                var child = await Settled(h, id, session.Inputs[0].RunId, 3000);
                Check.Equal("waiting", child.Status); Check.Equal("player", child.Wait?.Kind);
                Check.Equal(expected, session.Profile.Preset.SystemPrompt);
                Check.Equal(custom is null ? "dicerealm-combat" : Preset.Id, session.Profile.Preset.Id);
                Check.Equal(0, session.Profile.Skills.Length); Check.Equal(0, dice.Count);
                string frozen = HarnessJson.Serialize(session.Profile);
                string root = h.Root; await h.DisposeAsync();
                h = await Host.Start(root, dice: dice, configure: configure);
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                Check.Equal(frozen, HarnessJson.Serialize((await Session()).Profile));
                var replay = await Post<HarnessRunView>(h, id, "harness/runs", input);
                Check.Equal(parent.Id, replay.Id);
                Check.Equal(2, model.Calls); Check.Equal(0, dice.Count);
            }
            finally { await h.DisposeAsync(); }
        }
    }

    public static async Task MissingCombatSourceIsVisibleAndRecoverable()
    {
        var model = new Model((_, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            return Tool("combat_delegate", new CombatDelegateArgs(frame.GetProperty("agent").GetProperty("encounterId").GetString()!, "已发生真实交锋。", []));
        });
        var dice = new SequenceDice();
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var owner = await Create(h, StandardCombatTests.Document()); string id = owner.Snapshot.Id;
        var game = h.App.Services.GetRequiredService<GameService>();
        var current = await game.ReadHarnessExecution(id, owner.AccessToken, "player", Id(), "核对当前交锋", owner.Snapshot.Version, default, 39);
        Check.Equal(false, current.Agent!.CombatPromptReady!.Value);
        Check.True(!current.AvailableTools.Contains("combat_delegate"));
        Check.True(current.WorkingContext!.Guidance.Contains("未采用独立战斗主持提示词"));
        HarnessExecutionProtocol.Validate(current, current.Version, 39);
        var legacy = await game.ReadHarnessExecution(id, owner.AccessToken, "player", Id(), "旧运行", owner.Snapshot.Version, default, 38);
        Check.True(legacy.Agent!.CombatPromptReady is null && legacy.AvailableTools.Contains("combat_delegate"));
        HarnessExecutionProtocol.Validate(legacy, legacy.Version, 38);
        var failed = await StartHistorical(h, id, new(Id(), owner.Snapshot.Version, "继续已发生的交锋"), 38);
        failed = await Settled(h, id, failed.Id);
        Check.Equal("failed", failed.Status); Check.Equal("combat_prompt_required", failed.Error);
        var business = AdventureSessions.View(failed);
        Check.True(business.Notice.Contains("缺少战斗主持提示词") && business.Notice.Contains("不会重建或重掷"));
        Check.Equal(0, dice.Count); Check.Equal(owner.Snapshot.Version, (await h.Get(id))!.Version);
        Check.Equal(0, await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false,
            c => Task.FromResult(c.CombatAgentSessions?.Count ?? 0), default));
        var settings = (await h.Http.GetFromJsonAsync<AdventureSettingsView>($"/api/v1/campaigns/{id}/adventure/settings"))!;
        var saved = await Post<AdventureSettingsResult>(h, id, "adventure/settings/draft", new SaveAdventureSettingsDraftRequest(Id(), settings.SettingsVersion,
            settings.Active.ContentId, settings.Active.ContentVersion + 1, settings.Active.Prompt, settings.Active.Methods, "独立战斗作者稿，只处理当前实际战斗。"));
        saved = await Post<AdventureSettingsResult>(h, id, "adventure/settings/publish", new PublishAdventureSettingsRequest(Id(), saved.Settings.SettingsVersion));
        await Post<AdventureSettingsResult>(h, id, "adventure/settings/activate", new ActivateAdventureSettingsRequest(Id(), saved.Settings.SettingsVersion, saved.Settings.LatestRevision));
        current = await game.ReadHarnessExecution(id, owner.AccessToken, "player", Id(), "核对已修复配置", owner.Snapshot.Version, default, 39);
        Check.Equal(true, current.Agent!.CombatPromptReady!.Value); Check.True(current.AvailableTools.Contains("combat_delegate"));
        Check.Equal(1, model.Calls); Check.Equal(0, dice.Count); // Configuration reads/activation do not retry the failed run.
    }

    public static async Task SeparateVersionedSourceAndReplay()
    {
        var model = new Model((_, _) => throw new Exception("Settings must not call a model."));
        var h = await Host.Start(configure: Configure(model));
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id;
            string route = $"/api/v1/campaigns/{id}/adventure/settings";
            var old = (await h.Http.GetFromJsonAsync<AdventureSettingsView>(route))!;
            Check.True(old.Active.CombatPrompt is null);
            var original = HarnessJson.Element(new { preset = new { Preset.Id, Preset.Version, Preset.SystemPrompt }, skills = Array.Empty<HarnessSkill>() });
            Check.Equal(JsonFiles.Hash(original.GetRawText()), HarnessJson.ProfileHash(Preset, []));
            Check.True(!HarnessJson.Serialize(Preset).Contains("combatSystemPrompt"));
            var frozen = await h.App.Services.GetRequiredService<GameService>().ValidateHarnessStart(id, owner.AccessToken, owner.Snapshot.Version, default, "原探索输入");
            const string combat = "  战斗独立原文\r\n保留人物动机、交涉和本人确认。\t ";
            var request = new SaveAdventureSettingsDraftRequest(Id(), old.SettingsVersion, old.Active.ContentId,
                old.Active.ContentVersion + 1, old.Active.Prompt, old.Active.Methods, combat);
            var draft = await Post<AdventureSettingsResult>(h, id, "adventure/settings/draft", request);
            Check.Equal(combat, draft.Settings.Draft.CombatPrompt);
            Check.True(draft.Settings.Active.CombatPrompt is null);
            Check.Equal(old.Active.Prompt, draft.Settings.Draft.Prompt);
            var published = await Post<AdventureSettingsResult>(h, id, "adventure/settings/publish", new PublishAdventureSettingsRequest(Id(), draft.Settings.SettingsVersion));
            var applied = await Post<AdventureSettingsResult>(h, id, "adventure/settings/activate", new ActivateAdventureSettingsRequest(Id(), published.Settings.SettingsVersion, published.Settings.LatestRevision));
            Check.Equal(combat, applied.Settings.Active.CombatPrompt);
            Check.Equal(Preset.SystemPrompt, frozen.Profile.Preset.SystemPrompt);
            Check.True(frozen.Profile.Preset.CombatSystemPrompt is null, "Capturing a new profile cannot mutate an existing action binding.");
            Check.True(old.Active.Fingerprint != applied.Settings.Active.Fingerprint);
            var fresh = await h.App.Services.GetRequiredService<GameService>().ValidateHarnessStart(id, owner.AccessToken, owner.Snapshot.Version, default, "新输入");
            Check.Equal(combat, fresh.Profile.Preset.CombatSystemPrompt);
            Check.Equal(Preset.SystemPrompt, fresh.Profile.Preset.SystemPrompt);
            var sameVersion = await Post<AdventureSettingsResult>(h, id, "adventure/settings/draft", request with
            { RequestId = Id(), ExpectedSettingsVersion = applied.Settings.SettingsVersion, CombatPrompt = "不同战斗原文" });
            var conflict = await h.Http.PostAsJsonAsync(route + "/publish", new PublishAdventureSettingsRequest(Id(), sameVersion.Settings.SettingsVersion));
            Check.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
            Check.True((await conflict.Content.ReadAsStringAsync()).Contains("workspace_preset_conflict"));
            foreach (string bad in new[] { " ", "bad\0text", new string('x', 32769) })
                Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync(route + "/preview",
                    new AdventureSettingsPreviewRequest("primary", 10, "探索", [], bad))).StatusCode);
            var bytes = await h.App.Services.GetRequiredService<GameService>().ExportHarnessWorkspace(id, owner.AccessToken, published.Settings.LatestRevision, false, default);
            using (var zip = new ZipArchive(new MemoryStream(bytes)))
            {
                using var battle = new StreamReader(zip.GetEntry("selected/combat-preset.md")!.Open());
                using var exploration = new StreamReader(zip.GetEntry("selected/preset.md")!.Open());
                Check.Equal(combat, await battle.ReadToEndAsync());
                Check.Equal(Preset.SystemPrompt, await exploration.ReadToEndAsync());
            }
            string root = h.Root; await h.DisposeAsync();
            h = await Host.Start(root, configure: Configure(model)); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await Post<AdventureSettingsResult>(h, id, "adventure/settings/draft", request);
            Check.True(replay.Replayed);
            Check.True(replay.Settings.Draft.CombatPrompt == "不同战斗原文", "Replay must not replace later edits.");
            Check.Equal(combat, replay.Settings.Active.CombatPrompt);
            Check.Equal(owner.Snapshot.Version, (await h.Get(id))!.Version);
            Check.Equal(0, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }
}
