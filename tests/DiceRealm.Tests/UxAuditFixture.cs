using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

// Opt-in dual-client UI fixture. No real credentials, suppliers or existing game data.
internal static class UxAuditFixture
{
    public static async Task Run(string statePath)
    {
        statePath=Path.GetFullPath(statePath);
        if(File.Exists(statePath)||File.Exists(statePath+".stop"))throw new InvalidOperationException("Use a fresh audit state path.");
        var dice=new SequenceDice();var model=new HarnessTests.Model((_,_)=>throw new InvalidOperationException("No supplier calls in UX acceptance"));
        await using var host=await Host.Start(dice:dice,broken:new BrokenText(),configure:HarnessTests.Configure(model));
        AccountTests.SeedAdminFixture(host);
        var owner=await HarnessTests.Create(host);
        await host.App.Services.GetRequiredService<CampaignStore>().Access(owner.Snapshot.Id,owner.AccessToken,true,c=>
        {
            c.Character=c.Character! with {Inventory=[..c.Character.Inventory,new("burglar-s-pack","Burglar's Pack",2,false),new("candle","Candle",3,false),
                ..Enumerable.Range(1,30).Select(i=>new Item("audit-item-"+i,"隔离收藏品 "+i,i,false))]};
            c.PartyMembers.Add(new PartyMember{Id="audit-peer",TokenHash=JsonFiles.Hash(new string('b',64)),Character=BuildEvaluator.Create(FullCreationTests.Named("尚未发言的同伴")),Review=new(1,"approved")});
            return Task.FromResult(true);
        });
        JsonFiles.Write(statePath,new {baseUrl=host.Http.BaseAddress!.GetLeftPart(UriPartial.Authority),dataPath=host.Root,processId=Environment.ProcessId,
            owner.AccessToken,campaignId=owner.Snapshot.Id,fixture="ux-audit-real-http-seeded-party"});
        while(!File.Exists(statePath+".stop"))await Task.Delay(250);
        var final=(await host.Get(owner.Snapshot.Id))!;
        JsonFiles.Write(statePath+".result",new {final.Version,dice=dice.Count,modelCalls=model.Calls});
        Check.Equal(0,dice.Count);Check.Equal(0,model.Calls);
    }
}
