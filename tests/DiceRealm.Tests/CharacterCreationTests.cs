using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Application;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class CharacterCreationTests
{
    public static Task RulesAndBounds()
    {
        var catalog=CharacterCreation.Catalog();
        Check.Equal("dnd2024",catalog.Ruleset);Check.Equal("XPHB",catalog.Source);
        var fighter=catalog.Templates[0].Defaults;var wizard=catalog.Templates[1].Defaults;
        foreach(var t in catalog.Templates)
        {
            var original=CharacterEngine.Create("Default",t.TemplateId);
            var custom=CharacterEngine.Create("Default",t.TemplateId,t.Defaults);
            Check.True(original.Abilities.SequenceEqual(custom.Abilities));Check.Equal(original.MaxHitPoints,custom.MaxHitPoints);
            Check.True(original.Inventory.SequenceEqual(custom.Inventory));Check.True(original.Skills.SequenceEqual(custom.Skills));
        }
        var choices=wizard with { BaseScores=[8,15,10,14,13,12], BackgroundBonuses=[1,1,1,0,0,0], ClassSkills=["Medicine","Religion"],HumanSkill="Stealth",EquipmentId="wizard-dagger" };
        var ch=CharacterEngine.Create("Custom",CharacterEngine.Wizard,choices);
        Check.Equal(6,ch.HitPoints);Check.Equal(13,ch.ArmorClass);Check.Equal(4,ch.Spellcasting!.AttackBonus);Check.Equal(12,ch.Spellcasting.SaveDc);
        Check.Equal("dagger",CharacterEngine.Weapon(ch)!.Id);Check.True(ch.Features.Contains("Skillful: Stealth"));
        choices.BaseScores[0]=99;Check.Equal(8,ch.Creation!.BaseScores[0]);Check.Equal(9,ch.Abilities[0].Score);
        var varied=wizard with { BaseScores=[8,12,10,15,14,13],BackgroundBonuses=[0,2,1,0,0,0] };
        var variedCharacter=CharacterEngine.Create("Varied",CharacterEngine.Wizard,varied);
        Check.Equal(12,variedCharacter.ArmorClass);Check.Equal(6,variedCharacter.MaxHitPoints);
        var lowInt=CharacterEngine.Create("LowInt",CharacterEngine.Wizard,wizard with {BaseScores=[15,13,14,8,12,10]});
        Check.Equal(1,lowInt.Spellcasting!.AttackBonus);Check.Equal(9,lowInt.Spellcasting.SaveDc);
        Check.Throws<GameException>(()=>CharacterEngine.Create("Bad",CharacterEngine.Wizard,wizard with {BaseScores=[15,15,13,12,10,8]}));
        Check.Throws<GameException>(()=>CharacterEngine.Create("Bad",CharacterEngine.Wizard,wizard with {BaseScores=null!}));
        Check.Throws<GameException>(()=>CharacterEngine.Create("Bad",CharacterEngine.Wizard,wizard with {BackgroundBonuses=[0,0,0,2,1,0]}));
        Check.Throws<GameException>(()=>CharacterEngine.Create("Bad",CharacterEngine.Wizard,wizard with {BackgroundBonuses=[3,0,0,0,0,0]}));
        Check.Throws<GameException>(()=>CharacterEngine.Create("Bad",CharacterEngine.Wizard,wizard with {ClassSkills=["Arcana","Arcana"]}));
        Check.Throws<GameException>(()=>CharacterEngine.Create("Bad",CharacterEngine.Wizard,wizard with {ClassSkills=["Arcana","Survival"]}));
        Check.Throws<GameException>(()=>CharacterEngine.Create("Bad",CharacterEngine.Wizard,wizard with {HumanSkill="Athletics"}));
        Check.Throws<GameException>(()=>CharacterEngine.Create("Bad",CharacterEngine.Wizard,wizard with {HumanSkill="Arcana"}));
        Check.Throws<GameException>(()=>CharacterEngine.Create("Bad",CharacterEngine.Wizard,wizard with {EquipmentId="fighter-purchase"}));
        Check.Throws<GameException>(()=>CharacterEngine.Create("Bad",CharacterEngine.Fighter,fighter with {BaseScores=[8,15,14,13,12,10]}));
        Check.Throws<GameException>(()=>CharacterEngine.Create("Bad",CharacterEngine.Fighter,fighter with {ClassSkills=["Athletics","Survival"]}));
        var purchased=CharacterEngine.Create("Buyer",CharacterEngine.Fighter,fighter with {EquipmentId="fighter-purchase",HumanSkill="Stealth"});
        Check.Equal(78,purchased.Inventory.Single(i=>i.Id=="gold-piece").Quantity);Check.True(purchased.Inventory.Any(i=>i.Id=="dagger"));Check.True(!purchased.Inventory.Any(i=>i.Id=="dungeoneers-pack"));
        Check.True(StarterCharacter.Upgrade(purchased).Features.Contains("Skillful: Stealth"));
        var rules=new RulesEngine(new SequenceDice(17,4,10));
        Check.Equal("disadvantage",rules.AbilityCheck(purchased,"dexterity","Stealth",12).Mode);
        Check.Equal("normal",rules.AbilityCheck(purchased,"dexterity","Stealth",12,advantage:true).Mode);
        var c=TestContent.Campaign("harbor");c.Character=ch with { Inventory=ch.Inventory.Where(i=>i.Id!="quarterstaff").ToArray() };
        Check.True(CharacterEngine.CanCast(c,"mage-armor"),"XPHB p165 explicitly allows the Wizard spellbook as a focus");
        c.Character=c.Character with {Inventory=c.Character.Inventory.Where(i=>i.Id!="spellbook").ToArray()};
        Check.True(!CharacterEngine.CanCast(c,"mage-armor"),"Mage Armor still needs either supported focus");
        Check.True(CharacterEngine.CanCast(c,"fire-bolt"));
        return Task.CompletedTask;
    }
    public static async Task HttpPreviewAndDurability()
    {
        var host=await Host.Start();
        Check.Equal(HttpStatusCode.Gone,(await host.Http.GetAsync("/api/v1/character-creation")).StatusCode);
        var choices=CharacterCreation.Catalog().Templates[0].Defaults with {HumanSkill="Stealth",EquipmentId="fighter-purchase",BaseScores=[14,12,15,10,13,8]};
        Check.Equal(HttpStatusCode.Gone,(await host.Http.PostAsJsonAsync("/api/v1/character-creation/preview",new PreviewCharacterRequest("Ada",CharacterEngine.Fighter,choices))).StatusCode);
        Check.Equal(HttpStatusCode.BadRequest,(await host.Http.PostAsJsonAsync("/api/v1/campaigns",new CreateCampaignRequest("Custom","Ada",Creation:choices))).StatusCode);
        Check.True(!Directory.Exists(Path.Combine(host.Root,"campaigns"))||!Directory.EnumerateFiles(Path.Combine(host.Root,"campaigns"),"*",SearchOption.AllDirectories).Any(),"Rejected legacy creation must not create a save");
        // Seed an explicitly pre-existing legacy save. This is not a new-creation HTTP path.
        var expected=CharacterEngine.Create("Ada",CharacterEngine.Fighter,choices);
        string token=new('c',64);
        var legacy=new Campaign{Id=Guid.NewGuid().ToString(),Name="Legacy custom",TokenHash=JsonFiles.Hash(token),Character=expected};
        legacy.Events.Add(new(Guid.NewGuid().ToString(),1,"fixture.legacy","Legacy draft","","fixture",DateTimeOffset.UtcNow,null));
        host.App.Services.GetRequiredService<CampaignStore>().Create(legacy);
        host.Http.DefaultRequestHeaders.Authorization=new("Bearer",token);
        var loadedLegacy=(await host.Get(legacy.Id))!;
        var created=new CreatedCampaign(token,loadedLegacy);
        Check.Equal(expected.HitPoints,created.Snapshot.Character.Required().HitPoints);Check.True(expected.Abilities.SequenceEqual(created.Snapshot.Character.Required().Abilities));
        Check.Equal("draft",created.Snapshot.Content!.Status);Check.Equal(0,created.Snapshot.AvailableActions.Length);
        var trialRequest=new TrialRequest(Guid.NewGuid().ToString(),created.Snapshot.Version,Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)),TestContent.Document,TestContent.Prompts);
        var trialReply=await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{created.Snapshot.Id}/content/trial",trialRequest);
        Check.Equal(HttpStatusCode.OK,trialReply.StatusCode);var trial=(await trialReply.Content.ReadFromJsonAsync<TrialResponse>())!;
        Check.True(trial.Trial.Snapshot.Character.Required().Abilities.SequenceEqual(expected.Abilities));Check.True(trial.Trial.Snapshot.Character.Required().Features.Contains("Skillful: Stealth"));
        var path=host.Root;await host.DisposeAsync();await using var restart=await Host.Start(path);
        restart.Http.DefaultRequestHeaders.Authorization=new("Bearer",created.AccessToken);
        var loaded=(await restart.Http.GetFromJsonAsync<CampaignSnapshot>($"/api/v1/campaigns/{created.Snapshot.Id}"))!;
        Check.True(loaded.Character.Required().Features.Contains("Skillful: Stealth"));Check.Equal("fighter-purchase",loaded.Character.Required().Creation!.EquipmentId);
        Check.True(loaded.Character.Abilities.SequenceEqual(expected.Abilities));Check.True(loaded.Character.Inventory.SequenceEqual(expected.Inventory));
    }
}
