using System.Globalization;
using System.Text.RegularExpressions;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    private static bool NeedsPlayerBoardIntent(Campaign c, BoardCommandRequest command)
    {
        if (command.Operation == "update") return false;
        IEnumerable<string> actors = command.Spawns is { } spawns
            ? spawns.Select(s => s.Source.Kind == "player" ? s.ActorId : s.ExistingId.Length > 0 ? SharedBoard.Find(c, s.ExistingId).ActorId : "")
            : command.EntityId.Length > 0 ? [SharedBoard.Find(c, command.EntityId).ActorId] : Array.Empty<string>();
        if (actors.Any(actor => actor.Length > 0 && actor != c.ActingActorId))
            throw new GameException("forbidden", "AI不能移动或摆放其他玩家的角色。", 403);
        return actors.Any(actor => actor.Length > 0);
    }

    // A small explicit placement vocabulary, not semantic consent inferred from prose.
    // It binds the original authenticated input to one exact own-character destination.
    // Other natural descriptions still use the existing precise proposal/clarification.
    private static bool DirectPlayerBoardIntent(Campaign c, string runId, string input, BoardCommandRequest command, int contract)
    {
        if (command.Operation is not ("move" or "spawn") || command.Snap || command.Path is { Length: > 0 } ||
            CombatEngine.Restricted(c) || SharedBoard.MovementRestricted(c.ActingCharacter.Conditions) ||
            ContextualRolls.View(c) is not null || ActionUnderstanding.Current(c) is not null ||
            c.PendingRulings.Any(r => r.ActorId == c.ActingActorId && r.Status is "pending" or "awaiting_roll")) return false;
        var prior = c.PendingIntents.FirstOrDefault(i => i.Id == runId);
        if (prior is not null && (prior.ActorId != c.ActingActorId || prior.Text != input ||
            prior.HarnessSteps?.Any(s => s.Result.Kind is "board.move" or "board.spawn" or "travel") == true)) return false;
        BoardPoint destination;
        if (command.Operation == "move")
        {
            var entity = SharedBoard.Find(c, command.EntityId);
            if (entity.ActorId != c.ActingActorId) return false;
            destination = command.Destination!;
        }
        else
        {
            if (command.Spawns is not { Length: 1 } batch) return false;
            var spawn = batch[0];
            if (spawn.Source.Kind != "player" || spawn.ActorId != c.ActingActorId) return false;
            destination = new(spawn.X, spawn.Y);
        }
        // v31 delegates ordinary movement semantics to the DM, as other in-scope actions do.
        // Identity, saved input, map version, restrictions and once-per-run placement remain
        // server-owned. This is not consent to dice, combat, resources or another actor.
        if (contract >= 31) return true;
        string verb = command.Operation == "move" ? "(?:移到|移动到)" : "(?:放到|放在|放置到|放置在)";
        string prefix = @"^(?:请)?(?:把|将)?我的棋子" + verb;
        string text = input.Trim();
        if (Regex.IsMatch(text, prefix + @"(?:地图)?(?:中央|中心)[。！!]?$", RegexOptions.CultureInvariant))
            return destination is { X: .5, Y: .5 };
        var match = Regex.Match(text, prefix + @"(?:地图)?(?:坐标)?[（(]?(?<x>0(?:\.\d+)?|1(?:\.0+)?)[,，]\s*(?<y>0(?:\.\d+)?|1(?:\.0+)?)[）)]?[。！!]?$", RegexOptions.CultureInvariant);
        return match.Success && double.TryParse(match.Groups["x"].Value, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out double x) &&
            double.TryParse(match.Groups["y"].Value, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out double y) &&
            Math.Abs(destination.X - x) < 1e-9 && Math.Abs(destination.Y - y) < 1e-9;
    }

    private (HarnessToolOutcome Outcome, Resolution? Resolution) ProposePlayerBoard(Campaign c, string runId, string input,
        BoardCommandRequest command, MapAssetView map)
    {
        SharedBoard.ValidateCommand(command);
        ContextualRolls.RequireNoPending(c);
        if (ActionUnderstanding.Current(c) is not null) throw HarnessJson.Conflict("harness_mechanical_wait");
        var (intent, root) = HarnessRoot(c, runId, input);
        string target = command.Destination is { } point ? $"{point.X:P1}, {point.Y:P1}" : command.Operation == "remove" ? "移出当前图" : "按本次提议摆放";
        var option = new ActionCandidate("board-placement", "棋盘位置 · " + target, "board",
            new(map.Title + " · " + target, "按原规则结算；普通探索只保存摆位", "本人的实际角色",
                "确认仅执行此处冻结的位置/路径；不会授予模型后续移动权限。直接拖动本人棋子无需此确认。"), BoardCommand: command);
        intent.Options = [option]; intent.Status = "pending";
        intent.Question = "AI提议改变本人棋盘位置，请核对具体目标；未确认前实际位置不变。";
        var resolution = new Resolution("awaiting_confirmation", "intent.request", intent.Question, null, [], IntentId: intent.Id);
        RecordIntent(c, intent, resolution, root ? "intent.request" : "intent.clarify");
        return (ToolOutcome(c, new { version = c.Version, resolution, pendingIntent = ActionUnderstanding.View(c),
            board = ProjectHarnessBoard(c, map, 38) }, WaitFor(resolution)), resolution);
    }

    private Resolution ExecuteConfirmedBoard(Campaign c, PendingIntent intent, BoardCommandRequest frozen, string requestId)
    {
        // The caller has checked this actor's saved intent/version and exact offered option ID.
        // The player cannot supply new coordinates, source IDs or a replacement map version.
        var map = BoardMap(c, frozen.MapId, publicOnly: true);
        if (!map.CurrentScene) throw new GameException("board_scene_mismatch", "当前场景已变化，请放弃旧位置提议。", 409);
        var (result, combatResult) = ExecuteBoardCommand(c, map, frozen with { RequestId = requestId, ExpectedVersion = c.Version }, narrator: true,
            namingVersion: intent.NpcNamingVersion);
        var resolution = combatResult is not null ? combatResult with { IntentId = intent.Id } : new Resolution(
            result.Status == "pending" ? "needs_adjudication" : "resolved", "board." + frozen.Operation, result.Notice, null, [], result.RulingId, IntentId: intent.Id);
        RecordIntent(c, intent, resolution, resolution.Kind);
        ActionUnderstanding.Complete(c, resolution, IntentOrigin(c, intent));
        return resolution;
    }
}
