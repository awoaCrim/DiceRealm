using System.Net;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Api;

public static class AiSettingsEndpoints
{
    public static void MapAiSettings(this RouteGroupBuilder api)
    {
        api.MapPost("/operator/ai-settings/test", async (HttpContext context, AiConfigurationStore settings, AiConnectionTester tester) =>
        {
            Authorize(context);
            var request = await ContentEndpoints.Read<AiProbeRequest>(context, 2048);
            return await tester.Test(request);
        });
        api.MapGet("/operator/ai-settings/tests/{requestId}", (string requestId, HttpContext context, AiConfigurationStore settings) =>
        {
            Authorize(context);
            return settings.ReadProbe(requestId);
        });
        api.MapGet("/operator/ai-settings", (HttpContext context, AiConfigurationStore settings) =>
        {
            Authorize(context);
            return settings.Read();
        });
        api.MapPost("/operator/ai-settings", async (HttpContext context, AiConfigurationStore settings) =>
        {
            Authorize(context);
            var request = await ContentEndpoints.Read<AiSettingsEdit>(context, 32768);
            return settings.Save(request);
        });
    }
    internal static void Authorize(HttpContext context)
    {
        string host = context.Request.Host.Host;
        bool localHost = host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
            IPAddress.TryParse(host.Trim('[', ']'), out var address) && IPAddress.IsLoopback(address);
        if (!localHost || context.Connection.RemoteIpAddress is not { } peer || !IPAddress.IsLoopback(peer))
            throw new GameException("operator_local_only", "全局 AI 配置只能从服务所在机器的本机地址管理。", 403);
        string origin = context.Request.Headers.Origin.ToString();
        if (origin.Length > 0 && !string.Equals(origin, context.Request.Scheme + "://" + context.Request.Host, StringComparison.OrdinalIgnoreCase))
            throw new GameException("operator_origin", "不接受跨站的服务管理请求。", 403);
        // Automatic same-origin header, not a credential or an unlock step.
        // Cross-site forms cannot send it; cross-origin scripts cannot pass preflight.
        if (context.Request.Headers["X-DiceRealm-Local-Settings"] != "1")
            throw new GameException("operator_same_origin_required", "请从本机工作台打开 AI 设置。", 403);
        context.RequestServices.GetRequiredService<AccountStore>().RequireAdmin(AccountEndpoints.Token(context));
    }
}
