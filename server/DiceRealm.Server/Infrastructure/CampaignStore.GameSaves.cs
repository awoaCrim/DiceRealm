using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using Microsoft.Data.Sqlite;

namespace DiceRealm.Server.Infrastructure;

public sealed partial class CampaignStore
{
    internal GameSaveCatalog GameSaves { get; } = new(directory);

    // Caller already owns the authorized campaign gate. SQLite backup captures ALL tables,
    // including cold events/receipts/world entries, not the bounded aggregate projection.
    internal void CaptureGame(Campaign c, string destination)
    {
        GameSaveCatalog.CopyDatabase(DatabasePath(c.Id), destination);
        if (c.GameEnded)
        {
            using var db = OpenPath(destination); using var cmd = db.CreateCommand();
            cmd.CommandText = "UPDATE state SET json=json_set(json,'$.gameEnded',json('true')) WHERE id=1";
            cmd.ExecuteNonQuery();
        }
    }

    internal static T InspectGame<T>(string path, string campaignId, Func<Campaign, T> inspect)
    {
        using var db = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = path, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        db.Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = "PRAGMA user_version";
        int schema = Convert.ToInt32(cmd.ExecuteScalar());
        if (schema is not (1 or 2 or 3)) throw new GameException("unsupported_save", "不支持此存档版本；当前游戏未替换。", 409);
        cmd.CommandText = "SELECT json FROM state WHERE id=1";
        var c = Deserialize<Campaign>(cmd.ExecuteScalar() as string ?? throw new InvalidDataException("Missing game state."));
        if (c.Id != campaignId || c.SchemaVersion != 1 || c.Ruleset != "dnd2024") throw new InvalidDataException("Invalid game save identity.");
        if (schema >= 2)
        {
            if (c.WorldMemoryStorageVersion != 1 || c.WorldMemory.Count != 0) throw WorldMemoryIndex.Invalid();
            c.WorldMemoryIndex = new SqliteWorldMemory(db, c.Version);
        }
        else
        {
            if (c.WorldMemoryStorageVersion is not null) throw WorldMemoryIndex.Invalid();
            WorldMemoryIndex.ValidateLegacy(c.WorldMemory, c.Version);
        }
        PartyEngine.ValidateSeats(c);
        PrivateStories.ValidateState(c);
        AdventureOpenings.ValidateState(c);
        RuntimeEncounters.ValidateState(c);
        ValidateCombatSessions(c);
        SharedBoard.ValidateState(c);
        WorldRoutes.ValidateState(c);
        AdvancementEngine.ValidateState(c);
        StandardCombatEngine.ValidateState(c);
        AdvancementRestChoices.ValidateState(c);
        c.Events.Clear(); c.Receipts.Clear();
        cmd.CommandText = "SELECT json FROM events ORDER BY sequence DESC LIMIT 100";
        using (var rows = cmd.ExecuteReader()) while (rows.Read()) c.Events.Add(Deserialize<GameEvent>(rows.GetString(0)));
        c.Events.Reverse();
        if (c.Character is { } host) c.Character = StarterCharacter.Upgrade(host);
        foreach (var seat in c.PartyMembers) seat.Character = StarterCharacter.Upgrade(seat.Character);
        c.ElapsedSeconds = Math.Max(c.ElapsedSeconds, (long)c.ElapsedMinutes * 60);
        GameLifecycle.SynchronizeDeaths(c);
        CharacterEngine.Sync(c);
        return inspect(c);
    }

