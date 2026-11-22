using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

// Explicit isolated UI acceptance data. No real model or image provider is configured.
internal static class RulingBrowserFixture
{
    public static async Task Run(string statePath)
    {
        statePath=Path.GetFullPath(statePath);
        if(File.Exists(statePath)||File.Exists(statePath+".stop"))throw new InvalidOperationException("Use a fresh fixture path.");
        var dice=new SequenceDice();var model=new HarnessTests.Model((_,_)=>throw new InvalidOperationException("No supplier authorized"));
        await using var host=await Host.Start(dice:dice,configure:HarnessTests.Configure(model));
        AccountTests.SeedAdminFixture(host);
        var owner=await HarnessTests.Create(host);
        var game=host.App.Services.GetRequiredService<GameService>();
        foreach(var input in new[]{"隔离验收：询问码头上的公开情况", "隔离验收：辨认一块不明纹样"})
        {
            var auth=await game.AuthorizeHarness(owner.Snapshot.Id,owner.AccessToken,default);
            await game.ReadHarnessExecution(owner.Snapshot.Id,owner.AccessToken,auth.ActorId,HarnessTests.Id(),input,auth.Version,default,29);
            await game.HarnessTool(owner.Snapshot.Id,owner.AccessToken,auth.ActorId,HarnessTests.Id(),input,auth.Version,
                HarnessTests.Id(),HarnessTests.Id(),new("ruling_request",HarnessJson.Element(new {question="隔离验收数据：需要主持决定如何回应；没有执行攻击或扣除资源。"}),"fixture-ruling"),[],default,
                auth.Profile,toolContractVersion:29,contextAlreadyRead:true);
        }
        JsonFiles.Write(statePath,new {baseUrl=host.Http.BaseAddress!.GetLeftPart(UriPartial.Authority),dataPath=host.Root,processId=Environment.ProcessId,
            campaignId=owner.Snapshot.Id,fixture="ruling-clarity-no-provider"});
        while(!File.Exists(statePath+".stop"))await Task.Delay(200);
        var final=(await host.Get(owner.Snapshot.Id))!;
        JsonFiles.Write(statePath+".result",new {final.Version,dice=dice.Count,modelCalls=model.Calls,
            rulings=final.PendingRulings.Select(r=>new {r.Status,r.Outcome,r.RuleSource,hasStory=r.Story is not null}),
            pendingRolls=final.PendingRoll is not null});
        Check.Equal(0,dice.Count);Check.Equal(0,model.Calls);
    }
}
