using System.Buffers.Binary;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

public sealed class ImageGenerationException(string code, bool retryable) : Exception(code)
{
    public string Code { get; } = code;
    public bool Retryable { get; } = retryable;
}

public sealed class OpenAiImages(HttpClient http, IConfiguration configuration, SceneReferences references, ProviderBudget budget) : IMapImageGenerator
{
    private readonly string endpoint = configuration["ImageAi:Endpoint"] ?? "https://api.openai.com/v1/images/generations";
    private readonly string editsEndpoint = configuration["ImageAi:EditsEndpoint"] ?? "";
    private readonly string key = configuration["ImageAi:ApiKey"] ?? "";
    private readonly string model = configuration["ImageAi:Model"] ?? "";
    private readonly bool allowReferences = configuration.GetValue<bool>("ImageAi:AllowReferenceUpload");
    private readonly bool sendResponseFormat = configuration.GetValue("ImageAi:SendResponseFormat", true);
    public bool Enabled => !string.IsNullOrWhiteSpace(key) && !string.IsNullOrWhiteSpace(model);
    // Map size is supplied per request and is part of the map cache key. No scene jobs use this adapter.
    public string CacheIdentity => Identity(endpoint, editsEndpoint, model, sendResponseFormat);
    internal static string Identity(string endpoint, string editsEndpoint, string model, bool sendResponseFormat) =>
        "openai-compatible-map-png-v1:" + JsonFiles.Hash(endpoint + ":" + editsEndpoint + ":" + model + ":" + sendResponseFormat);

    public Task<byte[]> Generate(MapGenerationJob map, CancellationToken cancellationToken)
    {
        MapCatalog.Validate(map.Specification);
        return Generate(map.CampaignId, map.Specification.Prompt, map.Specification.Width, map.Specification.Height,
            map.Specification.ReferenceImages, true, cancellationToken, map.BeforeProviderRequest);
    }

    public Task<byte[]> Generate(ImageGenerationRequest image, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(image.Prompt) || image.Prompt.Length > 16000 ||
            image.Prompt.Any(c => char.IsControl(c) && c is not ('\r' or '\n' or '\t')) ||
            image.Width is < 256 or > 4096 || image.Height is < 256 or > 4096 || image.Width % 64 != 0 || image.Height % 64 != 0)
            throw new ImageGenerationException("image_request_invalid", false);
        return Generate(image.CampaignId, image.Prompt, image.Width, image.Height, [], false, cancellationToken);
    }

    private async Task<byte[]> Generate(string campaignId, string prompt, int width, int height, string[] referenceImages,
        bool mapImage, CancellationToken cancellationToken, Action? beforeProviderRequest = null)
    {
        if (!Enabled) throw new ImageGenerationException("image_provider_disabled", false);
        var editing = referenceImages.Length > 0;
        if (editing && !allowReferences) throw new ImageGenerationException("reference_upload_disabled", false);
        if (editing && string.IsNullOrWhiteSpace(editsEndpoint)) throw new ImageGenerationException("image_edits_not_configured", false);
        var target = editing ? editsEndpoint : endpoint;
        if (!Uri.TryCreate(target, UriKind.Absolute, out var uri) || !string.IsNullOrEmpty(uri.UserInfo) ||
            (uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback)))
            throw new ImageGenerationException("image_endpoint_invalid", false);
        // Map callers still pass the user's exact prompt; portraits pass only their visual
        // whitelist. Request purpose never adds instructions to an existing map prompt.
        var size = width + "x" + height;
        using var request = new HttpRequestMessage(HttpMethod.Post, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        if (editing)
        {
            var form = new MultipartFormDataContent();
            request.Content = form;
            form.Add(new StringContent(model), "model");
            form.Add(new StringContent(prompt), "prompt");
            form.Add(new StringContent("1"), "n");
            form.Add(new StringContent(size), "size");
            if (sendResponseFormat) form.Add(new StringContent("b64_json"), "response_format");
            foreach (var hash in referenceImages)
            {
                var image = new ByteArrayContent(references.Read(campaignId, hash));
                image.Headers.ContentType = new MediaTypeHeaderValue("image/png");
                form.Add(image, referenceImages.Length == 1 ? "image" : "image[]", hash + ".png");
            }
        }
        else
        {
            var body = new Dictionary<string, object> { ["model"] = model, ["n"] = 1, ["size"] = size, ["prompt"] = prompt };
            if (sendResponseFormat) body["response_format"] = "b64_json";
            request.Content = JsonContent.Create(body);
        }
        cancellationToken.ThrowIfCancellationRequested();
        beforeProviderRequest?.Invoke();
        budget.Reserve("image", campaignId);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            int code = (int)response.StatusCode;
            throw new ImageGenerationException(code == 429 ? "image_rate_limited" : "image_provider_rejected", code is 408 or 429 || code >= 500);
        }
        var bytes = await BoundedHttp.Read(response.Content, 48 * 1024 * 1024, cancellationToken);
        using var json = JsonDocument.Parse(bytes);
        if (!json.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array || data.GetArrayLength() != 1 ||
            !data[0].TryGetProperty("b64_json", out var encoded) || encoded.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("Expected one base64 PNG.");
        // No provider-controlled URL fetches (SSRF, redirect credentials and expiring hotlinks).
        byte[] png;
        try { png = Convert.FromBase64String(encoded.GetString()!); }
        catch (FormatException) { throw new InvalidDataException("Expected base64 PNG."); }
        if (mapImage) PngGuard.ValidateMap(png);
        else PngGuard.Validate(png);
        return png;
    }
}

