// Wick desktop launcher — compiled with the .NET Framework csc that ships with Windows:
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe
//     /out:%USERPROFILE%\Desktop\Wick.exe /r:System.Windows.Forms.dll scripts\WickLauncher.cs
// Starts the pm2 apps (server + web) if they aren't up, waits for health, opens the dashboard.
// Closing the browser does NOT stop the bots — stop them from the UI or `pm2 delete all`.
using System;
using System.Diagnostics;
using System.Net;
using System.Threading;
using System.Windows.Forms;

static class WickLauncher
{
    const string Repo = @"D:\Projects\Wick";
    const string NodeDir = @"D:\Claude\Tools\node-v22";
    const string NpmGlobal = @"C:\Users\user\AppData\Roaming\npm";
    const string HealthUrl = "http://127.0.0.1:3001/health";
    const string WebUrl = "http://127.0.0.1:3000";

    [STAThread]
    static void Main()
    {
        try
        {
            if (!Up(WebUrl) || !Up(HealthUrl))
            {
                var psi = new ProcessStartInfo("cmd.exe", "/c pm2 start ecosystem.config.cjs")
                {
                    WorkingDirectory = Repo,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                psi.EnvironmentVariables["PATH"] =
                    NodeDir + ";" + NpmGlobal + ";" + Environment.GetEnvironmentVariable("PATH");
                using (var p = Process.Start(psi)) p.WaitForExit(60000);
            }

            bool ok = false;
            for (int i = 0; i < 45 && !ok; i++)
            {
                ok = Up(HealthUrl) && Up(WebUrl);
                if (!ok) Thread.Sleep(2000);
            }

            if (ok)
                Process.Start(WebUrl); // default browser
            else
                MessageBox.Show(
                    "Wick didn't come up within 90 seconds.\n\nCheck logs from a terminal:\n  set PATH=" + NodeDir + ";%PATH%\n  pm2 logs\n\nRepo: " + Repo,
                    "Wick", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            MessageBox.Show("Wick launcher error: " + ex.Message, "Wick",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static bool Up(string url)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 2000;
            using (var res = (HttpWebResponse)req.GetResponse())
                return (int)res.StatusCode == 200;
        }
        catch { return false; }
    }
}
