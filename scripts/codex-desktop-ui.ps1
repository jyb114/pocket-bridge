# First version: explicit foreground desktop relay, text only. No private IPC.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:FailureCode = 'unknown'
$script:FailureReason = 'Desktop relay could not be verified.'
$script:SubmissionAttempted = $false
$script:ClipboardSaved = $false
$script:ClipboardBackup = $null
$script:BridgePasteAttempted = $false
$script:BridgeDraftCleared = $false
$script:RecoveringDraft = $false
$script:Started = [Diagnostics.Stopwatch]::StartNew()
$script:Stage = 'read-request'
$script:IdentityCopyKind = 'none'
$script:IdentityCopyPhase = 'none'
$script:LastForegroundObservation = $null
$script:FailureForegroundObservation = $null
$script:IdentityModifierObservation = $null
$script:DesktopUiMutex = $null
$script:DesktopUiMutexOwned = $false

# Keep this exact allowlist separate from UI queries. Chromium localizes the
# mode control and newer desktops call the former Work mode simply ChatGPT.
# Code points keep this file safe for Windows PowerShell 5 without a UTF-8 BOM.
$script:ChineseModePrefix = -join @([char]0x5207, [char]0x6362, [char]0x6A21, [char]0x5F0F,
    [char]0xFF0C, [char]0x5F53, [char]0x524D, [char]0x6A21, [char]0x5F0F, [char]0xFF1A)
$script:CodexModeNames = @('Switch mode, current mode: Codex', ($script:ChineseModePrefix + 'Codex'))
$script:ChatGPTModeNames = @('Switch mode, current mode: ChatGPT', 'Switch mode, current mode: ChatGPT Work',
    ($script:ChineseModePrefix + 'ChatGPT'), ($script:ChineseModePrefix + 'ChatGPT Work'))
$script:ChineseCodexDescription = -join @([char]0x6784, [char]0x5EFA, [char]0x3001, [char]0x8C03,
    [char]0x8BD5, [char]0x548C, [char]0x53D1, [char]0x5E03)
$script:CodexMenuNames = @('Codex Build, debug, and ship', ('Codex ' + $script:ChineseCodexDescription))
function Get-DesktopModeKind([string]$Name) {
    if ($script:CodexModeNames -ccontains $Name) { return 'codex' }
    if ($script:ChatGPTModeNames -ccontains $Name) { return 'chatgpt' }
    return $null
}
function Test-DesktopCodexMenuName([string]$Name) {
    return $script:CodexMenuNames -ccontains $Name
}
function Get-ThreadIdFromDesktopDeepLink([string]$Value) {
    # Accept only the exact locally observed chat link shape. Do not normalize,
    # trim, decode or accept URL query/fragment/userinfo/port variants.
    if ($Value.Length -ne 52) { return $null }
    $match = [Text.RegularExpressions.Regex]::Match($Value,
        '\Acodex://threads/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\z')
    if (-not $match.Success) { return $null }
    return $match.Groups[1].Value.ToLowerInvariant()
}
function Get-CopiedComposerTextProof([string]$NormalizedCopiedText) {
    # This value comes from the final actual clipboard read, not from echoing
    # request text. Preserve all user newlines; the caller normalizes only CRLF.
    $bytes = [Text.Encoding]::UTF8.GetBytes($NormalizedCopiedText)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $hash = $algorithm.ComputeHash($bytes) } finally { $algorithm.Dispose() }
    return @{ version = 1; sha256 = [BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant(); utf8Bytes = $bytes.Length }
}

function Fail-Relay([string]$Code, [string]$Reason) {
    $script:FailureCode = $Code
    $script:FailureReason = $Reason
    throw (New-Object InvalidOperationException('Pocket Bridge desktop relay stopped.'))
}
function Check-Deadline {
    $limit = 32000
    if ($script:RecoveringDraft) { $limit = 36000 }
    if ($script:Started.ElapsedMilliseconds -gt $limit) {
        Fail-Relay 'unknown' 'Desktop relay timed out before a verified result.'
    }
}

