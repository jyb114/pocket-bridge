# Source-view protection for independent Dot reading and sending. The caller
# already binds the official package, process birth and genuine main window.
# This module performs no focus, navigation, clipboard or message action.
function Get-DotSourceModeKind([string]$Name) {
    $prefix=-join @([char]0x5207,[char]0x6362,[char]0x6A21,[char]0x5F0F,[char]0xFF0C,
        [char]0x5F53,[char]0x524D,[char]0x6A21,[char]0x5F0F,[char]0xFF1A)
    if(@('Switch mode, current mode: Codex',($prefix+'Codex')) -ccontains $Name){return 'codex'}
    if(@('Switch mode, current mode: ChatGPT','Switch mode, current mode: ChatGPT Work',
        ($prefix+'ChatGPT'),($prefix+'ChatGPT Work')) -ccontains $Name){return 'chatgpt'}
    return $null
}
function Get-DotSourceEvidence {
    $root=Fresh-Root
    $buttons=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button)
    $edits=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit)
    $modes=@($root.FindAll([Windows.Automation.TreeScope]::Descendants,$buttons)|Where-Object {
        $null -ne (Get-DotSourceModeKind ([string]$_.Current.Name)) -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and (Raw-Contains $root $_)})
    $editors=@($root.FindAll([Windows.Automation.TreeScope]::Descendants,$edits)|Where-Object {
        (Has-Class $_ 'ProseMirror') -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and
        $_.Current.IsKeyboardFocusable -and -not $_.Current.IsPassword -and (Raw-Contains $root $_)})
    if($modes.Count -ne 1 -or $editors.Count -ne 1){Fail-Dot 'draft-present'}
    $kind=Get-DotSourceModeKind ([string]$modes[0].Current.Name)
    $profiles=@(Dot-Profiles)
    $names=@('Message',(-join @([char]0x6D88,[char]0x606F)))
    $dot=$kind -ceq 'chatgpt' -and $profiles.Count -eq 1 -and
        $names -ccontains $editors[0].Current.Name -and (Raw-Contains $root $profiles[0])
    return @{root=$root;mode=$kind;modeId=Key $modes[0];editor=$editors[0];editorId=Key $editors[0];currentDot=[bool]$dot}
}
function Protect-DotOutgoingSource([bool]$ReadOnlyCurrentDot,[string]$DesktopVersion) {
    Assert-Foreground
    $source=Get-DotSourceEvidence
    if($source.currentDot){
        # Reading the same physical Dot view is allowed with any unsent draft.
        # Sending requires the exact independently tested blank/attachment guard.
        if(-not $ReadOnlyCurrentDot){
            . (Join-Path $PSScriptRoot 'dot-desktop-source-guard.ps1')
            if(-not(Test-PocketBridgeDotBlankSource $source.editor $source.root $DesktopVersion $true)){Fail-Dot 'draft-present'}
        }
    }elseif($source.mode -ceq 'codex'){
        . (Join-Path $PSScriptRoot 'codex-desktop-source-guard.ps1')
        if(-not(Test-PocketBridgeCodexBlankSource $source.editor $source.root $DesktopVersion $true)){Fail-Dot 'draft-present'}
    }else{
        # Ordinary ChatGPT and unverified Dot shapes remain untouched.
        Fail-Dot 'draft-present'
    }
    Assert-Foreground
    $fresh=Get-DotSourceEvidence
    if($fresh.mode -cne $source.mode -or $fresh.modeId -cne $source.modeId -or
        $fresh.editorId -cne $source.editorId -or $fresh.currentDot -ne $source.currentDot){Fail-Dot 'draft-present'}
    return [bool]$source.currentDot
}
