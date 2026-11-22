using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using DiceRealm.Server.Application;

namespace DiceRealm.Server.Infrastructure;

// Presentation at the provider boundary only. Saved JSON, callback/profile hashes and signed
// native parts retain their original values. This is not a general backslash-unescape pass.
internal static class HarnessProviderJson
{
    public static string Serialize<T>(T value)
    {
        var element = HarnessJson.Element(value);
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
            Write(writer, element);
        return Encoding.UTF8.GetString(stream.ToArray());
    }
    private static void Write(Utf8JsonWriter writer, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in value.EnumerateObject()) { writer.WritePropertyName(property.Name); Write(writer, property.Value); }
                writer.WriteEndObject(); break;
            case JsonValueKind.Array:
                writer.WriteStartArray(); foreach (var child in value.EnumerateArray()) Write(writer, child); writer.WriteEndArray(); break;
            case JsonValueKind.String: writer.WriteStringValue(value.GetString()); break;
            default: value.WriteTo(writer); break;
        }
    }
    public static string Message(HarnessChatMessage message, bool initialTurn = false)
    {
        if (message.Role is not ("user" or "tool") || message.Role == "user" && !initialTurn) return message.Content;
        try
        {
            using var doc = JsonDocument.Parse(message.Content, new JsonDocumentOptions { MaxDepth = 32 });
            var root = doc.RootElement;
            // User prose (including deliberately typed JSON/escape sequences) stays exact.
            // Only the server-owned initial turn envelope has these three fields.
            if (message.Role == "user" && (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 3 ||
                !root.TryGetProperty("input", out var input) || input.ValueKind != JsonValueKind.String ||
                !root.TryGetProperty("ruleset", out var rules) || rules.ValueKind != JsonValueKind.String || rules.GetString() != "dnd2024" ||
                !root.TryGetProperty("memory", out _))) return message.Content;
            HarnessJson.Validate(root);
            return Serialize(root);
        }
        catch (JsonException) { return message.Content; }
    }
    private const int MaximumImageBytes = 2 * 1024 * 1024;
    // At most two independently padded base64 strings for the shared decoded-byte budget.
    private const int MaximumImageBase64Bytes = (MaximumImageBytes + 2) / 3 * 4 + 4;
    public static int ImageBase64Bytes(HarnessChatMessage[] messages)
    {
        if (messages is null) throw ImageContract();
        int imageCount = 0, decodedBytes = 0, base64Bytes = 0;
        foreach (var message in messages)
        {
            if (message is null || message.Images is null) throw ImageContract();
            if (message.Images.Length == 0) continue;
            if (message.Role != "user" || message.Images.Length > 2 || (imageCount += message.Images.Length) > 2)
                throw ImageContract();
            foreach (var image in message.Images)
            {
                if (image is null || image.MediaType is not ("image/png" or "image/jpeg") ||
                    string.IsNullOrEmpty(image.Base64) || image.Base64.Length % 4 != 0 ||
                    image.Base64.Length > (MaximumImageBytes + 2) / 3 * 4 ||
                    image.Base64.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('+' or '/' or '=')))
                    throw ImageContract();
                var bytes = new byte[image.Base64.Length / 4 * 3];
                if (!Convert.TryFromBase64String(image.Base64, bytes, out int length) ||
                    length > MaximumImageBytes - decodedBytes || !ImageSignature(bytes.AsSpan(0, length), image.MediaType))
                    throw ImageContract();
                decodedBytes += length;
                base64Bytes += image.Base64.Length;
            }
        }
        return base64Bytes;
    }
    private static bool ImageSignature(ReadOnlySpan<byte> bytes, string mediaType) => mediaType == "image/png"
        ? bytes.Length >= 57 && bytes[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) &&
            bytes.Slice(8, 8).SequenceEqual(new byte[] { 0, 0, 0, 13, 73, 72, 68, 82 }) &&
            bytes[^12..].SequenceEqual(new byte[] { 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130 })
        : bytes.Length > 4 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff &&
            bytes[^2] == 0xff && bytes[^1] == 0xd9;
    private static HarnessModelNotSentException ImageContract() => new(HarnessModelRejection.Contract);
    public static void Bound(string body, int imageBase64Bytes = 0, string? contextPolicy = null)
    {
        if (imageBase64Bytes is < 0 or > MaximumImageBase64Bytes) throw ImageContract();
        if (contextPolicy == HarnessContextCompactor.HistoryPolicy)
        {
            // This is an actual wire-size limit, not a token estimate or a reduction target.
            // Signed Parts and accepted tool results either all fit or nothing is sent.
            if (Encoding.UTF8.GetByteCount(body) > HarnessContextCompactor.MaximumPreparedBytes + MaximumImageBase64Bytes)
                throw new HarnessModelNotSentException(HarnessModelRejection.TransportLimit);
            return;
        }
        // Only the validated, unescaped base64 payload has a separate budget. System, tools,
        // all text and image-envelope overhead still share the original 128 KiB body limit.
        if (Encoding.UTF8.GetByteCount(body) - imageBase64Bytes > 131072)
            throw new HarnessModelNotSentException(HarnessModelRejection.ContextLimit);
    }
}
