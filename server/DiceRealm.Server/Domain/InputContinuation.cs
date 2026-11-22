using System.Globalization;

namespace DiceRealm.Server.Domain;

// Only the small consent vocabulary is deterministic. Ordinary language goes to the
// configured interpreter, which still cannot invent an executable command.
public static class InputContinuation
{
    public static bool Cancel(string text) => text.Trim().ToLowerInvariant() is "取消" or "放弃" or "取消这次行动" or "cancel";
    public static bool Confirm(string text) => text.Trim().ToLowerInvariant() is "确认" or "确认行动" or "执行" or "好" or "好的" or "confirm" or "yes";
    public static bool Roll(string text) => text.Trim().ToLowerInvariant() is "投掷" or "掷骰" or "确认投掷" or "确认掷骰" or "roll";
    public static bool Refer(string text) => text.Trim().ToLowerInvariant() is "交给dm" or "交给 dm" or "请求dm裁定" or "请求 dm 裁定";
    public static string? Resubmission(string text)
    {
        foreach (string prefix in new[] { "重新提交审核：", "重新提交审核:", "重新提交审核 " })
            if (text.StartsWith(prefix, StringComparison.Ordinal)) return text[prefix.Length..].Trim();
        return null;
    }
    public static string? Choose(PendingIntent intent, string text)
    {
        if (Confirm(text))
        {
            if (intent.Options.Length != 1) throw new GameException("input_choice_required", "当前不止一个选项，请输入选项编号或完整名称；不会替你选第一项。");
            return intent.Options[0].Id;
        }
        var exact = intent.Options.Where(o => o.Label.Equals(text.Trim(), StringComparison.OrdinalIgnoreCase)).ToArray();
        if (exact.Length == 1) return exact[0].Id;
        string number = text.Trim();
        if (number.StartsWith("选择", StringComparison.Ordinal)) number = number[2..].Trim();
        if (int.TryParse(number, NumberStyles.None, CultureInfo.InvariantCulture, out int index))
        {
            if (index < 1 || index > intent.Options.Length) throw new GameException("input_choice_required", "请输入当前列出的选项编号。");
            return intent.Options[index - 1].Id;
        }
        return null;
    }
    public static bool CanExecuteDirectly(Campaign c, ActionCandidate option)
    {
        if (option.Character?.Operation == "wear") return true; // Ordinary physical wearing has no paid cost or dice.
        if (option.Action is not { } action) return false; // Source-specific character commands first disclose their exact cost.
        if (ContextualRolls.Describe(c, action) is not null) return true; // Still waits for explicit dice consent.
        if (StandardCombatEngine.IsUnpaidMissilePlan(c, action)) return true; // Only edits an uncast plan; final cast still requires own roll consent.
        if (action.Kind is "observe" or "travel") return true;
        var authored = ContentRuntime.FindAction(c, action.Kind, action.Target);
        return authored is not null && !authored.Always.Concat(authored.Success.Effects).Concat(authored.Failure.Effects)
            .Any(e => e.Op == "item" && e.Amount < 0);
    }
}
