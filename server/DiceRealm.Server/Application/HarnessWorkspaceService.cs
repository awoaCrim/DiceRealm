using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    private static void RequireWorkspaceHost(Campaign c)
    {
        PartyEngine.RequireHost(c);
        if (c.Harness is null) throw HarnessJson.Conflict("harness_campaign_required");
    }
    public Task AuthorizeHarnessWorkspace(string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c => { RequireWorkspaceHost(c); return Task.FromResult(true); }, ct);
    public Task<HarnessWorkspace> GetHarnessWorkspace(string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c => { RequireWorkspaceHost(c); return Task.FromResult(workspaces.Get(c)); }, ct);
    public Task<HarnessRevisionPage> HarnessRevisions(string id, string token, int? before, int limit, CancellationToken ct) =>
        store.Access(id, token, false, c => { RequireWorkspaceHost(c); return Task.FromResult(workspaces.Revisions(c, before, limit)); }, ct);
    public Task<HarnessRevisionContent> HarnessRevision(string id, string token, int revision, CancellationToken ct) =>
        store.Access(id, token, false, c => { RequireWorkspaceHost(c); return Task.FromResult(workspaces.Revision(c, revision)); }, ct);
    private static HarnessProfile Profile(HarnessPreset preset, HarnessSkill[] skills)
    {
        HarnessProfiles.Validate(preset, skills);
        return new(preset, HarnessJson.ProfileHash(preset, skills), skills);
    }
    public Task<object> PreviewHarnessProfile(string id, string token, HarnessProfileRequest request, CancellationToken ct) =>
        store.Access<object>(id, token, false, c => { RequireWorkspaceHost(c); return Task.FromResult<object>(new { profile = Profile(request.Preset, request.Skills) }); }, ct);
    public Task<HarnessWorkspaceResult> SaveHarnessDraft(string id, string token, SaveHarnessDraftRequest request, CancellationToken ct) =>
        WorkspaceCommand(id, token, "draft", request.RequestId, request.ExpectedWorkspaceVersion, request, ct, () => Profile(request.Preset, request.Skills));
    public Task<HarnessWorkspaceResult> PublishHarness(string id, string token, PublishHarnessRequest request, CancellationToken ct) =>
        WorkspaceCommand(id, token, "publish", request.RequestId, request.ExpectedWorkspaceVersion, request, ct);
    public Task<HarnessWorkspaceResult> ActivateHarness(string id, string token, ActivateHarnessRequest request, CancellationToken ct) =>
        WorkspaceCommand(id, token, "activate", request.RequestId, request.ExpectedWorkspaceVersion, request, ct, revision: request.Revision);
    private Task<HarnessWorkspaceResult> WorkspaceCommand(string id, string token, string operation, string requestId, int version,
        object payload, CancellationToken ct, Func<HarnessProfile>? draft = null, int revision = 0) => store.Access(id, token, true, c =>
        {
            RequireWorkspaceHost(c);
            var result = workspaces.Mutate(c, operation, requestId, version, payload, () => store.CheckpointWorkspaceInitialization(c), draft?.Invoke(), revision);
            // Adopts any pre-marker compatible catalog on replay. New catalogs checkpoint the
            // marker first; a later save failure never permits bootstrap fallback.
            c.HarnessWorkspaceInitialized = true;
            return Task.FromResult(result);
        }, ct);
    public Task<HarnessMemory> GetHarnessMemory(string id, string token, CancellationToken ct) => store.Access(id, token, false, c =>
    {
        if (c.Harness is null) throw HarnessJson.Conflict("harness_campaign_required");
        return Task.FromResult(HarnessMemories.Build(c));
    }, ct);
    private sealed record WorkspaceExportCapture(string CampaignId, int GameVersion, HarnessWorkspace Workspace,
        HarnessRevisionContent Selection, bool IncludeDraft, AdventureDocument Adventure, HarnessMemory Memory);
    public async Task<byte[]> ExportHarnessWorkspace(string id, string token, int? revision, bool includeDraft, CancellationToken ct)
    {
        // All immutable sources and projection data captured at one authorization/version gate.
        // Compression and response transmission occur afterwards; no lock spans external I/O.
        var capture = await store.Access(id, token, false, c =>
        {
            RequireWorkspaceHost(c);
            var state = workspaces.Get(c);
            return Task.FromResult(new WorkspaceExportCapture(c.Id, c.Version, state, workspaces.Revision(c, revision ?? state.ActiveRevision),
                includeDraft, c.Adventure ?? throw HarnessJson.Conflict("content_required"), HarnessMemories.Build(c)));
        }, ct);
        var files = new List<(string Path, string Role, byte[] Bytes)>();
        void Json(string path, string role, object value) => files.Add((path, role, Encoding.UTF8.GetBytes(HarnessJson.Serialize(value))));
        void AddProfile(string prefix, HarnessProfile profile)
        {
            Json(prefix + "/profile.json", "binding-source", profile);
            files.Add((prefix + "/preset.md", "system-original", Encoding.UTF8.GetBytes(profile.Preset.SystemPrompt)));
            if (profile.Preset.CombatSystemPrompt is { } combatPrompt)
                files.Add((prefix + "/combat-preset.md", "combat-system-original", Encoding.UTF8.GetBytes(combatPrompt)));
            for (int i = 0; i < profile.Skills.Length; i++) files.Add(($"{prefix}/skills/{i + 1:D2}.md", "skill-original", Encoding.UTF8.GetBytes(profile.Skills[i].Content)));
        }
        AddProfile("selected", capture.Selection.Profile);
        if (includeDraft) AddProfile("draft", capture.Workspace.Draft);
        Json("adventure.json", "host-adventure-source", capture.Adventure);
        Json("memory.json", "own-seat-public-readonly", capture.Memory);
        var manifest = new
        {
            format = "dicerealm-harness-content", schemaVersion = 1, scope = "selected-binding-and-optional-draft-not-game-backup",
            campaignId = capture.CampaignId, gameVersion = capture.GameVersion, workspaceVersion = capture.Workspace.Version,
            activeRevision = capture.Workspace.ActiveRevision, selectedRevision = capture.Selection.Revision, includeDraft = capture.IncludeDraft,
            files = files.Select(f => new { path = f.Path, role = f.Role, byteLength = f.Bytes.Length, sha256 = Convert.ToHexStringLower(SHA256.HashData(f.Bytes)) }).ToArray()
        };
        Json("manifest.json", "manifest", manifest);
        using var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var file in files)
            {
                ct.ThrowIfCancellationRequested();
                var entry = zip.CreateEntry(file.Path, CompressionLevel.Optimal);
                using var body = entry.Open(); body.Write(file.Bytes);
            }
        return stream.ToArray();
    }
}
