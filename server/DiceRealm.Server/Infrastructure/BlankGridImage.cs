using SkiaSharp;

namespace DiceRealm.Server.Infrastructure;

// The plain battle grid for a fight whose scene has no map: parchment ground and 5-foot cell lines,
// no terrain. The same bytes every time, so a retried install replays instead of conflicting.
internal static class BlankGridImage
{
    public const int Columns = 12, Rows = 8, CellPixels = 64;
    public const int Width = Columns * CellPixels, Height = Rows * CellPixels;

    public static byte[] Png()
    {
        using var bitmap = new SKBitmap(Width, Height);
        using var canvas = new SKCanvas(bitmap);
        canvas.Clear(new SKColor(0xE6, 0xDC, 0xC4));
        using var line = new SKPaint { Color = new SKColor(0x9C, 0x8A, 0x68), StrokeWidth = 1 };
        for (int x = 0; x <= Columns; x++)
        {
            float at = Math.Min(x * CellPixels, Width - 1) + 0.5f;
            canvas.DrawLine(at, 0, at, Height, line);
        }
        for (int y = 0; y <= Rows; y++)
        {
            float at = Math.Min(y * CellPixels, Height - 1) + 0.5f;
            canvas.DrawLine(0, at, Width, at, line);
        }
        using var data = bitmap.Encode(SKEncodedImageFormat.Png, 100) ?? throw new InvalidDataException("Blank grid encode failed.");
        return data.ToArray();
    }
}
