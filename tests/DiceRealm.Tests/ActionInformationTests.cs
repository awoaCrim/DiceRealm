using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class ActionInformationTests
{
    private sealed class Dice:IDice { public int Calls;public int Roll(int sides){Calls++;return 1;} }
    public static Task BoardAndResources()
    {
        var c=TestContent.Campaign("causeway");c.Character=CharacterEngine.Create("Caster",CharacterEngine.Wizard);
        var dice=new Dice();var engine=new CombatEngine(dice);engine.Resolve(c,"combat.start","");
        ActionChoice[] Read()
        {
            var before=JsonSerializer.Serialize(c);int calls=dice.Calls;var allowed=Adventure.Choices(c);var result=ActionInformation.Build(c,allowed);
            Check.Equal(before,JsonSerializer.Serialize(c));Check.Equal(calls,dice.Calls);
            Check.Equal(result.Length,result.Select(a=>(a.Kind,a.Target)).Distinct().Count());
            foreach(var a in result)
            {
                Check.True(a.Details is not null&&!string.IsNullOrWhiteSpace(a.Details.TargetLabel)&&!string.IsNullOrWhiteSpace(a.Details.Cost)&&!string.IsNullOrWhiteSpace(a.Details.Range));
                Check.Equal(allowed.Any(x=>x.Kind==a.Kind&&x.Target==a.Target),a.Details!.UnavailableReason.Length==0);
            }
            return result;
        }
        ActionChoice Find(string kind,string target="")=>Read().Single(a=>a.Kind==kind&&a.Target==target);
        Check.True(Find("combat.attack","guardian").Details!.UnavailableReason.Contains("触及"));
        Check.True(Find("combat.cast","magic-missile:guardian").Details!.Cost.Contains("1 环法术位"));
        Check.True(Find("combat.cast","fire-bolt:guardian").Details!.Range.Contains("120 尺"));
        Check.True(Find("combat.move","3,2").Details!.Cost.Contains("10 尺"));
        Check.True(Find("combat.move","3,0").Details!.UnavailableReason.Contains("阻挡"));
        var before=JsonSerializer.Serialize(c);int count=dice.Calls;
        Check.Throws<GameException>(()=>engine.Resolve(c,"combat.attack","guardian"));Check.Equal(before,JsonSerializer.Serialize(c));Check.Equal(count,dice.Calls);
        var self=c.Combat!.Units.Single(u=>u.Id=="player");self.ActionAvailable=false;
        Check.True(Find("combat.cast","fire-bolt:guardian").Details!.UnavailableReason.Contains("动作已使用"));
        self.ActionAvailable=true;c.Character=c.Character with {Resources=c.Character.Resources.Select(r=>r.Name=="Spell Slots (1st)"?r with{Current=0}:r).ToArray()};
        Check.True(Find("combat.cast","magic-missile:guardian").Details!.UnavailableReason.Contains("法术位不足"));
        c.Combat.ActiveActorId="guardian";
        Check.True(Find("combat.end_turn").Details!.UnavailableReason.Contains("尚未轮到"));
        c.Combat=null;c.SceneId="causeway";
        Check.True(!Read().Any(a => PartyRest.IsInitiation(a.Kind)));
        Check.True(PartyRest.View(c).Options.Single(a => a.Kind == "long").Reason.Contains("安全"));
        c.SceneId="harbor";c.Character=c.Character with {NextLongRestAtSeconds=500};
        Check.True(!Read().Any(a => PartyRest.IsInitiation(a.Kind)));
        Check.True(PartyRest.View(c).Options.Single(a => a.Kind == "long").Reason.Contains("500 秒"));
        c.Archived=true;Check.Equal(0,ActionInformation.Build(c,[]).Length);
        return Task.CompletedTask;
    }
    public static async Task HttpContract()
    {
        await using var host=await Host.Start();
        var response=await host.Http.PostAsJsonAsync("/api/v1/campaigns",TestContent.CreateRequest("Action details","Arden"));
        Check.Equal(HttpStatusCode.Created,response.StatusCode);var created=(await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        var s=created.Snapshot;Check.True(s.ActionOptions is {Length:>0});
        Check.True(s.AvailableActions.All(a=>a.Details is not null&&a.Details.UnavailableReason==""));
        Check.Equal(s.AvailableActions.Length,s.ActionOptions!.Length);
        host.Http.DefaultRequestHeaders.Authorization=new("Bearer",created.AccessToken);
        Check.True(!s.ActionOptions!.Any(a=>PartyRest.IsInitiation(a.Kind)));
        var rejected=await host.Send(s.Id,new(Guid.NewGuid().ToString(),s.Version,"rest.short",""));Check.Equal(HttpStatusCode.Conflict,rejected.StatusCode);
        var after=(await host.Http.GetFromJsonAsync<CampaignSnapshot>($"/api/v1/campaigns/{s.Id}"))!;Check.Equal(s.Version,after.Version);
        var observe=(await host.Act(after,"observe")).Snapshot;
        Check.True(observe.AvailableActions.All(a=>a.Details is not null));Check.Equal(s.Version+1,observe.Version);
    }
}
