// Загрузчик лаунчера: маленький exe в стиле лаунчера. Скачивает свежий установщик
// с GitHub, ставит его тихо (/S) и запускает лаунчер. Белое окно NSIS игрок не видит.
// Собирается встроенным в Windows компилятором: npm run bootstrapper (tools/build-bootstrapper.ps1).
// Язык C# 5 — именно его понимает csc.exe из .NET Framework 4.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle(BuildConfig.ProjectName + " Installer")]
[assembly: AssemblyProduct(BuildConfig.ProjectName)]
[assembly: AssemblyDescription(BuildConfig.ProjectName + " Installer")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace ProjectManul.Installer
{
    static class Program
    {
        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        [STAThread]
        static void Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2

            // --url и --shot — только для проверки разработчиком.
            string url = BuildConfig.InstallerUrl;
            string shotDir = null;
            for (int i = 0; i + 1 < args.Length; i++)
            {
                if (args[i] == "--url") url = args[i + 1];
                if (args[i] == "--shot") shotDir = args[i + 1];
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm(url, shotDir));
        }
    }

    static class L
    {
        static readonly bool Ru = IsRu();

        static bool IsRu()
        {
            string lang = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName;
            return lang == "ru" || lang == "uk" || lang == "be" || lang == "kk";
        }

        public static string S(string ru, string en) { return Ru ? ru : en; }
    }

    enum Phase { Download, Install, Done, Error }

    class InstallerForm : Form
    {
        // Базовый размер в пикселях при 100% масштабе; всё рисуется через ScaleTransform.
        const float W = 560, H = 300;

        static readonly Color Bg = Hex(0x141414), Panel = Hex(0x1a1a1a), Track = Hex(0x222222),
            Line = Hex(0x2b2b2b), Line2 = Hex(0x3a3a3a), Text1 = Hex(0xededed), Muted = Hex(0xa6a6a6),
            Accent = Hex(0xf5951b), AccentHi = Hex(0xffa733), AccentDeep = Hex(0xb86a0a),
            AccentText = Hex(0xffb24d), Bronze = Hex(0x8a6b2c), Danger = Hex(0xe5533d);

        readonly string url, shotDir;
        readonly float k;
        readonly Image logo;
        readonly Font fTitle, fSub, fStatus, fSmall, fSmallBold, fBtn;
        readonly System.Windows.Forms.Timer anim;

        volatile Phase phase = Phase.Download;
        volatile string status = "", detail = "";
        long got, total = -1, speed;
        volatile bool cancelled;
        Thread worker;
        HttpWebRequest request;
        string tempFile;
        int stripe, hover, shots;
        bool halfShot;

        readonly RectangleF closeBtn = new RectangleF(W - 46, 10, 36, 30);
        readonly RectangleF retryBtn = new RectangleF(W - 28 - 150, H - 62, 150, 38);
        readonly RectangleF manualBtn = new RectangleF(W - 28 - 150 - 12 - 200, H - 62, 200, 38);

        public InstallerForm(string url, string shotDir)
        {
            this.url = url;
            this.shotDir = shotDir;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Bg;
            Text = BuildConfig.ProjectName + " — " + L.S("установка", "setup");
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            using (Graphics g = CreateGraphics()) k = g.DpiX / 96f;
            ClientSize = new Size((int)Math.Round(W * k), (int)Math.Round(H * k));

            Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png");
            if (res != null) logo = Image.FromStream(res);

            FontFamily head = Family("Bahnschrift SemiBold Condensed", "Bahnschrift SemiBold", "Bahnschrift", "Segoe UI Semibold", "Segoe UI");
            FontFamily body = Family("Bahnschrift", "Segoe UI");
            FontFamily bodyBold = Family("Bahnschrift SemiBold", "Segoe UI Semibold", "Segoe UI");
            fTitle = new Font(head, 30f, FontStyle.Regular, GraphicsUnit.Pixel);
            fSub = new Font(body, 13f, FontStyle.Regular, GraphicsUnit.Pixel);
            fStatus = new Font(bodyBold, 18f, FontStyle.Regular, GraphicsUnit.Pixel);
            fSmall = new Font(body, 13f, FontStyle.Regular, GraphicsUnit.Pixel);
            fSmallBold = new Font(bodyBold, 13f, FontStyle.Regular, GraphicsUnit.Pixel);
            fBtn = new Font(bodyBold, 14f, FontStyle.Regular, GraphicsUnit.Pixel);

            anim = new System.Windows.Forms.Timer();
            anim.Interval = 33;
            anim.Tick += delegate { stripe = (stripe + 1) % 24; Invalidate(); };
        }

        static Color Hex(int rgb) { return Color.FromArgb(255, (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255); }

        static FontFamily Family(params string[] names)
        {
            using (InstalledFontCollection installed = new InstalledFontCollection())
            {
                foreach (string name in names)
                    foreach (FontFamily f in installed.Families)
                        if (string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase)) return f;
            }
            return FontFamily.GenericSansSerif;
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ClassStyle |= 0x20000; // CS_DROPSHADOW
                return cp;
            }
        }

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [DllImport("user32.dll")]
        static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try { int round = 2; DwmSetWindowAttribute(Handle, 33, ref round, 4); } catch { } // скругление Windows 11
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            anim.Start();
            Start();
        }

        // ---------- работа ----------

        void Start()
        {
            Interlocked.Exchange(ref got, 0);
            Interlocked.Exchange(ref total, -1);
            Interlocked.Exchange(ref speed, 0);
            halfShot = false;
            SetPhase(Phase.Download, L.S("Скачиваем лаунчер…", "Downloading the launcher…"), "");
            worker = new Thread(Run);
            worker.IsBackground = true;
            worker.Start();
        }

        void Run()
        {
            try
            {
                tempFile = Path.Combine(Path.GetTempPath(), "ProjectManul-Setup-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
                Download();
                if (cancelled) return;

                SetPhase(Phase.Install, L.S("Устанавливаем…", "Installing…"), L.S("Это займёт несколько секунд", "This takes a few seconds"));
                ProcessStartInfo psi = new ProcessStartInfo(tempFile, "/S --force-run");
                psi.UseShellExecute = false;
                using (Process p = Process.Start(psi))
                {
                    if (!p.WaitForExit(10 * 60 * 1000))
                        throw new Exception(L.S("Установка не завершилась за 10 минут.", "Setup did not finish in 10 minutes."));
                    if (p.ExitCode != 0)
                        throw new Exception(L.S("Установщик завершился с кодом ", "Setup exited with code ") + p.ExitCode + ".");
                }
                TryDelete(tempFile);
                SetPhase(Phase.Done, L.S("Готово! Запускаем лаунчер…", "Done! Starting the launcher…"), "");
                Thread.Sleep(1800);
                BeginInvoke(new MethodInvoker(Close));
            }
            catch (Exception ex)
            {
                TryDelete(tempFile);
                if (cancelled) return;
                SetPhase(Phase.Error, L.S("Не получилось установить", "Installation failed"), Describe(ex));
            }
        }

        void Download()
        {
            request = (HttpWebRequest)WebRequest.Create(url);
            request.UserAgent = "ProjectManul-Installer/1.0";
            request.AllowAutoRedirect = true;
            request.Timeout = 30000;
            request.ReadWriteTimeout = 30000;
            using (HttpWebResponse resp = (HttpWebResponse)request.GetResponse())
            {
                Interlocked.Exchange(ref total, resp.ContentLength);
                using (Stream src = resp.GetResponseStream())
                using (FileStream dst = File.Create(tempFile))
                {
                    byte[] buf = new byte[81920];
                    Stopwatch sw = Stopwatch.StartNew();
                    long lastBytes = 0, lastMs = 0;
                    int n;
                    while ((n = src.Read(buf, 0, buf.Length)) > 0)
                    {
                        if (cancelled) throw new OperationCanceledException();
                        dst.Write(buf, 0, n);
                        long now = Interlocked.Add(ref got, n);
                        long ms = sw.ElapsedMilliseconds;
                        if (ms - lastMs >= 500)
                        {
                            Interlocked.Exchange(ref speed, (now - lastBytes) * 1000 / (ms - lastMs));
                            lastBytes = now;
                            lastMs = ms;
                        }
                        long t = Interlocked.Read(ref total);
                        if (!halfShot && t > 0 && now * 2 >= t) { halfShot = true; Shot(); }
                    }
                }
            }
            long size = Interlocked.Read(ref got), expected = Interlocked.Read(ref total);
            if (expected > 0 && size != expected)
                throw new IOException(L.S("Файл скачался не полностью.", "The download is incomplete."));
            using (FileStream f = File.OpenRead(tempFile))
            {
                if (f.ReadByte() != 'M' || f.ReadByte() != 'Z')
                    throw new IOException(L.S("Скачался не установщик. Попробуйте позже.", "The downloaded file is not an installer. Try again later."));
            }
        }

        static string Describe(Exception ex)
        {
            WebException web = ex as WebException;
            if (web != null)
            {
                HttpWebResponse r = web.Response as HttpWebResponse;
                if (r != null && r.StatusCode == HttpStatusCode.NotFound)
                    return L.S("Установщик ещё не выложен на GitHub (ошибка 404).", "The installer is not on GitHub yet (error 404).");
                if (r != null)
                    return L.S("GitHub ответил ошибкой ", "GitHub returned error ") + (int)r.StatusCode + ".";
                if (web.Status == WebExceptionStatus.NameResolutionFailure || web.Status == WebExceptionStatus.ConnectFailure)
                    return L.S("Нет подключения к интернету или GitHub недоступен.", "No internet connection, or GitHub is unreachable.");
                if (web.Status == WebExceptionStatus.Timeout)
                    return L.S("Соединение оборвалось. Проверьте интернет.", "The connection timed out. Check your internet.");
            }
            return ex.Message;
        }

        static void TryDelete(string file)
        {
            if (file == null) return;
            for (int i = 0; i < 5; i++)
            {
                try { if (File.Exists(file)) File.Delete(file); return; }
                catch { Thread.Sleep(300); }
            }
        }

        void SetPhase(Phase p, string s, string d)
        {
            phase = p;
            status = s;
            detail = d;
            if (IsHandleCreated) BeginInvoke(new MethodInvoker(delegate { Invalidate(); Shot(); }));
        }

        // Снимок окна для проверки разработчиком (--shot <папка>).
        void Shot()
        {
            if (shotDir == null) return;
            if (InvokeRequired) { BeginInvoke(new MethodInvoker(Shot)); return; }
            Directory.CreateDirectory(shotDir);
            using (Bitmap bmp = new Bitmap(ClientSize.Width, ClientSize.Height))
            {
                DrawToBitmap(bmp, new Rectangle(Point.Empty, ClientSize));
                bmp.Save(Path.Combine(shotDir, string.Format("{0:00}-{1}.png", ++shots, phase)), System.Drawing.Imaging.ImageFormat.Png);
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (phase == Phase.Install) { e.Cancel = true; return; } // установщик уже пишет файлы — не прерываем
            cancelled = true;
            HttpWebRequest r = request;
            if (r != null) try { r.Abort(); } catch { }
            if (worker != null) worker.Join(2000);
            TryDelete(tempFile);
            base.OnFormClosing(e);
        }

        // ---------- мышь ----------

        PointF ToBase(Point p) { return new PointF(p.X / k, p.Y / k); }

        int HitTest(PointF p)
        {
            if (closeBtn.Contains(p) && phase != Phase.Install) return 1;
            if (phase == Phase.Error && retryBtn.Contains(p)) return 2;
            if (phase == Phase.Error && manualBtn.Contains(p)) return 3;
            return 0;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            int h = HitTest(ToBase(e.Location));
            if (h != hover) { hover = h; Cursor = h != 0 ? Cursors.Hand : Cursors.Default; Invalidate(); }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (hover != 0) { hover = 0; Invalidate(); }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            int h = HitTest(ToBase(e.Location));
            if (h == 1) Close();
            else if (h == 2) Start();
            else if (h == 3) { try { Process.Start(BuildConfig.ReleasesUrl); } catch { } }
            else
            {
                ReleaseCapture();
                SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero); // перетаскивание окна
            }
        }

        // ---------- рисование ----------

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.ScaleTransform(k, k);
            g.Clear(Bg);

            // рамка и оранжевая полоса сверху
            using (Pen border = new Pen(Line, 1f)) g.DrawRectangle(border, 0.5f, 0.5f, W - 1, H - 1);
            using (SolidBrush b = new SolidBrush(Accent)) g.FillRectangle(b, 0, 0, W, 3);

            // кнопка закрытия
            if (phase != Phase.Install)
            {
                if (hover == 1) using (SolidBrush b = new SolidBrush(Panel)) g.FillRectangle(b, closeBtn);
                using (Pen x = new Pen(hover == 1 ? Accent : Muted, 1.6f))
                {
                    float cx = closeBtn.X + closeBtn.Width / 2, cy = closeBtn.Y + closeBtn.Height / 2;
                    g.DrawLine(x, cx - 6, cy - 6, cx + 6, cy + 6);
                    g.DrawLine(x, cx + 6, cy - 6, cx - 6, cy + 6);
                }
            }

            // шапка: логотип, название, подпись
            if (logo != null) g.DrawImage(logo, 28, 30, 58, 58);
            using (SolidBrush t = new SolidBrush(Text1)) g.DrawString(BuildConfig.ProjectName.ToUpperInvariant(), fTitle, t, 98, 30);
            using (SolidBrush m = new SolidBrush(Bronze)) g.FillRectangle(m, 101, 70, 18, 2);
            using (SolidBrush m = new SolidBrush(Muted)) g.DrawString(L.S("УСТАНОВКА ЛАУНЧЕРА", "LAUNCHER SETUP"), fSub, m, 124, 62);
            using (Pen p = new Pen(Line, 1f)) g.DrawLine(p, 28, 112, W - 28, 112);

            // статус
            Color statusColor = phase == Phase.Error ? Danger : phase == Phase.Done ? AccentText : Text1;
            using (SolidBrush b = new SolidBrush(statusColor)) g.DrawString(status, fStatus, b, 26, 134);

            if (phase == Phase.Error)
            {
                using (SolidBrush m = new SolidBrush(Muted))
                    g.DrawString(detail, fSmall, m, new RectangleF(28, 166, W - 56, 60));
                DrawButton(g, manualBtn, L.S("СКАЧАТЬ ВРУЧНУЮ", "DOWNLOAD MANUALLY"), false, hover == 3);
                DrawButton(g, retryBtn, L.S("ПОВТОРИТЬ", "RETRY"), true, hover == 2);
                return;
            }

            // полоса прогресса
            RectangleF bar = new RectangleF(28, 174, W - 56, 14);
            using (SolidBrush b = new SolidBrush(Track)) g.FillRectangle(b, bar);
            long t2 = Interlocked.Read(ref total), got2 = Interlocked.Read(ref got);
            bool indeterminate = phase == Phase.Install || (phase == Phase.Download && t2 <= 0);
            float frac = phase == Phase.Done ? 1f : indeterminate ? 1f : Math.Min(1f, (float)got2 / t2);
            if (frac > 0)
            {
                RectangleF fill = new RectangleF(bar.X, bar.Y, bar.Width * frac, bar.Height);
                using (SolidBrush b = new SolidBrush(phase == Phase.Done ? AccentHi : Accent)) g.FillRectangle(b, fill);
                if (phase != Phase.Done) DrawStripes(g, fill, indeterminate ? stripe : stripe / 2);
            }
            using (Pen p = new Pen(Line2, 1f)) g.DrawRectangle(p, bar.X, bar.Y, bar.Width, bar.Height);

            // подписи под полосой
            string left = detail, right = "";
            if (phase == Phase.Download)
            {
                left = Mb(got2) + (t2 > 0 ? " / " + Mb(t2) : "") + L.S(" МБ", " MB");
                long sp = Interlocked.Read(ref speed);
                if (sp > 0) left += "  ·  " + Mb(sp) + L.S(" МБ/с", " MB/s");
                if (t2 > 0) right = (int)(frac * 100) + "%";
            }
            using (SolidBrush m = new SolidBrush(Muted)) g.DrawString(left, fSmall, m, 27, 198);
            if (right.Length > 0)
                using (SolidBrush a = new SolidBrush(AccentText))
                {
                    SizeF sz = g.MeasureString(right, fSmallBold);
                    g.DrawString(right, fSmallBold, a, W - 28 - sz.Width + 2, 198);
                }

            if (phase == Phase.Download)
                using (SolidBrush m = new SolidBrush(Hex(0x5c5c5c)))
                    g.DrawString(L.S("Скачивается с GitHub проекта", "Downloading from the project's GitHub"), fSmall, m, 27, H - 38);
        }

        // Диагональные «предупреждающие» полосы поверх заливки.
        static void DrawStripes(Graphics g, RectangleF r, int offset)
        {
            GraphicsState state = g.Save();
            g.SetClip(r);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(70, AccentDeep)))
            {
                for (float x = r.X - 24 + offset; x < r.Right + 24; x += 24)
                {
                    PointF[] poly = {
                        new PointF(x, r.Bottom), new PointF(x + 12, r.Bottom),
                        new PointF(x + 12 + r.Height, r.Y), new PointF(x + r.Height, r.Y) };
                    g.FillPolygon(b, poly);
                }
            }
            g.Restore(state);
        }

        void DrawButton(Graphics g, RectangleF r, string text, bool primary, bool hot)
        {
            if (primary)
                using (SolidBrush b = new SolidBrush(hot ? AccentHi : Accent)) g.FillRectangle(b, r);
            else
            {
                if (hot) using (SolidBrush b = new SolidBrush(Panel)) g.FillRectangle(b, r);
                using (Pen p = new Pen(hot ? Accent : Line2, 1f)) g.DrawRectangle(p, r.X, r.Y, r.Width, r.Height);
            }
            using (StringFormat sf = new StringFormat())
            using (SolidBrush b = new SolidBrush(primary ? Hex(0x141414) : (hot ? AccentText : Text1)))
            {
                sf.Alignment = StringAlignment.Center;
                sf.LineAlignment = StringAlignment.Center;
                g.DrawString(text, fBtn, b, r, sf);
            }
        }

        static string Mb(long bytes)
        {
            return (bytes / 1048576.0).ToString("0.0", CultureInfo.InvariantCulture);
        }
    }
}