$result = $null
try {
    $raw = [Console]::In.ReadToEnd()
    if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 131072) { Fail-Relay 'target-mismatch' 'Desktop relay input is too large.' }
    $inputData = $raw | ConvertFrom-Json
    if ($inputData.action -ne 'inspect' -and $inputData.action -ne 'send') { Fail-Relay 'target-mismatch' 'Invalid desktop relay action.' }

    # Shared with every desktop adapter. Hold through clipboard restoration;
    # process termination abandons the OS mutex instead of admitting concurrent
    # native input while a timed-out helper is still alive.
    $script:Stage = 'acquire-desktop-action'
    $desktopSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $script:DesktopUiMutex = New-Object Threading.Mutex($false, ('Local\PocketBridge.DesktopUi.' + $desktopSid))
    try { $script:DesktopUiMutexOwned = $script:DesktopUiMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $script:DesktopUiMutexOwned = $true }
    if (-not $script:DesktopUiMutexOwned) {
        Fail-Relay 'desktop-busy' 'Another desktop action is in progress. Try again after it finishes.'
    }

    Add-Type -AssemblyName System.Windows.Forms, UIAutomationClient, UIAutomationTypes, System.Runtime.WindowsRuntime
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
[ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface BridgeApplicationActivationManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
    [PreserveSig] int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        IntPtr itemArray, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);
    [PreserveSig] int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        IntPtr itemArray, out uint processId);
}
public static class BridgeDesktopNative {
    private delegate bool EnumProc(IntPtr hwnd, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint sharing, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder text, uint length, uint flags);
    [DllImport("ole32.dll", ExactSpelling=true)]
    private static extern int CoCreateInstance(ref Guid classId, IntPtr outer, uint context,
        ref Guid interfaceId, [MarshalAs(UnmanagedType.Interface)] out BridgeApplicationActivationManager manager);
    [DllImport("ole32.dll", ExactSpelling=true)]
    private static extern int CoAllowSetForegroundWindow([MarshalAs(UnmanagedType.IUnknown)] object manager, IntPtr reserved);
    public static uint LaunchApplication(string appUserModelId) {
        if (appUserModelId != "OpenAI.Codex_2p2nqsd0c76g0!App") throw new ArgumentException("Invalid desktop activation target.");
        Guid classId=new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C");
        Guid activationId=new Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D");
        BridgeApplicationActivationManager manager=null;
        try {
            // Short-lived helpers use the Microsoft-recommended out-of-process activation manager.
            Marshal.ThrowExceptionForHR(CoCreateInstance(ref classId, IntPtr.Zero, 4, ref activationId, out manager));
            // This grants no new privilege; subsequent code still requires verified foreground ownership.
            CoAllowSetForegroundWindow(manager, IntPtr.Zero);
            uint processId;
            // Launch only. Full-trust desktop protocol navigation uses the documented WinRT Launcher below.
            Marshal.ThrowExceptionForHR(manager.ActivateApplication(appUserModelId, null, 2, out processId));
            return processId;
        } finally {
            if (manager != null) Marshal.FinalReleaseComObject(manager);
        }
    }
    public static int WindowProcess(IntPtr hwnd) { uint process; GetWindowThreadProcessId(hwnd, out process); return (int)process; }
    public static IntPtr[] VisibleWindows() {
        var windows = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) { if (IsWindowVisible(hwnd)) windows.Add(hwnd); return true; }, IntPtr.Zero);
        return windows.ToArray();
    }
    public static string FinalDirectoryPath(string path) {
        if (!System.IO.Directory.Exists(path)) throw new ArgumentException("Directory unavailable.");
        using (var handle=CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new InvalidOperationException("Directory identity unavailable.");
            var text=new StringBuilder(32768);
            uint length=GetFinalPathNameByHandle(handle,text,(uint)text.Capacity,0);
            if (length==0 || length>=text.Capacity) throw new InvalidOperationException("Directory identity unavailable.");
            string value=text.ToString();
            if(value.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase)) value=@"\\"+value.Substring(8);
            else if(value.StartsWith(@"\\?\",StringComparison.Ordinal)) value=value.Substring(4);
            string root=System.IO.Path.GetPathRoot(value);
            return value.Length>root.Length ? value.TrimEnd('\\','/') : value;
        }
    }
}
'@

    function Get-TrustedDesktop {
        $packages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -eq 'OpenAI.Codex' -and $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0'
        })
        if ($packages.Count -ne 1) { Fail-Relay 'desktop-unavailable' 'The verified OpenAI desktop package is unavailable.' }
        $package = $packages[0]
        $manifest = New-Object Xml.XmlDocument
        $manifest.XmlResolver = $null
        $manifest.Load((Join-Path $package.InstallLocation 'AppxManifest.xml'))
        $identity = $manifest.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Identity']")
        if ($identity.GetAttribute('Publisher') -ne 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B') {
            Fail-Relay 'desktop-unavailable' 'The desktop publisher identity could not be verified.'
        }
        $application = $manifest.SelectSingleNode("//*[local-name()='Application' and @Id='App']")
        if ($null -eq $application) { Fail-Relay 'desktop-unavailable' 'The verified desktop application is unavailable.' }
        $protocol = $application.SelectSingleNode(".//*[local-name()='Extension' and @Category='windows.protocol']/*[local-name()='Protocol' and @Name='codex']")
        if ($null -eq $protocol) { Fail-Relay 'desktop-unavailable' 'The desktop thread URL handler is unavailable.' }
        $relativeExecutable = $application.GetAttribute('Executable').Replace('/', '\')
        $packageRoot = [IO.Path]::GetFullPath($package.InstallLocation).TrimEnd('\')
        $executable = [IO.Path]::GetFullPath((Join-Path $packageRoot $relativeExecutable))
        if (-not $executable.StartsWith($packageRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetExtension($executable) -ne '.exe' -or -not [IO.File]::Exists($executable)) {
            Fail-Relay 'desktop-unavailable' 'The desktop executable identity could not be verified.'
        }
        $desktop = [pscustomobject]@{ Package = $package; ExecutablePath = $executable;
            AppUserModelId = $package.PackageFamilyName + '!' + $application.GetAttribute('Id'); Processes = @(); Windows = @() }
        Update-DesktopProcesses $desktop
        return $desktop
    }
    function Update-DesktopProcesses($Desktop) {
        $processName = [IO.Path]::GetFileName($Desktop.ExecutablePath).Replace("'", "''")
        $processes = @(Get-CimInstance Win32_Process -Filter ("Name='" + $processName + "'") | Where-Object {
            $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $Desktop.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)
        } | ForEach-Object {
            [pscustomobject]@{ ProcessId = [int]$_.ProcessId; CreationTicks = $_.CreationDate.ToUniversalTime().Ticks; ExecutablePath = $Desktop.ExecutablePath }
        })
        $windows = @([BridgeDesktopNative]::VisibleWindows() | Where-Object {
            $windowOwner = [BridgeDesktopNative]::WindowProcess($_)
            @($processes | Where-Object { $_.ProcessId -eq $windowOwner }).Count -eq 1
        })
        $Desktop.Processes = $processes
        $Desktop.Windows = $windows
    }
    function Activate-DesktopThread($Desktop, [string]$ThreadId) {
        Check-Deadline
        Update-DesktopProcesses $Desktop
        if ($Desktop.Processes.Count -eq 0) {
            # Launch the exact registered main package only if no verified main process exists.
            $null = [BridgeDesktopNative]::LaunchApplication($Desktop.AppUserModelId)
        }
        $launcherType = [Windows.System.Launcher, Windows.System, ContentType=WindowsRuntime]
        $optionsType = [Windows.System.LauncherOptions, Windows.System, ContentType=WindowsRuntime]
        $options = [Activator]::CreateInstance($optionsType)
        $options.TargetApplicationPackageFamilyName = [string]$Desktop.Package.PackageFamilyName
        $options.DisplayApplicationPicker = $false
        $asTaskMethods = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and
            $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })
        if ($asTaskMethods.Count -ne 1) { Fail-Relay 'desktop-unavailable' 'The Windows targeted launcher is unavailable.' }
        $asTask = $asTaskMethods[0].MakeGenericMethod([bool])
        $uri = New-Object Uri('codex://threads/' + $ThreadId.ToLowerInvariant())
        # Do not guess process arguments or change protocol defaults. Success here is not target confirmation.
        $operation = [Windows.System.Launcher]::LaunchUriAsync($uri, $options)
        $task = $asTask.Invoke($null, @($operation))
        $remaining = [Math]::Max(1, [Math]::Min(12000, 32000 - $script:Started.ElapsedMilliseconds))
        if (-not $task.Wait([int]$remaining)) { Fail-Relay 'desktop-unavailable' 'Windows thread navigation timed out. No message was sent.' }
        if (-not $task.Result) { Fail-Relay 'desktop-unavailable' 'Windows could not navigate the verified desktop thread.' }
        Check-Deadline
    }
    function Check-ProcessIdentity($Desktop, [int]$ProcessId) {
        Check-Deadline
        $expected = @($Desktop.Processes | Where-Object { $_.ProcessId -eq $ProcessId })
        $actual = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction SilentlyContinue
        if ($expected.Count -ne 1 -or $null -eq $actual -or -not $actual.ExecutablePath -or
            -not [string]::Equals([IO.Path]::GetFullPath($actual.ExecutablePath), $Desktop.ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
            $actual.CreationDate.ToUniversalTime().Ticks -ne $expected[0].CreationTicks) {
            Fail-Relay 'target-mismatch' 'The verified desktop process changed. No message was sent.'
        }
    }
    function Check-BoundForeground {
        Check-ProcessIdentity $script:Desktop $script:BoundProcess
        $foregroundIsBound = Foreground-IsBoundWindow
        if (-not [BridgeDesktopNative]::IsWindow($script:BoundWindow) -or
            [BridgeDesktopNative]::WindowProcess($script:BoundWindow) -ne $script:BoundProcess -or
            -not $foregroundIsBound) {
            # This fixed numeric context is private driver evidence only. Never
            # inspect or record window titles, accessibility names or clipboard.
            $script:FailureForegroundObservation = $script:LastForegroundObservation
            Fail-Relay 'target-mismatch' 'Desktop focus changed. No further input was sent.'
        }
    }
    function Foreground-IsBoundWindow {
        $foreground = [BridgeDesktopNative]::GetForegroundWindow()
        $foregroundExists = $foreground -ne [IntPtr]::Zero -and [BridgeDesktopNative]::IsWindow($foreground)
        $foregroundProcess = 0
        $foregroundRoot = [IntPtr]::Zero
        $foregroundRootProcess = 0
        if ($foregroundExists) {
            $foregroundProcess = [BridgeDesktopNative]::WindowProcess($foreground)
            $foregroundRoot = [BridgeDesktopNative]::GetAncestor($foreground, 2)
            if ($foregroundRoot -ne [IntPtr]::Zero) { $foregroundRootProcess = [BridgeDesktopNative]::WindowProcess($foregroundRoot) }
        }
        $script:LastForegroundObservation = @{ foregroundHandle = $foreground.ToInt64().ToString();
            foregroundProcessId = $foregroundProcess; foregroundRootHandle = $foregroundRoot.ToInt64().ToString();
            foregroundRootProcessId = $foregroundRootProcess; boundWindowHandle = $script:BoundWindow.ToInt64().ToString();
            boundProcessId = $script:BoundProcess; identityCopyKind = $script:IdentityCopyKind;
            identityCopyPhase = $script:IdentityCopyPhase; elapsedMs = $script:Started.ElapsedMilliseconds }
        if (-not $foregroundExists -or $foregroundProcess -ne $script:BoundProcess) { return $false }
        # Chromium may focus its real child render widget. Only the same process's
        # GA_ROOT ancestry is accepted; GA_ROOTOWNER would also admit independent modal windows.
        return $foreground -eq $script:BoundWindow -or $foregroundRoot -eq $script:BoundWindow
    }
    function Save-Clipboard {
        if ($script:ClipboardSaved) { return }
        $original = [Windows.Forms.Clipboard]::GetDataObject()
        $backup = New-Object Windows.Forms.DataObject
        if ($null -ne $original) {
            foreach ($format in $original.GetFormats($false)) {
                $value = $original.GetData($format, $false)
                if ($value -is [IO.Stream]) {
                    $position = $value.Position
                    $copy = New-Object IO.MemoryStream
                    $value.Position = 0
                    $value.CopyTo($copy)
                    $value.Position = $position
                    $copy.Position = 0
                    $value = $copy
                } elseif ($value -is [ICloneable]) { $value = $value.Clone() }
                $backup.SetData($format, $false, $value)
            }
        }
        $script:ClipboardBackup = $backup
        $script:ClipboardSaved = $true
    }
    function Copy-DesktopIdentity([string]$Keys, [ValidateSet('thread', 'cwd')][string]$Kind) {
        $script:IdentityCopyKind = $Kind
        $script:IdentityCopyPhase = 'before-sentinel'
        Check-BoundForeground
        $sentinel = 'PocketBridgeIdentity-' + [Guid]::NewGuid().ToString('D')
        [Windows.Forms.Clipboard]::SetText($sentinel, [Windows.Forms.TextDataFormat]::UnicodeText)
        $before = [BridgeDesktopNative]::GetClipboardSequenceNumber()
        $script:IdentityCopyPhase = 'before-shortcut'
        Check-BoundForeground
        $modifiers = [ordered]@{ shift = 0x10; control = 0x11; alt = 0x12;
            leftShift = 0xA0; rightShift = 0xA1; leftControl = 0xA2; rightControl = 0xA3;
            leftAlt = 0xA4; rightAlt = 0xA5; leftWin = 0x5B; rightWin = 0x5C }
        $states = [ordered]@{}
        foreach ($name in $modifiers.Keys) { $states[$name] = [BridgeDesktopNative]::GetAsyncKeyState($modifiers[$name]) -lt 0 }
        $script:IdentityModifierObservation = $states
        if (@($states.Values | Where-Object { $_ }).Count -ne 0) {
            Fail-Relay 'target-mismatch' 'A modifier key is already pressed. Release the keys before retrying; no further input was sent.'
        }
        [Windows.Forms.SendKeys]::SendWait($Keys)
        $script:IdentityCopyPhase = 'after-shortcut'
        for ($attempt = 0; $attempt -lt 25; $attempt++) {
            Check-BoundForeground
            if ([BridgeDesktopNative]::GetClipboardSequenceNumber() -ne $before -and
                [Windows.Forms.Clipboard]::ContainsText([Windows.Forms.TextDataFormat]::UnicodeText)) {
                $value = [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText)
                if ($value -ne $sentinel) {
                    $script:IdentityCopyPhase = 'complete'
                    $script:IdentityCopyKind = 'none'
                    return $value
                }
            }
            $script:IdentityCopyPhase = 'poll-shortcut'
            Start-Sleep -Milliseconds 80
        }
        Fail-Relay 'target-mismatch' 'The desktop did not provide its session and directory identity.'
    }
    function Verify-ThreadTarget([bool]$WaitForNavigation = $false) {
        $attempts = 1
        if ($WaitForNavigation) { $attempts = 12 }
        $threadVerified = $false
        for ($navigationAttempt = 0; $navigationAttempt -lt $attempts; $navigationAttempt++) {
            $identityComposer = Find-Composer
            Focus-Composer $identityComposer
            $actualThread = Get-ThreadIdFromDesktopDeepLink (Copy-DesktopIdentity '^%l' 'thread')
            if ($null -ne $actualThread -and
                [string]::Equals($actualThread, $inputData.threadId, [StringComparison]::OrdinalIgnoreCase)) {
                $threadVerified = $true
                break
            }
            if ($navigationAttempt + 1 -lt $attempts) { Start-Sleep -Milliseconds 200 }
        }
        if (-not $threadVerified) {
            Fail-Relay 'target-mismatch' 'The desktop session differs from the requested conversation.'
        }
        # Ctrl+Shift+C copies a browser URL when browser focus is active. Bind
        # keyboard focus to this exact conversation's composer before copying cwd.
        $directoryComposer = Find-Composer
        Focus-Composer $directoryComposer
        $actualDirectory = Copy-DesktopIdentity '^+c' 'cwd'
        try { $canonicalDirectory = [BridgeDesktopNative]::FinalDirectoryPath($actualDirectory) }
        catch { Fail-Relay 'target-mismatch' 'The desktop working directory could not be verified.' }
        if (-not [string]::Equals($canonicalDirectory, $script:RequestedDirectory, [StringComparison]::OrdinalIgnoreCase)) {
            Fail-Relay 'target-mismatch' 'The desktop working directory differs from the requested project.'
        }
        return $canonicalDirectory
    }
    function Runtime-IdsEqual($Left, $Right) {
        return [string]::Join(',', $Left.GetRuntimeId()) -eq [string]::Join(',', $Right.GetRuntimeId())
    }
    function Element-IsInBoundWindow($Element) {
        $current = $Element
        for ($depth = 0; $depth -lt 60 -and $null -ne $current; $depth++) {
            if (Runtime-IdsEqual $current $script:WindowElement) { return $true }
            $current = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($current)
        }
        return $false
    }
    function Get-ReadyComposerSelection($Element, [bool]$RequireFocus) {
        for ($readyAttempt = 0; $readyAttempt -lt 10; $readyAttempt++) {
            Check-BoundForeground
            $fresh = Find-Composer
            if (-not (Runtime-IdsEqual $fresh $Element)) { Fail-Relay 'composer-unavailable' 'The desktop composer changed while reading its selection.' }
            if ($RequireFocus) { Check-ComposerFocus $fresh }
            try {
                $pattern = $null
                if ($fresh.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$pattern) -and
                    $pattern.SupportedTextSelection -ne [Windows.Automation.SupportedTextSelection]::None) {
                    $selection = @($pattern.GetSelection())
                    if ($selection.Count -eq 1) {
                        $selectedText = [string]$selection[0].GetText(-1)
                        $endpoint = $selection[0].CompareEndpoints([Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
                            $selection[0], [Windows.Automation.Text.TextPatternRangeEndpoint]::End)
                        if (($endpoint -eq 0 -and $selectedText.Length -eq 0) -or
                            ($endpoint -lt 0 -and $selectedText.Length -gt 0)) {
                            return [pscustomobject]@{ Element = $fresh; Pattern = $pattern; Selection = $selection;
                                Text = $selectedText; Endpoint = $endpoint; Document = [string]$pattern.DocumentRange.GetText(-1) }
                        }
                    }
                }
            } catch { # Chromium may briefly expose a stale/unsupported pattern during a key-event update.
            }
            Start-Sleep -Milliseconds 50
        }
        Fail-Relay 'composer-unavailable' 'The desktop composer selection did not become safely readable.'
    }
    function Test-EmptyPlaceholderComposer($Element) {
        Check-BoundForeground
        $fresh = Find-Composer
        if (-not (Runtime-IdsEqual $fresh $Element)) { return $false }
        $priorStage = $script:Stage
        $layout = Get-ComposerLayoutBody $fresh
        $script:Stage = $priorStage
        try {
            # The current desktop exposes its CSS placeholder as document/value
            # text. Prove the entire observed raw subtree, never Name equality
            # alone: a real draft containing the same words must remain a draft.
            $walker = [Windows.Automation.TreeWalker]::RawViewWalker
            $placeholder = $walker.GetFirstChild($fresh)
            if ($null -eq $placeholder -or $placeholder.Current.ControlType -ne [Windows.Automation.ControlType]::Group -or
                $placeholder.Current.ClassName -cne 'placeholder' -or $placeholder.Current.Name.Length -ne 0 -or
                $null -ne $walker.GetNextSibling($placeholder)) { return $false }
            $labelGroup = $walker.GetFirstChild($placeholder)
            if ($null -eq $labelGroup -or $labelGroup.Current.ControlType -ne [Windows.Automation.ControlType]::Group -or
                $labelGroup.Current.ClassName.Length -ne 0 -or $labelGroup.Current.Name.Length -ne 0) { return $false }
            $break = $walker.GetNextSibling($labelGroup)
            if ($null -eq $break -or $break.Current.ControlType -ne [Windows.Automation.ControlType]::Text -or
                $break.Current.ClassName -cne 'ProseMirror-trailingBreak' -or $break.Current.Name -cne "`n" -or
                $null -ne $walker.GetNextSibling($break) -or $null -ne $walker.GetFirstChild($break)) { return $false }
            $label = $walker.GetFirstChild($labelGroup)
            $name = [string]$fresh.Current.Name
            if ($name.Length -eq 0 -or $null -eq $label -or $label.Current.ControlType -ne [Windows.Automation.ControlType]::Text -or
                $label.Current.ClassName.Length -ne 0 -or $label.Current.Name -cne $name -or
                $null -ne $walker.GetNextSibling($label) -or $null -ne $walker.GetFirstChild($label)) { return $false }
            foreach ($node in @($placeholder, $labelGroup, $break, $label)) {
                if ($node.Current.ProcessId -ne $fresh.Current.ProcessId -or $node.Current.IsKeyboardFocusable -or
                    $node.Current.IsPassword -or -not (Element-IsInBoundWindow $node)) { return $false }
            }
            if (-not (Runtime-IdsEqual ($walker.GetParent($placeholder)) $fresh) -or
                -not (Runtime-IdsEqual ($walker.GetParent($labelGroup)) $placeholder) -or
                -not (Runtime-IdsEqual ($walker.GetParent($break)) $placeholder) -or
                -not (Runtime-IdsEqual ($walker.GetParent($label)) $labelGroup)) { return $false }
            $text = $null; $value = $null
            if (-not $fresh.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$text) -or
                -not $fresh.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$value) -or
                $value.Current.IsReadOnly -or [string]$text.DocumentRange.GetText(-1) -cne ($name + "`n") -or
                [string]$value.Current.Value -cne ($name + "`n")) { return $false }
            if (-not (Test-ObservedEmptyComposerLayout $layout $fresh)) { return $false }
            # Requery identity/ancestry once more after reading the raw subtree.
            if (-not (Runtime-IdsEqual (Find-Composer) $fresh) -or
                -not (Runtime-IdsEqual (Get-ComposerLayoutBody $fresh) $layout)) { return $false }
            $script:Stage = $priorStage
            Check-BoundForeground
            return $true
        } catch { return $false }
    }
    function Test-ObservedEmptyComposerLayout($Layout, $Composer) {
        # Closed raw tree from the actual installed attachment-free composer:
        # editor, add, permissions, model, dictation, voice. Unknown nodes (such
        # as attachments) or an actual Send button invalidate this empty proof.
        $walker = [Windows.Automation.TreeWalker]::RawViewWalker
        $sendNames = @('Send', ([string][char]0x53D1 + [string][char]0x9001))
        function Get-ObservedRawChildren($Parent, [int]$Expected) {
            $children = New-Object Collections.Generic.List[object]
            $node = $walker.GetFirstChild($Parent)
            while ($null -ne $node -and $children.Count -le $Expected) {
                Check-Deadline
                if ($node.Current.ProcessId -ne $Composer.Current.ProcessId -or $node.Current.IsPassword -or
                    -not (Element-IsInBoundWindow $node) -or
                    -not (Runtime-IdsEqual ($walker.GetParent($node)) $Parent)) { return @() }
                if ($node.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and
                    $sendNames -ccontains $node.Current.Name) { return @() }
                $children.Add($node)
                $node = $walker.GetNextSibling($node)
            }
            if ($children.Count -ne $Expected -or $null -ne $node) { return @() }
            return $children.ToArray()
        }
        function Test-ObservedButton($Node, [string[]]$Tokens) {
            if ($Node.Current.ControlType -ne [Windows.Automation.ControlType]::Button -or
                -not $Node.Current.IsEnabled -or $Node.Current.IsOffscreen -or
                -not $Node.Current.IsKeyboardFocusable -or $sendNames -ccontains $Node.Current.Name) { return $false }
            $classes = @($Node.Current.ClassName -split '\s+')
            foreach ($token in $Tokens) { if (-not ($classes -ccontains $token)) { return $false } }
            return $true
        }
        $children = @(Get-ObservedRawChildren $Layout 6)
        if ($children.Count -ne 6 -or -not (Runtime-IdsEqual $children[0] $Composer)) { return $false }
        foreach ($index in @(1, 3, 4, 5)) {
            if ($children[$index].Current.ControlType -ne [Windows.Automation.ControlType]::Group -or
                $children[$index].Current.ClassName -cne 'contents' -or $children[$index].Current.IsKeyboardFocusable) { return $false }
        }
        $add = @(Get-ObservedRawChildren $children[1] 1)
        $model = @(Get-ObservedRawChildren $children[3] 1)
        $dictation = @(Get-ObservedRawChildren $children[4] 1)
        $voice = @(Get-ObservedRawChildren $children[5] 1)
        if ($add.Count -ne 1 -or $model.Count -ne 1 -or $dictation.Count -ne 1 -or $voice.Count -ne 1 -or
            -not (Test-ObservedButton $add[0] @('h-token-button-composer', 'aspect-square', '!px-0')) -or
            -not (Test-ObservedButton $children[2] @('h-token-button-composer', 'min-w-token-button-composer', 'px-1.5')) -or
            -not (Test-ObservedButton $model[0] @('h-token-button-composer', 'min-w-0', 'px-2')) -or
            -not (Test-ObservedButton $dictation[0] @('h-token-button-composer', 'aspect-square', '!px-0')) -or
            -not (Test-ObservedButton $voice[0] @('size-token-button-composer', 'bg-composer-primary'))) { return $false }
        foreach ($leaf in @($add[0], $model[0], $voice[0])) {
            if ($null -ne $walker.GetFirstChild($leaf)) { return $false }
        }
        $permission = @(Get-ObservedRawChildren $children[2] 2)
        if ($permission.Count -ne 2 -or $permission[0].Current.ControlType -ne [Windows.Automation.ControlType]::Image -or
            $permission[0].Current.ClassName -cne 'icon-xs shrink-0 text-warning' -or
            $permission[1].Current.ControlType -ne [Windows.Automation.ControlType]::Group -or
            -not $permission[1].Current.ClassName.StartsWith('_ComposerDropdownLabelValueContent_', [StringComparison]::Ordinal) -or
            $null -ne $walker.GetFirstChild($permission[0])) { return $false }
        $permissionLabel = @(Get-ObservedRawChildren $permission[1] 1)
        if ($permissionLabel.Count -ne 1 -or $permissionLabel[0].Current.ControlType -ne [Windows.Automation.ControlType]::Text -or
            $permissionLabel[0].Current.ClassName.Length -ne 0 -or $null -ne $walker.GetFirstChild($permissionLabel[0])) { return $false }
        $dictationIcon = @(Get-ObservedRawChildren $dictation[0] 1)
        if ($dictationIcon.Count -ne 1 -or $dictationIcon[0].Current.ControlType -ne [Windows.Automation.ControlType]::Image -or
            $dictationIcon[0].Current.ClassName -cne 'icon-leading text-default' -or
            $null -ne $walker.GetFirstChild($dictationIcon[0])) { return $false }
        return $true
    }
    function Get-ComposerText($Element, [bool]$RestoreSelection = $true) {
        if (-not $script:ClipboardSaved) { Fail-Relay 'composer-unavailable' 'The desktop clipboard has not been preserved.' }
        if (Test-EmptyPlaceholderComposer $Element) { return '' }
        $original = Get-ReadyComposerSelection $Element $false
        $originalDocument = $original.Document
        $restoreRange = $original.Selection[0].Clone()
        try {
            Focus-Composer $Element
            [Windows.Forms.SendKeys]::SendWait('^a')
            # Real native countertests use this event-settling interval. A transient None
            # pattern must not be mistaken for either an empty draft or permanent failure.
            Start-Sleep -Milliseconds 200
            # Requery the actual focused editor. Value/DocumentRange include CSS placeholders
            # and ProseMirror's artificial trailing break in the installed desktop version.
            $ready = Get-ReadyComposerSelection $Element $true
            $fresh = $ready.Element
            $pattern = $ready.Pattern
            $selectedText = $ready.Text
            $endpoint = $ready.Endpoint
            # Paired real empty/literal-placeholder/newline tests established this distinction.
            # Never equate the editor's accessible name with an empty user draft.
            if ($endpoint -eq 0 -and $selectedText.Length -eq 0) { return '' }
            if ($endpoint -ge 0 -or $selectedText.Length -eq 0) {
                Fail-Relay 'composer-unavailable' 'The desktop composer selection could not be verified.'
            }
            $sentinel = 'PocketBridgeComposer-' + [Guid]::NewGuid().ToString('D')
            [Windows.Forms.Clipboard]::SetText($sentinel, [Windows.Forms.TextDataFormat]::UnicodeText)
            $before = [BridgeDesktopNative]::GetClipboardSequenceNumber()
            Check-ComposerFocus $fresh
            [Windows.Forms.SendKeys]::SendWait('^c')
            for ($attempt = 0; $attempt -lt 20; $attempt++) {
                Check-ComposerFocus $fresh
                if ([BridgeDesktopNative]::GetClipboardSequenceNumber() -ne $before -and
                    [Windows.Forms.Clipboard]::ContainsText([Windows.Forms.TextDataFormat]::UnicodeText)) {
                    $copied = [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText)
                    if ($copied -cne $sentinel -and $copied.Length -gt 0) {
                        $latest = @($pattern.GetSelection())
                        if ($latest.Count -ne 1 -or [string]$latest[0].GetText(-1) -cne $selectedText -or
                            $latest[0].CompareEndpoints([Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
                                $latest[0], [Windows.Automation.Text.TextPatternRangeEndpoint]::End) -ge 0) {
                            Fail-Relay 'composer-unavailable' 'The desktop draft changed while copying its text.'
                        }
                        # Clipboard text excludes only UIA's fake break; keep every real trailing newline.
                        return [string]$copied
                    }
                }
                Start-Sleep -Milliseconds 50
            }
            Fail-Relay 'composer-unavailable' 'The desktop composer did not copy its actual selected text.'
        } finally {
            if ($RestoreSelection -and $null -ne $restoreRange) {
                try {
                    # Old text ranges are invalid after edits. Restore only an unchanged editor,
                    # and never reclaim focus after the user/app moved elsewhere.
                    Check-BoundForeground
                    $current = Find-Composer
                    Check-ComposerFocus $current
                    $currentPattern = $null
                    if ((Runtime-IdsEqual $current $Element) -and
                        $current.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$currentPattern) -and
                        [string]$currentPattern.DocumentRange.GetText(-1) -ceq $originalDocument) { $restoreRange.Select() }
                } catch { }
            }
        }
    }
    function Get-CodexComposerCandidates($Root, [bool]$AllowOffscreen = $false) {
        $candidates = New-Object Collections.Generic.List[object]
        $condition = New-Object Windows.Automation.PropertyCondition(
            [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Edit)
        foreach ($element in $Root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
            Check-Deadline
            # Grounded in the actual installed desktop's accessible composer, not an arbitrary input.
            if (-not (@($element.Current.ClassName -split '\s+') -ccontains 'ProseMirror') -or -not $element.Current.IsEnabled -or
                (-not $AllowOffscreen -and $element.Current.IsOffscreen) -or
                -not $element.Current.IsKeyboardFocusable -or $element.Current.IsPassword) { continue }
            $pattern = $null
            $editable = $false
            if ($element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                $editable = -not $pattern.Current.IsReadOnly
            } elseif ($element.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
                $attribute = $pattern.DocumentRange.GetAttributeValue([Windows.Automation.TextPattern]::IsReadOnlyAttribute)
                $editable = $attribute -is [bool] -and -not $attribute
            }
            if ($editable) { $candidates.Add($element) }
        }
        return $candidates.ToArray()
    }
    function Get-DesktopModeControls($Root, [bool]$AllowOffscreen = $false) {
        $condition = New-Object Windows.Automation.PropertyCondition(
            [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
        return @($Root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition) | Where-Object {
            $null -ne (Get-DesktopModeKind $_.Current.Name) -and $_.Current.IsEnabled -and ($AllowOffscreen -or -not $_.Current.IsOffscreen)
        })
    }
    function Get-DesktopMainWindows($Desktop) {
        $matches = New-Object Collections.Generic.List[object]
        foreach ($window in $Desktop.Windows) {
            Check-Deadline
            $processId = [BridgeDesktopNative]::WindowProcess($window)
            Check-ProcessIdentity $Desktop $processId
            try {
                $root = [Windows.Automation.AutomationElement]::FromHandle($window)
                $allowOffscreen = [BridgeDesktopNative]::IsIconic($window)
                $composers = @(Get-CodexComposerCandidates $root $allowOffscreen)
                $modeControls = @(Get-DesktopModeControls $root $allowOffscreen)
                if ($composers.Count -eq 1 -and $modeControls.Count -eq 1) {
                    $matches.Add([pscustomobject]@{ Window = $window; Root = $root; Composer = $composers[0]; ProcessId = $processId })
                }
            } catch { # A stale/empty overlay is not a verified conversation window.
                Check-Deadline
            }
        }
        return $matches.ToArray()
    }
    function Focus-CodexMainWindow($Candidate) {
        for ($focusAttempt = 0; $focusAttempt -lt 5; $focusAttempt++) {
            Check-ProcessIdentity $script:Desktop $script:BoundProcess
            if ([BridgeDesktopNative]::IsIconic($script:BoundWindow)) { $null = [BridgeDesktopNative]::ShowWindow($script:BoundWindow, 9) }
            $null = [BridgeDesktopNative]::SetForegroundWindow($script:BoundWindow)
            if (-not (Foreground-IsBoundWindow)) {
                try { $Candidate.Root.SetFocus() } catch { }
            }
            if (-not (Foreground-IsBoundWindow)) {
                try { $Candidate.Composer.SetFocus() } catch { }
            }
            if (Foreground-IsBoundWindow) { Check-BoundForeground; return }
            Start-Sleep -Milliseconds 100
        }
        Fail-Relay 'target-mismatch' 'The verified Codex conversation window could not receive foreground focus.'
    }
    function Bind-DesktopMainWindow {
        $script:BoundWindow = [IntPtr]::Zero
        $candidate = $null
        for ($attempt = 0; $attempt -lt 80; $attempt++) {
            Check-Deadline
            Update-DesktopProcesses $script:Desktop
            $mainWindows = @(Get-DesktopMainWindows $script:Desktop)
            if ($mainWindows.Count -gt 1) { Fail-Relay 'target-mismatch' 'More than one verified desktop conversation window is open.' }
            if ($mainWindows.Count -eq 1) { $candidate = $mainWindows[0]; $script:BoundWindow = $candidate.Window; break }
            Start-Sleep -Milliseconds 80
        }
        if ($script:BoundWindow -eq [IntPtr]::Zero) {
            Fail-Relay 'composer-unavailable' 'The verified desktop conversation window could not be identified.'
        }
        $script:BoundProcess = $candidate.ProcessId
        $script:WindowElement = $candidate.Root
        Check-ProcessIdentity $script:Desktop $script:BoundProcess
        Focus-CodexMainWindow $candidate
    }
    function Ensure-CodexMode {
        $script:Stage = 'verify-mode'
        Check-BoundForeground
        $modes = @(Get-DesktopModeControls $script:WindowElement)
        if ($modes.Count -ne 1) { Fail-Relay 'target-mismatch' 'A unique verified desktop mode control is unavailable.' }
        if ((Get-DesktopModeKind $modes[0].Current.Name) -ceq 'codex') { return $false }
        $script:Stage = 'read-chatgpt-draft'
        $workComposers = @(Get-CodexComposerCandidates $script:WindowElement)
        if ($workComposers.Count -ne 1 -or (Get-ComposerText $workComposers[0]).Length -ne 0) {
            Fail-Relay 'draft-present' 'An existing ChatGPT draft was preserved. Switch to Codex before retrying.'
        }
        $script:Stage = 'switch-mode'
        $expand = $null
        if (-not $modes[0].TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expand)) {
            Fail-Relay 'target-mismatch' 'The observed ChatGPT mode menu could not be opened safely.'
        }
        Check-BoundForeground
        if ($expand.Current.ExpandCollapseState -ne [Windows.Automation.ExpandCollapseState]::Expanded) { $expand.Expand() }
        $condition = New-Object Windows.Automation.PropertyCondition(
            [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::MenuItem)
        $selection = $null
        for ($attempt = 0; $attempt -lt 25; $attempt++) {
            Check-BoundForeground
            $items = @($script:WindowElement.FindAll([Windows.Automation.TreeScope]::Descendants, $condition) | Where-Object {
                (Test-DesktopCodexMenuName $_.Current.Name) -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen
            })
            if ($items.Count -gt 1) { Fail-Relay 'target-mismatch' 'The observed Codex mode menu item is ambiguous.' }
            if ($items.Count -eq 1) { $selection = $items[0]; break }
            Start-Sleep -Milliseconds 80
        }
        $invoke = $null
        if ($null -eq $selection -or -not (Element-IsInBoundWindow $selection) -or
            -not $selection.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
            Fail-Relay 'target-mismatch' 'The observed Codex mode menu item could not be invoked safely.'
        }
        Check-BoundForeground
        $invoke.Invoke()
        for ($attempt = 0; $attempt -lt 25; $attempt++) {
            Check-BoundForeground
            $modes = @(Get-DesktopModeControls $script:WindowElement)
            if ($modes.Count -eq 1 -and (Get-DesktopModeKind $modes[0].Current.Name) -ceq 'codex') { return $true }
            Start-Sleep -Milliseconds 80
        }
        Fail-Relay 'target-mismatch' 'The verified desktop app did not switch from ChatGPT to Codex.'
    }
    function Protect-OutgoingDesktopDraft {
        $script:Stage = 'read-source-draft'
        Check-BoundForeground
        $modes = @(Get-DesktopModeControls $script:WindowElement)
        $composers = @(Get-CodexComposerCandidates $script:WindowElement)
        if ($modes.Count -ne 1 -or $composers.Count -ne 1) {
            Fail-Relay 'draft-present' 'The current desktop draft could not be verified. No conversation was opened.'
        }
        $mode = Get-DesktopModeKind $modes[0].Current.Name
        if ($mode -ceq 'codex') {
            if ((Get-ComposerText $composers[0]).Length -ne 0 -or
                -not (Test-EmptyPlaceholderComposer $composers[0])) {
                Fail-Relay 'draft-present' 'The current desktop draft and attachments were preserved. No conversation was opened.'
            }
        } elseif ($mode -ceq 'chatgpt') {
            # The tested Dot composer is ephemeral across view changes. Prove
            # it is actually blank BEFORE the first thread URI can remount it.
            # Ordinary ChatGPT shapes remain unverified and are left alone.
            $profileName = 'Your dot' + [string][char]0x2019 + 's profile'
            $condition = New-Object Windows.Automation.PropertyCondition(
                [Windows.Automation.AutomationElement]::ControlTypeProperty,
                [Windows.Automation.ControlType]::Window)
            $profiles = @($script:WindowElement.FindAll([Windows.Automation.TreeScope]::Descendants, $condition) | Where-Object {
                $_.Current.Name -ceq $profileName -and -not $_.Current.IsOffscreen -and
                (@($_.Current.ClassName -split '\s+') -ccontains 'codex-dialog') -and
                (Element-IsInBoundWindow $_)
            })
            $guardFile = Join-Path $PSScriptRoot 'dot-desktop-source-guard.ps1'
            if (-not [IO.File]::Exists($guardFile)) {
                Fail-Relay 'draft-present' 'The current ChatGPT draft could not be verified. No conversation was opened.'
            }
            . $guardFile
            $dotBlank = Test-PocketBridgeDotBlankSource $composers[0] $script:WindowElement ([string]$script:Desktop.Package.Version) ($profiles.Count -eq 1)
            if (-not $dotBlank) {
                Fail-Relay 'draft-present' 'The current ChatGPT draft and attachments were preserved. No conversation was opened.'
            }
        } else {
            Fail-Relay 'draft-present' 'The current desktop view could not be verified. No conversation was opened.'
        }
        Check-BoundForeground
    }
    function Find-Composer {
        $candidates = @(Get-CodexComposerCandidates $script:WindowElement)
        if ($candidates.Count -ne 1) { Fail-Relay 'composer-unavailable' 'A unique editable desktop composer could not be verified.' }
        if (-not (Element-IsInBoundWindow $candidates[0])) { Fail-Relay 'composer-unavailable' 'The Codex composer is outside the verified conversation window.' }
        return $candidates[0]
    }
    function Check-CodexMode {
        Check-BoundForeground
        $modes = @(Get-DesktopModeControls $script:WindowElement)
        if ($modes.Count -ne 1 -or (Get-DesktopModeKind $modes[0].Current.Name) -cne 'codex') {
            Fail-Relay 'target-mismatch' 'The verified desktop window is no longer in Codex mode.'
        }
    }
    function Focus-Composer($Element) {
        Check-BoundForeground
        $Element.SetFocus()
        Check-ComposerFocus $Element
    }
    function Check-ComposerFocus($Element) {
        Check-BoundForeground
        $focused = [Windows.Automation.AutomationElement]::FocusedElement
        if ($null -eq $focused -or -not (Element-IsInBoundWindow $focused)) {
            Fail-Relay 'target-mismatch' 'Desktop input focus could not be verified.'
        }
        Check-ProcessIdentity $script:Desktop $focused.Current.ProcessId
        $current = $focused
        for ($depth = 0; $depth -lt 25 -and $null -ne $current; $depth++) {
            if (Runtime-IdsEqual $current $Element) { return }
            $current = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($current)
        }
        Fail-Relay 'target-mismatch' 'The verified composer lost keyboard focus.'
    }
    function Normalized-InputText([string]$Value) { return $Value.Replace("`r`n", "`n") }
    function Get-ComposerLayoutBody($Composer) {
        $script:Stage = 'verify-composer-layout'
        Check-BoundForeground
        $rootComposers = @(Get-CodexComposerCandidates $script:WindowElement)
        if ($rootComposers.Count -ne 1 -or -not (Runtime-IdsEqual $rootComposers[0] $Composer) -or
            -not (Element-IsInBoundWindow $rootComposers[0])) {
            Fail-Relay 'composer-unavailable' 'A unique fresh composer could not verify its layout.'
        }
        $current = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($rootComposers[0])
        for ($depth = 0; $depth -lt 15 -and $null -ne $current; $depth++) {
            Check-Deadline
            if (Runtime-IdsEqual $current $script:WindowElement) { break }
            $layoutTokens = @($current.Current.ClassName -split '\s+' | Where-Object { $_.StartsWith('_ComposerLayoutBody_', [StringComparison]::Ordinal) })
            if ($current.Current.ControlType -eq [Windows.Automation.ControlType]::Group -and $layoutTokens.Count -eq 1) {
                if (-not (Element-IsInBoundWindow $current)) { break }
                # Chromium's scoped FindAll omits the editor from this Group
                # even though the fresh RawViewWalker parent is that Group.
                # Prove unique editor identity at the verified root and recheck
                # its nearest matching raw ancestor instead of trusting that
                # inconsistent descendant enumeration.
                $fresh = @(Get-CodexComposerCandidates $script:WindowElement)
                if ($fresh.Count -ne 1 -or -not (Runtime-IdsEqual $fresh[0] $Composer) -or
                    -not (Element-IsInBoundWindow $fresh[0])) {
                    Fail-Relay 'composer-unavailable' 'The unique composer changed while verifying its layout.'
                }
                $ancestor = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($fresh[0])
                for ($verifyDepth = 0; $verifyDepth -lt 15 -and $null -ne $ancestor; $verifyDepth++) {
                    Check-Deadline
                    if (Runtime-IdsEqual $ancestor $script:WindowElement) { break }
                    $ancestorTokens = @($ancestor.Current.ClassName -split '\s+' | Where-Object {
                        $_.StartsWith('_ComposerLayoutBody_', [StringComparison]::Ordinal) })
                    if ($ancestor.Current.ControlType -eq [Windows.Automation.ControlType]::Group -and $ancestorTokens.Count -eq 1) {
                        if (-not (Runtime-IdsEqual $ancestor $current) -or -not (Element-IsInBoundWindow $ancestor)) {
                            Fail-Relay 'composer-unavailable' 'The verified composer layout changed.'
                        }
                        return $ancestor
                    }
                    $ancestor = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($ancestor)
                }
                Fail-Relay 'composer-unavailable' 'The fresh composer ancestry could not verify its layout.'
            }
            $current = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($current)
        }
        Fail-Relay 'composer-unavailable' 'The actual Codex composer layout could not be verified.'
    }
    function Find-SendControl($Composer, $Layout) {
        if (-not (Runtime-IdsEqual (Get-ComposerLayoutBody $Composer) $Layout)) {
            Fail-Relay 'send-control-unavailable' 'The verified composer layout changed.'
        }
        $script:Stage = 'verify-send'
        $names = @('Send', ([string][char]0x53D1 + [string][char]0x9001))
        $condition = New-Object Windows.Automation.PropertyCondition(
            [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
        # Actual UIA evidence shows composer and Send share this closest layout Group.
        # Match the stable CSS-module component prefix and observed button token, not its build hash/full CSS.
        $controls = $Layout.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
        $matches = New-Object Collections.Generic.List[object]
        foreach ($control in $controls) {
            Check-Deadline
            if ($control.Current.IsEnabled -and -not $control.Current.IsOffscreen -and
                $names -ccontains $control.Current.Name -and
                (@($control.Current.ClassName -split '\s+') -ccontains 'size-token-button-composer') -and
                (Element-IsInBoundWindow $control)) {
                $parent = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($control)
                if (-not (Runtime-IdsEqual $parent $Layout)) { continue }
                $invoke = $null
                if ($control.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
                    $matches.Add([pscustomobject]@{ Element = $control; Invoke = $invoke })
                }
            }
        }
        if ($matches.Count -ne 1) { Fail-Relay 'send-control-unavailable' 'A unique enabled Send button could not be verified.' }
        return $matches[0]
    }
    function Try-ClearBridgeDraft {
        if (-not $script:BridgePasteAttempted -or $script:SubmissionAttempted) { return }
        $script:RecoveringDraft = $true
        try {
            # Recovery never takes back lost window focus, and never clears an existing/edited draft.
            Check-CodexMode
            $null = Verify-ThreadTarget
            if (-not (Runtime-IdsEqual (Get-ComposerLayoutBody $script:BridgeComposer) $script:BridgeLayout) -or
                (Normalized-InputText (Get-ComposerText $script:BridgeComposer)) -cne $script:BridgeExpectedText) { return }
            $fresh = Find-Composer
            if (-not (Runtime-IdsEqual $fresh $script:BridgeComposer)) { return }
            # Leave only our freshly copied, exact matching message selected for deletion.
            if ((Normalized-InputText (Get-ComposerText $fresh $false)) -cne $script:BridgeExpectedText) { return }
            Check-ComposerFocus $fresh
            $pattern = $null
            if (-not $fresh.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { return }
            $selection = @($pattern.GetSelection())
            if ($selection.Count -ne 1 -or $selection[0].CompareEndpoints(
                [Windows.Automation.Text.TextPatternRangeEndpoint]::Start, $selection[0],
                [Windows.Automation.Text.TextPatternRangeEndpoint]::End) -ge 0) { return }
            Check-ComposerFocus $fresh
            [Windows.Forms.SendKeys]::SendWait('{BACKSPACE}')
            $fresh = Find-Composer
            if (-not (Runtime-IdsEqual $fresh $script:BridgeComposer)) { return }
            $script:BridgeDraftCleared = (Get-ComposerText $fresh).Length -eq 0
        } catch { # Preserve the original failure; uncertainty requires desktop review.
        } finally { $script:RecoveringDraft = $false }
    }

    $script:Stage = 'trust-desktop'
    $script:Desktop = Get-TrustedDesktop
    if ($inputData.action -eq 'inspect') {
        $result = @{ ok = $true; available = $true; desktopRunning = $script:Desktop.Processes.Count -gt 0;
            reason = $null; version = [string]$script:Desktop.Package.Version }
    } else {
        if ([string]$inputData.threadId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -or
            [string]::IsNullOrWhiteSpace([string]$inputData.text) -or ([string]$inputData.text).Contains([string][char]0)) {
            Fail-Relay 'target-mismatch' 'Invalid desktop relay input.'
        }
        try { $script:RequestedDirectory = [BridgeDesktopNative]::FinalDirectoryPath([string]$inputData.cwd) }
        catch { Fail-Relay 'target-mismatch' 'The requested project directory could not be verified.' }
        if ($script:Desktop.Processes.Count -gt 0) {
            $script:Stage = 'bind-window'
            Bind-DesktopMainWindow
            Save-Clipboard
            Protect-OutgoingDesktopDraft
        }
        # Target the verified packaged application directly. Do not change Windows defaults
        # or invoke Open With when the ordinary codex URL association is missing.
        try {
            $script:Stage = 'activate-thread'
            Activate-DesktopThread $script:Desktop ([string]$inputData.threadId)
        } catch {
            Fail-Relay 'desktop-unavailable' 'Windows could not activate the verified desktop thread protocol.'
        }
        # A documented thread URI does not switch the unified app from Work to Codex.
        # Identify and focus its real conversation window before any mode-menu invocation.
        $script:Stage = 'bind-window'
        Bind-DesktopMainWindow
        Save-Clipboard
        if (Ensure-CodexMode) {
            $script:Stage = 'activate-thread'
            Activate-DesktopThread $script:Desktop ([string]$inputData.threadId)
            $script:Stage = 'bind-window'
            Bind-DesktopMainWindow
        }
        Check-CodexMode
        $script:Stage = 'verify-target'
        $actualCwd = Verify-ThreadTarget $true
        $composer = Find-Composer
        $composerLayout = Get-ComposerLayoutBody $composer
        $script:Stage = 'read-codex-draft'
        if ((Get-ComposerText $composer).Length -ne 0) { Fail-Relay 'draft-present' 'An existing desktop draft was preserved. No message was sent.' }
        $script:BridgeComposer = $composer
        $script:BridgeLayout = $composerLayout
        $script:BridgeExpectedText = Normalized-InputText ([string]$inputData.text)
        Focus-Composer $composer
        Check-CodexMode
        # Repeat the fresh structural proof immediately before inserting text;
        # neither placeholder words nor a failed copy can justify overwriting.
        if (-not (Test-EmptyPlaceholderComposer $composer)) {
            Fail-Relay 'draft-present' 'An empty desktop composer could not be confirmed. Its draft and attachments were preserved.'
        }
        [Windows.Forms.Clipboard]::SetText([string]$inputData.text, [Windows.Forms.TextDataFormat]::UnicodeText)
        Check-ComposerFocus $composer
        $script:BridgePasteAttempted = $true
        $script:Stage = 'paste-text'
        [Windows.Forms.SendKeys]::SendWait('^v')
        $script:Stage = 'verify-paste'
        $expectedText = Normalized-InputText ([string]$inputData.text)
        $textVerified = $false
        for ($attempt = 0; $attempt -lt 25; $attempt++) {
            Check-ComposerFocus $composer
            if ((Normalized-InputText (Get-ComposerText $composer)) -ceq $expectedText) { $textVerified = $true; break }
            Start-Sleep -Milliseconds 80
        }
        if (-not $textVerified) { Fail-Relay 'composer-unavailable' 'The pasted text could not be verified. Check the desktop draft before retrying.' }
        $script:Stage = 'verify-target'
        $actualCwd = Verify-ThreadTarget
        Focus-Composer $composer
        $verifiedCopiedText = Normalized-InputText (Get-ComposerText $composer)
        if ($verifiedCopiedText -cne $expectedText) {
            Fail-Relay 'draft-present' 'The desktop draft changed. No message was sent.'
        }
        $verifiedCopiedProof = Get-CopiedComposerTextProof $verifiedCopiedText
        $script:Stage = 'verify-send'
        $send = Find-SendControl $composer $composerLayout
        Check-CodexMode
        Check-ComposerFocus $composer
        $sendNames = @('Send', ([string][char]0x53D1 + [string][char]0x9001))
        if (-not $send.Element.Current.IsEnabled -or $send.Element.Current.IsOffscreen -or
            -not ($sendNames -ccontains $send.Element.Current.Name) -or
            -not (@($send.Element.Current.ClassName -split '\s+') -ccontains 'size-token-button-composer') -or
            -not (Element-IsInBoundWindow $send.Element) -or
            -not (Runtime-IdsEqual ([Windows.Automation.TreeWalker]::RawViewWalker.GetParent($send.Element)) $composerLayout) -or
            -not (Runtime-IdsEqual (Get-ComposerLayoutBody $composer) $composerLayout)) {
            Fail-Relay 'send-control-unavailable' 'The verified Send button changed.'
        }
        # Invoke only the verified Send button; never Enter or an approval shortcut.
        $script:SubmissionAttempted = $true
        $script:Stage = 'invoke-send'
        $send.Invoke.Invoke()
        $script:Stage = 'complete'
        $result = @{ ok = $true; submitted = $true; verifiedThreadId = ([string]$inputData.threadId).ToLowerInvariant(); actualCwd = $actualCwd;
            composerTextProof = $verifiedCopiedProof;
            desktopIdentity = @{ packageFamilyName = [string]$script:Desktop.Package.PackageFamilyName;
                version = [string]$script:Desktop.Package.Version; processId = $script:BoundProcess;
                processCreationTicks = [string](@($script:Desktop.Processes | Where-Object { $_.ProcessId -eq $script:BoundProcess })[0].CreationTicks);
                windowHandle = $script:BoundWindow.ToInt64().ToString(); executablePath = $script:Desktop.ExecutablePath } }
    }
} catch {
    $originalFailureCode = $script:FailureCode
    $originalFailureReason = $script:FailureReason
    $originalFailureStage = $script:Stage
    $originalFailureForeground = $script:FailureForegroundObservation
    $originalFailureModifiers = $script:IdentityModifierObservation
    if ($script:BridgePasteAttempted -and -not $script:SubmissionAttempted) { Try-ClearBridgeDraft }
    $script:FailureCode = $originalFailureCode
    $script:FailureReason = $originalFailureReason
    $script:Stage = $originalFailureStage
    $script:FailureForegroundObservation = $originalFailureForeground
    $script:IdentityModifierObservation = $originalFailureModifiers
    if ($script:BridgePasteAttempted -and -not $script:SubmissionAttempted -and -not $script:BridgeDraftCleared) {
        $script:FailureReason += ' Bridge text may remain in the desktop draft; review it before retrying.'
    }
    $submitted = $false
    if ($script:SubmissionAttempted) { $submitted = $null }
    $result = @{ ok = $false; code = $script:FailureCode; reason = $script:FailureReason; submitted = $submitted;
        stage = $script:Stage;
        desktopDraftRemaining = $script:BridgePasteAttempted -and -not $script:SubmissionAttempted -and -not $script:BridgeDraftCleared;
        desktopDraftCleared = $script:BridgeDraftCleared }
    if ($null -ne $script:FailureForegroundObservation) { $result.foregroundDiagnostic = $script:FailureForegroundObservation }
    if ($null -ne $script:IdentityModifierObservation) { $result.modifierDiagnostic = $script:IdentityModifierObservation }
} finally {
    if ($script:ClipboardSaved) {
        try { [Windows.Forms.Clipboard]::SetDataObject($script:ClipboardBackup, $true) }
        catch {
            $submitted = $false
            if ($script:SubmissionAttempted) { $submitted = $null }
            $result = @{ ok = $false; code = 'unknown'; reason = 'Clipboard restoration failed. Check the desktop before retrying.'; submitted = $submitted; stage = 'restore-clipboard' }
        }
    }
    if ($null -ne $script:DesktopUiMutex) {
        if ($script:DesktopUiMutexOwned) { try { $script:DesktopUiMutex.ReleaseMutex() } catch { } }
        try { $script:DesktopUiMutex.Dispose() } catch { }
    }
}
[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 6 -Compress))