    internal static void PrepareGameRestore(Campaign current, string path, string timeline)
    {
        // Read/validate before touching the live database. Identity and current admission
        // permissions are copied from NOW, while game data belongs to the chosen save.
        InspectGame(path, current.Id, saved =>
        {
            using var db = OpenPath(path);
            using var query = db.CreateCommand(); query.CommandText = "SELECT json FROM state WHERE id=1";
            var state = JsonNode.Parse((string)query.ExecuteScalar()!)!.AsObject();
            state["tokenHash"] = current.TokenHash;
            state["ownerUserId"] = current.OwnerUserId;
            state["hostOnlySeat"] = current.HostOnlySeat;
            state["room"] = JsonSerializer.SerializeToNode(current.Room, JsonFiles.Options);
            state["invitations"] = JsonSerializer.SerializeToNode(current.Invitations, JsonFiles.Options);
            state["timelineId"] = timeline;
            var seats = current.PartyMembers.Select(member => new PartyMember
            {
                Id = member.Id, TokenHash = member.TokenHash, Revoked = member.Revoked, RoomJoin = member.RoomJoin,
                Character = saved.PartyMembers.FirstOrDefault(m => m.Id == member.Id)?.Character ?? InitialCharacter(member.Character),
                Review = saved.PartyMembers.FirstOrDefault(m => m.Id == member.Id)?.Review ?? member.Review,
                PendingAbilityCheck = saved.PartyMembers.FirstOrDefault(m => m.Id == member.Id)?.PendingAbilityCheck
            }).ToArray();
            state["partyMembers"] = JsonSerializer.SerializeToNode(seats, JsonFiles.Options);
            // A save cannot introduce a host character into a current DM-only connection.
            if (current.HostOnlySeat) { state["character"] = null; state["hostReview"] = null; }
            query.Parameters.AddWithValue("$json", state.ToJsonString(JsonFiles.Options));
            query.CommandText = "UPDATE state SET json=$json WHERE id=1";
            query.ExecuteNonQuery();
            return true;
        });
        InspectGame(path, current.Id, _ => true);
    }

    internal static Character InitialCharacter(Character character) =>
        // Existing legacy acquisitions are reconstructed via their original creation path;
        // this is not a new-character admission or a preset fallback for a missing build.
        CharacterEngine.Create(character.Name, character.TemplateId, character.Creation, character.Build) with { Id = character.Id };

    internal static void WriteRestart(string path, Campaign campaign)
    {
        using var db = OpenPath(path);
        using var tx = db.BeginTransaction();
        using var cmd = db.CreateCommand(); cmd.Transaction = tx;
        cmd.CommandText = "DELETE FROM events; DELETE FROM receipts;";
        cmd.ExecuteNonQuery();
        cmd.CommandText = "PRAGMA user_version";
        int schema = Convert.ToInt32(cmd.ExecuteScalar());
        bool indexed = schema >= 2;
        if (schema == 3)
        {
            cmd.CommandText = "DELETE FROM history_summaries; DELETE FROM history_work;"; cmd.ExecuteNonQuery();
        }
        if (indexed)
        {
            cmd.CommandText = "DELETE FROM world_terms; DELETE FROM world_entries;"; cmd.ExecuteNonQuery();
            SqliteWorldMemory.Write(db, tx, campaign.WorldMemory, campaign.Version);
            campaign.WorldMemoryStorageVersion = 1;
        }
        var state = JsonSerializer.SerializeToNode(campaign, JsonFiles.Options)!.AsObject();
        state.Remove("events"); state.Remove("receipts");
        if (indexed) state.Remove("worldMemory");
        cmd.CommandText = "UPDATE state SET json=$json WHERE id=1";
        cmd.Parameters.AddWithValue("$json", state.ToJsonString(JsonFiles.Options)); cmd.ExecuteNonQuery();
        foreach (var e in campaign.Events)
        {
            cmd.Parameters.Clear(); cmd.CommandText = "INSERT INTO events(sequence,json) VALUES($sequence,$json)";
            cmd.Parameters.AddWithValue("$sequence", e.Sequence);
            cmd.Parameters.AddWithValue("$json", JsonSerializer.Serialize(e, JsonFiles.Options)); cmd.ExecuteNonQuery();
        }
        tx.Commit();
        InspectGame(path, campaign.Id, _ => true);
    }
}
