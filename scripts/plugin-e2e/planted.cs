// Compiled by run.ps1 with the csc that ships with Windows (issue #559). The plugin end-to-end
// test copies the result to node.exe, powershell.exe, where.exe and cmd.exe in the project folder:
// if anything of the plugin ever starts one of those, "PLANTED" shows up in the session log.
class Planted
{
    static void Main(string[] args)
    {
        System.Console.WriteLine("PLANTED-EXE " + System.IO.Path.GetFileName(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName) + " args=" + string.Join(" ", args));
    }
}
