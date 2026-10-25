using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace AI3DPrintFlow
{
    /// <summary>
    /// Native Windows entry point for the local console. It deliberately stays a
    /// thin launcher: the bundled runtime and the Node server remain visible in
    /// this source tree, while Explorer/shortcuts get a normal .exe to target.
    /// </summary>
    internal static class Launcher
    {
        private const string WindowTitle = "AI3D Print Flow - 请保持此窗口打开";

        private static string Quote(string value)
        {
            if (value == null) value = string.Empty;
            StringBuilder result = new StringBuilder();
            result.Append('"');
            int backslashes = 0;
            foreach (char c in value)
            {
                if (c == '\\')
                {
                    backslashes += 1;
                }
                else if (c == '"')
                {
                    result.Append('\\', backslashes * 2 + 1);
                    result.Append('"');
                    backslashes = 0;
                }
                else
                {
                    if (backslashes > 0)
                    {
                        result.Append('\\', backslashes);
                        backslashes = 0;
                    }
                    result.Append(c);
                }
            }
            if (backslashes > 0) result.Append('\\', backslashes * 2);
            result.Append('"');
            return result.ToString();
        }

        private static bool IsCliFlag(string arg)
        {
            return arg == "--help" || arg == "-h" || arg == "--version" || arg == "-v";
        }

        private static void Pause()
        {
            try
            {
                if (Environment.UserInteractive)
                {
                    Console.WriteLine();
                    Console.Write("按回车键关闭此窗口…");
                    Console.ReadLine();
                }
            }
            catch
            {
                // No console (for example a scripted launch); nothing to pause.
            }
        }

        private static int Main(string[] args)
        {
            try
            {
                Console.OutputEncoding = new UTF8Encoding(false);
                Console.Title = WindowTitle;
            }
            catch
            {
                // A redirected or non-interactive host may reject both calls.
            }

            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string node = Path.Combine(Path.Combine(baseDir, "runtime"), "node.exe");
            string cli = Path.Combine(Path.Combine(baseDir, "app"), "cli.mjs");
            bool defaultStart = args == null || args.Length == 0;

            if (!File.Exists(node))
            {
                Console.Error.WriteLine("找不到内置 Node 运行时：");
                Console.Error.WriteLine("  " + node);
                Console.Error.WriteLine("请确认打包完整，或运行 deploy.cmd 重新部署。");
                Pause();
                return 1;
            }
            if (!File.Exists(cli))
            {
                Console.Error.WriteLine("找不到程序入口：");
                Console.Error.WriteLine("  " + cli);
                Console.Error.WriteLine("请确认 app\\cli.mjs 存在，或重新解压完整安装包。");
                Pause();
                return 1;
            }

            // No argument means normal double-click startup. Server-style flags
            // (--no-open / --deploy / --port) are accepted for compatibility with
            // the old .cmd launcher and implicitly become the `start` command.
            string[] forwarded = args ?? new string[0];
            bool addStart = forwarded.Length == 0;
            if (!addStart && forwarded[0].StartsWith("-") && !IsCliFlag(forwarded[0])) addStart = true;

            StringBuilder argumentLine = new StringBuilder();
            argumentLine.Append(Quote(cli));
            if (addStart) argumentLine.Append(" start");
            foreach (string arg in forwarded)
            {
                argumentLine.Append(' ');
                argumentLine.Append(Quote(arg));
            }

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = node;
            startInfo.Arguments = argumentLine.ToString();
            startInfo.WorkingDirectory = baseDir;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = false;
            try
            {
                startInfo.EnvironmentVariables["AI3D_LAUNCHER"] = "AI3D-Print-Flow.exe";
            }
            catch
            {
                // Environment variables are a diagnostic nicety, not required.
            }

            try
            {
                using (Process child = Process.Start(startInfo))
                {
                    if (child == null)
                    {
                        Console.Error.WriteLine("无法启动内置 Node 进程。");
                        Pause();
                        return 1;
                    }
                    child.WaitForExit();
                    int code = child.ExitCode;
                    // Keep a double-clicked console open when startup fails so the
                    // actual error is readable. Commands such as `check` or
                    // `--version` must return immediately without an extra prompt.
                    if (code != 0 && defaultStart)
                    {
                        Console.Error.WriteLine();
                        Console.Error.WriteLine("启动器退出，代码 " + code + "。");
                        Pause();
                    }
                    return code;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("启动 AI3D Print Flow 失败：" + ex.Message);
                Pause();
                return 1;
            }
        }
    }
}
