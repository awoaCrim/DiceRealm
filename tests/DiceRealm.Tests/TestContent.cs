using System.Text.Json;
using System.Text.Json.Serialization;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

// External content fixture for the historical "mist coast" regression suite.
//
// The scenario text below used to live inside the server as an implicit production default. The
// user requirement is that the server ships no authored adventure, prompt or script content, so
// the same material now exists only as inert data in tests/Fixtures/*.json and is imported into a
// campaign exactly the way a host would import it. Nothing here is production behaviour: the
// fixture is regression coverage for the content runtime, not a built-in scenario.
//
// coast-regression.json reproduces the previous authored story verbatim (scenes, routes, checks,
// facts, quests, NPCs, factions, branches and the bounded causeway patrol). prompts.json holds the
// exact system text the old OpenAiText adapter carried in source. Fixtures are data only: no
// executable content, no URLs, no state patches, and no provider access happens while loading.
public static class TestContent
{
    public const string AdventureFileName = "coast-regression.json";
    public const string PromptsFileName = "prompts.json";
    public const string FirstSceneId = "harbor";

    // Strict read: unknown members fail, so a fixture drift from the server contract is a test
    // failure rather than a silently ignored field.
    private static readonly JsonSerializerOptions ReadOptions = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        AllowTrailingCommas = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
    };

    public static AdventureDocument Document { get; }
    public static PromptBundle Prompts { get; }

    static TestContent()
    {
        Document = Read<AdventureDocument>(AdventureFileName);
        Prompts = Read<PromptBundle>(PromptsFileName);
        // The fixture must satisfy the real import contract, not a test-local copy of it:
        // ContentValidator is the server boundary a host import goes through.
        ContentValidator.Validate(Document);
        try { PromptBundles.Validate(Prompts); }
        catch (ArgumentException ex) { throw new InvalidOperationException($"Fixture {PromptsFileName} is not a valid prompt bundle: {ex.Message}", ex); }
    }

    public static string PathOf(string fileName)
    {
        foreach (var root in CandidateRoots())
        {
            var path = Path.Combine(root, fileName);
            if (File.Exists(path)) return path;
        }
        throw new FileNotFoundException($"Missing test fixture '{fileName}'. Expected it under tests/Fixtures or next to the test binary.");
    }

    public static T Read<T>(string fileName)
    {
        var path = PathOf(fileName);
        try { return JsonSerializer.Deserialize<T>(File.ReadAllBytes(path), ReadOptions)
                    ?? throw new InvalidDataException($"Fixture {path} is empty."); }
        catch (JsonException ex) { throw new InvalidOperationException($"Fixture {path} does not match the server content contract: {ex.Message}", ex); }
    }

    /// Maps a fixture scene to the flat scene view the asset layer consumes. Optional arguments
    /// mirror the parent's SceneDefinition extension (style profile and visual constraints come
    /// from the imported document, never from a server-side default).
    public static SceneDefinition Scene(string sceneId, string? title = null, string? summary = null,
        string? arrival = null, string? prompt = null, string[]? exits = null)
    {
        var scene = Document.Scenes.FirstOrDefault(s => s.Id == sceneId)
            ?? throw new GameException("unknown_scene", "剧本中不存在此场景。", 409);
        return new(scene.Id, title ?? scene.Title, summary ?? scene.Summary, arrival ?? scene.Arrival,
            prompt ?? scene.ImagePrompt, exits ?? scene.Exits.Select(e => e.Target).ToArray(),
            Document.StyleProfile, Document.VisualConstraints);
    }

    /// A content-activated campaign carrying this fixture: the same state a host import produces.
    /// Id/token/character stay overridable because Campaign pins them at construction time.
    public static Campaign Campaign(string? sceneId = null, string name = "Coast regression",
        string? id = null, string? tokenHash = null, Character? character = null)
    {
        var start = sceneId ?? Document.StartSceneId;
        var campaign = new Campaign
        {
            Id = id ?? Guid.NewGuid().ToString(),
            Name = name,
            TokenHash = JsonFiles.Hash(tokenHash ?? "fixture-token"),
            Character = character ?? StarterCharacter.Create("Arden"),
            Adventure = Document,
            Prompts = Prompts,
            ContentActivated = true,
            SceneId = start,
        };
        if (!campaign.VisitedScenes.Contains(FirstSceneId)) campaign.VisitedScenes.Add(FirstSceneId);
        if (start != FirstSceneId && !campaign.VisitedScenes.Contains(start)) campaign.VisitedScenes.Add(start);
        return campaign;
    }

    /// The create-request body a host sends to activate this fixture: document + prompts + start.
    public static CreateCampaignRequest CreateRequest(string name, string characterName,
        string templateId = CharacterEngine.Fighter) =>
        new(name, characterName, Adventure: Document, Prompts: Prompts, StartImmediately: true, Build: FullCreationTests.Named(characterName, templateId));

    private static IEnumerable<string> CandidateRoots()
    {
        yield return Path.Combine(AppContext.BaseDirectory, "Fixtures");
        yield return Path.Combine(AppContext.BaseDirectory, "tests", "Fixtures");
        yield return Path.Combine(Directory.GetCurrentDirectory(), "Fixtures");
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            yield return Path.Combine(dir.FullName, "tests", "Fixtures");
            yield return Path.Combine(dir.FullName, "Fixtures");
            if (dir.Name.Equals("DiceRealm.Tests", StringComparison.OrdinalIgnoreCase) && dir.Parent is not null)
                yield return Path.Combine(dir.Parent.FullName, "Fixtures");
        }
    }
}
