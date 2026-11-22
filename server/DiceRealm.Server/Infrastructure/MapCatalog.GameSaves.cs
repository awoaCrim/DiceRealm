using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

public sealed partial class MapCatalog
{
    // Lock order: Harness scheduling -> campaign -> map catalog. No await/network while
    // holding the catalog gate. Claim/Complete/Fail all use this same gate.
    internal T WithGameSaveLock<T>(Func<T> operation) { lock (gate) return operation(); }

    internal void RequireGenerationLease(MapGenerationJob job)
    {
        lock (gate)
            if (GameSaveCatalog.IsRestoring(dataRoot, job.CampaignId) || !File.Exists(PathFor(job.CampaignId, job.Id)) || !Owns(Read(job.CampaignId, job.Id), job))
                throw new ImageGenerationException("map_generation_superseded", false);
    }

    internal void PrepareGameRestore(string campaign, string folder)
    {
        lock (gate)
        {
            if (!Directory.Exists(folder)) return;
            foreach (string file in Directory.EnumerateFiles(folder, "*.json"))
            {
                var map = LoadSaved(file);
                if (map.CampaignId != campaign || Path.GetFileNameWithoutExtension(file) != map.Id)
                    throw GameSaveCatalog.Corrupt();
                // Never resurrect a saved worker lease or auto-send a queued request that
                // could already have been billed in the abandoned branch. A new explicit
                // generation confirmation is required; ready immutable artwork is reused.
                if (map.Status is "generating" or "pending")
                    map = map with { Status = "failed", LeaseId = "", RetryAfter = null, Error = "map_generation_restored_unknown" };
                JsonFiles.Write(file, map);
            }
        }
    }
}
