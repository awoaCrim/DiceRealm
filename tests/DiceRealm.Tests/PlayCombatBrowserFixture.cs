using System.Net.Http.Json;
using System.Security.Cryptography;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Opt-in fixture for combat on the browser player page (/play/): isolated DataPath, real Pi, fake
// model only. A fighter (or, with "wizard", a caster for Magic Missile, Shield and death saves; with
// "caster", one with Acid Splash and Blade Ward against a guard whose saves are on record; with
// "party", that caster as host plus a guest fighter, Bram, who joined by invitation and stands by the
// guard) and the causeway guard stand on a published 12x8 tactical map before the
// standard-2024 fight. Asking to fight goes the real way: exploration delegates to the combat agent,
// which proposes the start; the page consents to initiative and then uses the combat buttons. The
// fake model writes one line per settled beat and lets the battle continue; it proves the page's
// combat path, not narrative quality. "random" swaps the scripted dice for the server's own, for a
// person playing it by hand. "<state>.stop" ends it.
internal static class PlayCombatBrowserFixture
{
    public static async Task Run(string statePath, string scenario = "fighter", bool randomDice = false)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path.");
        bool wizard = scenario == "wizard", party = scenario == "party", caster = scenario == "caster" || party;
        // Fighter: initiative 20 vs 1; Arden hits (15) for 4+5 (Savage Attacker 3+3); the guard hits back
        // (18) so Second Wind opens next round. Wizard: initiative, three missiles (d4 2 each), the guard
        // hits (10) for 2+8 and drops the 9 HP caster, one death save succeeds (10), the next is a natural
        // 20. Caster: initiative; the guard hits through Blade Ward (18, ward 1) for 2+1 and the CON save
        // holds (15); next round Acid Splash (4) catches both: Arden fails DEX (5) and then concentration
        // (3), the guard fails DEX (3). Party: initiative Arden 20, Bram 19, guard 1; Arden's Acid Splash (4)
        // catches Bram and the guard, both fail DEX (5, 3); Bram hits (15) for 4+5 (Savage Attacker 3+3).
        // Later dice stay mid-range for their size.
        ScriptedDice? dice = randomDice ? null : wizard ? new ScriptedDice(20, 1, 2, 2, 2, 10, 2, 10, 20) : party ? new ScriptedDice(20, 19, 1, 4, 5, 3, 15, 4, 5, 3, 3)
            : caster ? new ScriptedDice(20, 1, 18, 1, 2, 15, 4, 5, 3, 3) : new ScriptedDice(20, 1, 15, 4, 5, 3, 3, 18);
        int beat = 0;
        string[] lines = ["Arden压低重心，雨水顺着剑脊滑落。", "守卫的长戟擦过石栏，火星溅进潮湿的空气。", "两人在湿滑的堤道上交换位置，谁都没有退。"];
        // The wizard's guard hits hard enough to drop a 9 HP caster in one blow (not massive damage).
        var document = StandardCombatTests.Document(damageBonus: wizard ? 8 : 1);
        // Area spells need every saving throw of their target on record.
        if (caster) document = document with { Scenes = document.Scenes.Select(s => s.Encounter is null ? s : s with
            { Encounter = s.Encounter with { Enemies = s.Encounter.Enemies.Select(e => e with { SavingThrows = StandardAreaTests.Saves(0) }).ToArray() } }).ToArray() };
        // A guest can only be invited at a safe place: the party starts in the harbour and walks over.
        if (party) document = document with { StartSceneId = "harbor" };
        string start = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
        string mapId = "", bram = "";
        var model = new Model((_, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            var agent = frame.GetProperty("agent");
            // Player starting positions are the AI DM's to set: it places Bram by the guard first.
            if (agent.GetProperty("role").GetString() == "exploration" && bram.Length > 0 &&
                !frame.GetProperty("board").GetProperty("state").GetProperty("tokens").EnumerateArray().Any(t => t.GetProperty("actorId").GetString() == bram))
                // Only the fields a model sends; Pi's schema refuses the records' unused null members.
                return Tool("token_spawn", new { mapId, spawns = new[] { new { existingId = "", kind = "creature", source = new { kind = "player", id = bram },
                    appearance = new { name = "Bram" }, x = 5.5 / 12, y = 3.5 / 8, actorId = bram } } });
            if (agent.GetProperty("role").GetString() == "exploration")
                return agent.TryGetProperty("encounterId", out var encounter) && encounter.GetString() is { Length: > 0 } id
                    ? Tool("combat_delegate", new CombatDelegateArgs(id, "Arden向堤道守卫挑战。", []))
                    : Tool("world_record", new NarrativeHarnessArgs("潮声里没有别的动静。", []));
            if (agent.TryGetProperty("narration", out var narration))
            {
                if (narration.GetProperty("pending").GetBoolean())
                    return Tool("world_record", new NarrativeHarnessArgs(lines[beat++ % lines.Length], []));
                if (narration.GetProperty("canContinue").GetBoolean()) return Tool("combat_continue");
            }
            var candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                .FirstOrDefault(c => c.GetProperty("label").GetString() == start);
            return candidate.ValueKind == System.Text.Json.JsonValueKind.Object
                ? Tool("actions_propose", new { candidateId = candidate.GetProperty("id").GetString() })
                : Tool("world_record", new NarrativeHarnessArgs(lines[beat++ % lines.Length], []));
        });
        await using var h = await Host.Start(dice: dice, configure: Configure(model, extra: b =>
        {
            b.Logging.AddConsole().SetMinimumLevel(LogLevel.Warning);
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        }));
        var build = FullCreationTests.Named("Arden", scenario == "fighter" ? CharacterEngine.Fighter : CharacterEngine.Wizard);
        if (caster) build = build with { Cantrips = ["acid-splash", "blade-ward", "thunderclap"] };
        var created = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("隔离 Harness", "Arden", document, Preset, Build: build));
        if (!created.IsSuccessStatusCode) throw new Exception(await created.Content.ReadAsStringAsync());
        var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        string campaign = owner.Snapshot.Id;
        CreatedCampaign? guest = null;
        if (party)
        {
            var invite = new InviteRequest(Id(), (await h.Get(campaign))!.Version, Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)));
            await Post<ActionResponse>(h, campaign, "invitations", invite);
            guest = await h.ApproveGuest(owner, await Post<CreatedCampaign>(h, campaign, "join",
                new JoinCampaignRequest(Id(), invite.InviteToken, Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)), "Bram", Build: FullCreationTests.Named("Bram"))));
            var s = (await h.Act((await h.Get(campaign))!, "talk")).Snapshot;
            await h.Act(s, "travel", "causeway");
        }
        var maps = h.App.Services.GetRequiredService<MapCatalog>(); var map = maps.Create(campaign, new(Id(), ImportedMapTests.Spec()));
        map = maps.Import(campaign, map.Id, new(Id(), map.Version), SharedBoardTests.MapPng(768, 512));
        map = maps.ConfigureScenes(campaign, map.Id, new(Id(), map.Version, ["causeway"]), ["causeway"]);
        map = maps.ConfigureGrid(campaign, map.Id, new(Id(), map.Version, new() { Type = "square", CellPixels = 64, Distance = 5, Units = "feet", Uncalibrated = false }));
        // Pins: where the party stands and the three ways out, saved before the map is published.
        var pins = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/maps/{map.Id}/markers", new ConfigureMapMarkersRequest(Id(), map.Version,
            [new(Id(), "scene", "causeway", .5, .62, "player"), new(Id(), "scene", "harbor", .08, .9, "player"),
             new(Id(), "scene", "beacon", .95, .08, "player"), new(Id(), "scene", "watchpost", .93, .9, "player")]));
        if (!pins.IsSuccessStatusCode) throw new Exception(await pins.Content.ReadAsStringAsync());
        map = (await pins.Content.ReadFromJsonAsync<MapAssetView>(JsonFiles.Options))!;
        map = maps.Publish(campaign, map.Id, new(Id(), map.Version, true, true));
        string encounter = document.Scenes.Single(s => s.Id == "causeway").Encounter!.Id;
        await SharedBoardTests.BoardPost<BoardCommandResponse>(h, campaign, "board/commands", new BoardCommandRequest(Id(), (await h.Get(campaign))!.Version, map.Id, "spawn", Spawns:
            [new("", "creature", new("player", "player"), new("Arden"), 3.5 / 12, 4.5 / 8, "player"),
             new("", "creature", new("enemy", "guardian", encounter), new("堤道守卫"), 6.5 / 12, 3.5 / 8)]));
        mapId = map.Id; bram = guest?.Snapshot.Party!.SelfActorId ?? "";
        string baseUrl = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority);
        JsonFiles.Write(statePath, new { baseUrl, campaignId = campaign, accessToken = owner.AccessToken, guestToken = guest?.AccessToken, dataPath = h.Root,
            processId = Environment.ProcessId, fixture = "play-combat-real-pi-fake-model" });
        Console.WriteLine("Play combat fixture ready: " + baseUrl + "/play/ (seat in the state file; fake model, no paid provider).");
        while (!File.Exists(statePath + ".stop"))
        {
            JsonFiles.Write(statePath + ".stats", new { dice = dice?.Count, modelCalls = model.Calls, paidProviderCalls = 0 });
            await Task.Delay(500);
        }
    }
    private sealed class ScriptedDice(params int[] rolls) : IDice
    {
        private int count;
        public int Count => count;
        public int Roll(int sides)
        {
            int i = Interlocked.Increment(ref count) - 1;
            return Math.Clamp(i < rolls.Length ? rolls[i] : sides == 20 ? 10 : (sides + 1) / 2, 1, sides);
        }
    }
}
