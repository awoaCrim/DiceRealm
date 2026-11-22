using System.Text.Json;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class FullCreationTests
{
    // Test input builder consumes the PUBLIC choice groups. It contains no parallel rules engine.
    internal static CharacterBuild Complete(string classId = "fighter", string speciesId = "human", string backgroundId = "soldier")
    {
        var data = BuildCatalog.Get(); var cls = data.Classes.Single(c => c.Id == classId); var bg = data.Backgrounds.Single(b => b.Id == backgroundId);
        var bonuses = new int[6]; bonuses[Array.IndexOf(data.Abilities,bg.Abilities[0])] = 2; bonuses[Array.IndexOf(data.Abilities,bg.Abilities[1])] = 1;
        var build = new CharacterBuild { ClassId=classId, SpeciesId=speciesId, BackgroundId=backgroundId, BaseScores=[15,14,13,12,10,8], BackgroundBonuses=bonuses,
            ClassEquipment=cls.Equipment[0].Id, BackgroundEquipment=bg.Equipment[0].Id, Identity=new() { Name="Test adventurer" } };
        for (int pass=0; pass<80; pass++)
        {
            var result=BuildEvaluator.Evaluate(build);
            if(result.CanCreate)return build;
            var group=result.Groups.FirstOrDefault(g=>!g.Complete);
            if(group is null)throw new Exception(JsonSerializer.Serialize(result.Issues));
            var values=group.Options.Take(group.Count).Select(o=>o.Id).ToArray();
            Check.True(group.Count==values.Length,"Not enough choices for "+group.Key);
            build=group.Key switch
            {
                "$classSkills"=>build with {ClassSkills=values}, "$expertise"=>build with {Expertise=values},
                "$cantrips"=>build with {Cantrips=values}, "$spellbook"=>build with {Spellbook=values}, "$preparedSpells"=>build with {PreparedSpells=values},
                _=>build with {Selections=[..build.Selections.Where(s=>s.Key!=group.Key),new(group.Key,values)]}
            };
        }
        throw new Exception("Creation choice dependency loop");
    }
    // Explicit complete HTTP fixture with familiar, deliberately selected choices. This is
    // test input, not a production preset or an alternate rules engine.
    internal static CharacterBuild Named(string name, string template = CharacterEngine.Fighter)
    {
        bool wizard = template == CharacterEngine.Wizard;
        var build = Complete(wizard ? "wizard" : "fighter") with
        {
            Identity = new() { Name = name },
            BaseScores = wizard ? [8, 13, 14, 15, 12, 10] : [15, 13, 14, 10, 12, 8],
            BackgroundBonuses = wizard ? [1, 0, 2, 0, 0, 0] : [2, 0, 1, 0, 0, 0],
            ClassSkills = wizard ? ["arcana", "history"] : ["perception", "survival"],
            BackgroundEquipment = "B",
            Equipped = wizard ? ["quarterstaff"] : ["chain-mail", "greatsword"]
        };
        build = build with { Selections = build.Selections
            .Where(s => !s.Key.StartsWith("equipment:background/", StringComparison.Ordinal))
            .Select(s => s.Key switch
            {
                "species:human/skill" => s with { Values = ["investigation"] },
                "species:human/origin-feat" => s with { Values = ["alert"] },
                "class:fighter/style" => s with { Values = ["great-weapon-fighting"] },
                "class:fighter/masteries" => s with { Values = ["greatsword", "flail", "javelin"] },
                _ => s
            }).ToArray() };
        if (wizard) build = build with { Cantrips = ["fire-bolt", "mage-hand", "prestidigitation"],
            Spellbook = ["magic-missile", "mage-armor", "shield", "sleep", "detect-magic", "find-familiar"],
            PreparedSpells = ["magic-missile", "mage-armor", "shield", "sleep"] };
        var evaluation = BuildEvaluator.Evaluate(build);
        Check.True(evaluation.CanCreate, "Full HTTP fixture must be valid: " + JsonSerializer.Serialize(evaluation.Issues));
        return build;
    }

    public static Task CatalogAndCombinations()
    {
        var catalog=BuildCatalog.Get(); Check.Equal(12,catalog.Classes.Length);Check.Equal(10,catalog.Species.Length);Check.Equal(16,catalog.Backgrounds.Length);
        Check.Equal("dnd2024",catalog.Ruleset);Check.Equal(BuildCatalog.Revision,catalog.Revision);Check.Equal(98,catalog.Spells.Length);
        var cleric=catalog.Classes.Single(c=>c.Id=="cleric");Check.True(cleric.Equipment[0].Copper==700,"Canonical entry is 7 GP, not old raw 70 GP");
        var wizard=catalog.Classes.Single(c=>c.Id=="wizard");Check.True(wizard.Equipment[0].Items.Any(i=>i.Id=="spellbook"),"Special Spellbook entry must not disappear");
        int count=0;
        foreach(var cls in catalog.Classes) foreach(var species in catalog.Species) foreach(var bg in catalog.Backgrounds)
        {
            var input=Complete(cls.Id,species.Id,bg.Id);var result=BuildEvaluator.Evaluate(input);
            Check.True(result.CanCreate,$"{cls.Id}/{species.Id}/{bg.Id}: "+JsonSerializer.Serialize(result.Issues));
            Check.True(result.Character!.Build is not null && result.Character.BuildMechanics is not null);
            Check.Equal(cls.HitDie+result.Character.Abilities[2].Modifier+(species.Id=="dwarf"?1:0)+(result.Character.BuildMechanics!.Feats.Count(f=>f=="tough")*2),result.Character.MaxHitPoints);
            Check.True(result.Character.Inventory.All(i=>!i.Equipped),"Owning is not equipping");
            Check.Equal(8,result.Steps.Length);Check.True(result.Steps.All(s=>s.Complete));count++;
        }
        Check.Equal(1920,count);return Task.CompletedTask;
    }
    public static async Task RuntimeAndHttp()
    {
        var barbarian=Complete("barbarian","dwarf","farmer");var derived=BuildEvaluator.Create(barbarian);
        Check.Equal("Hit Dice (d12)",CharacterEngine.HitDie(derived));Check.Equal(10+derived.Abilities[1].Modifier+derived.Abilities[2].Modifier,derived.ArmorClass);
        var c=TestContent.Campaign("harbor");c.Character=derived;CharacterEngine.Sync(c);Check.Equal(derived.ArmorClass,c.Character.ArmorClass);
        Check.True(!BuildRuntime.CanAutomateCombat(derived));Check.True(GrowthEngine.Choices(c).Length==0);
        c.SceneId="causeway";Check.True(!CombatEngine.Choices(c).Any(a=>a.Kind=="combat.start"));
        var info=ActionInformation.Build(c,Adventure.Choices(c));Check.True(info.Any(a=>a.Kind=="combat.start"&&a.Details!.UnavailableReason.Contains("主持")));
        var fighter=Complete() with {Equipped=["chain-mail","greatsword"]};
        fighter=fighter with {Selections=fighter.Selections.Select(s=>s.Key=="class:fighter/style"?s with {Values=["defense"]}:s).ToArray()};
        var defense=BuildEvaluator.Create(fighter);Check.Equal(17,defense.ArmorClass);c.Character=defense;CharacterEngine.Sync(c);Check.Equal(17,c.Character.ArmorClass);
        Check.True(BuildRuntime.StealthDisadvantage(defense));
        var wizard=Complete("wizard") with {ClassEquipment="B",BackgroundEquipment="B"};
        Check.True(!BuildEvaluator.Evaluate(wizard).CanCreate,"Changing the package must invalidate its old object choices");
        wizard=wizard with {Selections=wizard.Selections.Where(s=>!s.Key.StartsWith("equipment:",StringComparison.Ordinal)).ToArray()};
        var gold=BuildEvaluator.Create(wizard);Check.Equal(1,gold.Inventory.Single(i=>i.Id=="spellbook").Quantity);Check.Equal(10500,gold.BuildMechanics!.CurrencyCp);
        var host=await Host.Start();
        var catalogue=await host.Http.GetFromJsonAsync<BuildCatalogData>("/api/v1/character-build/catalog");Check.Equal(12,catalogue!.Classes.Length);
        var preview=await host.Http.PostAsJsonAsync("/api/v1/character-build/evaluate",new EvaluateBuildRequest(barbarian));Check.Equal(HttpStatusCode.OK,preview.StatusCode);
        var result=(await preview.Content.ReadFromJsonAsync<BuildEvaluation>())!;Check.True(result.CanCreate);Check.Equal(derived.MaxHitPoints,result.Character!.MaxHitPoints);
        var incomplete=await host.Http.PostAsJsonAsync("/api/v1/character-build/evaluate",new EvaluateBuildRequest(new()));Check.Equal(HttpStatusCode.OK,incomplete.StatusCode);
        Check.True(!(await incomplete.Content.ReadFromJsonAsync<BuildEvaluation>())!.CanCreate);
        var forged=JsonSerializer.Serialize(new {build=new {classId="fighter",hitPoints=999}});Check.Equal(HttpStatusCode.BadRequest,(await host.Http.PostAsync("/api/v1/character-build/evaluate",new StringContent(forged,Encoding.UTF8,"application/json"))).StatusCode);
        var request=new CreateCampaignRequest("Full creation",barbarian.Identity.Name,Build:barbarian);
        Check.Equal(HttpStatusCode.BadRequest,(await host.Http.PostAsJsonAsync("/api/v1/campaigns",request with {CharacterName="Other"})).StatusCode);
        Check.Equal(HttpStatusCode.BadRequest,(await host.Http.PostAsJsonAsync("/api/v1/campaigns",request with {Creation=CharacterCreation.Catalog().Templates[0].Defaults})).StatusCode);
        var create=await host.Http.PostAsJsonAsync("/api/v1/campaigns",request);Check.Equal(HttpStatusCode.Created,create.StatusCode);
        var created=(await create.Content.ReadFromJsonAsync<CreatedCampaign>())!;Check.Equal("draft",created.Snapshot.Content!.Status);Check.Equal("Dwarf",created.Snapshot.Character.Required().Species);
        host.Http.DefaultRequestHeaders.Authorization=new("Bearer",created.AccessToken);
        var trial=await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{created.Snapshot.Id}/content/trial",new TrialRequest(Guid.NewGuid().ToString(),created.Snapshot.Version,new string('d',64),TestContent.Document,TestContent.Prompts));
        Check.Equal(HttpStatusCode.OK,trial.StatusCode);Check.Equal(derived.ArmorClass,(await trial.Content.ReadFromJsonAsync<TrialResponse>())!.Trial.Snapshot.Character.Required().ArmorClass);
        var party=await host.Create("Full-build party");
        var invite=new InviteRequest(Guid.NewGuid().ToString(),party.Snapshot.Version,new string('a',64));
        Check.Equal(HttpStatusCode.OK,(await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{party.Snapshot.Id}/invitations",invite)).StatusCode);
        var guest=Complete("rogue","elf","sage") with {Identity=new() {Name="Guest",Backstory=new('星',4000)}};
        var joinRequest=new JoinCampaignRequest(Guid.NewGuid().ToString(),invite.InviteToken,new string('b',64),"Guest",Build:guest);
        Check.Equal(HttpStatusCode.BadRequest,(await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{party.Snapshot.Id}/join",joinRequest with {Creation=CharacterCreation.Catalog().Templates[0].Defaults})).StatusCode);
        var joined=await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{party.Snapshot.Id}/join",joinRequest);Check.Equal(HttpStatusCode.OK,joined.StatusCode);
        var seat=(await joined.Content.ReadFromJsonAsync<CreatedCampaign>())!;Check.Equal("Rogue",seat.Snapshot.Character.Required().ClassName);Check.Equal(4000,seat.Snapshot.Character.Required().Build!.Identity.Backstory.Length);
        var replay=await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{party.Snapshot.Id}/join",joinRequest);Check.Equal(HttpStatusCode.OK,replay.StatusCode);
        Check.Equal(seat.Snapshot.Version,(await replay.Content.ReadFromJsonAsync<CreatedCampaign>())!.Snapshot.Version);
        var root=host.Root;await host.DisposeAsync();await using var restarted=await Host.Start(root);
        restarted.Http.DefaultRequestHeaders.Authorization=new("Bearer",created.AccessToken);
        var loaded=(await restarted.Http.GetFromJsonAsync<CampaignSnapshot>($"/api/v1/campaigns/{created.Snapshot.Id}"))!;
        Check.Equal(JsonSerializer.Serialize(barbarian),JsonSerializer.Serialize(loaded.Character.Required().Build));Check.Equal(derived.MaxHitPoints,loaded.Character.Required().MaxHitPoints);
        Check.Equal(derived.ArmorClass,loaded.Character.ArmorClass);Check.Equal("Hit Dice (d12)",CharacterEngine.HitDie(loaded.Character));
    }
    public static Task AuthorityAndDependencies()
    {
        var empty=BuildEvaluator.Evaluate(new());Check.True(!empty.CanCreate);Check.True(empty.Character is null);Check.True(empty.Issues.Any(i=>i.Step=="abilities"));
        var draft=Complete();var valid=BuildEvaluator.Evaluate(draft);var before=JsonSerializer.Serialize(draft);
        Check.Equal(valid.Fingerprint,BuildEvaluator.Evaluate(draft).Fingerprint);Check.Equal(before,JsonSerializer.Serialize(draft));
        Check.True(!BuildEvaluator.Evaluate(draft with {Revision="other"}).CanCreate);
        Check.True(!BuildEvaluator.Evaluate(draft with {BaseScores=[15,15,13,12,10,8]}).CanCreate);
        Check.True(!BuildEvaluator.Evaluate(draft with {AbilityMethod="point-buy",BaseScores=[15,15,15,15,15,15]}).CanCreate);
        Check.True(!BuildEvaluator.Evaluate(draft with {AbilityMethod="point-buy",BaseScores=[8,8,8,8,8,8]}).CanCreate);
        Check.True(BuildEvaluator.Evaluate(draft with {AbilityMethod="point-buy"}).CanCreate);
        var invalidBonuses=BuildEvaluator.Evaluate(draft with {BackgroundBonuses=[0,0,0,2,1,0]});
        Check.True(!invalidBonuses.CanCreate);
        Check.Equal("abilities",invalidBonuses.Issues.Single(i=>i.Code=="background_boost_invalid").Step);
        Check.True(!BuildEvaluator.Evaluate(draft with {ClassSkills=["athletics","athletics"]}).CanCreate);
        Check.True(!BuildEvaluator.Evaluate(draft with {Selections=[..draft.Selections,new("fabricated",["value"])]}).CanCreate);
        Check.True(!BuildEvaluator.Evaluate(draft with {Selections=[..draft.Selections,draft.Selections[0]]}).CanCreate);
        Check.True(!BuildEvaluator.Evaluate(draft with {Purchases=[new("plate-armor",10)]}).CanCreate);
        Check.True(!BuildEvaluator.Evaluate(draft with {Purchases=[new("fabricated",1)]}).CanCreate);
        Check.True(!BuildEvaluator.Evaluate(draft with {Equipped=["shield"]}).CanCreate);
        Check.Throws<GameException>(()=>BuildEvaluator.Evaluate(draft with {Selections=null!}));
        Check.Throws<GameException>(()=>BuildEvaluator.Evaluate(draft with {Identity=new() {Name="x",Backstory=new('x',4001)}}));
        var elf=Complete("wizard","elf","sage");var oldLineage=elf.Selections.Single(s=>s.Key=="species:elf/lineage").Values[0];
        var changed=elf with {Selections=elf.Selections.Select(s=>s.Key=="species:elf/lineage"?s with {Values=["wood-elf"]}:s).ToArray()};
        Check.True(oldLineage!="wood-elf");var invalid=BuildEvaluator.Evaluate(changed);Check.True(invalid.Issues.Any(i=>i.Code=="choice_not_granted"));
        var rogue=Complete("rogue","human","soldier");
        var expertise=BuildEvaluator.Evaluate(rogue).Groups.Single(g=>g.Key=="$expertise");
        Check.True(expertise.DependsOn.Contains("species:human/skill"),"Expertise must invalidate when a proficiency source changes");
        var wiz=Complete("wizard");
        Check.True(!BuildEvaluator.Evaluate(wiz with {PreparedSpells=["cure-wounds",..wiz.PreparedSpells.Skip(1)]}).CanCreate);
        Check.True(!BuildEvaluator.Evaluate(wiz with {Spellbook=wiz.Spellbook.Skip(1).ToArray()}).CanCreate);
        var charCopy=valid.Character!;draft.BaseScores[0]=1;Check.Equal(15,charCopy.Build!.BaseScores[0]);
        return Task.CompletedTask;
    }
}
