using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessCharacterContextTests
{
    private const string V18CatalogFingerprint = "55e6caa46c36adcbb5275c9a0aa1bcd97ba3c4b2a7a5eb5bec955611d1f79f35";
    // Captured from the unchanged v18 production assembly before any implementation edit.
    private const string V18FrameBytes = """
        {"kind":"execution_state","contract":15,"version":7,"phase":"ready","context":{"intent":{"text":"original","clarifications":[],"context":{"place":"harbor","situation":"public","character":{"name":"Golden","species":"Human","className":"Fighter","background":"Soldier","level":1,"hitPoints":12,"maxHitPoints":12,"conditions":[],"skills":[],"features":[],"relevantIdentity":[]},"goals":[],"people":[],"knownPlaces":[],"recentActions":[]},"candidates":[]},"knownMemory":[],"knownScenes":[],"canNarrate":true},"combat":null,"availableTools":["context_read","actions_list","checks_result","world_record","ask_player","ruling_request","skills_list","skills_read","rules_scope","memory_search","memory_read","world_search","rules_search","rules_read","memory_semantic_search","memory_digest","world_routes","world_route_propose","map_request"]}
        """;

    private static HarnessExecutionFrame Frame(Campaign c) => HarnessExecutionProtocol.Capture(c.Version,
        AdventureDirecting.Build(c, IntentContexts.Build(c, "unrelated input", [], [])), null,
        HarnessCharacterContext.Capture(c), 19);
    private static byte[] Bytes(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var output = new MemoryStream(); stream.CopyTo(output); return output.ToArray();
    }
    private static async Task Refused(Func<Task> action, string code)
    {
        try { await action(); throw new Exception("Expected refusal " + code); }
        catch (GameException e) { Check.Equal(code, e.Code); }
    }
    private static async Task<CreatedCampaign> CreateWithIdentity(Host h, string backstory, AdventureDocument? adventure = null)
    {
        var build = FullCreationTests.Named("Arden") with { Identity = new() { Name = "Arden", Backstory = backstory, Appearance = "自有身份外观" } };
        var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("self fixture", "Arden", adventure ?? TestContent.Document,
            Preset, Build: build));
        Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken); return owner;
    }

    public static Task FullFactsAndIndependentSpellRoutes()
    {
        var c = TestContent.Campaign("harbor");
        var build = FullCreationTests.Complete("wizard", "dwarf", "sage") with
        { Identity = new() { Name = "SELF_IDENTITY", Pronouns = "they", Appearance = "自己的外观", Personality = "自己的个性", Backstory = new('星', 4000), Alignment = "neutral" } };
        c.Character = PlayResources.Ensure(BuildEvaluator.Create(build));
        var grant = c.Character.BuildMechanics!.SpellGrants.Single(g => g.FreeUses == 1);
        Check.True(build.PreparedSpells.Contains(grant.Id), "The same spell is obtained by class and feat independently");
        c.Character = c.Character with { HitPoints = 1, TemporaryHitPoints = 7, Exhaustion = 1,
            Resources = c.Character.Resources.Select(r => r.Name == PlayResources.FreeSpell(grant) ? r with { Current = 0 } : r).ToArray() };
        var before = HarnessJson.Serialize(c);
        var frame = Frame(c); var self = frame.Self!;
        HarnessExecutionProtocol.Validate(frame, c.Version, 19);
        Check.Equal(before, HarnessJson.Serialize(c));
        Check.Equal(6, self.Abilities.Length); Check.Equal(6, self.SavingThrows.Length); Check.Equal(18, self.Skills.Length);
        foreach (var ability in c.Character.Abilities)
        {
            Check.Equal(RulesEngine.AbilityModifier(ability.Score), self.Abilities.Single(a => a.Name == ability.Name).Modifier);
            Check.Equal(RulesEngine.TestModifier(c.Character, ability.Name, "", true), self.SavingThrows.Single(a => a.Ability == ability.Name).Modifier);
        }
        foreach (var skill in self.Skills) Check.Equal(RulesEngine.TestModifier(c.Character, skill.Ability, skill.Name, false), skill.Modifier);
        Check.Equal(c.Character.ArmorClass, self.ArmorClass); Check.Equal(c.Character.ProficiencyBonus, self.ProficiencyBonus);
        Check.Equal(1, self.HitPoints); Check.Equal(7, self.TemporaryHitPoints); Check.Equal(BuildRuntime.Speed(c.Character), self.Speed);
        Check.Equal(c.Character.BuildMechanics.InitiativeBonus - 2, self.InitiativeBonus);
        Check.Equal(c.Character.BuildMechanics.PassivePerception, self.PassivePerception);
        Check.Equal(4000, self.Identity!.Backstory.Length); Check.Equal("自己的个性", self.Identity.Personality);
        Check.Equal(HarnessJson.Serialize(c.Character.Features), HarnessJson.Serialize(self.Features));
        Check.Equal(HarnessJson.Serialize(c.Character.Inventory), HarnessJson.Serialize(self.Inventory));
        Check.Equal(HarnessJson.Serialize(build.PreparedSpells), HarnessJson.Serialize(self.SpellSelections.Single().Prepared));
        Check.Equal(HarnessJson.Serialize(build.Spellbook), HarnessJson.Serialize(self.SpellSelections.Single().Spellbook));
        Check.Equal(c.Character.Spellcasting!.Spells.Length, self.Spells.Length);
        var routes = self.SpellRoutes.Where(s => s.SpellId == grant.Id).ToArray();
        Check.True(routes.Any(s => s.Source == "class:wizard" && s.Resource == "Spell Slots (1st)"));
        Check.True(routes.Any(s => s.Source == grant.Source && s.Resource == "Spell Slots (1st)"));
        Check.True(routes.Any(s => s.Source == grant.Source && s.Resource == PlayResources.FreeSpell(grant) && s.Remaining == 0 && !s.Available));
        Check.Equal(CharacterPlayEngine.SpellSources(c.Character).Length, self.SpellRoutes.Length);
        var resource = self.Resources.Single(r => r.Name == PlayResources.FreeSpell(grant));
        Check.Equal(0, resource.Current); Check.Equal(1, resource.Maximum); Check.Equal("long", resource.Recovery);
        var fields = HarnessJson.Element(self).EnumerateObject().Select(p => p.Name).ToArray();
        Check.True(!fields.Any(n => n is "build" or "creation" or "advancement" or "source" or "templateId"));
        // Multiclass levels/preparations and higher-slot routes use the domain projection.
        c.Character = AdvancementTests.Level(AdvancementSpellChangeTests.Qualified(c.Character), "fighter");
        c.Character = AdvancementTests.Level(c.Character, "wizard");
        self = Frame(c).Self!;
        Check.Equal(3, self.Level); Check.Equal(1, self.Classes.Single(s => s.Id == "fighter").Level);
        Check.Equal(2, self.Classes.Single(s => s.Id == "wizard").Level); Check.Equal(2, self.SpellSelections.Length);
        Check.Equal(CharacterPlayEngine.SpellSources(c.Character).Length, self.SpellRoutes.Length);
        return Task.CompletedTask;
    }

    public static Task CompleteCollectionsAndExistingSizeBoundary()
    {
        var c = TestContent.Campaign("harbor"); c.Character = PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Named("Collections")));
        c.Character = c.Character with
        {
            Features = Enumerable.Range(0, 80).Select(i => "feature-" + i).ToArray(),
            Resources = Enumerable.Range(0, 64).Select(i => new Resource("counter-" + i, i, i + 1, "manual")).ToArray(),
            Inventory = Enumerable.Range(0, 400).Select(i => new Item("prop-" + i, "prop " + i, i + 1, false)).ToArray(),
            PlayState = c.Character.PlayState! with { ActiveWeaponId = "" }
        };
        var frame = Frame(c); HarnessExecutionProtocol.Validate(frame, c.Version, 19);
        Check.Equal(80, frame.Self!.Features.Length); Check.Equal(64, frame.Self.Resources.Length); Check.Equal(400, frame.Self.Inventory.Length);
        var request = new HarnessModelRequest(Preset.SystemPrompt, [new("user", "initial")], HarnessTools.ForVersion(19), 4096);
        var projected = HarnessExecutionProtocol.Project(request, frame, 19);
        Check.Equal(1, request.Messages.Length); Check.Equal(2, projected.Messages.Length);
        Check.Equal(400, HarnessExecutionProtocolTests.Frame(projected).GetProperty("self").GetProperty("inventory").GetArrayLength());
        var oversized = frame with { Self = frame.Self with { Features = [new string('文', 50000)] } };
        try { HarnessExecutionProtocol.Project(request, oversized, 19); throw new Exception("Expected context limit"); }
        catch (GameException e) { Check.Equal("harness_context_limit", e.Code); }
        return Task.CompletedTask;
    }

    public static async Task AuthorizedReadsPrivacyAndVersionShapes()
    {
        var model = new Model((_, _) => throw new Exception("Read-only test must not call a model")); var dice = new SequenceDice();
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var owner = await CreateWithIdentity(h, "OWNER_IDENTITY_PRIVATE", TestContent.Document with { SourceText = "AUTHORED_SOURCE_PRIVATE",
            InitialKnowledge = [new("private-self", "clue", "主持秘密", "HOST_STORY_PRIVATE", "harbor", "host")] });
        var invite = new InviteRequest(Id(), owner.Snapshot.Version, new string('a', 64));
        await Post<ActionResponse>(h, owner.Snapshot.Id, "invitations", invite);
        var guestBuild = FullCreationTests.Named("Lyra") with { Identity = new() { Name = "Lyra", Backstory = "GUEST_IDENTITY_PRIVATE" } };
        var guest = await Post<CreatedCampaign>(h, owner.Snapshot.Id, "join", new JoinCampaignRequest(Id(), invite.InviteToken, new string('b', 64), "Lyra", Build: guestBuild));
        guest = await h.ApproveGuest(owner, guest);
        var game = h.App.Services.GetRequiredService<GameService>(); string id = owner.Snapshot.Id;
        // Two ready weapons are carried, but only one is active. The new selection
        // candidates are absent from every frozen execution-frame version.
        var equipped = await game.PlayCharacter(id, owner.AccessToken, new CharacterPlayRequest(Id(), guest.Snapshot.Version, "equip", "flail"), default);
        var version = equipped.Snapshot.Version;
        string path = Path.Combine(h.Root, "campaigns", id + ".sqlite"); var before = Bytes(path);
        var hostFrame = await game.ReadHarnessExecution(id, owner.AccessToken, PartyEngine.HostId, Id(), "无关输入", version, default, 19);
        var guestFrame = await game.ReadHarnessExecution(id, guest.AccessToken, guest.Snapshot.Party!.SelfActorId, Id(), "无关输入", version, default, 19);
        Check.Equal(owner.Snapshot.Character!.Id, hostFrame.Self!.Id); Check.Equal(guest.Snapshot.Character!.Id, guestFrame.Self!.Id);
        Check.Equal("flail", hostFrame.Self.ActiveWeaponId);
        Check.True(hostFrame.Self.Inventory.Single(i => i.Id == "greatsword").Equipped);
        Check.True(hostFrame.Context.Intent.Candidates.Any(c => c.Label == "当前使用 Greatsword"));
        Check.Equal("OWNER_IDENTITY_PRIVATE", hostFrame.Self.Identity!.Backstory); Check.Equal("GUEST_IDENTITY_PRIVATE", guestFrame.Self.Identity!.Backstory);
        string hostRaw = HarnessJson.Serialize(hostFrame), guestRaw = HarnessJson.Serialize(guestFrame);
        Check.True(!hostRaw.Contains("GUEST_IDENTITY_PRIVATE")); Check.True(!guestRaw.Contains("OWNER_IDENTITY_PRIVATE"));
        foreach (var text in new[] { hostRaw, guestRaw }) Check.True(!text.Contains("AUTHORED_SOURCE_PRIVATE") && !text.Contains("HOST_STORY_PRIVATE") && !text.Contains(owner.AccessToken) && !text.Contains(guest.AccessToken));
        foreach (int contract in Enumerable.Range(15, 4))
        {
            var old = await game.ReadHarnessExecution(id, owner.AccessToken, PartyEngine.HostId, Id(), "无关输入", version, default, contract);
            Check.True(old.Self is null); Check.True(!HarnessJson.Element(old).TryGetProperty("self", out _)); HarnessExecutionProtocol.Validate(old, version, contract);
            Check.True(old.Context.Intent.Candidates.All(c => !c.Label.StartsWith("当前使用 ", StringComparison.Ordinal)));
        }
        await Refused(() => game.ReadHarnessExecution(id, guest.AccessToken, PartyEngine.HostId, Id(), "", version, default, 19), "unauthorized");
        await Refused(() => game.ReadHarnessExecution(id, owner.AccessToken, PartyEngine.HostId, Id(), "", version - 1, default, 19), "stale_version");
        await Refused(() => game.ReadHarnessExecution(id, owner.AccessToken, PartyEngine.HostId, Id(), "", version, default, HarnessTools.CurrentVersion + 1), "harness_tool_contract");
        Check.True(before.SequenceEqual(Bytes(path))); Check.Equal(0, dice.Count); Check.Equal(0, model.Calls);
    }

    public static async Task RealPiFirstWriteAndConfirmationRefresh()
    {
        var dice = new SequenceDice(4); string? initialId = null;
        var model = new Model((call, request) =>
        {
            var self = HarnessExecutionProtocolTests.Frame(request).GetProperty("self");
            Check.Equal(Preset.SystemPrompt, request.System);
            if (call == 1)
            {
                Check.True(!self.TryGetProperty("abilities", out _));
                Check.True(self.GetProperty("skills").EnumerateArray().All(s => s.GetProperty("proficient").GetBoolean() || s.GetProperty("expertise").GetBoolean()));
            }
            else
            {
                Check.Equal(6, self.GetProperty("abilities").GetArrayLength()); Check.Equal(18, self.GetProperty("skills").GetArrayLength());
            }
            Check.Equal(PartyEngine.HostId, self.GetProperty("actorId").GetString());
            initialId ??= self.GetProperty("id").GetString(); Check.Equal(initialId, self.GetProperty("id").GetString());
            Check.Equal(4, self.GetProperty("temporaryHitPoints").GetInt32());
            int wind = self.GetProperty("resources").EnumerateArray().Single(r => r.GetProperty("name").GetString() == "Second Wind").GetProperty("current").GetInt32();
            if (call == 1)
            {
                Check.Equal(1, self.GetProperty("hitPoints").GetInt32()); Check.Equal(2, wind);
                Check.True(!self.GetProperty("inventory").EnumerateArray().Any(i => i.GetProperty("name").GetString() == "本轮验证信物"));
                return Tool("world_record", new NarrativeHarnessArgs("取得本轮验证信物。", [], Items: [new("", "本轮验证信物", 3, new("current_scene", "harbor", "港口主人备有三个本轮验证信物，允许玩家取用。"))], Complete: false));
            }
            Check.Equal(3, self.GetProperty("inventory").EnumerateArray().Single(i => i.GetProperty("name").GetString() == "本轮验证信物").GetProperty("quantity").GetInt32());
            if (call == 2)
            {
                Check.Equal(1, self.GetProperty("hitPoints").GetInt32()); Check.Equal(2, wind);
                return Tool("actions_propose", new { candidateId = HarnessExecutionProtocolTests.Choice(request, "Second Wind") });
            }
            Check.Equal(6, self.GetProperty("hitPoints").GetInt32()); Check.Equal(1, wind);
            return call == 3 ? Tool("ask_player", new { question = "还需要补充什么？" }) : Text("角色事实已刷新。");
        });
        var configure = Configure(model, extra: b =>
        { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h, HarnessItemSearchTests.WithEvidence("港口主人备有三个本轮验证信物，允许玩家取用。")); string id = owner.Snapshot.Id;
            var state = (await Post<ActionResponse>(h, id, "characters/adjust", new AdjustCharacterRequest(Id(), owner.Snapshot.Version, PartyEngine.HostId,
                "self projection fixture", "isolated test", [new("hp", "", 1), new("temporary-hp", "", 4)]))).Snapshot;
            var input = new HarnessInputRequest(Id(), state.Version, "拿取信物后回气 Second Wind，治疗我自己");
            var run = await Post<HarnessRunView>(h, id, "harness/runs", input); run = await Settled(h, id, run.Id, 3000);
            Check.Equal("waiting", run.Status); Check.Equal("intent", run.Wait!.Kind); Check.Equal(2, model.Calls); Check.Equal(0, dice.Count);
            state = (await h.Get(id))!; var choice = state.PendingIntent!.Options.Single();
            var confirmed = await Post<ActionResponse>(h, id, "intents/respond", new IntentResponseRequest(Id(), state.Version, state.PendingIntent.Id, "choose", choice.Id));
            Check.Equal(6, confirmed.Snapshot.Character!.HitPoints); Check.Equal(1, dice.Count);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), confirmed.Snapshot.Version));
            run = await Settled(h, id, run.Id, 3000); Check.Equal("waiting", run.Status); Check.Equal("player", run.Wait!.Kind); Check.Equal(3, model.Calls);
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version, "不需要了"));
            run = await Settled(h, id, run.Id, 3000); Check.Equal("completed", run.Status); Check.Equal(4, model.Calls);
            var stored = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.True(stored.Steps.All(s => s.ToolName is not ("context_read" or "actions_list")));
            var frames = stored.Steps.Where(s => s.Kind == "model").Select(s => s.ExecutionFrame!).ToArray();
            Check.Equal(4, frames.Length); Check.Equal(1, frames[0].Self!.HitPoints); Check.Equal(6, frames[2].Self!.HitPoints);
            Check.Equal(2, frames[0].Self!.Resources.Single(r => r.Name == "Second Wind").Current);
            Check.Equal(1, frames[3].Self!.Resources.Single(r => r.Name == "Second Wind").Current);
            string saved = HarnessJson.Serialize(stored);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
            Check.Equal(saved, HarnessJson.Serialize(h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!));
            Check.Equal(4, model.Calls); Check.Equal(1, dice.Count);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task FrozenV18CatalogFramesAndReplay()
    {
        Check.Equal(V18CatalogFingerprint, HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(18))));
        var actor = new ActingCharacterContext("Golden", "Human", "Fighter", "Soldier", 1, 12, 12, [], [], [], []);
        var context = new AdventureContext(new("original", [], new("harbor", "public", actor, [], [], [], []), []), [], [], true);
        foreach (int version in Enumerable.Range(15, 4))
            Check.Equal(V18FrameBytes, HarnessJson.Serialize(HarnessExecutionProtocol.Capture(7, context, null, toolContractVersion: version)));
        var model = new Model((call, request) =>
        {
            Check.Equal(V18CatalogFingerprint, HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(18))));
            Check.True(!HarnessExecutionProtocolTests.Frame(request).TryGetProperty("self", out _));
            return call == 1 ? Tool("ask_player", new { question = "旧合同答复？" }) : Text("旧合同继续。");
        });
        var configure = Configure(model); var h = await Host.Start(configure: configure);
        try
        {
            var owner = await Create(h); var game = h.App.Services.GetRequiredService<GameService>(); string id = owner.Snapshot.Id;
            var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
            var input = new HarnessInputRequest(Id(), auth.Version, "v18 frozen fixture");
            var start = await game.ValidateHarnessStart(id, owner.AccessToken, auth.Version, default, input.Text);
            var store = h.App.Services.GetRequiredService<HarnessRunStore>();
            store.Create(new() { Id = input.RequestId, IntentId = Id(), CampaignId = id, ActorId = auth.ActorId,
                Fingerprint = HarnessJson.Fingerprint(HarnessJson.Element(input)), Input = input.Text, Profile = start.Profile,
                MemorySnapshot = start.Memory, Version = auth.Version, ToolContractVersion = 18, RulesCatalogVersion = start.RulesCatalogVersion,
                Limits = new(), Turns = [HarnessJson.Serialize(new { input = input.Text, ruleset = "dnd2024", memory = start.Memory })] });
            await Post<HarnessRunView>(h, id, $"harness/runs/{input.RequestId}/resume", new HarnessResumeRequest(Id(), auth.Version));
            var run = await Settled(h, id, input.RequestId); Check.Equal("waiting", run.Status); Check.Equal(1, model.Calls);
            string original = HarnessJson.Serialize(store.Read(id, PartyEngine.HostId, run.Id));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
            store = h.App.Services.GetRequiredService<HarnessRunStore>();
            Check.Equal(original, HarnessJson.Serialize(store.Read(id, PartyEngine.HostId, run.Id))); Check.Equal(1, model.Calls);
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version, "旧答复"));
            run = await Settled(h, id, run.Id); Check.Equal("completed", run.Status); Check.Equal(2, model.Calls);
            Check.True(store.Read(id, PartyEngine.HostId, run.Id)!.Steps.Where(s => s.Kind == "model").All(s => s.ExecutionFrame!.Self is null));
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task MalformedSelfPreservesRunAndRejectsVersionMixing()
    {
        var model = new Model((_, _) => Text("self fixture completed"));
        await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h);
        var run = await Start(h, owner.Snapshot); run = await Settled(h, owner.Snapshot.Id, run.Id); Check.Equal("completed", run.Status);
        var store = h.App.Services.GetRequiredService<HarnessRunStore>();
        string path = Directory.GetFiles(Path.Combine(h.Root, "harness"), run.Id + ".json", SearchOption.AllDirectories).Single();
        string original = File.ReadAllText(path);
        foreach (var damage in new Action<JsonNode>[]
        {
            root => root["steps"]![0]!["executionFrame"]!.AsObject().Remove("self"),
            root => root["steps"]![0]!["executionFrame"]!["self"] = null,
            root => root["steps"]![0]!["executionFrame"]!["self"]!["actorId"] = "other-seat",
            root => root["steps"]![0]!["executionFrame"]!["self"]!["id"] = "bad-id",
            root => root["steps"]![0]!["executionFrame"]!["self"]!["abilities"] = null,
            root => root["steps"]![0]!["executionFrame"]!["self"]!["abilities"]![0]!["modifier"] = 999,
            root => root["steps"]![0]!["executionFrame"]!["self"]!["skills"] = new JsonArray(),
            root => root["steps"]![0]!["executionFrame"]!["self"]!["resources"]![0]!["current"] = 999,
            root => root["steps"]![0]!["executionFrame"]!["self"]!["proficiencies"]!["tools"] = null,
            root => root["steps"]![0]!["executionFrame"]!["self"]!["activeWeaponId"] = "not-carried",
            root => root["steps"]![0]!["executionFrame"]!["self"]!["build"] = new JsonObject(),
            root => root["steps"]![0]!["executionFrame"]!["self"]!.AsObject().Remove("wearables"),
            root => root["steps"]![0]!["executionFrame"]!["self"]!["wearables"]!["attunementLimit"] = 0,
            root => root["steps"]![0]!["executionFrame"]!["self"]!["equipmentStatus"]!["armor"] = "",
            root => root["steps"]![0]!["executionFrame"]!["contract"] = 19,
            root => root["toolContractVersion"] = 18,
            root => root["toolContractVersion"] = 20,
            root => root["toolContractVersion"] = HarnessTools.CurrentVersion + 1
        })
        {
            var data = JsonNode.Parse(original)!; damage(data); File.WriteAllText(path, data.ToJsonString()); var corrupt = Bytes(path);
            Check.Throws<GameException>(() => store.Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id));
            Check.True(corrupt.SequenceEqual(Bytes(path))); Check.Equal(1, model.Calls);
        }
        File.WriteAllText(path, original); Check.True(store.Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!.Steps[0].ExecutionFrame!.Self is not null);
    }
}
