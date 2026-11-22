using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

public sealed partial class HarnessRunStore
{
    private sealed record IssuedSlot(string Id, string Fingerprint);
    private sealed record IssuedRun(int SchemaVersion, string Fingerprint, IssuedSlot[] Slots);
    private string IssuedPath(string campaign, string actor, string run) => Path.Combine(directory.Root, "harness-issued",
        JsonFiles.CampaignId(campaign), JsonFiles.Hash(actor), JsonFiles.CampaignId(run) + ".json");
    private IssuedRun? ReadIssued(HarnessRun run) => ReadIssued(run.CampaignId, run.ActorId, run.Id, run.Fingerprint);
    private IssuedRun? ReadIssued(string campaign, string actor, string run, string fingerprint)
    {
        string path = IssuedPath(campaign, actor, run);
        if (!File.Exists(path)) return null;
        var issued = JsonFiles.Read<IssuedRun>(path);
        if (issued.SchemaVersion != 1 || issued.Fingerprint != fingerprint || issued.Slots is null ||
            issued.Slots.Any(s => s is null || string.IsNullOrEmpty(s.Id) || !AssetCatalog.IsHash(s.Fingerprint)) ||
            issued.Slots.Select(s => s.Id).Distinct().Count() != issued.Slots.Length) throw HarnessJson.Conflict("harness_corrupt_run");
        return issued;
    }
    // A small non-rewinding record of issued slots. It contains no prompts or model bodies.
    // Persist it before the run's started marker can authorize any supplier request.
    private void RecordIssued(HarnessRun run)
    {
        var models = run.Steps.Where(s => s.Kind == "model").ToArray();
        if (models.Length == 0) return;
        var issued = ReadIssued(run);
        var slots = (issued?.Slots ?? []).ToList();
        bool changed = false;
        foreach (var step in models)
        {
            var prior = slots.FirstOrDefault(s => s.Id == step.Id);
            if (prior is not null)
            {
                if (prior.Fingerprint != step.Fingerprint) throw HarnessJson.Conflict("harness_model_unknown");
                continue;
            }
            slots.Add(new(step.Id, step.Fingerprint)); changed = true;
        }
        if (changed) JsonFiles.Write(IssuedPath(run.CampaignId, run.ActorId, run.Id), new IssuedRun(1, run.Fingerprint, slots.ToArray()));
    }
    internal void RequireNewModel(HarnessRun run, string slotId)
    {
        lock (gate)
            if (ReadIssued(run)?.Slots.Any(s => s.Id == slotId) == true)
                throw HarnessJson.Conflict("harness_model_unknown");
    }
    internal bool HasIssuedCombatInput(string campaign, CombatAgentInput input)
    {
        lock (gate) return ReadIssued(campaign, input.ActorId, input.RunId, input.Fingerprint) is not null;
    }
    // Only the coordinator may reconstruct a saved first-input/command identity. The
    // future journal is gone after restore; its issued record is never permission to resend.
    internal bool TryRestoreIssuedCombatInput(HarnessRun run, CombatAgentSession session)
    {
        lock (gate)
        {
            var input = session.Inputs.SingleOrDefault(i => i.RunId == run.Id && i.ActorId == run.ActorId);
            if (input is null || run.CombatSessionId != session.Id ||
                (run.CombatFirstInput ? input != session.Inputs[0] || input.ActorId != session.ParentActorId : input.Command is null) ||
                run.CombatParentRunId != (input.ActorId == session.ParentActorId ? session.ParentRunId : null) ||
                run.CombatCommand != input.Command || run.IntentId != input.IntentId || run.Fingerprint != input.Fingerprint ||
                run.Input != input.Input || run.Version != input.AcceptedVersion || run.Profile.Hash != session.Profile.Hash ||
                run.ToolContractVersion != (input.ToolContractVersion ?? session.ToolContractVersion) || run.RulesCatalogVersion != session.RulesCatalogVersion ||
                run.Status is not ("running" or "cancelled") || run.CancelRequested != (run.Status == "cancelled") ||
                run.Steps.Count != 0 || run.Resumes.Count != 0 || run.Turns.Count != 1 || run.Wait is not null ||
                run.Text.Length != 0 || run.ModelAttempts != 0 || run.Tokens != 0 || run.RuntimeMilliseconds != 0)
                throw HarnessJson.Conflict("harness_run_conflict");
            if (ReadIssued(run) is null) return false;
            string path = ExistingPath(run.CampaignId, run.ActorId, run.Id);
            if (File.Exists(path)) throw HarnessJson.Conflict("harness_run_conflict");
            run.Status = run.CancelRequested ? "cancelled" : "unknown";
            run.Error = "harness_model_unknown";
            Write(path, run); // no model steps/results: RecordIssued leaves the ledger intact
            history.Add(run);
            return true;
        }
    }
    private IEnumerable<(string Path, HarnessRun Run)> CampaignFiles(string campaign, string? folder = null)
    {
        string root = folder ?? Path.Combine(directory.Root, "harness", JsonFiles.CampaignId(campaign));
        if (!Directory.Exists(root)) yield break;
        foreach (string file in Directory.EnumerateFiles(root, "*.json", SearchOption.AllDirectories))
        {
            var run = JsonFiles.Read<HarnessRun>(file);
            Validate(run, campaign, run.ActorId, Path.GetFileNameWithoutExtension(file));
            if (run.TimelineId is not null && !Guid.TryParseExact(run.TimelineId, "D", out _)) throw HarnessJson.Conflict("harness_corrupt_run");
            string seat = Path.GetRelativePath(root, file).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)[0];
            if (seat != JsonFiles.Hash(run.ActorId)) throw HarnessJson.Conflict("harness_corrupt_run");
            yield return (file, run);
        }
    }
    internal void CaptureIssued(string campaign)
    {
        lock (gate)
            foreach (var (_, run) in CampaignFiles(campaign)) RecordIssued(run);
    }
    internal void PrepareGameRestore(string campaign, string folder, string timeline)
    {
        lock (gate)
            foreach (var (path, run) in CampaignFiles(campaign, folder).ToArray())
            {
                // A future branch may already have emitted additional model slots. Do not
                // replay their replies in the older world or send the same slots again.
                // Preserve the old wait and all original saved outputs for reading/cancel.
                var issued = ReadIssued(run);
                bool laterIssued = issued?.Slots.Any(s => !run.Steps.Any(step => step.Kind == "model" && step.Id == s.Id && step.Fingerprint == s.Fingerprint)) == true;
                if (laterIssued && run.Status is "running" or "waiting" or "delegated")
                { run.Status = "unknown"; run.Error = "harness_model_unknown"; }
                run.TimelineId = timeline;
                Validate(run, campaign, run.ActorId, run.Id);
                JsonFiles.Write(path, run);
            }
    }
    internal void ReindexCampaign(string campaign)
    {
        lock (gate)
        {
            history.ForgetCampaign(campaign);
            unindexedSeats.RemoveWhere(seat => seat.StartsWith(campaign + "/", StringComparison.Ordinal));
            foreach (var (_, run) in CampaignFiles(campaign)) history.Add(run);
        }
    }
}
