using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

public sealed class HarnessRun
{
    public int SchemaVersion { get; init; } = 1;
    public string RuntimeVersion { get; init; } = "pi-0.87.1/wire-1";
    public required string Id { get; init; }
    public required string IntentId { get; init; }
    public required string CampaignId { get; init; }
    public required string ActorId { get; init; }
    public required string Fingerprint { get; init; }
    public required string Input { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? TimelineId { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    public bool Opening { get; init; }
    public required HarnessProfile Profile { get; init; }
    public required HarnessLimits Limits { get; init; }
    // Absent in pre-efficiency runs: retain their exact tool descriptions and full outputs.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    public int ToolContractVersion { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? RulesCatalogVersion { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    public int ContextReadVersion { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public HarnessMemory? MemorySnapshot { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? CombatSessionId { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public CombatCommandSource? CombatCommand { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    public bool CombatFirstInput { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? CombatParentRunId { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public HarnessCombatHistory? CombatHistory { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? DelegatedSessionId { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? CombatReturnId { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public List<HarnessCombatReturnReceipt>? CombatReturns { get; set; }
    public List<string> Turns { get; init; } = [];
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public List<int>? TurnVersions { get; init; }
    public List<HarnessStep> Steps { get; init; } = [];
    public List<HarnessResumeReceipt> Resumes { get; init; } = [];
    public int Version { get; set; }
    public string Status { get; set; } = "running";
    public HarnessWait? Wait { get; set; }
    public string Text { get; set; } = "";
    public string Error { get; set; } = "";
    public bool CancelRequested { get; set; }
    public string[] OfferedIds { get; set; } = [];
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string[]? OfferedMemoryIds { get; set; }
    public int ModelAttempts { get; set; }
    public int Tokens { get; set; }
    public long RuntimeMilliseconds { get; set; }
    public DateTimeOffset? ExecutionStartedAt { get; set; }
}
public sealed class HarnessStep
{
    public required string Id { get; init; }
    public required string Kind { get; init; }
    public required string Fingerprint { get; init; }
    public required string CommandId { get; init; }
    public string Status { get; set; } = "started";
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? ToolName { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public HarnessToolRequest? ToolRequest { get; init; }
    public JsonElement? Result { get; set; }
    public HarnessToolOutcome? Outcome { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public HarnessProviderContinuation? ProviderContinuation { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? ProviderIdentity { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public HarnessContextPlan? ContextPlan { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public HarnessExecutionFrame? ExecutionFrame { get; set; }
}
public sealed record HarnessResumeReceipt(string Id, string Fingerprint);
// Immutable receipt/budget boundary for each authoritative return, not a second transcript.
public sealed record HarnessCombatReturnReceipt(string SessionId, string ReturnId, int Turn, int StepCount,
    int ResumeCount, int ModelAttempts, long RuntimeMilliseconds);

// Only the coordinator writes an executing run. Cancellation is the sole concurrent update:
// Save merges its durable monotonic flag so a late model completion cannot undo cancellation.
public sealed partial class HarnessRunStore(DataDirectory directory, ILogger<HarnessRunStore> logger)
{
    private readonly object gate = new();
    private readonly HarnessRunIndex history = new(directory.Root);
    private readonly HashSet<string> unindexedSeats = new(StringComparer.Ordinal);
    // Startup-only backfill for legacy files. Already indexed cold runs need no parsing.
    public void InitializeHistory()
    {
        lock (gate)
        {
            var known = history.Initialize();
            string root = Path.Combine(directory.Root, "harness");
            if (!Directory.Exists(root)) return;
            foreach (string campaignPath in Directory.EnumerateDirectories(root))
            {
                string campaign = Path.GetFileName(campaignPath);
                foreach (string seatPath in Directory.EnumerateDirectories(campaignPath))
                    foreach (string file in Directory.EnumerateFiles(seatPath, "*.json", SearchOption.AllDirectories))
                    {
                        string id = Path.GetFileNameWithoutExtension(file), seat = Path.GetFileName(seatPath);
                        if (known.Contains(HarnessRunIndex.Key(campaign, seat, id))) continue;
                        try
                        {
                            if (new FileInfo(file).Length > 8 * 1024 * 1024) throw new InvalidDataException();
                            using var json = JsonDocument.Parse(File.ReadAllBytes(file));
                            var data = json.RootElement;
                            string actor = data.GetProperty("actorId").GetString() ?? "", action = data.GetProperty("intentId").GetString() ?? "";
                            if (JsonFiles.Hash(actor) != seat || data.GetProperty("campaignId").GetString() != campaign || data.GetProperty("id").GetString() != id ||
                                JsonFiles.CampaignId(campaign) != campaign || JsonFiles.CampaignId(id) != id || JsonFiles.CampaignId(action) != action) throw new InvalidDataException();
                            history.Add(campaign, actor, action, id);
                        }
                        catch (Exception ex) when (ex is JsonException or InvalidDataException or GameException or KeyNotFoundException or InvalidOperationException or IOException)
                        {
                            unindexedSeats.Add(campaign + "/" + seat);
                            logger.LogWarning("A saved run could not be indexed in campaign {Campaign}; the original file is unchanged ({Error}).", campaign, ex.GetType().Name);
                        }
                    }
            }
        }
    }
    public HarnessRun? ReadAction(string campaign, string actor, string action)
    {
        lock (gate)
        {
            string? id = history.Find(campaign, actor, action);
            if (id is null)
            {
                if (unindexedSeats.Contains(campaign + "/" + JsonFiles.Hash(actor))) throw HarnessJson.Conflict("harness_corrupt_run");
                return null;
            }
            var run = Read(campaign, actor, id);
            if (run is null || run.IntentId != action) throw HarnessJson.Conflict("harness_corrupt_run");
            return run;
        }
    }
    private string Seat(string campaign, string actor) => Path.Combine(directory.Root, "harness", JsonFiles.CampaignId(campaign), JsonFiles.Hash(actor));
    private string PathFor(string campaign, string actor, string id) => Path.Combine(Seat(campaign, actor), JsonFiles.CampaignId(id) + ".json");
    private string ClosedPath(string campaign, string actor, string id)
    {
        string canonical = JsonFiles.CampaignId(id);
        return Path.Combine(Seat(campaign, actor), "closed", canonical[..2], canonical + ".json");
    }
    private string ExistingPath(string campaign, string actor, string id)
    {
        string active = PathFor(campaign, actor, id), closed = ClosedPath(campaign, actor, id);
        if (File.Exists(active) && File.Exists(closed)) throw HarnessJson.Conflict("harness_corrupt_run");
        return File.Exists(closed) ? closed : active;
    }
    private static bool Terminal(HarnessRun r) => r.Status is "completed" or "cancelled" or "failed" or "unknown";
    public HarnessRun? Read(string campaign, string actor, string id)
    {
        campaign = JsonFiles.CampaignId(campaign); id = JsonFiles.CampaignId(id);
        lock (gate) return ReadFile(ExistingPath(campaign, actor, id), campaign, actor, id);
    }
    public HarnessRun[] ListActive(string campaign, string actor)
    {
        lock (gate)
        {
            string path = Seat(campaign, actor);
            if (!Directory.Exists(path)) return [];
            var files = Directory.GetFiles(path, "*.json");
            if (files.Length > 64) throw HarnessJson.Conflict("harness_corrupt_run");
            return files.Select(f => ReadFile(f, campaign, actor, Path.GetFileNameWithoutExtension(f))!).ToArray();
        }
    }
    // Metadata scan only; deserialize the newest closed record plus the bounded live set.
    // No migration, pointer write or receipt deletion on a host observation.
    public HarnessRun[] ListRecent(string campaign, string actor)
    {
        lock (gate)
        {
            var live = ListActive(campaign, actor);
            string closed = Path.Combine(Seat(campaign, actor), "closed");
            if (!Directory.Exists(closed)) return live;
            var latest = new DirectoryInfo(closed).EnumerateFiles("*.json", SearchOption.AllDirectories)
                .OrderByDescending(file => file.LastWriteTimeUtc).ThenBy(file => file.Name, StringComparer.Ordinal).FirstOrDefault();
            if (latest is null) return live;
            var run = ReadFile(latest.FullName, campaign, actor, Path.GetFileNameWithoutExtension(latest.Name))!;
            return live.Append(run).ToArray();
        }
    }
    public void Create(HarnessRun run)
    {
        lock (gate)
        {
            string path = ExistingPath(run.CampaignId, run.ActorId, run.Id);
            if (File.Exists(path) || File.Exists(IssuedPath(run.CampaignId, run.ActorId, run.Id))) throw HarnessJson.Conflict("harness_run_conflict");
            // Terminal records keep their exact replay identity in sharded cold storage. Only
            // unfinished runs count toward the live cap; finishing 64 inputs is not a lifetime limit.
            foreach (var finished in ListActive(run.CampaignId, run.ActorId).Where(Terminal))
                Archive(PathFor(finished.CampaignId, finished.ActorId, finished.Id), finished);
            if (ListActive(run.CampaignId, run.ActorId).Length >= 64) throw HarnessJson.Conflict("harness_run_capacity");
            Write(path, run);
            history.Add(run);
        }
    }
    public void Save(HarnessRun run)
    {
        lock (gate)
        {
            string path = ExistingPath(run.CampaignId, run.ActorId, run.Id);
            var old = ReadFile(path, run.CampaignId, run.ActorId, run.Id) ?? throw HarnessJson.Conflict("harness_run_missing");
            if (old.Fingerprint != run.Fingerprint) throw HarnessJson.Conflict("harness_run_conflict");
            run.CancelRequested |= old.CancelRequested;
            Write(path, run);
        }
    }
    public HarnessRun Cancel(string campaign, string actor, string id, bool active)
    {
        lock (gate)
        {
            string path = ExistingPath(campaign, actor, id);
            var run = ReadFile(path, campaign, actor, id) ?? throw new GameException("harness_not_found", "没有此运行。", 404);
            if (run.Status == "unknown")
            {
                // A stopped/unknown delegated parent still owns the first input and any
                // pending return. Persist the stop without disguising the unknown call.
                if (run.DelegatedSessionId is not null && !run.CancelRequested)
                {
                    run.CancelRequested = true;
                    Write(path, run);
                }
                return run;
            }
            if (run.Status is "completed" or "cancelled" or "failed") return run;
            run.CancelRequested = true;
            if (!active) { run.Status = "cancelled"; run.Error = "harness_cancelled"; }
            Write(path, run); return run;
        }
    }
    private void Write(string path, HarnessRun run)
    {
        Validate(run, run.CampaignId, run.ActorId, run.Id);
        HarnessJson.Bound(run, 8 * 1024 * 1024);
        RecordIssued(run);
        JsonFiles.Write(path, run);
        if (Terminal(run)) Archive(path, run);
    }
    private void Archive(string path, HarnessRun run)
    {
        string target = ClosedPath(run.CampaignId, run.ActorId, run.Id);
        if (path == target) return;
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.Move(path, target); // atomic rename, never deletes receipts or overwrites an existing ID
    }
    private static HarnessRun? ReadFile(string path, string campaign, string actor, string id)
    {
        if (!File.Exists(path)) return null;
        try
        {
            if (new FileInfo(path).Length > 8 * 1024 * 1024) throw new InvalidDataException();
            using var json = JsonDocument.Parse(File.ReadAllBytes(path), new JsonDocumentOptions { MaxDepth = 32 });
            var run = HarnessJson.Read<HarnessRun>(json.RootElement);
            Validate(run, campaign, actor, id); return run;
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or GameException or ArgumentException or NullReferenceException)
        { throw HarnessJson.Conflict("harness_corrupt_run"); }
    }
    private static bool ValidMemoryIds(string[] ids) => ids.Length <= 256 &&
        ids.All(id => id is { Length: > 0 and <= 64 } && char.IsAsciiLetterOrDigit(id[0]) &&
            id.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-')) &&
        ids.Distinct(StringComparer.Ordinal).Count() == ids.Length;
    private static void ValidateCombatReturns(HarnessRun r)
    {
        if (r.CombatParentRunId is not null && (r.CombatSessionId is null || !Guid.TryParseExact(r.CombatParentRunId, "D", out _) || r.CombatParentRunId == r.Id) ||
            r.CombatFirstInput && (r.ToolContractVersion < 36 || r.CombatSessionId is null) ||
            r.CombatCommand is { } command && (r.ToolContractVersion < 51 || r.CombatSessionId is null || r.CombatFirstInput ||
                !command.Valid(r.Version) || r.TurnVersions is not { Count: > 0 } || command.Sequence != r.TurnVersions[0]) ||
            r.CombatReturns is not null && (r.ToolContractVersion < 36 || r.CombatSessionId is not null || r.CombatReturns.Count == 0))
            throw new InvalidDataException();
        var delegated = r.Steps.Where(s => s.Outcome?.DelegatedSessionId is not null).ToArray();
        var returned = r.CombatReturns ?? [];
        if (delegated.Select(s => s.Outcome!.DelegatedSessionId).Distinct().Count() != delegated.Length ||
            delegated.LastOrDefault()?.Outcome?.DelegatedSessionId != r.DelegatedSessionId ||
            returned.Count > delegated.Length || delegated.Length - returned.Count > 1 ||
            r.CombatReturnId != (returned.Count == delegated.Length ? returned.LastOrDefault()?.ReturnId : null) ||
            returned.Any(b => b is null) || returned.Select(b => b.ReturnId).Distinct().Count() != returned.Count)
            throw new InvalidDataException();
        HarnessCombatReturnReceipt? previous = null;
        for (int index = 0; index < returned.Count; index++)
        {
            var receipt = returned[index];
            if (receipt.SessionId != delegated[index].Outcome!.DelegatedSessionId || !Guid.TryParseExact(receipt.ReturnId, "D", out _) ||
                receipt.Turn <= (previous?.Turn ?? 0) || receipt.Turn >= r.Turns.Count || receipt.Turn > (previous?.Turn ?? 0) + 12 ||
                receipt.StepCount <= (previous?.StepCount ?? 0) || receipt.StepCount > r.Steps.Count || receipt.StepCount > (previous?.StepCount ?? 0) + 64 ||
                r.Steps[receipt.StepCount - 1] != delegated[index] ||
                receipt.ResumeCount < (previous?.ResumeCount ?? 0) || receipt.ResumeCount > r.Resumes.Count || receipt.ResumeCount > (previous?.ResumeCount ?? 0) + 16 ||
                receipt.ModelAttempts < (previous?.ModelAttempts ?? 0) || receipt.ModelAttempts > r.ModelAttempts ||
                receipt.ModelAttempts > (previous?.ModelAttempts ?? 0) + r.Limits.MaxModelCalls ||
                receipt.ModelAttempts < r.Steps.Take(receipt.StepCount).Count(s => s.Kind == "model") ||
                receipt.RuntimeMilliseconds < (previous?.RuntimeMilliseconds ?? 0) || receipt.RuntimeMilliseconds > r.RuntimeMilliseconds)
                throw new InvalidDataException();
            for (int stepIndex = 0; stepIndex < r.Steps.Count; stepIndex++)
            {
                var step = r.Steps[stepIndex];
                if (!int.TryParse(step.Id.Split(':')[0], out int turn) || (stepIndex < receipt.StepCount) != (turn < receipt.Turn) ||
                    stepIndex < receipt.StepCount && step.Status != "done") throw new InvalidDataException();
            }
            using var turnJson = JsonDocument.Parse(r.Turns[receipt.Turn]);
            var packet = turnJson.RootElement.GetProperty("combatReturn");
            if (packet.GetProperty("sessionId").GetString() != receipt.SessionId || packet.GetProperty("id").GetString() != receipt.ReturnId)
                throw new InvalidDataException();
            previous = receipt;
        }
    }

    private static void Validate(HarnessRun r, string campaign, string actor, string id)
    {
        if (r.SchemaVersion != 1 || r.RuntimeVersion != "pi-0.87.1/wire-1" || !Guid.TryParseExact(r.IntentId, "D", out _) || r.Id != id || r.CampaignId != campaign || r.ActorId != actor ||
            !HarnessTools.Supports(r.ToolContractVersion) || r.ContextReadVersion < 0 || r.ContextReadVersion > r.Version ||
            r.Opening && (r.ToolContractVersion < 38 || r.CombatSessionId is not null || r.Input != HarnessOpenings.Input) ||
            r.ToolContractVersion == 0 && r.ContextReadVersion != 0 ||
            r.RulesCatalogVersion is not null && (r.ToolContractVersion < 4 || !LocalRulesCatalog.Version(r.RulesCatalogVersion)) ||
            r.OfferedMemoryIds is not null && (r.ToolContractVersion < 3 || !ValidMemoryIds(r.OfferedMemoryIds)) ||
            r.Profile is null || r.Limits is null || r.Turns is null || r.Turns.Count < 1 || r.Turns.Where((_, index) => r.ToolContractVersion < 45 || r.CombatReturns?.Any(receipt => receipt.Turn == index) != true)
                .Any(t => t is null || t.Length > 32768) || r.Turns.Any(t => t is null) ||
            r.Steps is null || r.Steps.Any(s => s is null || s.Fingerprint?.Length != 64 ||
                !Guid.TryParseExact(s.CommandId, "D", out _) || s.Kind is not ("model" or "tool" or "final") ||
                s.Status is not ("started" or "done") || (s.Status == "done" && s.Result is null) ||
                s.ToolName is not null && (s.Kind != "tool" || !HarnessTools.ForVersion(r.ToolContractVersion).Any(t => t.Name == s.ToolName)) ||
                s.Outcome?.OfferedMemoryIds is { } memoryIds && (r.ToolContractVersion < 3 || s.Kind != "tool" || s.Status != "done" ||
                    s.ToolName is not ("context_read" or "world_search") || !ValidMemoryIds(memoryIds))) ||
            r.Steps.Select(s => s.Id).Distinct().Count() != r.Steps.Count || r.Resumes is null ||
            r.Resumes.Any(x => x is null || !Guid.TryParseExact(x.Id, "D", out _) || x.Fingerprint?.Length != 64) ||
            r.Resumes.Select(s => s.Id).Distinct().Count() != r.Resumes.Count || r.Fingerprint?.Length != 64 ||
            r.Status is not ("running" or "waiting" or "delegated" or "completed" or "cancelled" or "failed" or "unknown") ||
            r.Input is not { Length: > 0 and <= 1000 } || r.Text is null || r.Text.Length > 32768 || r.Error is null || r.Version < 1 ||
            r.ModelAttempts < 0 || r.Tokens < 0 || r.RuntimeMilliseconds < 0 || r.OfferedIds is null || r.OfferedIds.Length > 32 ||
            r.Limits.MaxModelCalls is < 1 or > 16 || r.Limits.MaxToolCalls is < 1 or > 32 || r.Limits.MaxContextBytes != 131072 ||
            r.Limits.MaxOutputCharacters != 8192 || r.Wait is not null && (r.Wait.Kind is not ("roll" or "intent" or "ruling" or "player") ||
                !Guid.TryParseExact(r.Wait.Id, "D", out _))) throw new InvalidDataException();
        ValidateCombatReturns(r);
        if (r.Turns.Count > HarnessGeneration.TurnLimit(r) || r.Steps.Count > HarnessGeneration.StepLimit(r) ||
            r.ModelAttempts > HarnessGeneration.ModelLimit(r) || r.Resumes.Count > HarnessGeneration.ResumeLimit(r) &&
                !(r.Resumes.Count == HarnessGeneration.ResumeLimit(r) + 1 && r.ToolContractVersion >= 23 && r.Status == "completed" &&
                    r.Steps.LastOrDefault()?.Outcome?.CompletedNarrative is not null)) throw new InvalidDataException();
        if (r.TurnVersions is { } versions && (r.ToolContractVersion < 36 || versions.Count != r.Turns.Count ||
            versions.Any(v => v < 1 || v > r.Version) || !versions.SequenceEqual(versions.Order()))) throw new InvalidDataException();
        foreach (string? reference in new[] { r.CombatSessionId, r.DelegatedSessionId, r.CombatReturnId })
            if (reference is not null && (r.ToolContractVersion < 36 || !Guid.TryParseExact(reference, "D", out _))) throw new InvalidDataException();
        if (r.CombatSessionId is not null && r.DelegatedSessionId is not null ||
            r.CombatReturnId is not null && r.DelegatedSessionId is null ||
            r.Status == "delegated" && (r.DelegatedSessionId is null || r.CombatReturnId is not null) ||
            (r.CombatSessionId is not null) != (r.CombatHistory is not null)) throw new InvalidDataException();
        if (r.CombatHistory is { } combatHistory) HarnessCombatHistories.Validate(combatHistory);
        foreach (var step in r.Steps)
        {
            if (step.Outcome?.DelegatedSessionId is { } delegated && (r.ToolContractVersion < 36 || step.Kind != "tool" ||
                step.ToolName != "combat_delegate" || step.Status != "done" || !step.Outcome.Reply.Stop || step.Outcome.Wait is not null ||
                step.Outcome.Reply.IsError || !Guid.TryParseExact(delegated, "D", out _))) throw new InvalidDataException();
            if (step.Outcome?.CompletedNarrative is { } accepted)
            {
                var outcome = step.Outcome;
                if (r.ToolContractVersion < 23 || step.Kind != "tool" || step.ToolName != (r.Opening ? "opening_commit" : "world_record") ||
                    step.Status != "done" || step.ToolRequest is null || step != r.Steps.Last() ||
                    outcome.Wait is not null || !outcome.Reply.Stop || outcome.Reply.IsError || outcome.Version != r.Version ||
                    accepted.Length > 4096 || !r.Opening && r.ToolContractVersion < 43 && accepted.Length == 0 || accepted != accepted.Trim() ||
                    HarnessJson.Fingerprint(step.Result!.Value) != HarnessJson.Fingerprint(HarnessJson.Element(outcome.Reply)))
                    throw new InvalidDataException();
                if (r.Opening)
                {
                    var args = HarnessJson.Read<OpeningNarrativeArgs>(step.ToolRequest.Arguments);
                    if (accepted != args.Public?.Trim() || (r.ToolContractVersion < 43 && args.Private is null) || args.Private is { Length: > 1024 }) throw new InvalidDataException();
                }
                else
                {
                    var args = HarnessJson.Read<NarrativeHarnessArgs>(step.ToolRequest.Arguments);
                    if (args.Complete == false || accepted != (r.ToolContractVersion >= 34 ? args.PublicText(r.ToolContractVersion) : args.Narrative.Trim())) throw new InvalidDataException();
                }
                if (r.Status == "completed" && r.Text != accepted) throw new InvalidDataException();
            }
            if (step.ToolRequest is { } request && (step.Kind == "model" || request.Arguments.ValueKind != JsonValueKind.Object ||
                (step.Kind == "final" ? request.Name != "narrative_commit" : request.Name != step.ToolName) ||
                step.Fingerprint != HarnessJson.Fingerprint(HarnessJson.Element(new { runId = r.Id, stepId = step.Id, step.Kind, Payload = request }))))
                throw new InvalidDataException();
            bool expectedFrame = r.ToolContractVersion >= HarnessExecutionProtocol.Version && step.Kind == "model";
            if (expectedFrame != (step.ExecutionFrame is not null)) throw new InvalidDataException();
            if (step.ExecutionFrame is not null)
            {
                HarnessExecutionProtocol.Validate(step.ExecutionFrame, r.Version, r.ToolContractVersion);
                if (step.ExecutionFrame.Agent?.SessionId != r.CombatSessionId || step.ExecutionFrame.Agent?.Command?.Source != r.CombatCommand ||
                    (step.ExecutionFrame.Opening?.Generating == true) != r.Opening) throw new InvalidDataException();
                if (step.ExecutionFrame.Self is { } self && self.ActorId != r.ActorId) throw new InvalidDataException();
                if (step.ExecutionFrame.DmChecklist is { } checklist &&
                    (checklist.Progress.IntentId != r.IntentId || checklist.Progress.ActorId != r.ActorId ||
                     step.ExecutionFrame.Context.Intent.Text != r.Input)) throw new InvalidDataException();
                if (r.ToolContractVersion >= 24 && step.ExecutionFrame.HasImportedSkills != (r.Profile.Skills.Length > 0)) throw new InvalidDataException();
            }
        }
        if (r.ToolContractVersion >= HarnessContextCompactor.HistoryToolVersion && r.Steps.Any(s => s.Kind == "model" && s.ContextPlan is null))
            throw new InvalidDataException();
        foreach (var step in r.Steps.Where(s => s.ContextPlan is not null))
        {
            if (r.ToolContractVersion < 5 || step.Kind != "model") throw new InvalidDataException();
            HarnessContextCompactor.Validate(step.ContextPlan!, maximumExchanges: HarnessGeneration.ModelLimit(r) + (r.CombatHistory?.Exchanges.Length ?? 0),
                combatHistory: r.CombatSessionId is not null, protectedHistory: r.ToolContractVersion >= HarnessContextCompactor.HistoryToolVersion);
            if (step.ContextPlan!.InputBudget is { } evidence && evidence.ProviderIdentity != step.ProviderIdentity)
                throw new InvalidDataException();
            if (step.ContextPlan.ReportedInputTokens is { } reported && (step.Status != "done" || step.Result is null ||
                HarnessJson.Read<HarnessModelReply>(step.Result.Value).InputTokens != reported))
                throw new InvalidDataException();
        }
        foreach (var step in r.Steps.Where(s => s.ProviderIdentity is not null))
            if (r.ToolContractVersion < 36 || step.Kind != "model" || step.ProviderIdentity is not { Length: 64 } identity ||
                !identity.All(char.IsAsciiHexDigit) || step.ProviderContinuation is { } continuation && continuation.Identity != identity)
                throw new InvalidDataException();
        foreach (var step in r.Steps.Where(s => s.ProviderContinuation is not null))
        {
            if (step.Kind != "model" || step.Status != "done") throw new InvalidDataException();
            step.ProviderContinuation!.Validate();
        }
        if (r.MemorySnapshot is not null)
        {
            HarnessMemories.Validate(r.MemorySnapshot);
            if (r.ToolContractVersion < 5 && r.MemorySnapshot.Archive is not null) throw new InvalidDataException();
            if (r.MemorySnapshot.ActorId != actor || r.MemorySnapshot.Version > r.Version ||
                r.Turns[0] != HarnessJson.Serialize(new { input = r.Input, ruleset = "dnd2024", memory = r.MemorySnapshot })) throw new InvalidDataException();
        }
        HarnessProfiles.Validate(r.Profile.Preset, r.Profile.Skills);
        if (r.Profile.Hash != HarnessJson.ProfileHash(r.Profile.Preset, r.Profile.Skills)) throw new InvalidDataException();
    }
}
