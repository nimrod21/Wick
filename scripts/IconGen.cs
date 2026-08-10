// Renders the Wick "Pulse/Echo" (G7) logo to a multi-size .ico + a 256px .png.
// Build & run (no deps beyond .NET Framework):
//   csc /nologo /out:%TEMP%\icongen.exe scripts\IconGen.cs && %TEMP%\icongen.exe assets
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

static class IconGen
{
    static void Main(string[] args)
    {
        string outDir = args.Length > 0 ? args[0] : "assets";
        Directory.CreateDirectory(outDir);
        int[] sizes = { 16, 24, 32, 48, 64, 128, 256 };
        var pngs = new List<byte[]>();
        foreach (int s in sizes)
        {
            using (var bmp = Render(s))
            using (var ms = new MemoryStream())
            {
                bmp.Save(ms, ImageFormat.Png);
                pngs.Add(ms.ToArray());
                if (s == 256) File.WriteAllBytes(Path.Combine(outDir, "wick-256.png"), ms.ToArray());
            }
        }
        WriteIco(Path.Combine(outDir, "wick.ico"), sizes, pngs);
        Console.WriteLine("wrote " + Path.Combine(outDir, "wick.ico"));
    }

    static Bitmap Render(int size)
    {
        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float k = size / 512f;
            g.ScaleTransform(k, k);
            bool tiny = size <= 24;
            float stroke = tiny ? 72f : 46f;   // thicker line at taskbar sizes

            // Tile
            using (var tile = RoundedRect(8, 8, 496, 496, 112))
            {
                using (var b = new SolidBrush(ColorTranslator.FromHtml("#0E0E15"))) g.FillPath(b, tile);
                using (var p = new Pen(ColorTranslator.FromHtml("#23232F"), 6f)) g.DrawPath(p, tile);
            }

            var w = new[] { new PointF(96, 168), new PointF(196, 360), new PointF(256, 236),
                            new PointF(316, 360), new PointF(416, 168) };

            // Echo (skipped at tiny sizes — it just muddies 16px)
            if (!tiny)
            {
                var echo = new PointF[w.Length];
                for (int i = 0; i < w.Length; i++) echo[i] = new PointF(w[i].X + 14, w[i].Y - 16);
                using (var p = MakePen(Color.FromArgb(89, ColorTranslator.FromHtml("#1E9E44")), stroke))
                    g.DrawLines(p, echo);
            }

            // Main stroke — vertical green gradient
            var rect = new RectangleF(60, 100, 400, 320);
            using (var gb = new LinearGradientBrush(rect, ColorTranslator.FromHtml("#4BFF7E"),
                                                    ColorTranslator.FromHtml("#1DB954"), 90f))
            using (var p = MakePen(gb, stroke))
                g.DrawLines(p, w);

            // Ember at the tip: soft glow rings + gradient core
            var c = new PointF(416, 168);
            FillCircle(g, c, 66, Color.FromArgb(28, ColorTranslator.FromHtml("#FF9900")));
            FillCircle(g, c, 50, Color.FromArgb(50, ColorTranslator.FromHtml("#FFB000")));
            float r = tiny ? 44f : 34f;
            var cr = new RectangleF(c.X - r, c.Y - r, 2 * r, 2 * r);
            using (var gb = new LinearGradientBrush(cr, ColorTranslator.FromHtml("#FFE066"),
                                                    ColorTranslator.FromHtml("#FF9900"), 90f))
                g.FillEllipse(gb, cr);
        }
        return bmp;
    }

    static Pen MakePen(Brush b, float w)
    {
        var p = new Pen(b, w) { LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round };
        return p;
    }
    static Pen MakePen(Color c, float w)
    {
        var p = new Pen(c, w) { LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round };
        return p;
    }
    static void FillCircle(Graphics g, PointF c, float r, Color col)
    {
        using (var b = new SolidBrush(col)) g.FillEllipse(b, c.X - r, c.Y - r, 2 * r, 2 * r);
    }
    static GraphicsPath RoundedRect(float x, float y, float w, float h, float rad)
    {
        var p = new GraphicsPath();
        p.AddArc(x, y, 2 * rad, 2 * rad, 180, 90);
        p.AddArc(x + w - 2 * rad, y, 2 * rad, 2 * rad, 270, 90);
        p.AddArc(x + w - 2 * rad, y + h - 2 * rad, 2 * rad, 2 * rad, 0, 90);
        p.AddArc(x, y + h - 2 * rad, 2 * rad, 2 * rad, 90, 90);
        p.CloseFigure();
        return p;
    }

    // ICO container with PNG-compressed entries (valid on Win Vista+)
    static void WriteIco(string path, int[] sizes, List<byte[]> pngs)
    {
        using (var fs = new FileStream(path, FileMode.Create))
        using (var bw = new BinaryWriter(fs))
        {
            bw.Write((ushort)0); bw.Write((ushort)1); bw.Write((ushort)sizes.Length);
            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                int s = sizes[i];
                bw.Write((byte)(s == 256 ? 0 : s)); // 0 means 256
                bw.Write((byte)(s == 256 ? 0 : s));
                bw.Write((byte)0); bw.Write((byte)0);
                bw.Write((ushort)1); bw.Write((ushort)32);
                bw.Write((uint)pngs[i].Length); bw.Write((uint)offset);
                offset += pngs[i].Length;
            }
            foreach (var png in pngs) bw.Write(png);
        }
    }
}
