# Pure, read-only Dot source-composer proof from four actual native cases.
# Caller attests the official package/window and actual Your dot view first.
# No focus, navigation, clipboard input, clearing or Send is performed here.
function Test-PocketBridgeDotBlankSource($Editor,$BoundRoot,[string]$DesktopVersion,[bool]$KnownDotView) {
    if(-not $KnownDotView -or $DesktopVersion -cne '26.928.3736.0' -or $null -eq $Editor -or $null -eq $BoundRoot){return $false}
    $sendEvidence=@{}
    $accepted=@'
{"rawLayoutTree":{"className":"_ComposerLayoutBody_gcdh7_2","name":"","controlType":"ControlType.Group","children":[{"className":"contents","name":"","controlType":"ControlType.Group","children":[{"className":"no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full text-tertiary not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent h-token-button-composer px-(--padding-button-composer-inline,calc(var(--spacing)*2)) py-0 text-(length:--text-button-composer,var(--text-sm)) leading-(--line-height-button-composer,18px) aspect-square shrink-0 items-center justify-center !px-0","name":"\u6dfb\u52a0\u6587\u4ef6\u7b49\u5185\u5bb9","controlType":"ControlType.Button","children":[]}]},{"className":"ProseMirror ProseMirror-focused","name":"\u6d88\u606f","controlType":"ControlType.Edit","children":[]},{"className":"flex shrink-0 items-center gap-2","name":"","controlType":"ControlType.Group","children":[{"className":"contents","name":"","controlType":"ControlType.Group","children":[{"className":"no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full text-tertiary not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent h-token-button-composer px-(--padding-button-composer-inline,calc(var(--spacing)*2)) py-0 text-(length:--text-button-composer,var(--text-sm)) leading-(--line-height-button-composer,18px) aspect-square shrink-0 items-center justify-center !px-0","name":"\u542c\u5199","controlType":"ControlType.Button","children":[{"className":"icon-leading text-default","name":"","controlType":"ControlType.Image","children":[]}]}]}]},{"className":"cursor-interaction size-token-button-composer flex items-center justify-center rounded-full transition-opacity focus-visible:outline-2 bg-composer-primary p-0.5 focus-visible:outline-background-composer-primary cursor-default opacity-50","name":"\u53d1\u9001","controlType":"ControlType.Button","children":[]}]},"rawComposerTree":{"className":"ProseMirror ProseMirror-focused","name":"\u6d88\u606f","controlType":"ControlType.Edit","children":[{"className":"placeholder","name":"","controlType":"ControlType.Group","children":[{"className":"","name":"","controlType":"ControlType.Group","children":[{"className":"","name":"Send a message","controlType":"ControlType.Text","children":[]}]},{"className":"ProseMirror-trailingBreak","name":"\n","controlType":"ControlType.Text","children":[]}]}]}}
'@|ConvertFrom-Json
    $expanded=@'
{"rawLayoutTree":{"className":"_ComposerLayoutBody_gcdh7_2","name":"","controlType":"ControlType.Group","children":[{"className":"ProseMirror ProseMirror-focused","name":"\u6d88\u606f","controlType":"ControlType.Edit","children":[]},{"className":"contents","name":"","controlType":"ControlType.Group","children":[{"className":"no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full text-tertiary not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent h-token-button-composer px-(--padding-button-composer-inline,calc(var(--spacing)*2)) py-0 text-(length:--text-button-composer,var(--text-sm)) leading-(--line-height-button-composer,18px) aspect-square shrink-0 items-center justify-center !px-0","name":"\u6dfb\u52a0\u6587\u4ef6\u7b49\u5185\u5bb9","controlType":"ControlType.Button","children":[]}]},{"className":"flex shrink-0 items-center gap-2","name":"","controlType":"ControlType.Group","children":[{"className":"contents","name":"","controlType":"ControlType.Group","children":[{"className":"no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full text-tertiary not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent h-token-button-composer px-(--padding-button-composer-inline,calc(var(--spacing)*2)) py-0 text-(length:--text-button-composer,var(--text-sm)) leading-(--line-height-button-composer,18px) aspect-square shrink-0 items-center justify-center !px-0","name":"\u542c\u5199","controlType":"ControlType.Button","children":[{"className":"icon-leading text-default","name":"","controlType":"ControlType.Image","children":[]}]}]}]},{"className":"cursor-interaction size-token-button-composer flex items-center justify-center rounded-full transition-opacity focus-visible:outline-2 bg-composer-primary p-0.5 focus-visible:outline-background-composer-primary","name":"\u53d1\u9001","controlType":"ControlType.Button","children":[]}]}}
'@|ConvertFrom-Json
    function Key($Element){return [string]::Join(',',$Element.GetRuntimeId())}
    function Has-Class($Element,[string]$Token){return @($Element.Current.ClassName -split '\s+') -ccontains $Token}
    function Fresh-Root{return $BoundRoot}
    function Dot-Composer{return $Editor}
    function Raw-Contains($Scope,$Element){$current=$Element
        for($depth=0;$depth -lt 55 -and $null -ne $current;$depth++){
            if((Key $current) -ceq (Key $Scope)){return $true}
            $current=[Windows.Automation.TreeWalker]::RawViewWalker.GetParent($current)};return $false}
    function Raw-Ancestor($Element,[string]$Token){$current=$Element
        for($depth=0;$depth -lt 55 -and $null -ne $current;$depth++){
            if((Has-Class $current $Token) -and $current.Current.ControlType -eq [Windows.Automation.ControlType]::Group){return $current}
            $current=[Windows.Automation.TreeWalker]::RawViewWalker.GetParent($current)};throw 'dot-source-scope-unknown'}
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

    try {
        $name=-join @([char]0x6D88,[char]0x606F)
        if($Editor.Current.ControlType -ne [Windows.Automation.ControlType]::Edit -or $Editor.Current.Name -cne $name -or
            -not(Has-Class $Editor 'ProseMirror') -or $Editor.Current.IsPassword -or -not $Editor.Current.IsEnabled -or
            $Editor.Current.IsOffscreen -or -not(Raw-Contains $BoundRoot $Editor)){return $false}
        return [bool](Test-DotActualBlank)
    }catch{return $false}
}
