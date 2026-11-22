using System.Net.Http.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;
using static DiceRealm.Tests.GameSaveTests;

namespace DiceRealm.Tests;

// Explicit isolated scenarios; browser only uses normal login, reads and save controls.
// Control files drive real HTTP combat commands, never inject client DTOs.
internal static class WorkbenchCombatBrowserFixture
{
    private sealed class Dice : IDice
    {
        private readonly Queue<int> values = new();
        public int Count { get; private set; }
        public void Set(params int[] rolls) { Check.Equal(0, values.Count); foreach (int roll in rolls) values.Enqueue(roll); }
        public int Roll(int sides) { Count++; int value = values.Dequeue(); Check.True(value >= 1 && value <= sides); return value; }
    }
    private static async Task<CreatedCampaign> CreateNamed(Host h, string name, AdventureDocument document, string template = CharacterEngine.Fighter)
    {
        var response = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest(name, "Arden", Adventure: document,
            Prompts: TestContent.Prompts, StartImmediately: true, Build: FullCreationTests.Named("Arden", template)));
        Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; Auth(h, owner.AccessToken); return owner;
    }
    public static async Task Run(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path.");
        var dice = new Dice(); var model = new Model((_, _) => throw new Exception("No model calls in read-only fixture"));
        await using var h = await Host.Start(dice: dice, configure: Configure(model)); AccountTests.SeedAdminFixture(h);
        var party = await WorkbenchCombatTests.CreateParty(h);
        var first = await HarnessBoundaryTests.Guest(h, party); var second = await HarnessBoundaryTests.Guest(h, party);
        Auth(h, party.AccessToken); await Save(h, party.Snapshot.Id, "战斗开始前");
        await WorkbenchCombatTests.Begin(h, first);

        var document = StandardCombatTests.Document("withdraw");
        document = document with { Scenes = document.Scenes.Select(s => s.Encounter is null ? s : s with
            { Encounter = s.Encounter with { Repeatable = true, OnStart = [], Victory = new("敌人撤离，交锋结束。", []) } }).ToArray() };
        var board = await CreateNamed(h, "战术格位与攻击记录", document); string id = board.Snapshot.Id;
        var maps = h.App.Services.GetRequiredService<MapCatalog>(); var map = maps.Create(id, new(Id(), ImportedMapTests.Spec()));
        map = maps.Import(id, map.Id, new(Id(), map.Version), SharedBoardTests.MapPng(768, 512));
        map = maps.ConfigureScenes(id, map.Id, new(Id(), map.Version, ["causeway"]), ["causeway"]);
        map = maps.ConfigureGrid(id, map.Id, new(Id(), map.Version, new() { Type = "square", CellPixels = 64, Distance = 5, Units = "feet", Uncalibrated = false }));
        map = maps.Publish(id, map.Id, new(Id(), map.Version, true, true));
        string encounter = document.Scenes.Single(s => s.Id == "causeway").Encounter!.Id;
        var spawn = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), board.Snapshot.Version, map.Id, "spawn", Spawns:
            [new("", "creature", new("player", "player"), new("Arden"), 1.5 / 12, 2.5 / 8, "player"),
             new("", "creature", new("enemy", "guardian", encounter), new("石桥守卫"), 2.5 / 12, 2.5 / 8)]));
        string enemy = spawn.Result.EntityIds[1];
        await Mutate(h, board, c => c.Character = c.Character.Required() with { TemporaryHitPoints = 4 });
        var s = (await h.Get(id))!; s = (await h.Act(s, "combat.start")).Snapshot;
        dice.Set(20, 1); s = await WorkbenchCombatTests.Confirm(h, board);
        s = (await h.Act(s, "combat.attack", enemy)).Snapshot;
        dice.Set(15, 3, 4, 2, 5); s = await WorkbenchCombatTests.Confirm(h, board);
        Check.True(s.Combat!.Log.Any(l => l.Attack is not null));

        var shield = await CreateNamed(h, "Shield等待与法术资源", StandardCombatTests.Document(), CharacterEngine.Wizard);
        s = (await Post<ActionResponse>(h, shield.Snapshot.Id, "character/commands", new CharacterPlayRequest(Id(), shield.Snapshot.Version, "equip", "quarterstaff", 0))).Snapshot;
        s = (await h.Act(s, "combat.start")).Snapshot; dice.Set(20, 1); s = await WorkbenchCombatTests.Confirm(h, shield);
        dice.Set(11); s = (await h.Act(s, "combat.move", "0,2")).Snapshot;
        Check.Equal("shield", s.Combat!.Standard!.Wait!.Kind);

        var death = await CreateNamed(h, "倒地与死亡豁免", StandardCombatTests.Document());
        await Mutate(h, death, c => c.Character = c.Character.Required() with { HitPoints = 1 });
        s = (await h.Get(death.Snapshot.Id))!; s = (await h.Act(s, "combat.start")).Snapshot;
        dice.Set(20, 1); s = await WorkbenchCombatTests.Confirm(h, death);
        dice.Set(15, 4); s = (await h.Act(s, "combat.end_turn")).Snapshot;
        Check.Equal("death", s.Combat!.Standard!.Wait!.Kind);
        JsonFiles.Write(statePath, new { baseUrl = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority), dataPath = h.Root, processId = Environment.ProcessId,
            campaigns = new { party = party.Snapshot.Id, board = id, shield = shield.Snapshot.Id, death = death.Snapshot.Id }, enemy, fixture = "workbench-read-only-real-http-offline" });
        Console.WriteLine("Isolated workbench combat fixture ready.");
        while (!File.Exists(statePath + ".stop"))
        {
            foreach (string scenario in new[] { "confirm-first", "confirm-second", "finish-board", "new-board", "death-save" })
            {
                string file = statePath + "." + scenario;
                if (!File.Exists(file) || File.Exists(file + ".done")) continue;
                if (scenario == "confirm-first") await WorkbenchCombatTests.Confirm(h, first);
                if (scenario == "confirm-second") { dice.Set(20, 19, 1); await WorkbenchCombatTests.Confirm(h, second); }
                if (scenario == "finish-board")
                {
                    Auth(h, board.AccessToken); s = (await h.Get(id))!;
                    for (int step = 0; step < 20 && s.Combat!.Status == "active"; step++)
                        s = (await h.Act(s, s.Combat.Standard?.Wait is null ? "combat.end_turn" : "combat.react", s.Combat.Standard?.Wait is null ? "" : "pass")).Snapshot;
                    Check.Equal("victory", s.Combat!.Status);
                }
                if (scenario == "new-board")
                {
                    Auth(h, board.AccessToken); s = (await h.Get(id))!;
                    await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), s.Version, map.Id, "spawn", Spawns:
                        [new(enemy, "creature", new("existing"), new("守卫"), 2.5 / 12, 2.5 / 8)]));
                    s = (await h.Get(id))!; await h.Act(s, "combat.start"); dice.Set(20, 1); await WorkbenchCombatTests.Confirm(h, board);
                }
                if (scenario == "death-save")
                {
                    Auth(h, death.AccessToken);
                    dice.Set(1); await WorkbenchCombatTests.Confirm(h, death);
                }
                File.WriteAllText(file + ".done", "applied");
            }
            JsonFiles.Write(statePath + ".stats", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0 });
            await Task.Delay(250);
        }
        JsonFiles.Write(statePath + ".result", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0 });
    }
}
