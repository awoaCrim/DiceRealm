using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Api;

public sealed record VerifiedRulesFile(string Version, int Entries, long Bytes);
public sealed record VerifiedRulesDirectory(string ActiveVersion, int ActiveEntries, VerifiedRulesFile[] Packages);

// Packaging and startup use the same loader as gameplay, without opening a data directory,
// starting hosted workers, or taking provider credentials from the process environment.
public static class RuntimeCommands
{
    private const string VerifyRules = "--verify-local-rules";
    private const int MaximumPackages = 128;
    private const long MaximumDirectoryBytes = 512L * 1024 * 1024;

    public static int? Execute(string[] args, TextWriter output, TextWriter error)
    {
        if (!args.Any(arg => arg.StartsWith(VerifyRules, StringComparison.Ordinal))) return null;
        if (args.Length != 2 || args[0] != VerifyRules || !Path.IsPathFullyQualified(args[1]))
        {
            error.WriteLine("{\"code\":\"invalid_runtime_command\",\"message\":\"用法：--verify-local-rules <绝对目录>；不能附加服务启动参数。\"}");
            return 2;
        }
        try
        {
            output.WriteLine(JsonSerializer.Serialize(InspectRules(args[1]), new JsonSerializerOptions(JsonSerializerDefaults.Web)));
            return 0;
        }
        catch (GameException ex)
        {
            error.WriteLine(JsonSerializer.Serialize(new { code = ex.Code, message = ex.Message }));
            return 1;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            error.WriteLine("{\"code\":\"rules_catalog_unavailable\",\"message\":\"无法只读校验本地规则目录；没有启动服务或修改文件。\"}");
            return 1;
        }
    }

    public static VerifiedRulesDirectory InspectRules(string directory)
    {
        if (!Path.IsPathFullyQualified(directory))
            throw new GameException("invalid_runtime_command", "规则预检需要绝对目录。");
        var catalog = new LocalRulesCatalog(new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["LocalRules:Directory"] = directory }).Build());
        string active = catalog.CaptureVersion()!;
        var files = new List<VerifiedRulesFile>();
        long totalBytes = 0;
        // Ignore unrelated authoring files. Only these validated hash-named files and active.json
        // are eligible for copying into a private package; no recursive directory copy is used.
        foreach (string file in Directory.EnumerateFiles(directory, "*.json", SearchOption.TopDirectoryOnly).Order(StringComparer.Ordinal))
        {
            string version = Path.GetFileNameWithoutExtension(file);
            if (!LocalRulesCatalog.Version(version)) continue;
            long bytes = new FileInfo(file).Length;
            if (files.Count >= MaximumPackages || bytes > MaximumDirectoryBytes - totalBytes)
                throw new GameException("rules_catalog_limit", "规则目录超过128个不可变包或512MiB；请显式选择所需历史版本。", 409);
            var package = catalog.Read(version);
            files.Add(new(version, package.Entries.Length, bytes));
            totalBytes += bytes;
        }
        var current = files.SingleOrDefault(file => file.Version == active);
        if (current is null || catalog.CaptureVersion() != active)
            throw new GameException("rules_catalog_changed", "规则目录在预检期间发生变化；未启动服务，请重新检查。", 409);
        return new(active, current.Entries, files.ToArray());
    }
}