public static class PngGuard
{
    // PNG CRC-32, with the same polynomial and checks as the bitwise algorithm.
    // Full-resolution imported atlases make eight branches per byte too expensive.
    private static readonly uint[] CrcTable = BuildCrcTable();
    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (uint i = 0; i < table.Length; i++)
        {
            uint value = i;
            for (int bit = 0; bit < 8; bit++) value = (value >> 1) ^ ((value & 1) != 0 ? 0xedb88320u : 0u);
            table[i] = value;
        }
        return table;
    }

    public const int MaximumBytes = 10 * 1024 * 1024;
    public const int MaximumMapBytes = 32 * 1024 * 1024;
    public static (int width, int height) Dimensions(byte[] bytes) =>
        ((int)BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(16, 4)), (int)BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(20, 4)));
    public static void Validate(byte[] bytes) => Validate(bytes, MaximumBytes, 4096, 16777216);
    public static void ValidateMap(byte[] bytes) => Validate(bytes, MaximumMapBytes, 8192, 33554432);
    private static void Validate(byte[] bytes, int maximumBytes, int maximumDimension, long maximumPixels)
    {
        byte[] signature = [137, 80, 78, 71, 13, 10, 26, 10];
        if (bytes.Length < 57 || bytes.Length > maximumBytes || !bytes.AsSpan(0, 8).SequenceEqual(signature))
            throw new InvalidDataException("Expected bounded PNG.");
        bool header = false, data = false;
        int offset = 8;
        while (offset <= bytes.Length - 12)
        {
            uint length = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(offset, 4));
            if (length > (uint)(bytes.Length - offset - 12)) throw new InvalidDataException("Truncated PNG chunk.");
            var type = bytes.AsSpan(offset + 4, 4);
            var content = bytes.AsSpan(offset + 8, (int)length);
            uint crc = 0xffffffff;
            foreach (byte value in bytes.AsSpan(offset + 4, (int)length + 4))
                crc = (crc >> 8) ^ CrcTable[(crc ^ value) & 0xff];
            if (~crc != BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(offset + 8 + (int)length, 4)))
                throw new InvalidDataException("PNG checksum mismatch.");
            if (type.SequenceEqual("IHDR"u8))
            {
                if (header || offset != 8 || length != 13) throw new InvalidDataException("Invalid PNG header.");
                header = true;
                uint width = BinaryPrimitives.ReadUInt32BigEndian(content[..4]);
                uint height = BinaryPrimitives.ReadUInt32BigEndian(content.Slice(4, 4));
                bool depthValid = content[9] switch
                { 0 => content[8] is 1 or 2 or 4 or 8 or 16, 2 or 4 or 6 => content[8] is 8 or 16, 3 => content[8] is 1 or 2 or 4 or 8, _ => false };
                if (width < 1 || width > maximumDimension || height < 1 || height > maximumDimension || (long)width * height > maximumPixels || !depthValid || content[10] != 0 || content[11] != 0 || content[12] > 1)
                    throw new InvalidDataException("Invalid PNG dimensions or format.");
            }
            else if (!header) throw new InvalidDataException("PNG needs an IHDR first.");
            if (type.SequenceEqual("IDAT"u8) && length > 0) data = true;
            offset += (int)length + 12;
            if (type.SequenceEqual("IEND"u8))
            {
                if (!data || length != 0 || offset != bytes.Length) throw new InvalidDataException("Invalid PNG end.");
                return;
            }
        }
        throw new InvalidDataException("Incomplete PNG.");
    }
}

public sealed class MapWorker(MapCatalog catalog, IMapImageGenerator generator, ILogger<MapWorker> logger, IConfiguration configuration)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var asset = catalog.Claim();
                if (asset is null) { await Task.Delay(500, stoppingToken); continue; }
                if (!generator.Enabled) { catalog.Fail(asset, "image_provider_disabled", false); continue; }
                asset = asset with { BeforeProviderRequest = () => catalog.RequireGenerationLease(asset) };
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                    timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue("ImageAi:TimeoutSeconds", 180), 15, 300)));
                    catalog.RequireGenerationLease(asset);
                    var png = await generator.Generate(asset, timeout.Token);
                    catalog.Complete(asset, png);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
                catch (OperationCanceledException) { catalog.Fail(asset, "image_generation_unconfirmed", false); }
                catch (ProviderQuotaException) { catalog.Fail(asset, "image_quota_exceeded", false); }
                catch (ImageGenerationException ex) { catalog.Fail(asset, ex.Code, ex.Retryable); }
                catch (GameException) { catalog.Fail(asset, "reference_unavailable", false); }
                catch (Exception ex)
                {
                    logger.LogWarning("Map image failed ({ErrorType}), job {JobId}", ex.GetType().Name, asset.Id);
                    catalog.Fail(asset, "image_generation_failed", false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                logger.LogError("Map queue iteration failed ({ErrorType})", ex.GetType().Name);
                await Task.Delay(1000, stoppingToken);
            }
        }
    }
}
