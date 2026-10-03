# Independent official Your dot UI reader. No local Codex RPC, cwd shortcut,
# cloud MCP plugin, text paste/send, task actions or permission changes.
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$watch=[Diagnostics.Stopwatch]::StartNew(); $clipboardSaved=$false; $result=$null; $failure='unknown'
$nativeMutex=$null; $mutexOwned=$false
function Fail-Dot([string]$Code) { $script:failure=$Code; throw 'Dot desktop action stopped.' }
function Join-DotObservedMessage([string[]]$Fragments,[bool]$Self) {
    # Native self-row Text nodes already carry their literal separators.
    # Adding an LF between them corrupts multiline text and its exact hash.
    # Preserve the existing CRLF history convention; never trim/collapse text.
    $normalized=@($Fragments|ForEach-Object {$_.Replace(([string][char]13+[string][char]10),[string][char]10)})
    if($Self){return [string]::Concat($normalized)}
    return [string]::Join([string][char]10,$normalized)
}
function Test-DotMainWindowEvidence([bool]$RootIsWindow,[bool]$NativeHandleMatches,[int]$SidebarYourDotCount) {
    return $RootIsWindow -and $NativeHandleMatches -and $SidebarYourDotCount -eq 1
}
function Test-DotSidebarLabel([string]$Name) {
    if($Name -ceq 'Your dot'){return $true}
    $match=[Text.RegularExpressions.Regex]::Match($Name,'\AYour dot ([1-9][0-9]{0,5}) unread (message|messages)\z')
    if(-not $match.Success){return $false}
    $count=[int]$match.Groups[1].Value
    return ($count -eq 1 -and $match.Groups[2].Value -ceq 'message') -or
        ($count -gt 1 -and $match.Groups[2].Value -ceq 'messages')
}
function Get-DotNavigationReadiness {
    # Only metadata is sampled while the one intended sidebar navigation mounts.
    # Every sample retains the same official process birth, HWND and foreground.
    $root=Fresh-Root
    if ($root.Current.ControlType -ne [Windows.Automation.ControlType]::Window -or
        [long]$root.Current.NativeWindowHandle -ne $bound.ToInt64() -or
        $root.Current.ProcessId -ne $ownerId) { Fail-Dot 'desktop-unavailable' }
    $buttonsCondition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button)
    $buttons=@($root.FindAll([Windows.Automation.TreeScope]::Descendants,$buttonsCondition) | Where-Object {
        $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
    $sidebar=@($buttons | Where-Object { (Test-DotSidebarLabel ([string]$_.Current.Name)) -and (Has-Class $_ 'sidebar-item') })
    $toggles=@($buttons | Where-Object { $_.Current.Name -ceq 'Toggle profile' })
    $editorCondition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit)
    $names=@('Message',(-join @([char]0x6D88,[char]0x606F)))
    $editors=@($root.FindAll([Windows.Automation.TreeScope]::Descendants,$editorCondition) | Where-Object {
        $names -ccontains $_.Current.Name -and (Has-Class $_ 'ProseMirror') -and $_.Current.IsEnabled -and
        -not $_.Current.IsOffscreen -and $_.Current.IsKeyboardFocusable -and -not $_.Current.IsPassword })
    $profileCondition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Window)
    $profiles=@($root.FindAll([Windows.Automation.TreeScope]::Descendants,$profileCondition) | Where-Object {
        $_.Current.Name -ceq ('Your dot'+[string][char]0x2019+'s profile') -and (Has-Class $_ 'codex-dialog') -and -not $_.Current.IsOffscreen })
    Assert-Foreground
    return @{sidebarCount=$sidebar.Count;editorCount=$editors.Count;profileCount=$profiles.Count;toggleCount=$toggles.Count}
}
function Test-DotNavigationReadiness($Evidence) {
    # Zero candidates can be a transient remount. Ambiguity never authorizes a
    # retry or another invocation; the existing profile/identity guards follow.
    foreach($name in @('sidebarCount','editorCount','profileCount','toggleCount')) {
        if ($Evidence[$name] -lt 0 -or $Evidence[$name] -gt 1) { Fail-Dot 'dot-unavailable' }
    }
    return $Evidence.sidebarCount -eq 1 -and $Evidence.editorCount -eq 1 -and
        ($Evidence.profileCount -eq 1 -or $Evidence.toggleCount -eq 1)
}
function Wait-DotSelectedView {
    $settleWatch=[Diagnostics.Stopwatch]::StartNew()
    while ($settleWatch.ElapsedMilliseconds -lt 3000) {
        $ready=Test-DotNavigationReadiness (Get-DotNavigationReadiness)
        if ($settleWatch.ElapsedMilliseconds -ge 3000) { break }
        if ($ready) { return }
        $remaining=3000-$settleWatch.ElapsedMilliseconds
        if ($remaining -le 0) { break }
        Start-Sleep -Milliseconds ([Math]::Min(80,$remaining))
    }
    Fail-Dot 'dot-unavailable'
}
try {
    $raw=[Console]::In.ReadToEnd()
    if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 4096) { Fail-Dot 'target-mismatch' }
    $request=$raw | ConvertFrom-Json
    if ($request.action -notin @('inspect','snapshot')) { Fail-Dot 'send-unavailable' }
    if ($request.expectedThreadId -and [string]$request.expectedThreadId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { Fail-Dot 'target-mismatch' }
    # Match Codex's cross-process guard before any foreground/input/clipboard action.
    $mutexName='Local\PocketBridge.DesktopUi.'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $nativeMutex=New-Object Threading.Mutex($false,$mutexName)
    try {$mutexOwned=$nativeMutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$mutexOwned=$true}
    if (-not $mutexOwned) {Fail-Dot 'desktop-busy'}
    Add-Type -AssemblyName System.Windows.Forms, UIAutomationClient, UIAutomationTypes
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DotDesktopNative {
    private delegate bool EnumProc(IntPtr hwnd,IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback,IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint process);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    public static int WindowProcess(IntPtr hwnd) { uint process; GetWindowThreadProcessId(hwnd,out process); return (int)process; }
    public static IntPtr[] VisibleWindows() {
        var windows=new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd,IntPtr ignored) { if(IsWindowVisible(hwnd))windows.Add(hwnd); return true; },IntPtr.Zero);
        return windows.ToArray();
    }
}
'@
    $packages=@(Get-AppxPackage -Name 'OpenAI.Codex' | Where-Object {
        $_.Name -ceq 'OpenAI.Codex' -and $_.PackageFamilyName -ceq 'OpenAI.Codex_2p2nqsd0c76g0' })
    if ($packages.Count -ne 1) { Fail-Dot 'desktop-unavailable' }
    $package=$packages[0]; $manifest=New-Object Xml.XmlDocument; $manifest.XmlResolver=$null
    $manifest.Load((Join-Path $package.InstallLocation 'AppxManifest.xml'))
    $identity=$manifest.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Identity']")
    if ($identity.GetAttribute('Publisher') -cne 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B') { Fail-Dot 'desktop-unavailable' }
    $app=$manifest.SelectSingleNode("//*[local-name()='Application' and @Id='App']")
    if ($null -eq $app) { Fail-Dot 'desktop-unavailable' }
    $packageRoot=[IO.Path]::GetFullPath($package.InstallLocation).TrimEnd('\')
    $exe=[IO.Path]::GetFullPath((Join-Path $packageRoot $app.GetAttribute('Executable').Replace('/','\')))
    if (-not $exe.StartsWith($packageRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($exe) -cne '.exe' -or -not [IO.File]::Exists($exe)) { Fail-Dot 'desktop-unavailable' }
    $exeName=[IO.Path]::GetFileName($exe).Replace("'","''")
    $processes=@(Get-CimInstance Win32_Process -Filter ("Name='"+$exeName+"'") | Where-Object {
        $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath),$exe,[StringComparison]::OrdinalIgnoreCase) })
    $candidates=@([DotDesktopNative]::VisibleWindows() | Where-Object {
        $owner=[DotDesktopNative]::WindowProcess($_); @($processes | Where-Object {$_.ProcessId -eq $owner}).Count -eq 1 })
    $windows=@()
    foreach($candidate in $candidates) {
        try {
            $root=[Windows.Automation.AutomationElement]::FromHandle($candidate)
            $buttonCondition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button)
            $allowOffscreen=[DotDesktopNative]::IsIconic($candidate)
            $sidebar=@($root.FindAll([Windows.Automation.TreeScope]::Descendants,$buttonCondition) | Where-Object {
                (Test-DotSidebarLabel ([string]$_.Current.Name)) -and @($_.Current.ClassName -split '\s+') -ccontains 'sidebar-item' -and
                $_.Current.IsEnabled -and ($allowOffscreen -or -not $_.Current.IsOffscreen) })
            # An actual same-process Chrome_WidgetWin_1 Pane exposes a
            # ProseMirror editor but has no main sidebar. Neither its title nor
            # an editor alone identifies the official conversation window.
            $rootIsWindow=$root.Current.ControlType -eq [Windows.Automation.ControlType]::Window
            $nativeHandleMatches=[long]$root.Current.NativeWindowHandle -eq $candidate.ToInt64()
            if(Test-DotMainWindowEvidence $rootIsWindow $nativeHandleMatches $sidebar.Count) {$windows+=$candidate}
        } catch { # Unreadable/stale auxiliary windows are not verified main windows.
        }
    }
    if ($windows.Count -ne 1) { if ($windows.Count -gt 1) { Fail-Dot 'desktop-ambiguous' }; Fail-Dot 'desktop-unavailable' }
    $bound=$windows[0]; $ownerId=[DotDesktopNative]::WindowProcess($bound)
    $owner=@($processes | Where-Object {$_.ProcessId -eq $ownerId})[0]; $creationTicks=$owner.CreationDate.ToUniversalTime().Ticks
    function Assert-Process {
        if ($watch.ElapsedMilliseconds -gt 39000) { Fail-Dot 'unknown' }
        $actual=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ownerId)
        if ($null -eq $actual -or $actual.CreationDate.ToUniversalTime().Ticks -ne $creationTicks -or
            -not [string]::Equals($actual.ExecutablePath,$exe,[StringComparison]::OrdinalIgnoreCase) -or
            -not [DotDesktopNative]::IsWindow($bound) -or [DotDesktopNative]::WindowProcess($bound) -ne $ownerId) { Fail-Dot 'desktop-unavailable' }
    }
    function Assert-Foreground {
        Assert-Process; $fg=[DotDesktopNative]::GetForegroundWindow(); $fgRoot=[DotDesktopNative]::GetAncestor($fg,2)
        if ([DotDesktopNative]::WindowProcess($fg) -ne $ownerId -or ($fg -ne $bound -and $fgRoot -ne $bound)) { Fail-Dot 'desktop-busy' }
    }
    function Assert-ReleasedInput {
        for ($key=1;$key -le 254;$key++) { if ([DotDesktopNative]::GetAsyncKeyState($key) -lt 0) { Fail-Dot 'desktop-busy' } }
    }
    function Before-Input { Assert-Foreground; Assert-ReleasedInput; Assert-Foreground }
    function Key($Element) { return [string]::Join(',',$Element.GetRuntimeId()) }
    function Has-Class($Element,[string]$Token) { return @($Element.Current.ClassName -split '\s+') -ccontains $Token }
    function Fresh-Root { Assert-Foreground; return [Windows.Automation.AutomationElement]::FromHandle($bound) }
    function Unique-Button([string]$Name,[string]$Token) {
        $root=Fresh-Root
        $cond=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button)
        $found=@($root.FindAll([Windows.Automation.TreeScope]::Descendants,$cond) | Where-Object {
            (($_.Current.Name -ceq $Name) -or ($Name -ceq 'Your dot' -and (Test-DotSidebarLabel ([string]$_.Current.Name)))) -and
            $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and (-not $Token -or (Has-Class $_ $Token)) })
        if ($found.Count -ne 1) { Fail-Dot 'dot-unavailable' }; return $found[0]
    }
    function Dot-Profiles {
        $root=Fresh-Root
        $cond=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Window)
        return @($root.FindAll([Windows.Automation.TreeScope]::Descendants,$cond) | Where-Object {
            $_.Current.Name -ceq ('Your dot'+[string][char]0x2019+'s profile') -and (Has-Class $_ 'codex-dialog') -and -not $_.Current.IsOffscreen })
    }
    function Dot-Composer {
        $root=Fresh-Root
        $cond=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit)
        $names=@('Message',(-join @([char]0x6D88,[char]0x606F)))
        $found=@($root.FindAll([Windows.Automation.TreeScope]::Descendants,$cond) | Where-Object {
            $names -ccontains $_.Current.Name -and (Has-Class $_ 'ProseMirror') -and $_.Current.IsEnabled -and
            -not $_.Current.IsOffscreen -and $_.Current.IsKeyboardFocusable -and -not $_.Current.IsPassword })
        if ($found.Count -ne 1) { Fail-Dot 'dot-unavailable' }; return $found[0]
    }
    function Raw-Contains($Scope,$Element) {
        $current=$Element
        for ($depth=0;$depth -lt 55 -and $null -ne $current;$depth++) {
            if ((Key $current) -ceq (Key $Scope)) { return $true }
            $current=[Windows.Automation.TreeWalker]::RawViewWalker.GetParent($current)
        }; return $false
    }
    function Raw-Ancestor($Element,[string]$Token) {
        $current=$Element
        for ($depth=0;$depth -lt 55 -and $null -ne $current;$depth++) {
            if ((Has-Class $current $Token) -and $current.Current.ControlType -eq [Windows.Automation.ControlType]::Group) { return $current }
            $current=[Windows.Automation.TreeWalker]::RawViewWalker.GetParent($current)
        }; Fail-Dot 'history-unavailable'
    }
    function Focus-DotComposer {
        for($focusAttempt=0;$focusAttempt -lt 2;$focusAttempt++) {
            $composer=Dot-Composer; Before-Input; $composer.SetFocus()
            for($settle=0;$settle -lt 12;$settle++) {
                Assert-Foreground; $fresh=Dot-Composer; $focused=[Windows.Automation.AutomationElement]::FocusedElement
                if($null -ne $focused -and (Key $focused) -ceq (Key $fresh)){return $fresh}
                Start-Sleep -Milliseconds 40
            }
        }
        Fail-Dot 'dot-unavailable'
    }
    function Copy-DurableIdentity {
        $fresh=Focus-DotComposer
        Before-Input; $sentinel='PocketBridgeDotIdentity-'+[Guid]::NewGuid().ToString('D')
        [Windows.Forms.Clipboard]::SetText($sentinel,[Windows.Forms.TextDataFormat]::UnicodeText)
        $sequence=[DotDesktopNative]::GetClipboardSequenceNumber(); Before-Input
        $fresh=Focus-DotComposer; $focused=[Windows.Automation.AutomationElement]::FocusedElement
        if ($null -eq $focused -or (Key $focused) -cne (Key $fresh)) { Fail-Dot 'dot-unavailable' }
        [Windows.Forms.SendKeys]::SendWait('^%l'); $copied=$null
        for ($attempt=0;$attempt -lt 25;$attempt++) {
            Assert-Foreground
            if ([DotDesktopNative]::GetClipboardSequenceNumber() -ne $sequence -and [Windows.Forms.Clipboard]::ContainsText([Windows.Forms.TextDataFormat]::UnicodeText)) {
                $value=[Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText)
                if ($value -cne $sentinel) { $copied=$value; break }
            }; Start-Sleep -Milliseconds 80
        }
        $match=[Text.RegularExpressions.Regex]::Match([string]$copied,'\Acodex://threads/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\?hostId=durable\z')
        if (-not $match.Success) { Fail-Dot 'target-mismatch' }
        $id=$match.Groups[1].Value.ToLowerInvariant()
        if ($request.expectedThreadId -and $id -cne [string]$request.expectedThreadId) { Fail-Dot 'target-mismatch' }; return $id
    }
    Assert-Process
    if ($request.action -eq 'inspect') {
        $result=@{ok=$true;available=$true;desktopRunning=$true;version=[string]$package.Version;sendAvailable=$false}
    } else {
        # Restoring the verified window is an intentional phone-mode action.
        Assert-Process; Assert-ReleasedInput
        if ([DotDesktopNative]::IsIconic($bound)) { $null=[DotDesktopNative]::ShowWindow($bound,9) }
        $null=[DotDesktopNative]::SetForegroundWindow($bound); Start-Sleep -Milliseconds 100; Assert-Foreground
        . (Join-Path $PSScriptRoot 'dot-desktop-navigation-guard.ps1')
        $alreadyDot=Protect-DotOutgoingSource $true ([string]$package.Version)
        if(-not $alreadyDot){
            $dot=Unique-Button 'Your dot' 'sidebar-item'; $invoke=$null
            if (-not $dot.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)) { Fail-Dot 'dot-unavailable' }
            Before-Input
            if(Protect-DotOutgoingSource $true ([string]$package.Version)){Fail-Dot 'target-mismatch'}
            $invoke.Invoke(); Wait-DotSelectedView; Assert-Foreground
        }
        $dot=Unique-Button 'Your dot' 'sidebar-item'; $profiles=@(Dot-Profiles)
        if ($profiles.Count -eq 0) {
            $button=Unique-Button 'Toggle profile' ''; $toggle=$null
            if (-not $button.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$toggle)) { Fail-Dot 'dot-unavailable' }
            Before-Input; $toggle.Toggle()
            for($settle=0;$settle -lt 12;$settle++){Start-Sleep -Milliseconds 80;Assert-Foreground;$profiles=@(Dot-Profiles);if($profiles.Count -eq 1){break}}
        }
        if ($profiles.Count -ne 1) { Fail-Dot 'dot-unavailable' }
        $original=[Windows.Forms.Clipboard]::GetDataObject(); $backup=New-Object Windows.Forms.DataObject
        if ($null -ne $original) {
            foreach ($format in $original.GetFormats($false)) {
                $value=$original.GetData($format,$false)
                if ($value -is [IO.Stream]) {
                    $pos=$value.Position; $copy=New-Object IO.MemoryStream; $value.Position=0; $value.CopyTo($copy); $value.Position=$pos; $copy.Position=0; $value=$copy
                } elseif ($value -is [ICloneable]) { $value=$value.Clone() }; $backup.SetData($format,$false,$value)
            }
        }; $clipboardSaved=$true
        $beforeId=Copy-DurableIdentity; $composer=Dot-Composer
        $viewport=Raw-Ancestor $composer 'conversation-viewport'; $pane=Raw-Ancestor $viewport 'thread-pane'
        if (-not (Raw-Contains (Fresh-Root) $pane)) { Fail-Dot 'history-unavailable' }
        $groupCondition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Group)
        $textCondition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Text)
        $rows=@($viewport.FindAll([Windows.Automation.TreeScope]::Descendants,$groupCondition) | Where-Object {Has-Class $_ 'message-row'})
        $messages=@(); $bytes=0; $start=[Math]::Max(0,$rows.Count-40); $messageListParent=$null
        $sha=[Security.Cryptography.SHA256]::Create()
        try {
            for ($index=$start;$index -lt $rows.Count;$index++) {
                if ($index % 5 -eq 0) { Assert-Foreground }; $row=$rows[$index]
                if (-not (Raw-Contains $viewport $row) -or -not (Raw-Contains $pane $row)) { Fail-Dot 'history-unavailable' }
                # Observed Dot rows are direct siblings in one message list.
                # Reject nested lookalike rows instead of reading embedded content.
                $rowParent=[Windows.Automation.TreeWalker]::RawViewWalker.GetParent($row)
                if ($null -eq $rowParent -or -not (Raw-Contains $viewport $rowParent)) { Fail-Dot 'history-unavailable' }
                if ($null -eq $messageListParent) {$messageListParent=Key $rowParent}
                elseif ($messageListParent -cne (Key $rowParent)) {Fail-Dot 'history-unavailable'}
                $bodies=@($row.FindAll([Windows.Automation.TreeScope]::Descendants,$groupCondition) | Where-Object {Has-Class $_ 'message-body'})
                if ($bodies.Count -ne 1 -or -not (Raw-Contains $row $bodies[0])) { Fail-Dot 'history-unavailable' }
                $nodes=@($bodies[0].FindAll([Windows.Automation.TreeScope]::Descendants,$textCondition))
                if ($nodes.Count -gt 200) { Fail-Dot 'history-unavailable' }; $fragments=@()
                foreach ($node in $nodes) {
                    if (-not (Raw-Contains $bodies[0] $node) -or $node.Current.IsPassword) { Fail-Dot 'history-unavailable' }
                    if ($node.Current.Name) { $fragments+=[string]$node.Current.Name }
                }
                $text=Join-DotObservedMessage $fragments (Has-Class $row 'self'); $bytes+=[Text.Encoding]::UTF8.GetByteCount($text)
                if ($text.Length -gt 32768 -or $bytes -gt 131072) { Fail-Dot 'history-unavailable' }
                $hash=$sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($beforeId+'|'+$creationTicks+'|'+(Key $row)))
                $observationId=[BitConverter]::ToString($hash).Replace('-','').ToLowerInvariant()
                $messages+=@{observationId=$observationId;role=if (Has-Class $row 'self') {'user'} else {'assistant'};text=$text;hasText=$text.Length -gt 0}
            }
        } finally {$sha.Dispose()}
        Assert-Foreground; $fresh=Dot-Composer
        if ((Key (Raw-Ancestor $fresh 'conversation-viewport')) -cne (Key $viewport)) { Fail-Dot 'history-unavailable' }
        $afterId=Copy-DurableIdentity
        if ($beforeId -cne $afterId) { Fail-Dot 'target-mismatch' }
        $result=@{ok=$true;hostId='durable';threadId=$beforeId;observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
            historyScope='materialized-recent';stableMessageIds=$false;materializedRowCount=$rows.Count;messages=$messages;
            taskExecution='unknown';localComputerAccess='unverified';sendAvailable=$false}
    }
} catch {
    $result=@{ok=$false;code=$failure;submitted=$false}
} finally {
    if ($clipboardSaved) {
        try {[Windows.Forms.Clipboard]::SetDataObject($backup,$true)}
        catch {$result=@{ok=$false;code='clipboard-unavailable';submitted=$false}}
    }
    if ($null -ne $nativeMutex) {
        try {if ($mutexOwned) {$nativeMutex.ReleaseMutex()}} finally {$nativeMutex.Dispose()}
    }
}
[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
