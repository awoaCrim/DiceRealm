using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Opt-in test runner mode, not part of the production server. Real Pi/MCP, fake model,
// isolated loopback port/DataPath; signal files stop/restart only this fixture's hosts.
internal static class HarnessBrowserFixture
{
    public static async Task Run(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        string root = Path.Combine(Path.GetTempPath(), "dicerealm-harness-browser-" + Guid.NewGuid());
        string? address = null;
        int boots = 0;
        var dice = new SequenceDice(18);
        var model = new BrowserModel();
        string entry = Path.GetFullPath("agent-host/dist/main.js");
        if (!File.Exists(entry)) throw new InvalidOperationException("Build agent-host before starting this fixture.");
        foreach (string suffix in new[] { ".stop", ".restart" })
            if (File.Exists(statePath + suffix)) throw new InvalidOperationException("Remove the stale fixture signal explicitly first: " + suffix);
        while (true)
        {
            await using var host = await Host.Start(root, dice, configure: Configure(model, extra: builder =>
            {
                if (address is not null) builder.WebHost.UseUrls(address);
                builder.Configuration["Harness:AgentHostPath"] = entry;
                builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
                // Never load a real provider in this opt-in runner even if a developer has env keys.
                foreach (string prefix in new[] { "TextAi", "ImageAi", "HarnessAi", "PreparationAi" })
                {
                    builder.Configuration[prefix + ":ApiKey"] = "";
                    builder.Configuration[prefix + ":Model"] = "";
                }
            }));
            address = host.Http.BaseAddress!.GetLeftPart(UriPartial.Authority);
            boots++;
            JsonFiles.Write(statePath, new { baseUrl = address, dataPath = root, processId = Environment.ProcessId, boots });
            Console.WriteLine("Isolated Harness browser fixture ready (boot " + boots + ").");
            // Avoid test-only HTTP mutation routes. The browser gets fixture data from local test
            // files and all interactions go through the actual product API and embedded workbench.
            while (!File.Exists(statePath + ".stop") && !File.Exists(statePath + ".restart"))
            {
                JsonFiles.Write(statePath + ".stats", new
                {
                    boots, modelCalls = model.Calls, diceCount = dice.Count,
                    memoryObserved = model.MemoryObserved, modelAdapter = "fake", runtime = "PiHarnessRuntime"
                });
                await Task.Delay(200);
            }
            if (File.Exists(statePath + ".stop")) break;
            File.Delete(statePath + ".restart"); // Explicit test signal acknowledged, not production state.
        }
    }

    private sealed class BrowserModel : IHarnessModel
    {
        private int calls;
        private int memoryObserved;
        public bool Enabled => true;
        public int Calls => Volatile.Read(ref calls);
        public int MemoryObserved => Volatile.Read(ref memoryObserved);
        public async Task<HarnessModelReply> Complete(HarnessModelRequest request, string campaignId, CancellationToken ct)
        {
            Interlocked.Increment(ref calls);
            await Task.Delay(300, ct); // Make actual progress observable, without a supplier call.
            var users = request.Messages.Where(message => message.Role == "user").ToArray();
            using var initial = JsonDocument.Parse(users[0].Content);
            string input = initial.RootElement.GetProperty("input").GetString()!;
            if (initial.RootElement.TryGetProperty("memory", out var memory))
                Interlocked.Exchange(ref memoryObserved, memory.GetProperty("entries").GetArrayLength());
            using var current = JsonDocument.Parse(users[^1].Content);
            bool resumed = current.RootElement.TryGetProperty("confirmedResult", out _) || current.RootElement.TryGetProperty("playerAnswer", out _);
            var tools = request.Messages.Where(message => message.Role == "tool" && message.IsError != true).ToArray();
            if (input.Contains("未知", StringComparison.Ordinal)) throw new HttpRequestException("fixture provider response lost");
            if (input.Contains("慢", StringComparison.Ordinal)) await Task.Delay(TimeSpan.FromSeconds(30), ct);
            if (input.Contains("澄清", StringComparison.Ordinal))
                return resumed ? Text("已收到本人补充，继续这次隔离冒险。") : Tool("ask_player", new { question = "你希望与谁交谈？请补充目标。" });
            if (input.Contains("裁定", StringComparison.Ordinal))
                return resumed ? Text("依据主持已经提交的真实裁定继续。") : Tool("ruling_request", new { question = "隔离夹具中的未支持行动，需要主持给出理由与来源。" });
            if (input.Contains("记忆", StringComparison.Ordinal))
                return Text("本轮冻结了 " + MemoryObserved + " 条本人已公开记忆；没有重复执行之前的行动。");
            if (input.Contains("来源", StringComparison.Ordinal))
            {
                if (resumed) return Text("本人已明确确认来源与消耗，结果由服务端保存。");
                if (tools.Length == 0) return Tool("actions_list");
                using var listed = JsonDocument.Parse(tools[^1].Content);
                string choice = listed.RootElement.GetProperty("candidates").EnumerateArray()
                    .First(candidate => candidate.GetProperty("label").GetString()!.Contains("Mage Armor", StringComparison.Ordinal))
                    .GetProperty("id").GetString()!;
                return Tool("actions_propose", new { candidateId = choice });
            }
            if (tools.Length == 0) return Tool("context_read");
            if (!resumed)
            {
                string label = TestContent.Document.Scenes.Single(scene => scene.Id == "harbor")
                    .Actions.Single(action => action.Kind == "investigate").Label;
                return Tool("actions_propose", new { candidateId = Candidate(request, label) });
            }
            if (!tools.Any(tool => tool.Name == "checks_result")) return Tool("checks_result");
            if (!tools.Any(tool => tool.Name == "world_record"))
                return Tool("world_record", new NarrativeHarnessArgs("调查的真实结果已保存，沿岸留下了一条公开线索。",
                    [new("", "clue", "浏览器隔离线索", "本人确认后的非机械记忆。", "known", "harbor")]));
            return Text("本次调查已完成。你可以继续输入下一步行动，已确认的检定不会重掷。");
        }
    }
}
