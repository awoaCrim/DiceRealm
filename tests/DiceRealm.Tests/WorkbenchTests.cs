using System.Net;
using System.Text.RegularExpressions;

namespace DiceRealm.Tests;

internal static class WorkbenchTests
{
    public static async Task Hosting()
    {
        await using var host = await Host.Start();
        var page = await host.Http.GetAsync("/workbench/");
        Check.Equal(HttpStatusCode.OK,page.StatusCode);
        Check.Equal("text/html",page.Content.Headers.ContentType!.MediaType);
        Check.True(page.Headers.GetValues("Content-Security-Policy").Single().Contains("frame-ancestors 'none'"));
        Check.Equal("no-referrer",page.Headers.GetValues("Referrer-Policy").Single());
        Check.Equal("no-store",page.Headers.CacheControl!.ToString());
        var html = await page.Content.ReadAsStringAsync();
        Check.True(html.Contains("type=\"module\""));
        foreach (Match match in Regex.Matches(html,"(?:src|href)=\"(\\./[^\"]+\\.(?:js|css))\""))
        {
            var asset = await host.Http.GetAsync("/workbench/" + match.Groups[1].Value[2..]);
            Check.Equal(HttpStatusCode.OK,asset.StatusCode);
            Check.True((await asset.Content.ReadAsByteArrayAsync()).Length > 20);
        }
        var plain = await host.Http.GetAsync("/workbench"); Check.Equal(HttpStatusCode.OK,plain.StatusCode);
        Check.True(plain.RequestMessage!.RequestUri!.AbsolutePath.EndsWith("/workbench/"));
        foreach (var (path, mime) in new[] { ("fonts/SourceHanSansCN-Regular.otf", "font/otf"), ("fonts/SourceHanSerifCN-Regular.otf", "font/otf") })
        {
            var asset = await host.Http.GetAsync("/workbench/" + path);
            Check.Equal(HttpStatusCode.OK, asset.StatusCode);
            Check.Equal(mime, asset.Content.Headers.ContentType!.MediaType);
            Check.True((await asset.Content.ReadAsByteArrayAsync()).Length > 20);
        }
        foreach (var path in new[] { "session.json", "appsettings.json", "package.json", "tests/client.test.js", ".local/secrets/provider.json", "missing.js", "data/map.png", "assets/game/missing.jpg" })
            Check.Equal(HttpStatusCode.NotFound,(await host.Http.GetAsync("/workbench/"+path)).StatusCode);
        // The player page is the same embedded frontend under its own default page and the same headers.
        var play = await host.Http.GetAsync("/play/");
        Check.Equal(HttpStatusCode.OK,play.StatusCode);
        Check.True(play.Headers.GetValues("Content-Security-Policy").Single().Contains("frame-ancestors 'none'"));
        var playHtml = await play.Content.ReadAsStringAsync();
        Check.True(playHtml.Contains("src/play/main.js"));
        foreach (Match match in Regex.Matches(playHtml,"(?:src|href)=\"(\\./[^\"]+\\.(?:js|css))\""))
            Check.Equal(HttpStatusCode.OK,(await host.Http.GetAsync("/play/" + match.Groups[1].Value[2..])).StatusCode);
        Check.True((await host.Http.GetAsync("/play")).RequestMessage!.RequestUri!.AbsolutePath.EndsWith("/play/"));
        Check.Equal(HttpStatusCode.NotFound,(await host.Http.GetAsync("/play/session.json")).StatusCode);
        // Serving a public UI must not grant access to its backing endpoints.
        Check.Equal(HttpStatusCode.Unauthorized,(await host.Http.GetAsync("/api/v1/campaigns/"+Guid.NewGuid()+"/resources")).StatusCode);
    }
}
