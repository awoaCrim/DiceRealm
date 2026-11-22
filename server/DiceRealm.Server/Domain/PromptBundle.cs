namespace DiceRealm.Server.Domain;

// An imported, user-authored prompt bundle. Intent and Narration hold the EXACT system text the
// scenario author supplies; the server stores it as inert data and never generates, rewrites,
// supplements, or falls back to built-in prompt content. Nothing in this type is ever loaded from
// or resolved against an external URL, path, or executable: bundle fields are plain text only and
// no code path fetches anything based on their content.
// Scene image prompts and visual constraints belong to the imported adventure document.
public sealed record PromptBundle(
    int FormatVersion, string Id, string Version, string Name,
    string Intent, string Narration);

public static class PromptBundles
{
    public const int CurrentFormatVersion = 1;
    public const int MaximumTextCharacters = 32 * 1024; // per authored prompt field
    public const int MaximumIdCharacters = 64;
    public const int MaximumVersionCharacters = 32;
    public const int MaximumNameCharacters = 120;

    // Throws ArgumentException on the first violation; performs no normalization and no I/O.
    public static void Validate(PromptBundle? bundle)
    {
        if (bundle is null) throw new ArgumentException("A prompt bundle is required.", nameof(bundle));
        if (bundle.FormatVersion != CurrentFormatVersion)
            throw new ArgumentException($"Unsupported prompt bundle format version {bundle.FormatVersion}; expected {CurrentFormatVersion}.", nameof(bundle.FormatVersion));
        ValidateToken(bundle.Id, "id", MaximumIdCharacters);
        ValidateToken(bundle.Version, "version", MaximumVersionCharacters);
        ValidateName(bundle.Name);
        ValidatePromptText(bundle.Intent, "intent");
        ValidatePromptText(bundle.Narration, "narration");
    }

    // Identifiers/versions: bounded ASCII tokens, no whitespace or punctuation surprises.
    private static void ValidateToken(string value, string field, int maximum)
    {
        if (string.IsNullOrEmpty(value) || value.Length > maximum ||
            !value.All(c => c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '.' or '_' or '-'))
            throw new ArgumentException($"Prompt bundle {field} must be 1-{maximum} characters of [A-Za-z0-9._-].", field);
    }

    private static void ValidateName(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > MaximumNameCharacters ||
            value != value.Trim() || value.Any(char.IsControl))
            throw new ArgumentException($"Prompt bundle name must be non-empty, at most {MaximumNameCharacters} characters, with no control or surrounding whitespace.", "name");
    }

    // Authored prompt text is taken verbatim; validation only bounds it and rejects control
    // characters other than CR/LF and tab; ordinary Windows text remains byte-for-byte intact.
    private static void ValidatePromptText(string value, string field)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new ArgumentException($"Prompt bundle {field} is required and cannot be blank.", field);
        if (value.Length > MaximumTextCharacters)
            throw new ArgumentException($"Prompt bundle {field} exceeds the {MaximumTextCharacters} character limit.", field);
        if (value.Any(c => char.IsControl(c) && c != '\r' && c != '\n' && c != '\t'))
            throw new ArgumentException($"Prompt bundle {field} contains control characters other than newline or tab.", field);
    }
}
