' 让守护进程在**完全不出现窗口**的情况下运行。
'
' 为什么需要它
' ------------
' 计划任务「PocketBridge Gateway Watchdog」每 5 分钟跑一次
'     node.exe scripts\gateway-daemon.js
' 而任务计划程序直接启动**控制台程序**时会定期弹出黑框，干扰当前工作。
'
' 为什么不用任务自带的「隐藏」
' --------------------------
' Task Scheduler 的动作里确实有个 HideWindow，但它对控制台程序**并不总生效**
' —— 窗口是 conhost 起的，不在任务的直接控制之下。
' WScript.Shell.Run 的第二个参数 0 才是可靠的一招：由 wscript 去创建进程并
' 指定隐藏窗口，全程不闪。
'
' 路径从脚本自身位置推，不写死 —— 项目挪个目录也不用改这里。
Option Explicit

Dim fso, sh, base, nodeExe, daemon
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

' 这个文件在 <项目>\scripts\ 下，往上一层就是项目根
base = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
nodeExe = base & "\runtime\node-v24.18.1-win-x64\node.exe"
daemon = base & "\scripts\gateway-daemon.js"

If Not fso.FileExists(nodeExe) Then WScript.Quit 1
If Not fso.FileExists(daemon) Then WScript.Quit 1

sh.CurrentDirectory = base
' 0 = 隐藏窗口，False = 不等它结束（守护进程自己会退）
sh.Run """" & nodeExe & """ """ & daemon & """", 0, False
