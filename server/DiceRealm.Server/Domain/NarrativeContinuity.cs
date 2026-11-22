namespace DiceRealm.Server.Domain;

// Model-reported narrative notes, not verified world facts, rule results or permission to act.
// A statement/promise describes what was said or intended; it does not establish fulfillment.
public sealed record NarrativeContinuityEntry(string Kind, string Text);

public static class NarrativeContinuities
{
    public const int MaximumEntries = 8;
    public const int MaximumTextLength = 240;
    // Two full batches retain intermediate and final notes without growing a second transcript.
    // Additional batches discard the oldest notes; the original narrative/receipts are unchanged.
    public const int MaximumStoredEntries = 16;

    public static void Validate(NarrativeContinuityEntry[]? entries) => Validate(entries, MaximumEntries);

    internal static void ValidateStored(NarrativeContinuityEntry[]? entries) => Validate(entries, MaximumStoredEntries);

    private static void Validate(NarrativeContinuityEntry[]? entries, int maximum)
    {
        // Missing/null means no model notes, including all pre-v23 records.
        if (entries is null) return;
        if (entries.Length > maximum || entries.Any(entry => entry is null ||
            entry.Kind is not ("observation" or "statement" or "promise" or "relationship" or "open_question") ||
            string.IsNullOrWhiteSpace(entry.Text) || entry.Text.Length > MaximumTextLength ||
            entry.Text.Any(ch => char.IsControl(ch) && ch is not ('\n' or '\r' or '\t'))))
            throw new GameException("invalid_narrative_continuity", "叙事连续性条目的数量、类型或正文不符合限制。");
    }

    public static NarrativeContinuityEntry[] Merge(NarrativeContinuityEntry[]? existing, NarrativeContinuityEntry[]? proposed)
    {
        ValidateStored(existing);
        Validate(proposed);
        // Exact duplicates do not displace other intermediate notes. Do not infer equivalence,
        // fulfillment, factual truth or relationships from free text, and do not rewrite it.
        return (existing ?? []).Concat(proposed ?? []).Distinct().TakeLast(MaximumStoredEntries).ToArray();
    }
}
