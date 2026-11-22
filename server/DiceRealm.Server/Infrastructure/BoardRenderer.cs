using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using SkiaSharp;

namespace DiceRealm.Server.Infrastructure;

// Renders only the frozen, already-authorized board. Never reads a desktop, campaign or network.
internal static class BoardRenderer
{
    public static HarnessBoardImage[] Render(BoardView board, byte[] png)
    {
        if (JsonFiles.Hash(png) != board.Map.ContentHash) throw new InvalidDataException("Board map hash mismatch.");
        using var image = SKBitmap.Decode(png) ?? throw new InvalidDataException("Board map decode failed.");
        if (image.Width != board.Map.Width || image.Height != board.Map.Height) throw new InvalidDataException("Board map size mismatch.");
        var result = new List<HarnessBoardImage> { Draw(board, image, "overview", new(0, 0, 1, 1)) };
        var focus = board.Tokens.FirstOrDefault(t => t.OnMap && t.CanControl) ?? board.Tokens.FirstOrDefault(t => t.OnMap);
        if (focus is not null && Math.Max(image.Width, image.Height) > 1280)
        {
            float width = Math.Min(1, 768f / image.Width), height = Math.Min(1, 768f / image.Height);
            float left = Math.Clamp((float)focus.X - width / 2, 0, 1 - width);
            float top = Math.Clamp((float)focus.Y - height / 2, 0, 1 - height);
            result.Add(Draw(board, image, "detail", new(left, top, left + width, top + height)));
        }
        return result.ToArray();
    }
    private static HarnessBoardImage Draw(BoardView board, SKBitmap map, string kind, SKRect bounds)
    {
        float sourceWidth = map.Width * bounds.Width, sourceHeight = map.Height * bounds.Height;
        float scale = Math.Min(1, 768f / Math.Max(sourceWidth, sourceHeight));
        int width = Math.Max(1, (int)Math.Round(sourceWidth * scale)), height = Math.Max(1, (int)Math.Round(sourceHeight * scale));
        using var bitmap = new SKBitmap(width, height);
        using var canvas = new SKCanvas(bitmap);
        using var paint = new SKPaint { IsAntialias = true };
        canvas.Clear(SKColors.White);
        canvas.DrawBitmap(map, new SKRect(bounds.Left * map.Width, bounds.Top * map.Height, bounds.Right * map.Width, bounds.Bottom * map.Height),
            new SKRect(0, 0, width, height), paint);
        using var font = new SKFont(SKTypeface.Default, 12);
        foreach (var token in board.Tokens.Where(t => t.OnMap && t.X >= bounds.Left && t.X <= bounds.Right && t.Y >= bounds.Top && t.Y <= bounds.Bottom))
        {
            float x = (float)((token.X - bounds.Left) / bounds.Width * width), y = (float)((token.Y - bounds.Top) / bounds.Height * height);
            paint.Color = SKColors.White; canvas.DrawCircle(x, y, 14, paint);
            paint.Color = token.CanControl ? new SKColor(38, 120, 170) : new SKColor(120, 82, 42);
            canvas.DrawCircle(x, y, 11, paint);
            if (BoardArt.Keys.Contains(token.IconKey))
            {
                string path = Path.Combine(AppContext.BaseDirectory, "board-icons", token.IconKey + ".png");
                if (File.Exists(path))
                {
                    using var icon = SKBitmap.Decode(path);
                    if (icon is not null)
                    {
                        float factor = 24f / Math.Max(icon.Width, icon.Height);
                        float iw = icon.Width * factor, ih = icon.Height * factor;
                        canvas.DrawBitmap(icon, new SKRect(x - iw / 2, y - ih / 2, x + iw / 2, y + ih / 2), paint);
                    }
                }
            }
            // Image identity stays equal to the client's short instance label; names/details live in the summary.
            float labelWidth = font.MeasureText(token.Label) + 6;
            float left = Math.Clamp(x - labelWidth / 2, 0, Math.Max(0, width - labelWidth));
            float top = Math.Clamp(y + 15, 0, Math.Max(0, height - 16));
            paint.Color = new SKColor(255, 255, 255, 235); canvas.DrawRect(left, top, labelWidth, 16, paint);
            paint.Color = SKColors.Black; canvas.DrawText(token.Label, left + 3, top + 12, SKTextAlign.Left, font, paint);
        }
        using var composed = SKImage.FromBitmap(bitmap);
        // Keep the frozen frame bounded without reducing unrelated text limits or hiding absent images.
        foreach (int quality in new[] { 75, 55, 35, 20 })
        {
            using var data = composed.Encode(SKEncodedImageFormat.Jpeg, quality) ?? throw new InvalidDataException("Board image encode failed.");
            if (data.Size > 96 * 1024) continue;
            byte[] bytes = data.ToArray();
            return new(kind, "image/jpeg", Convert.ToBase64String(bytes), JsonFiles.Hash(bytes), width, height, bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
        }
        throw new InvalidDataException("Board image exceeds the saved-frame size.");
    }
}
