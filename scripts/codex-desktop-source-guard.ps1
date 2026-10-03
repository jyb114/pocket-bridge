# Pure source-view proof shared with the independent Dot adapter. The caller
# attests the official package, main window and current Codex mode. This never
# focuses, copies, navigates, clears, pastes or sends. Unknown shapes fail closed.
function Test-PocketBridgeCompactActiveSourceLayout($Layout, $Composer, [bool]$Expanded = $false) {
    # Actual compact ACTIVE source observed on package 26.928.3736.0: exactly
    # six children, icon-only permission/model controls and a direct Stop.
    # The separately observed expanded ACTIVE variant retains the idle
    # permission/model setting labels and replaces only its terminal voice
    # control with the exact direct Stop tree. Neither variant grants target
    # Send authority; both remain outgoing-source empty proofs.
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    $common = 'no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full text-tertiary not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent h-token-button-composer '
    $square = $common + 'px-(--padding-button-composer-inline,calc(var(--spacing)*2)) py-0 text-(length:--text-button-composer,var(--text-sm)) leading-(--line-height-button-composer,18px) aspect-square shrink-0 items-center justify-center !px-0'
    $permission = $common + 'min-w-token-button-composer justify-center px-1.5 py-0 text-sm leading-[18px] outline-hidden cursor-interaction'
    $model = $common + 'px-2 py-0 text-sm leading-[18px] aspect-square shrink-0 items-center justify-center !px-0 min-w-0'
    $stop = 'cursor-interaction size-token-button-composer flex items-center justify-center rounded-full transition-opacity focus-visible:outline-2 bg-composer-primary p-0.5 focus-visible:outline-background-composer-primary'
    $types = @{group=[Windows.Automation.ControlType]::Group;button=[Windows.Automation.ControlType]::Button;image=[Windows.Automation.ControlType]::Image;text=[Windows.Automation.ControlType]::Text}
    $addNames = @('Add files and more',(-join [char[]]@(0x6DFB,0x52A0,0x6587,0x4EF6,0x7B49,0x5185,0x5BB9)))
    $permissionNames = @('Change permissions',(-join [char[]]@(0x66F4,0x6539,0x6743,0x9650)))
    $modelNames = @('Select model','Choose model',(-join [char[]]@(0x9009,0x62E9,0x6A21,0x578B)))
    $dictationNames = @('Dictate',(-join [char[]]@(0x542C,0x5199)))
    $stopNames = @('Stop',(-join [char[]]@(0x505C,0x6B62)))
    $sendNames = @('Send',(-join [char[]]@(0x53D1,0x9001)))
    function Active-Shape([string]$Kind,[string]$Class,[string[]]$Names,$Children,[bool]$SettingLabel = $false) {
        return @{kind=$Kind;class=$Class;names=$Names;children=@($Children);settingLabel=$SettingLabel}
    }
    $shapes = @(
        (Active-Shape 'group' 'contents' @('') @((Active-Shape 'button' $square $addNames @()))),
        (Active-Shape 'button' $permission $permissionNames @((Active-Shape 'image' 'icon-xs shrink-0 text-warning' @('') @()))),
        (Active-Shape 'group' 'contents outline-hidden cursor-interaction' @('') @((Active-Shape 'button' $model $modelNames @((Active-Shape 'image' 'icon-leading text-tertiary' @('') @()))))),
        (Active-Shape 'group' 'contents' @('') @((Active-Shape 'button' $square $dictationNames @((Active-Shape 'image' 'icon-leading text-default' @('') @()))))),
        (Active-Shape 'button' $stop $stopNames @((Active-Shape 'image' 'icon-primary-action text-composer-primary' @('') @())))
    )
    if ($Expanded) {
        # Dynamic names are allowed only on the same two setting labels that
        # the audited idle tree already permits. They cannot add raw text,
        # children or attachments, and cannot impersonate a Send control.
        $shapes[1] = Active-Shape 'button' $permission $permissionNames @(
            (Active-Shape 'image' 'icon-xs shrink-0 text-warning' @('') @()),
            (Active-Shape 'group' '_ComposerDropdownLabelValueContent_gjskc_105' @('') @(
                (Active-Shape 'text' '' @() @() $true)
            ))
        )
        $expandedModel = $common + 'px-2 py-0 text-sm leading-[18px] min-w-0'
        $shapes[2] = Active-Shape 'group' 'contents' @('') @(
            (Active-Shape 'button' $expandedModel @() @() $true)
        )
    }
    function Active-Children($Parent,[int]$Count) {
        $children = New-Object Collections.Generic.List[object]
        $child = $walker.GetFirstChild($Parent)
        while ($null -ne $child -and $children.Count -le $Count) {
            Check-Deadline
            if ($child.Current.ProcessId -ne $Composer.Current.ProcessId -or $child.Current.IsPassword -or
                -not (Element-IsInBoundWindow $child) -or
                -not (Runtime-IdsEqual ($walker.GetParent($child)) $Parent)) { throw 'source-active-ancestry-unverified' }
            $children.Add($child); $child = $walker.GetNextSibling($child)
        }
        if ($children.Count -ne $Count -or $null -ne $child) { throw 'source-active-children-unverified' }
        return $children.ToArray()
    }
    function Test-ActiveNode($Node,$Parent,$Shape,[bool]$ObservedCompactDictationWrapper = $false) {
        Check-Deadline
        $nameMatches = if ($Shape.settingLabel) {
            $Node.Current.Name -is [string] -and -not ($sendNames -ccontains $Node.Current.Name)
        } else { $Shape.names -ccontains $Node.Current.Name }
        if ($null -eq $Node -or $Node.Current.ProcessId -ne $Composer.Current.ProcessId -or
            $Node.Current.IsPassword -or -not $Node.Current.IsEnabled -or
            ($Node.Current.IsOffscreen -and -not $ObservedCompactDictationWrapper) -or
            -not (Element-IsInBoundWindow $Node) -or
            -not (Runtime-IdsEqual ($walker.GetParent($Node)) $Parent) -or
            $Node.Current.ControlType -ne $types[$Shape.kind] -or $Node.Current.ClassName -cne $Shape.class -or
            -not $nameMatches -or
            $Node.Current.IsKeyboardFocusable -ne ($Shape.kind -ceq 'button')) { return $false }
        $children = @(Active-Children $Node $Shape.children.Count)
        if ($children.Count -ne $Shape.children.Count) { return $false }
        for ($index=0; $index -lt $children.Count; $index++) {
            if (-not (Test-ActiveNode $children[$index] $Node $Shape.children[$index])) { return $false }
        }
        return $true
    }
    try {
        Check-BoundForeground
        if ($Layout.Current.ControlType -ne [Windows.Automation.ControlType]::Group -or
            $Layout.Current.ClassName -cne '_ComposerLayoutBody_gcdh7_2' -or $Layout.Current.Name.Length -ne 0 -or
            $Layout.Current.ProcessId -ne $Composer.Current.ProcessId -or $Layout.Current.IsKeyboardFocusable -or
            $Layout.Current.IsPassword -or -not $Layout.Current.IsEnabled -or $Layout.Current.IsOffscreen -or
            -not (Element-IsInBoundWindow $Layout)) { return $false }
        $children = @(Active-Children $Layout 6)
        if ($children.Count -ne 6 -or -not (Runtime-IdsEqual $children[0] $Composer) -or
            -not (@('ProseMirror','ProseMirror ProseMirror-focused') -ccontains $Composer.Current.ClassName)) { return $false }
        for ($index=1; $index -lt 6; $index++) {
            # The separately captured compact 18-node ACTIVE tree reports
            # IsOffscreen on only the noninteractive `contents` wrapper around
            # dictation, while its exact button and icon remain onscreen. Allow
            # that flag only at this direct structural slot. Recursion never
            # inherits it; every leaf and every expanded node stays visible.
            $observedWrapper = -not $Expanded -and $index -eq 4
            if (-not (Test-ActiveNode $children[$index] $Layout $shapes[$index-1] $observedWrapper)) { return $false }
        }
        return $true
    } catch { return $false }
}
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
            if ($name -ceq 'Test-ObservedEmptyComposerLayout') {
                $definition = $definition.Replace('function Test-ObservedEmptyComposerLayout(', 'function Test-PocketBridgeIdleSourceLayout(')
            }
            Invoke-Expression $definition
        }
        function Test-ObservedEmptyComposerLayout($Layout,$Composer) {
            return (Test-PocketBridgeIdleSourceLayout $Layout $Composer) -or
                (Test-PocketBridgeCompactActiveSourceLayout $Layout $Composer) -or
                (Test-PocketBridgeCompactActiveSourceLayout $Layout $Composer $true)
        }
        Check-BoundForeground
        return [bool](Test-EmptyPlaceholderComposer $Editor)
    } catch { return $false }
}
