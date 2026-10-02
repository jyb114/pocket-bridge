# Independent official Your dot text sender. Disabled unless the parent
# supplies its explicit test capability. Uses bound persistent ACKs; no Codex RPC.
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$watch=[Diagnostics.Stopwatch]::StartNew(); $clipboardSaved=$false; $result=$null; $failure='unknown'
$nativeMutex=$null; $mutexOwned=$false
$framedReady=$false;$sequence=0;$sendAttempted=$false;$sendBaseline=$null;$sendBaselineDigest=$null;$ownDraftPasted=$false
$sendEvidence=@{};$request=$null
function Dot-Hash([string]$Value) {
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant()}
    finally{$algorithm.Dispose()}
}
function Emit-DotFrame([string]$Stage,$Data) {
    $script:sequence++
    $frame=[ordered]@{protocol=1;operationId=[string]$request.operationId;requestId=[string]$request.requestId;
        requestFingerprint=[string]$request.requestFingerprint;sequence=$script:sequence;stage=$Stage}
    foreach($key in $Data.Keys){$frame[$key]=$Data[$key]}
    [Console]::Out.WriteLine(($frame|ConvertTo-Json -Depth 12 -Compress));[Console]::Out.Flush()
}
function Wait-DotAck([string]$Stage,[string]$Digest) {
    $pending=[Console]::In.ReadLineAsync()
    if(-not $pending.Wait(10000)){Fail-Dot 'unknown'}
    $line=$pending.Result
    if($null -eq $line -or [Text.Encoding]::UTF8.GetByteCount($line) -gt 2048){Fail-Dot 'unknown'}
    $ack=$line|ConvertFrom-Json
    $keys=@($ack.PSObject.Properties.Name)
    if($keys.Count -ne 7 -or @($keys|Where-Object {$_ -notin @('protocol','operationId','requestId','requestFingerprint','sequence','stage','baselineDigest')}).Count -ne 0 -or
        $ack.protocol -ne 1 -or $ack.operationId -cne $request.operationId -or $ack.requestId -cne $request.requestId -or
        $ack.requestFingerprint -cne $request.requestFingerprint -or $ack.sequence -ne $script:sequence -or $ack.stage -cne $Stage -or
        ($Stage -eq 'continue-preflight' -and $null -ne $ack.baselineDigest) -or
        ($Stage -ne 'continue-preflight' -and ($Digest -cnotmatch '^[0-9a-f]{64}$' -or $ack.baselineDigest -cne $Digest))){Fail-Dot 'unknown'}
}
function Fail-Dot([string]$Code) { $script:failure=$Code; throw 'Dot desktop action stopped.' }
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
try {
    $raw=[Console]::In.ReadLine()
    if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 32768) { Fail-Dot 'target-mismatch' }
    $request=$raw | ConvertFrom-Json
    if ($request.action -cne 'send' -or $request.testOnlyPermitSend -ne $true -or $request.protocol -ne 1){Fail-Dot 'send-unavailable'}
    foreach($field in @('operationId','requestId','expectedThreadId')){if([string]$request.$field -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'){Fail-Dot 'target-mismatch'}}
    if($request.text -isnot [string] -or $request.text.Length -eq 0 -or $request.text.Contains([string][char]0) -or
        [Text.Encoding]::UTF8.GetByteCount($request.text) -gt 16000 -or [string]$request.requestFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
        [string]$request.textSha256 -cne (Dot-Hash $request.text)){Fail-Dot 'target-mismatch'}
    $framedReady=$true
    if ($request.expectedThreadId -and [string]$request.expectedThreadId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { Fail-Dot 'target-mismatch' }
    # Match Codex's cross-process guard before any foreground/input/clipboard action.
    $mutexName='Local\PocketBridge.DesktopUi.'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $nativeMutex=New-Object Threading.Mutex($false,$mutexName)
    try {$mutexOwned=$nativeMutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$mutexOwned=$true}
    if (-not $mutexOwned) {Fail-Dot 'desktop-busy'}
    $helper=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
    Emit-DotFrame 'locked' @{helper=@{pid=[int]$PID;creationTicks=$helper.CreationDate.ToUniversalTime().Ticks.ToString()}}
    Wait-DotAck 'continue-preflight' $null
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
    $package=$packages[0]; if([string]$package.Version -cne [string]$request.expectedVersion){Fail-Dot 'send-unavailable'}; $manifest=New-Object Xml.XmlDocument; $manifest.XmlResolver=$null
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
        if ($watch.ElapsedMilliseconds -gt 74000) { Fail-Dot 'unknown' }
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

    # These are technical control descriptions from four actual Dot countertests,
    # not a private account UUID or transcript. The exact desktop build is gated.
    $accepted=@'
{"rawLayoutTree":{"className":"_ComposerLayoutBody_gcdh7_2","name":"","controlType":"ControlType.Group","children":[{"className":"contents","name":"","controlType":"ControlType.Group","children":[{"className":"no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full text-tertiary not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent h-token-button-composer px-(--padding-button-composer-inline,calc(var(--spacing)*2)) py-0 text-(length:--text-button-composer,var(--text-sm)) leading-(--line-height-button-composer,18px) aspect-square shrink-0 items-center justify-center !px-0","name":"\u6dfb\u52a0\u6587\u4ef6\u7b49\u5185\u5bb9","controlType":"ControlType.Button","children":[]}]},{"className":"ProseMirror ProseMirror-focused","name":"\u6d88\u606f","controlType":"ControlType.Edit","children":[]},{"className":"flex shrink-0 items-center gap-2","name":"","controlType":"ControlType.Group","children":[{"className":"contents","name":"","controlType":"ControlType.Group","children":[{"className":"no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full text-tertiary not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent h-token-button-composer px-(--padding-button-composer-inline,calc(var(--spacing)*2)) py-0 text-(length:--text-button-composer,var(--text-sm)) leading-(--line-height-button-composer,18px) aspect-square shrink-0 items-center justify-center !px-0","name":"\u542c\u5199","controlType":"ControlType.Button","children":[{"className":"icon-leading text-default","name":"","controlType":"ControlType.Image","children":[]}]}]}]},{"className":"cursor-interaction size-token-button-composer flex items-center justify-center rounded-full transition-opacity focus-visible:outline-2 bg-composer-primary p-0.5 focus-visible:outline-background-composer-primary cursor-default opacity-50","name":"\u53d1\u9001","controlType":"ControlType.Button","children":[]}]},"rawComposerTree":{"className":"ProseMirror ProseMirror-focused","name":"\u6d88\u606f","controlType":"ControlType.Edit","children":[{"className":"placeholder","name":"","controlType":"ControlType.Group","children":[{"className":"","name":"","controlType":"ControlType.Group","children":[{"className":"","name":"Send a message","controlType":"ControlType.Text","children":[]}]},{"className":"ProseMirror-trailingBreak","name":"\n","controlType":"ControlType.Text","children":[]}]}]}}
'@|ConvertFrom-Json
    $expanded=@'
{"rawLayoutTree":{"className":"_ComposerLayoutBody_gcdh7_2","name":"","controlType":"ControlType.Group","children":[{"className":"ProseMirror ProseMirror-focused","name":"\u6d88\u606f","controlType":"ControlType.Edit","children":[]},{"className":"contents","name":"","controlType":"ControlType.Group","children":[{"className":"no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full text-tertiary not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent h-token-button-composer px-(--padding-button-composer-inline,calc(var(--spacing)*2)) py-0 text-(length:--text-button-composer,var(--text-sm)) leading-(--line-height-button-composer,18px) aspect-square shrink-0 items-center justify-center !px-0","name":"\u6dfb\u52a0\u6587\u4ef6\u7b49\u5185\u5bb9","controlType":"ControlType.Button","children":[]}]},{"className":"flex shrink-0 items-center gap-2","name":"","controlType":"ControlType.Group","children":[{"className":"contents","name":"","controlType":"ControlType.Group","children":[{"className":"no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full text-tertiary not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent h-token-button-composer px-(--padding-button-composer-inline,calc(var(--spacing)*2)) py-0 text-(length:--text-button-composer,var(--text-sm)) leading-(--line-height-button-composer,18px) aspect-square shrink-0 items-center justify-center !px-0","name":"\u542c\u5199","controlType":"ControlType.Button","children":[{"className":"icon-leading text-default","name":"","controlType":"ControlType.Image","children":[]}]}]}]},{"className":"cursor-interaction size-token-button-composer flex items-center justify-center rounded-full transition-opacity focus-visible:outline-2 bg-composer-primary p-0.5 focus-visible:outline-background-composer-primary","name":"\u53d1\u9001","controlType":"ControlType.Button","children":[]}]}}
'@|ConvertFrom-Json
    function Raw-Children($Element) {
        $children=@(); $child=[Windows.Automation.TreeWalker]::RawViewWalker.GetFirstChild($Element)
        while ($null -ne $child) { $children+=$child; if($children.Count -gt 30){throw 'dot-raw-children-limit'};
            $child=[Windows.Automation.TreeWalker]::RawViewWalker.GetNextSibling($child) }
        return $children
    }
    function Dot-Layout($Composer) {
        $layout=[Windows.Automation.TreeWalker]::RawViewWalker.GetParent($Composer)
        if ($null -eq $layout -or $layout.Current.ControlType -ne [Windows.Automation.ControlType]::Group -or
            $layout.Current.ClassName -cne $accepted.rawLayoutTree.className) {throw 'dot-actual-layout-changed'}
        $viewport=Raw-Ancestor $Composer 'conversation-viewport'; $pane=Raw-Ancestor $viewport 'thread-pane'
        if (-not(Raw-Contains (Fresh-Root) $pane) -or -not(Raw-Contains $viewport $layout)) {throw 'dot-scope-outside-bound-window'}
        return $layout
    }
    function Assert-DotAttachmentFree($Composer) {
        $layout=Dot-Layout $Composer; $children=@(Raw-Children $layout)
        if($children.Count -ne 4) {throw 'dot-attachments-or-layout-changed'}
        # Exactly TWO actual Dot orders are known, both with the same four
        # controls. Multi-line input moves the editor before the add-file group.
        if((Key $children[1]) -ceq (Key $Composer)) {$template=$accepted.rawLayoutTree;$controlIndexes=@(0,2,3);$editorIndex=1}
        elseif((Key $children[0]) -ceq (Key $Composer)) {$template=$expanded.rawLayoutTree;$controlIndexes=@(1,2,3);$editorIndex=0}
        else{throw 'dot-attachments-or-layout-changed'}
        foreach($index in $controlIndexes) {
            if($children[$index].Current.ClassName -cne $template.children[$index].className -and $index -ne 3) {throw 'dot-attachments-or-layout-changed'}
            if($children[$index].Current.ControlType.ProgrammaticName -cne $template.children[$index].controlType -or
                $children[$index].Current.Name -cne $template.children[$index].name) {throw 'dot-attachments-or-layout-changed'}
        }
        if(-not(Has-Class $children[3] 'size-token-button-composer')){throw 'dot-attachments-or-layout-changed'}
        $outer=$layout
        for($depth=0;$depth -lt 8;$depth++) {
            if (@($outer.Current.ClassName -split '\s+'|Where-Object {$_.StartsWith('_composer_',[StringComparison]::Ordinal)}).Count -eq 1){break}
            $outer=[Windows.Automation.TreeWalker]::RawViewWalker.GetParent($outer)
        }
        if($null -eq $outer -or @($outer.Current.ClassName -split '\s+'|Where-Object {$_.StartsWith('_composer_',[StringComparison]::Ordinal)}).Count -ne 1){throw 'dot-attachments-or-layout-changed'}
        # Attachment chips outside the editor/layout must also make the probe
        # stop. Do not mistake an empty text field for an attachment-free draft.
        # Actual multiline Dot evidence 162053936: FindAll returned ten nodes
        # and omitted the bound first-child editor; the scoped Raw tree had
        # seventeen nodes, exactly one same editor, three buttons and one image.
        # Walk the full bounded Raw scope instead of accepting a missing editor.
        $rawNodes=New-Object 'System.Collections.Generic.List[Windows.Automation.AutomationElement]'
        $rawIds=New-Object 'System.Collections.Generic.HashSet[string]'
        function Collect-DotOuterRaw($Element,[int]$Depth) {
            if($Depth -gt 12 -or $rawNodes.Count -ge 128){throw 'dot-structure-limit'}
            if(-not $rawIds.Add((Key $Element))){throw 'dot-attachments-or-layout-changed'}
            $rawNodes.Add($Element)
            foreach($rawChild in @(Raw-Children $Element)){Collect-DotOuterRaw $rawChild ($Depth+1)}
        }
        foreach($rawChild in @(Raw-Children $outer)){Collect-DotOuterRaw $rawChild 1}
        $elements=@($rawNodes.ToArray())
        $buttons=@($elements|Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::Button})
        $images=@($elements|Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::Image})
        $edits=@($elements|Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::Edit})
        $names=@($accepted.rawLayoutTree.children[0].children[0].name,
            $accepted.rawLayoutTree.children[2].children[0].children[0].name,$accepted.rawLayoutTree.children[3].name)
        $sendEvidence.attachmentGuard=@{outerClass=[string]$outer.Current.ClassName;buttons=$buttons.Count;images=$images.Count;edits=$edits.Count;
            fourDotLayoutChildren=$children.Count;editorIndex=$editorIndex;observedDotOrder=if($editorIndex -eq 0){'multiline-editor-first'}else{'compact-add-file-first'};
            rawOuterDescendantCount=$elements.Count;rawCollectionComplete=$true;
            expectedNamesOnly=@($buttons|Where-Object {-not($names -ccontains $_.Current.Name)}).Count -eq 0}
        if($buttons.Count -ne 3 -or $images.Count -ne 1 -or $edits.Count -ne 1 -or (Key $edits[0]) -cne (Key $Composer) -or
            @($buttons|Where-Object {-not($names -ccontains $_.Current.Name)}).Count -ne 0 -or
            $images[0].Current.ClassName -cne $accepted.rawLayoutTree.children[2].children[0].children[0].children[0].className) {throw 'dot-attachments-or-layout-changed'}
        return $layout
    }
    function Test-DotActualBlank {
        $composer=Dot-Composer; $layout=Assert-DotAttachmentFree $composer
        $direct=@(Raw-Children $composer)
        if($direct.Count -ne 1 -or $direct[0].Current.ControlType -ne [Windows.Automation.ControlType]::Group -or
            $direct[0].Current.ClassName -cne 'placeholder' -or $direct[0].Current.Name.Length -ne 0){return $false}
        $inside=@(Raw-Children $direct[0])
        if($inside.Count -ne 2 -or $inside[0].Current.ControlType -ne [Windows.Automation.ControlType]::Group -or
            $inside[0].Current.ClassName.Length -ne 0 -or $inside[0].Current.Name.Length -ne 0 -or
            $inside[1].Current.ControlType -ne [Windows.Automation.ControlType]::Text -or
            $inside[1].Current.ClassName -cne 'ProseMirror-trailingBreak' -or $inside[1].Current.Name -cne [string][char]10){return $false}
        $labels=@(Raw-Children $inside[0])
        if($labels.Count -ne 1 -or $labels[0].Current.ControlType -ne [Windows.Automation.ControlType]::Text -or
            $labels[0].Current.ClassName.Length -ne 0 -or @(Raw-Children $labels[0]).Count -ne 0 -or
            @(Raw-Children $inside[1]).Count -ne 0){return $false}
        $placeholder=[string]$labels[0].Current.Name
        if($placeholder -cne $accepted.rawComposerTree.children[0].children[0].children[0].name){return $false}
        $value=$null;$document=$null
        if(-not $composer.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$value) -or
            -not $composer.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$document)){return $false}
        $expected=$placeholder+[string][char]10
        $controls=@(Raw-Children $layout); $send=$controls[3]
        return [string]$value.Current.Value -ceq $expected -and [string]$document.DocumentRange.GetText(32768) -ceq $expected -and
            -not $send.Current.IsEnabled -and (Has-Class $send 'size-token-button-composer')
    }
    function Copy-DotDraft {
        $fresh=Focus-DotComposer; $sentinel='PocketBridgeDotDraftCopy-'+[Guid]::NewGuid().ToString('D')
        Before-Input; [Windows.Forms.Clipboard]::SetText($sentinel,[Windows.Forms.TextDataFormat]::UnicodeText)
        $sequence=[DotDesktopNative]::GetClipboardSequenceNumber()
        $fresh=Focus-DotComposer; Before-Input; [Windows.Forms.SendKeys]::SendWait('^a')
        Before-Input; [Windows.Forms.SendKeys]::SendWait('^c')
        for($attempt=0;$attempt -lt 12;$attempt++) {
            Assert-Foreground
            if([DotDesktopNative]::GetClipboardSequenceNumber() -ne $sequence -and [Windows.Forms.Clipboard]::ContainsText([Windows.Forms.TextDataFormat]::UnicodeText)) {
                $copied=[Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText)
                if($copied -cne $sentinel){return @{changed=$true;text=[string]$copied}}
            }; Start-Sleep -Milliseconds 40
        }
        return @{changed=$false;text=$null}
    }

    function Dot-ComposerCandidates {
        $root=Fresh-Root;$cond=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit)
        $name=-join @([char]0x6D88,[char]0x606F)
        return @($root.FindAll([Windows.Automation.TreeScope]::Descendants,$cond)|Where-Object {
            $_.Current.Name -ceq $name -and (Has-Class $_ 'ProseMirror') -and $_.Current.IsEnabled -and
            -not $_.Current.IsOffscreen -and $_.Current.IsKeyboardFocusable -and -not $_.Current.IsPassword})
    }
    function Capture-DotObservation([int]$ObservationSequence) {
        $composer=Dot-Composer;$viewport=Raw-Ancestor $composer 'conversation-viewport';$pane=Raw-Ancestor $viewport 'thread-pane'
        if(-not(Raw-Contains (Fresh-Root) $pane)){Fail-Dot 'history-unavailable'}
        $raw=New-Object 'System.Collections.Generic.List[object]'
        $seen=New-Object 'System.Collections.Generic.HashSet[string]'
        function Collect-DotConversation($Element,[int]$Depth,[string]$ParentKey,[string]$RowKey,[string]$BodyKey) {
            $key=Key $Element
            if($Depth -gt 55 -or $raw.Count -ge 2500 -or -not $seen.Add($key)){Fail-Dot 'history-unavailable'}
            $type=$Element.Current.ControlType;$class=[string]$Element.Current.ClassName;$tokens=@($class -split '\s+')
            if($type -eq [Windows.Automation.ControlType]::Group -and $tokens -ccontains 'message-row'){$RowKey=$key;$BodyKey=$null}
            if($type -eq [Windows.Automation.ControlType]::Group -and $tokens -ccontains 'message-body'){$BodyKey=$key}
            $name=$null
            if($type -eq [Windows.Automation.ControlType]::Text){if($Element.Current.IsPassword){Fail-Dot 'history-unavailable'};$name=[string]$Element.Current.Name}
            $raw.Add(@{key=$key;parentKey=$ParentKey;rowKey=$RowKey;bodyKey=$BodyKey;type=$type;tokens=$tokens;name=$name})
            $child=[Windows.Automation.TreeWalker]::RawViewWalker.GetFirstChild($Element);$count=0
            while($null -ne $child){$count++;if($count -gt 200){Fail-Dot 'history-unavailable'}
                Collect-DotConversation $child ($Depth+1) $key $RowKey $BodyKey;$child=[Windows.Automation.TreeWalker]::RawViewWalker.GetNextSibling($child)}
        }
        Collect-DotConversation $viewport 0 $null $null $null
        $nodes=@($raw.ToArray());$rows=@($nodes|Where-Object {$_.type -eq [Windows.Automation.ControlType]::Group -and $_.tokens -ccontains 'message-row'})
        if($rows.Count -gt 45){Fail-Dot 'history-unavailable'}
        $rowParent=$null;$descriptions=@()
        foreach($row in $rows){
            if(-not $row.parentKey -or @($nodes|Where-Object {$_.key -ceq $row.parentKey}).Count -ne 1){Fail-Dot 'history-unavailable'}
            if($null -eq $rowParent){$rowParent=$row.parentKey}elseif($rowParent -cne $row.parentKey){Fail-Dot 'history-unavailable'}
            $bodies=@($nodes|Where-Object {$_.type -eq [Windows.Automation.ControlType]::Group -and $_.tokens -ccontains 'message-body' -and $_.rowKey -ceq $row.key})
            if($bodies.Count -ne 1){Fail-Dot 'history-unavailable'}
            $texts=@($nodes|Where-Object {$_.type -eq [Windows.Automation.ControlType]::Text -and $_.bodyKey -ceq $bodies[0].key})
            if($texts.Count -gt 200){Fail-Dot 'history-unavailable'};$fragments=@()
            foreach($text in $texts){if($text.name){$fragments+=([string]$text.name).Replace(([string][char]13+[string][char]10),[string][char]10)}}
            $value=[string]::Join([string][char]10,$fragments)
            if($value.Length -gt 32768){Fail-Dot 'history-unavailable'}
            $descriptions+=@{observationId=Dot-Hash ($beforeId+'|'+$creationTicks+'|'+$row.key);
                role=if($row.tokens -ccontains 'self'){'user'}else{'assistant'};textSha256=Dot-Hash $value}
        }
        if($null -eq $rowParent){Fail-Dot 'history-unavailable'}
        Assert-Foreground;$fresh=Dot-Composer
        if((Key(Raw-Ancestor $fresh 'conversation-viewport')) -cne (Key $viewport)){Fail-Dot 'history-unavailable'}
        $generationJson=@($beforeId,[int]$ownerId,$creationTicks.ToString(),$bound.ToInt64().ToString(),(Key $viewport),$rowParent)|ConvertTo-Json -Compress
        $rectangle=$viewport.Current.BoundingRectangle
        # Integer physical bounds avoid language-dependent floating JSON forms.
        $bounds=@([long][Math]::Floor($rectangle.X),[long][Math]::Floor($rectangle.Y),[long][Math]::Ceiling($rectangle.Width),[long][Math]::Ceiling($rectangle.Height))
        return [ordered]@{schemaVersion=1;requestId=[string]$request.requestId;operationId=[string]$request.operationId;
            requestFingerprint=[string]$request.requestFingerprint;threadId=$beforeId;hostId='durable';
            packageFamilyName=[string]$package.PackageFamilyName;version=[string]$package.Version;windowHandle=$bound.ToInt64().ToString();
            processId=[int]$ownerId;creationTicks=$creationTicks.ToString();viewportRuntimeId=Key $viewport;messageListRuntimeId=$rowParent;
            contextGeneration=Dot-Hash $generationJson;observationSequence=$ObservationSequence;
            observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();materializedRowCount=$rows.Count;completeMaterializedScope=$true;
            settled=$true;viewportBounds=$bounds;rows=@($descriptions|ForEach-Object {[ordered]@{observationId=$_.observationId;role=$_.role;textSha256=$_.textSha256}})}
    }
    Assert-Process;Assert-ReleasedInput
    if([DotDesktopNative]::IsIconic($bound)){$null=[DotDesktopNative]::ShowWindow($bound,9)}
    $null=[DotDesktopNative]::SetForegroundWindow($bound);Start-Sleep -Milliseconds 100;Assert-Foreground
    # Prove the outgoing source before any conversation navigation. Preserve
    # the current exact Dot view; unknown ordinary ChatGPT stays untouched.
    . (Join-Path $PSScriptRoot 'dot-desktop-navigation-guard.ps1')
    $alreadyDot=Protect-DotOutgoingSource $false ([string]$package.Version)
    if(-not $alreadyDot){
        $dot=Unique-Button 'Your dot' 'sidebar-item';$invoke=$null
        if(-not $dot.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)){Fail-Dot 'dot-unavailable'}
        Before-Input
        if(Protect-DotOutgoingSource $false ([string]$package.Version)){Fail-Dot 'target-mismatch'}
        $invoke.Invoke();Start-Sleep -Milliseconds 400;Assert-Foreground
        if(-not(Test-DotActualBlank)){Fail-Dot 'draft-present'}
    }
    $profiles=@(Dot-Profiles)
    if($profiles.Count -eq 0){$button=Unique-Button 'Toggle profile' '';$toggle=$null
        if(-not $button.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$toggle)){Fail-Dot 'dot-unavailable'}
        Before-Input;$toggle.Toggle()
        for($settle=0;$settle -lt 12;$settle++){Start-Sleep -Milliseconds 80;Assert-Foreground;$profiles=@(Dot-Profiles);if($profiles.Count -eq 1){break}}
    }
    if($profiles.Count -ne 1){Fail-Dot 'dot-unavailable'}
    $original=[Windows.Forms.Clipboard]::GetDataObject();$backup=New-Object Windows.Forms.DataObject
    if($null -ne $original){foreach($format in $original.GetFormats($false)){$value=$original.GetData($format,$false)
        if($value -is [IO.Stream]){$position=$value.Position;$copy=New-Object IO.MemoryStream;$value.Position=0;$value.CopyTo($copy);$value.Position=$position;$copy.Position=0;$value=$copy}
        elseif($value -is [ICloneable]){$value=$value.Clone()};$backup.SetData($format,$false,$value)}};$clipboardSaved=$true
    $beforeId=Copy-DurableIdentity
    if(-not(Test-DotActualBlank)){Fail-Dot 'draft-present'}
    $sendBaseline=Capture-DotObservation 1
    if($sendBaseline.rows.Count -gt 40){Fail-Dot 'history-unavailable'}
    Start-Sleep -Milliseconds 80;$settled=Capture-DotObservation 2
    if(($sendBaseline.rows|ConvertTo-Json -Depth 4 -Compress) -cne ($settled.rows|ConvertTo-Json -Depth 4 -Compress) -or
        $sendBaseline.contextGeneration -cne $settled.contextGeneration){Fail-Dot 'history-unavailable'}
    $sendBaselineDigest=Dot-Hash ($sendBaseline|ConvertTo-Json -Depth 10 -Compress)
    Emit-DotFrame 'prepared' @{baseline=$sendBaseline;baselineDigest=$sendBaselineDigest}
    Wait-DotAck 'paste' $sendBaselineDigest
    # Recheck after the parent's durable ACK, not just before it.
    if((Copy-DurableIdentity) -cne $beforeId -or -not(Test-DotActualBlank)){Fail-Dot 'draft-present'}
    $composer=Focus-DotComposer;$layout=Assert-DotAttachmentFree $composer;$ownedEditor=Key $composer;$ownedLayout=Key $layout
    Before-Input;[Windows.Forms.Clipboard]::SetText([string]$request.text,[Windows.Forms.TextDataFormat]::UnicodeText)
    Before-Input;[Windows.Forms.SendKeys]::SendWait('^v');$ownDraftPasted=$true;Start-Sleep -Milliseconds 120
    $copy=Copy-DotDraft
    if(-not $copy.changed -or $copy.text -cne [string]$request.text){Fail-Dot 'unknown'}
    $composer=Focus-DotComposer;$layout=Assert-DotAttachmentFree $composer
    if((Key $composer) -cne $ownedEditor -or (Key $layout) -cne $ownedLayout -or (Copy-DurableIdentity) -cne $beforeId){Fail-Dot 'target-mismatch'}
    Emit-DotFrame 'ready-to-send' @{baselineDigest=$sendBaselineDigest;composerTextHash=Dot-Hash $copy.text}
    Wait-DotAck 'invoke' $sendBaselineDigest
    $copy=Copy-DotDraft
    if(-not $copy.changed -or $copy.text -cne [string]$request.text -or (Copy-DurableIdentity) -cne $beforeId){Fail-Dot 'target-mismatch'}
    $composer=Focus-DotComposer;$layout=Assert-DotAttachmentFree $composer
    if((Key $composer) -cne $ownedEditor -or (Key $layout) -cne $ownedLayout){Fail-Dot 'target-mismatch'}
    $controls=@(Raw-Children $layout);$send=$controls[3];$sendInvoke=$null
    if(-not $send.Current.IsEnabled -or -not $send.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$sendInvoke)){Fail-Dot 'send-unavailable'}
    Before-Input;$sendAttempted=$true;$sendInvoke.Invoke();Start-Sleep -Milliseconds 200
    $after=Capture-DotObservation 3
    if((Copy-DurableIdentity) -cne $beforeId){Fail-Dot 'target-mismatch'}
    $result=@{stage='result';data=@{baselineDigest=$sendBaselineDigest;observation=$after;submitted=$true;
        draftRemaining=-not(Test-DotActualBlank);draftCleared=Test-DotActualBlank}}
} catch {
    $result=@{stage='error';data=@{code=$failure;submitted=if($sendAttempted){$null}else{$false};baselineDigest=$sendBaselineDigest;draftRemaining=$ownDraftPasted}}
} finally {
    if ($clipboardSaved) {
        try {[Windows.Forms.Clipboard]::SetDataObject($backup,$true)}
        catch {$result=@{stage='error';data=@{code='clipboard-unavailable';submitted=if($sendAttempted){$null}else{$false};baselineDigest=$sendBaselineDigest;draftRemaining=$ownDraftPasted}}}
    }
    if ($null -ne $nativeMutex) {
        try {if ($mutexOwned) {$nativeMutex.ReleaseMutex()}} finally {$nativeMutex.Dispose()}
    }
}
if($framedReady){Emit-DotFrame $result.stage $result.data}else{[Console]::Out.WriteLine('{"ok":false,"code":"send-unavailable","submitted":false}')}
