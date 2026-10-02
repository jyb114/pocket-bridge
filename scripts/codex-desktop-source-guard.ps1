# Pure source-view proof shared with the independent Dot adapter. The caller
# attests the official package, main window and current Codex mode. This never
# focuses, copies, navigates, clears, pastes or sends. Unknown shapes fail closed.
function Test-PocketBridgeCodexBlankSource($Editor, $BoundRoot, [string]$DesktopVersion, [bool]$KnownCodexView) {
    if (-not $KnownCodexView -or $DesktopVersion -cne '26.928.3736.0' -or
        $null -eq $Editor -or $null -eq $BoundRoot) { return $false }
    $guardWatch = [Diagnostics.Stopwatch]::StartNew()
    $guardStage = 'source-proof'
    function Fail-Relay([string]$Code, [string]$Reason) { throw 'source-proof-unavailable' }
    function Check-Deadline { if ($guardWatch.ElapsedMilliseconds -gt 8000) { throw 'source-proof-timeout' } }
    function Element-IsInBoundWindow($Element) {
        Check-Deadline
        if ($null -eq $Element -or $Element.Current.ProcessId -ne $BoundRoot.Current.ProcessId) { return $false }
        $current = $Element
        for ($depth = 0; $depth -lt 65 -and $null -ne $current; $depth++) {
            if ([string]::Join(',', $current.GetRuntimeId()) -ceq [string]::Join(',', $BoundRoot.GetRuntimeId())) { return $true }
            $current = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($current)
        }
        return $false
    }
    function Check-BoundForeground {
        Check-Deadline
        if ($BoundRoot.Current.ControlType -ne [Windows.Automation.ControlType]::Window -or
            $BoundRoot.Current.IsOffscreen -or $Editor.Current.IsOffscreen -or
            -not (Element-IsInBoundWindow $Editor)) { throw 'source-proof-window-changed' }
    }
    function Find-Composer {
        $candidates = @(Get-CodexComposerCandidates $BoundRoot)
        if ($candidates.Count -ne 1 -or -not (Runtime-IdsEqual $candidates[0] $Editor) -or
            -not (Element-IsInBoundWindow $candidates[0])) { throw 'source-proof-editor-changed' }
        return $candidates[0]
    }
    try {
        # Reuse only the audited, read-only definitions from the installed
        # native driver. A closed AST allowlist avoids a second divergent copy
        # of its actual placeholder/attachment-free raw tree contract.
        $source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'codex-desktop-ui.ps1'), [Text.Encoding]::UTF8)
        $tokens = $null; $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
        if ($errors.Count) { return $false }
        foreach ($name in @('Runtime-IdsEqual', 'Get-CodexComposerCandidates', 'Get-ComposerLayoutBody',
            'Test-ObservedEmptyComposerLayout', 'Test-EmptyPlaceholderComposer')) {
            $definitions = @($ast.FindAll({ param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
            }, $true))
            if ($definitions.Count -ne 1) { return $false }
            $definition = [string]$definitions[0].Extent.Text
            $definition = $definition.Replace('$script:WindowElement', '$BoundRoot').Replace('$script:Stage', '$guardStage')
            Invoke-Expression $definition
        }
        Check-BoundForeground
        return [bool](Test-EmptyPlaceholderComposer $Editor)
    } catch { return $false }
}
