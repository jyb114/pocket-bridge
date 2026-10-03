'use strict';

// WScript.Shell's shortcut fields pass through the active ANSI code page.
// Use the Windows Unicode interface explicitly; no external tools or packages.
// https://learn.microsoft.com/windows/win32/api/shobjidl_core/nn-shobjidl_core-ishelllinkw
const { execFileSync } = require('child_process');

const nativeSource = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class PocketBridgeShellLink { }
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface PocketBridgeShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr data, uint flags);
  void GetIDList(out IntPtr itemList);
  void SetIDList(IntPtr itemList);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int count);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string path);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int count);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string text);
  void GetHotkey(out short hotkey);
  void SetHotkey(short hotkey);
  void GetShowCmd(out int command);
  void SetShowCmd(int command);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, out int index);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
  void Resolve(IntPtr window, uint flags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
}
public sealed class PocketBridgeShortcutFields {
  public string TargetPath, Arguments, WorkingDirectory, IconLocation, Description;
  public int ShowCommand;
}
public static class PocketBridgeShortcut {
  public static void Save(string file, string target, string arguments, string working, string icon, string description, int show) {
    object instance = new PocketBridgeShellLink();
    try {
      var link = (PocketBridgeShellLinkW)instance;
      link.SetPath(target); link.SetArguments(arguments); link.SetWorkingDirectory(working);
      link.SetDescription(description); link.SetShowCmd(show);
      if (!String.IsNullOrEmpty(icon)) link.SetIconLocation(icon, 0);
      ((IPersistFile)instance).Save(file, true);
    } finally { Marshal.FinalReleaseComObject(instance); }
  }
  public static PocketBridgeShortcutFields Read(string file) {
    object instance = new PocketBridgeShellLink();
    try {
      ((IPersistFile)instance).Load(file, 0);
      var link = (PocketBridgeShellLinkW)instance;
      var text = new StringBuilder(32768);
      var result = new PocketBridgeShortcutFields();
      link.GetPath(text, text.Capacity, IntPtr.Zero, 0); result.TargetPath = text.ToString(); text.Clear();
      link.GetArguments(text, text.Capacity); result.Arguments = text.ToString(); text.Clear();
      link.GetWorkingDirectory(text, text.Capacity); result.WorkingDirectory = text.ToString(); text.Clear();
      int index; link.GetIconLocation(text, text.Capacity, out index); result.IconLocation = text.ToString() + "," + index.ToString(System.Globalization.CultureInfo.InvariantCulture); text.Clear();
      link.GetDescription(text, text.Capacity); result.Description = text.ToString();
      int show; link.GetShowCmd(out show); result.ShowCommand = show;
      return result;
    } finally { Marshal.FinalReleaseComObject(instance); }
  }
}
`;

function q(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function run(body) {
  if (process.platform !== 'win32') throw new Error('Windows shortcuts require Windows.');
  const script = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Add-Type -TypeDefinition @'\n" + nativeSource + "\n'@\n" + body;
  // The native command line is ASCII; the script and every path remain UTF-16.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 30000, windowsHide: true });
}

function createWindowsShortcut({ file, target, arguments: args, workingDirectory, icon = '', description = '', showCommand = 1 }) {
  if (!Number.isInteger(showCommand) || showCommand < 0 || showCommand > 11) throw new Error('Invalid shortcut window style.');
  return run(`[PocketBridgeShortcut]::Save(${[file, target, args, workingDirectory, icon, description].map(q).join(',')},${showCommand}); Write-Output 'SAVED'`);
}

function readWindowsShortcut(file) {
  // Base64 keeps readback independent of the host console's output code page.
  const result = run(`$fields = [PocketBridgeShortcut]::Read(${q(file)}); ` +
    '$json = $fields | ConvertTo-Json -Compress; [Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($json)))');
  return JSON.parse(Buffer.from(result.trim(), 'base64').toString('utf16le'));
}

module.exports = { createWindowsShortcut, readWindowsShortcut };
