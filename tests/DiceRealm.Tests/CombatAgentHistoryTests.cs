using System.Reflection;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class CombatAgentHistoryTests
{
    public static Task MessageCountCompactionAndExactNativePairs()
    {
        var messages = new List<HarnessChatMessage> { new("user", "current-goal") };
        var exchanges = new List<HarnessModelExchange>();
        for (int i = 0; i < 30; i++)
        {
            messages.Add(new("user", "answer-" + i));
            var calls = Enumerable.Range(0, 3).Select(j => new HarnessToolCall($"call-{i}-{j}", "context_read", HarnessJson.Element(new { }))).ToArray();
            var reply = new HarnessModelReply("turn-" + i, calls, 0, 0);
            var native = new HarnessProviderContinuation(new string('d', 64), HarnessJson.Element(new { signature = "native-" + i, parts = new[] { new { text = "turn-" + i } } }));
            exchanges.Add(new(reply, native)); messages.Add(new("assistant", reply.Text, calls));
            messages.AddRange(calls.Select(c => new HarnessChatMessage("tool", "result", ToolCallId:c.Id, Name:c.Name)));
        }
        var request = new HarnessModelRequest("battle", messages.ToArray(), [], 4096)
            { ProviderHistory = exchanges.ToArray(), PriorProviderIdentities = [new string('d',64)] };
        Check.True(Encoding.UTF8.GetByteCount(HarnessJson.Serialize(request)) < HarnessContextCompactor.TargetBytes);
        string original = HarnessJson.Serialize(request);
        var prepared = HarnessContextCompactor.Prepare(request, providerEncoding:true, maximumMessages:128);
        Check.True(prepared.Plan is not null); Check.True(prepared.Request.Messages.Length <= 128);
        HarnessContextCompactor.Validate(prepared.Plan!, maximumExchanges:40, combatHistory:true);
        Check.True(prepared.Plan!.OriginalMessages > 128);
        try { HarnessContextCompactor.Validate(prepared.Plan); throw new Exception("Legacy plan accepted combined history"); }
        catch (InvalidDataException) { }
        for (int i = 0; i < 30; i++) Check.True(prepared.Request.Messages.Any(m => m.Role == "user" && m.Content == "answer-" + i));
        foreach (int index in prepared.Plan.RetainedAssistantIndices)
            Check.True(prepared.Request.ProviderHistory.Any(e => ReferenceEquals(e, exchanges[index])), "Never recreate native parts or signatures");
        Check.Equal(original, HarnessJson.Serialize(request));
        Check.Equal(request.PriorProviderIdentities[0], prepared.Request.PriorProviderIdentities[0]);

        string source = Id();
        var keptMessages = messages.Take(6).ToArray(); // source header, own answer, assistant and three exact results
        keptMessages[0] = new("user", HarnessJson.Serialize(new { completedBattleInput = new { id = source, input = "本人的原始战斗输入" } }));
        keptMessages[1] = new("user", HarnessJson.Serialize(new { playerAnswer = "本人的续答" }));
        var history = new HarnessCombatHistory([source], keptMessages, [exchanges[0]], [new string('d',64)], 0);
        Validate(history);
        Reject(history with { SourceRunIds = [Id()] });
        Reject(history with { SourceRunIds = [] });
        Reject(history with { Messages = [.. keptMessages.Skip(1)] });
        Reject(history with { Messages = keptMessages.Take(5).ToArray() });
        Reject(history with { Messages = keptMessages.Select((m,i)=>i==5 ? m with { ToolCallId="foreign" } : m).ToArray() });
        Reject(history with { Exchanges = [exchanges[0] with { Reply = exchanges[0].Reply with { Text="mismatched" } }] });
        Reject(history with { Messages = [.. keptMessages, new("tool","orphan",ToolCallId:"orphan",Name:"context_read")] });
        Reject(history with { Messages = keptMessages.Select((m,i)=>i==5 ? m with { Content=new string('x',256*1024) } : m).ToArray() });
        return Task.CompletedTask;
    }

    private static void Validate(HarnessCombatHistory history)
    {
        var owner = typeof(HarnessRunService).Assembly.GetType("DiceRealm.Server.Application.HarnessCombatHistories")!;
        try { owner.GetMethod("Validate", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, [history]); }
        catch (TargetInvocationException error) when (error.InnerException is not null) { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw(); }
    }
    private static void Reject(HarnessCombatHistory history)
    {
        try { Validate(history); throw new Exception("Broken battle history accepted"); }
        catch (GameException error) { Check.Equal("harness_corrupt_run", error.Code); }
    }
}
