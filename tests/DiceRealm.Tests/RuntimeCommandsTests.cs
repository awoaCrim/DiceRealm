using System.Security.Cryptography;
using System.Text.Json;
using DiceRealm.Server.Api;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class RuntimeCommandsTests
{
    public static Task ReadOnlyRulesPreflight()
    {
        string root = Path.Combine(Path.GetTempPath(), "dicerealm-runtime-preflight-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            string Publish(string text)
            {
                var entry = new LocalRuleEntry("rule:fixture", "rule", "预检夹具", "Fixture", [], text, "XPHB", 1,
                    LocalRulesCatalog.SourceRevision, new string('a', 64), "translated");
                string[] categories = ["spell", "class", "subclass", "feature", "species", "background", "feat", "equipment", "magic_item", "monster", "condition", "rule", "language"];
                var package = new LocalRulesPackage(1, "dnd2024", "zh-CN", LocalRulesCatalog.SourceRevision, ["XPHB"],
                    new(false, false, ["synthetic test package"], categories.ToDictionary(c => c, c => new LocalRulesCount(c == "rule" ? 1 : 0, c == "rule" ? 1 : 0))), [entry]);
                byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(package, new JsonSerializerOptions(JsonSerializerDefaults.Web));
                string hash = Convert.ToHexStringLower(SHA256.HashData(bytes));
                File.WriteAllBytes(Path.Combine(root, hash + ".json"), bytes);
                File.WriteAllText(Path.Combine(root, "active.json"), JsonSerializer.Serialize(new { version = hash }));
                return hash;
            }
            int? Execute(string[] args, out string stdout, out string stderr)
            {
                using var output = new StringWriter(); using var error = new StringWriter();
                int? result = RuntimeCommands.Execute(args, output, error);
                stdout = output.ToString(); stderr = error.ToString(); return result;
            }
            string old = Publish("历史预检正文隐私哨兵");
            string active = Publish("当前预检正文隐私哨兵");
            File.WriteAllText(Path.Combine(root, "authoring-private.json"), "not a runtime package");
            var before = Directory.GetFiles(root).ToDictionary(file => Path.GetFileName(file)!, File.ReadAllBytes);
            Check.Equal(0, Execute(["--verify-local-rules", root], out string stdout, out string stderr)!.Value);
            Check.Equal("", stderr); Check.True(!stdout.Contains("隐私哨兵"));
            using var parsed = JsonDocument.Parse(stdout);
            Check.Equal(active, parsed.RootElement.GetProperty("activeVersion").GetString());
            Check.Equal(1, parsed.RootElement.GetProperty("activeEntries").GetInt32());
            Check.Equal(2, parsed.RootElement.GetProperty("packages").GetArrayLength());
            Check.True(parsed.RootElement.GetProperty("packages").EnumerateArray().Any(e => e.GetProperty("version").GetString() == old));
            Check.Equal(before.Count, Directory.GetFiles(root).Length);
            foreach (var pair in before) Check.True(pair.Value.SequenceEqual(File.ReadAllBytes(Path.Combine(root, pair.Key!))));
            Check.True(Execute(["--urls", "http://127.0.0.1:5199"], out stdout, out stderr) is null);
            Check.Equal("", stdout + stderr);
            foreach (string[] args in new[] { new[] { "--verify-local-rules" }, new[] { "--verify-local-rules", "relative" },
                new[] { "--verify-local-rules=" + root }, new[] { "--verify-local-rules", root, "--urls", "http://127.0.0.1:5199" } })
            {
                Check.Equal(2, Execute(args, out stdout, out stderr)!.Value);
                Check.Equal("", stdout); Check.True(stderr.Contains("invalid_runtime_command"));
            }
            File.AppendAllText(Path.Combine(root, old + ".json"), " ");
            byte[] corrupted = File.ReadAllBytes(Path.Combine(root, old + ".json"));
            Check.Equal(1, Execute(["--verify-local-rules", root], out stdout, out stderr)!.Value);
            Check.Equal("", stdout); Check.True(stderr.Contains("rules_catalog_corrupt"));
            Check.True(corrupted.SequenceEqual(File.ReadAllBytes(Path.Combine(root, old + ".json"))));
            File.Delete(Path.Combine(root, "active.json"));
            Check.Equal(1, Execute(["--verify-local-rules", root], out stdout, out stderr)!.Value);
            Check.True(stderr.Contains("rules_catalog_unavailable"));
            return Task.CompletedTask;
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
