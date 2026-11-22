using System.Reflection;

namespace DiceRealm.Server.Api;

// The host web UI (/workbench/) and the player page (/play/) are one frontend, packaged with the API for
// same-origin auth; both paths serve the same embedded files and differ only in their default page.
// Only embedded public assets can be served; never expose data directories or arbitrary files.
internal static class WorkbenchHost
{
    private const string Prefix = "DiceRealm.Workbench.";
    public static void MapWorkbench(this WebApplication app)
    {
        var assembly = typeof(WorkbenchHost).Assembly;
        var names = assembly.GetManifestResourceNames().Where(n => n.StartsWith(Prefix, StringComparison.Ordinal)).ToHashSet(StringComparer.Ordinal);
        foreach (var (root, page) in new[] { ("/workbench/", "index.html"), ("/play/", "play.html") })
        app.MapGet(root + "{**file}", (string? file, HttpContext context) =>
        {
            if (string.IsNullOrEmpty(file) && !context.Request.Path.Value!.EndsWith('/')) return Results.Redirect(root);
            var path = string.IsNullOrEmpty(file) ? page : file;
            if (path.Contains("..", StringComparison.Ordinal) || path.Contains('\\') || path.StartsWith('/')) return Results.NotFound();
            var mime = Path.GetExtension(path) switch
            {
                ".html" => "text/html; charset=utf-8", ".js" => "text/javascript; charset=utf-8", ".css" => "text/css; charset=utf-8",
                ".otf" => "font/otf", ".txt" => "text/plain; charset=utf-8", ".json" => "application/json; charset=utf-8",
                ".png" => "image/png", ".jpg" => "image/jpeg", _ => null
            };
            var name = Prefix + path.Replace('/', '.');
            if (mime is null || !names.Contains(name)) return Results.NotFound();
            context.Response.Headers.CacheControl = mime == "font/otf" ? "public, max-age=86400" : "no-store";
            context.Response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
            context.Response.Headers["Referrer-Policy"] = "no-referrer";
            context.Response.Headers["X-Content-Type-Options"] = "nosniff";
            context.Response.Headers["X-Frame-Options"] = "DENY";
            return Results.Stream(assembly.GetManifestResourceStream(name)!, mime);
        });
    }
}
