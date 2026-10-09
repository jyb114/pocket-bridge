/* Pocket Bridge's DSH settings panel. MIT; no external assets or dependencies.
 * React is provided by DSH's own module loader, not bundled by this plugin.
 * Pairing links live only in this mounted panel's memory. */
window.__ModuleLoader__.load({
  id: 'pocket-bridge',
  factory(require) {
    'use strict';
    const React = require('react');
    const h = React.createElement;

    const CSS = `
.pb-plugin{--pb-accent:#3269e8;--pb-border:color-mix(in srgb,currentColor 16%,transparent);--pb-muted:color-mix(in srgb,currentColor 64%,transparent);max-width:840px;margin:0 auto;padding:24px;line-height:1.5;color:inherit;font-family:inherit;box-sizing:border-box}
.pb-plugin *{box-sizing:border-box}.pb-plugin h2,.pb-plugin h3,.pb-plugin p{margin:0}.pb-plugin h2{font-size:25px;letter-spacing:-.6px;font-weight:650}.pb-plugin h3{font-size:16px;font-weight:620}.pb-plugin button,.pb-plugin input{font:inherit}.pb-plugin button{min-height:42px;border:1px solid var(--pb-border);border-radius:9px;padding:9px 14px;background:transparent;color:inherit;cursor:pointer;line-height:1.3}.pb-plugin button:hover:not(:disabled){background:color-mix(in srgb,currentColor 6%,transparent)}.pb-plugin button:focus-visible,.pb-plugin input:focus-visible{outline:3px solid var(--pb-accent);outline-offset:3px}.pb-plugin button:disabled{opacity:.45;cursor:not-allowed}.pb-plugin .pb-primary{background:var(--pb-accent);color:#fff;border-color:var(--pb-accent)}.pb-plugin .pb-primary:hover:not(:disabled){background:#2458cf}.pb-plugin .pb-danger{color:#bc3636;border-color:color-mix(in srgb,#bc3636 40%,transparent)}.pb-plugin .pb-header{display:flex;align-items:center;gap:13px;margin-bottom:24px}.pb-plugin .pb-logo{width:44px;height:44px;flex:none}.pb-plugin .pb-muted{color:var(--pb-muted);font-size:13px}.pb-plugin .pb-card{border:1px solid var(--pb-border);border-radius:14px;padding:20px;margin-bottom:16px}.pb-plugin .pb-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.pb-plugin .pb-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:18px}.pb-plugin .pb-badge{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--pb-border);border-radius:20px;padding:4px 10px;font-size:12px;white-space:nowrap}.pb-plugin .pb-dot{width:7px;height:7px;border-radius:50%;background:#999}.pb-plugin .pb-dot.running{background:#20976a}.pb-plugin .pb-dot.unavailable{background:#be7322}.pb-plugin .pb-fields{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:18px}.pb-plugin .pb-value{font-size:14px;margin-top:3px;overflow-wrap:anywhere}.pb-plugin .pb-hint{margin-top:12px;color:var(--pb-muted);font-size:13px}.pb-plugin .pb-notice{border-radius:10px;background:color-mix(in srgb,var(--pb-accent) 8%,transparent);padding:12px 14px;margin-bottom:16px;font-size:13px;overflow-wrap:anywhere}.pb-plugin .pb-notice.error{background:color-mix(in srgb,#c53838 8%,transparent)}.pb-plugin .pb-notice button{margin:8px 8px 0 0;min-height:34px;padding:6px 10px}.pb-plugin .pb-pairing{display:grid;grid-template-columns:210px minmax(0,1fr);gap:20px;margin-top:20px;padding-top:20px;border-top:1px solid var(--pb-border);align-items:center}.pb-plugin .pb-qr{display:block;width:210px;height:210px;background:#fff;border-radius:8px;padding:8px;image-rendering:pixelated}.pb-plugin .pb-private-link{width:100%;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:inherit;background:transparent;border:1px solid var(--pb-border);border-radius:8px;padding:10px;margin-top:12px;min-height:42px}.pb-plugin .pb-checks{list-style:none;margin:16px 0 0;padding:0}.pb-plugin .pb-check{display:grid;grid-template-columns:24px 1fr;gap:8px;padding:12px 0;border-top:1px solid var(--pb-border)}.pb-plugin .pb-check-mark{font-size:16px}.pb-plugin .pb-check.pass .pb-check-mark{color:#20976a}.pb-plugin .pb-check.fail .pb-check-mark{color:#bc3636}.pb-plugin .pb-check-title{font-size:14px;font-weight:550}.pb-plugin .pb-confirm{border:1px solid color-mix(in srgb,#bc3636 40%,transparent);border-radius:10px;padding:16px;margin-top:16px}.pb-plugin .pb-footer{font-size:12px;color:var(--pb-muted);margin-top:22px}.pb-plugin .pb-spinner{display:inline-block;width:12px;height:12px;border:2px solid var(--pb-border);border-top-color:var(--pb-accent);border-radius:50%;animation:pb-spin .8s linear infinite;margin-right:7px;vertical-align:-1px}@keyframes pb-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.pb-plugin .pb-spinner{animation:none}}@media(max-width:560px){.pb-plugin{padding:18px 14px}.pb-plugin h2{font-size:22px}.pb-plugin .pb-card{padding:16px}.pb-plugin .pb-fields{grid-template-columns:1fr}.pb-plugin .pb-pairing{grid-template-columns:1fr}.pb-plugin .pb-qr{margin:auto}.pb-plugin .pb-row{align-items:flex-start;gap:10px}.pb-plugin .pb-actions button{flex:1 1 auto}.pb-plugin .pb-badge{font-size:11px;padding:4px 8px}}

.pb-plugin{width:100%;min-width:0;max-width:min(840px,100%);overflow-wrap:anywhere}.pb-plugin button,.pb-plugin select{min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere}.pb-plugin .pb-header,.pb-plugin .pb-row{flex-wrap:wrap}.pb-plugin .pb-header>div,.pb-plugin .pb-row>div{min-width:0}.pb-plugin .pb-badge{max-width:100%;white-space:normal}.pb-plugin .pb-fields{grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))}.pb-plugin .pb-pairing{grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr))}.pb-plugin .pb-qr{max-width:100%;height:auto;aspect-ratio:1}.pb-plugin .pb-language{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 16px}.pb-plugin .pb-language select{font:inherit;color:inherit;background:transparent;border:1px solid var(--pb-border);border-radius:7px;padding:6px;min-height:38px}.pb-plugin .pb-details{margin-top:14px;font-size:13px}.pb-plugin .pb-details summary{cursor:pointer}.pb-plugin select:focus-visible,.pb-plugin summary:focus-visible{outline:3px solid var(--pb-accent);outline-offset:3px}
`;

    // These translations belong only to this mounted plugin panel. They never
    // change the host's locale, storage, cookies, transport, or control state.
    const TRANSLATIONS = {
      "Key ready; phone delivery not tested": {
        "zh": "密钥已就绪；尚未测试手机端接收",
        "es": "Clave lista; recepción en el teléfono sin probar"
      },
      "Encryption key not confirmed": {
        "zh": "尚未确认加密密钥",
        "es": "Clave de cifrado sin confirmar"
      },
      "This bridge is connected to a different DSH runtime. Open desktop controls and select this DSH instance, then refresh.": {
        "zh": "此桥接服务已连接到另一个 DSH 运行实例。请打开桌面控制面板，选择当前 DSH 实例，然后刷新。",
        "es": "Este puente está conectado a otro entorno de ejecución de DSH. Abre los controles de escritorio, selecciona esta instancia de DSH y actualiza."
      },
      "Open desktop controls to finish the bridge setup, then refresh.": {
        "zh": "请打开桌面控制面板，完成桥接设置后刷新。",
        "es": "Abre los controles de escritorio para completar la configuración del puente y actualiza."
      },
      "Use Start bridge below. If startup fails, check the prerequisites and run diagnostics.": {
        "zh": "请使用下方的“启动桥接”。如果启动失败，请检查运行要求并运行诊断。",
        "es": "Pulsa «Iniciar puente» abajo. Si no se inicia, revisa los requisitos y ejecuta el diagnóstico."
      },
      "Start the bridge, then try again.": {
        "zh": "请先启动桥接服务，然后重试。",
        "es": "Inicia el puente y vuelve a intentarlo."
      },
      "The internet tunnel is not ready. Wait a moment, then refresh. Desktop controls show tunnel errors.": {
        "zh": "互联网隧道尚未就绪。请稍候再刷新。可在桌面控制面板中查看隧道错误。",
        "es": "El túnel de internet aún no está listo. Espera un momento y actualiza. Los controles de escritorio muestran los errores del túnel."
      },
      "The secure connection is not ready. Refresh the status or open desktop controls.": {
        "zh": "安全连接尚未就绪。请刷新状态或打开桌面控制面板。",
        "es": "La conexión segura aún no está lista. Actualiza el estado o abre los controles de escritorio."
      },
      "The bridge restarted. Refresh before trying again.": {
        "zh": "桥接服务已重启。请刷新后再试。",
        "es": "El puente se ha reiniciado. Actualiza antes de volver a intentarlo."
      },
      "The bridge changed while this request was running. Refresh before trying again.": {
        "zh": "处理此请求期间，桥接服务发生了变化。请刷新后再试。",
        "es": "El puente ha cambiado durante esta solicitud. Actualiza antes de volver a intentarlo."
      },
      "Open this panel in DSH on this computer using a localhost address.": {
        "zh": "请通过本机的 localhost 地址，在 DSH 中打开此面板。",
        "es": "Abre este panel en DSH en este equipo mediante una dirección localhost."
      },
      "The bridge did not respond in time. Refresh to check what actually happened before trying again.": {
        "zh": "桥接服务未及时响应。请先刷新并确认实际结果，再重试。",
        "es": "El puente no respondió a tiempo. Actualiza para comprobar qué ocurrió antes de volver a intentarlo."
      },
      "The local connection was interrupted. Check that DSH and Pocket Bridge are running, then refresh.": {
        "zh": "本地连接已中断。请确认 DSH 和 Pocket Bridge 正在运行，然后刷新。",
        "es": "La conexión local se ha interrumpido. Comprueba que DSH y Pocket Bridge estén en ejecución y actualiza."
      },
      "Select a complete Pocket Bridge installation in this plugin’s configuration, then refresh.": {
        "zh": "请在此插件的配置中选择完整的 Pocket Bridge 安装，然后刷新。",
        "es": "Selecciona una instalación completa de Pocket Bridge en la configuración de este plugin y actualiza."
      },
      "Select your Pocket Bridge installation in this plugin’s configuration, then refresh.": {
        "zh": "请在此插件的配置中选择你的 Pocket Bridge 安装，然后刷新。",
        "es": "Selecciona tu instalación de Pocket Bridge en la configuración de este plugin y actualiza."
      },
      "The last start attempt found only an older Node.js runtime. Install genuine Node.js 24 or newer, restart DSH, then try Start bridge again.": {
        "zh": "上次启动时只找到了较旧的 Node.js 运行时。请安装标准 Node.js 24 或更高版本，重启 DSH 后再次点击“启动桥接”。",
        "es": "En el último intento de inicio solo se encontró una versión antigua del entorno de ejecución de Node.js. Instala una distribución genuina de Node.js 24 o posterior, reinicia DSH y vuelve a pulsar «Iniciar puente»."
      },
      "The last start attempt could not find a usable genuine Node.js 24+ runtime. Install Node.js 24 or newer, restart DSH, then try Start bridge again. The DSH desktop app’s embedded runtime may not be usable.": {
        "zh": "上次启动时未找到可用的标准 Node.js 24+ 运行时。请安装 Node.js 24 或更高版本，重启 DSH 后再次点击“启动桥接”。DSH 桌面应用内置的运行时可能无法用于启动。",
        "es": "En el último intento de inicio no se encontró un entorno de ejecución genuino y utilizable de Node.js 24+. Instala Node.js 24 o posterior, reinicia DSH y vuelve a pulsar «Iniciar puente». Es posible que el entorno integrado en la aplicación de escritorio de DSH no sirva."
      },
      "The bridge is already starting or stopping. Refresh to check its progress; do not repeat the request.": {
        "zh": "桥接服务正在启动或停止。请刷新查看进度，不要重复发送请求。",
        "es": "El puente ya se está iniciando o deteniendo. Actualiza para comprobar el progreso; no repitas la solicitud."
      },
      "The last operation was not confirmed. Refresh to check its state before retrying Start bridge; open desktop controls if available.": {
        "zh": "尚未确认上次操作的结果。请先刷新并检查状态，再次点击“启动桥接”；也可打开桌面控制面板（如可用）。",
        "es": "No se ha confirmado la última operación. Actualiza para comprobar su estado antes de volver a pulsar «Iniciar puente»; abre los controles de escritorio si están disponibles."
      },
      "The bridge did not finish starting. Refresh before retrying Start bridge; open desktop controls if available.": {
        "zh": "桥接服务未完成启动。请先刷新再点击“启动桥接”；也可打开桌面控制面板（如可用）。",
        "es": "El puente no terminó de iniciarse. Actualiza antes de volver a pulsar «Iniciar puente»; abre los controles de escritorio si están disponibles."
      },
      "Start the bridge, then show the phone connection again.": {
        "zh": "请先启动桥接服务，再次显示手机连接信息。",
        "es": "Inicia el puente y vuelve a mostrar la conexión del teléfono."
      },
      "This DSH runtime is not responding. Keep DSH open, then refresh the bridge status.": {
        "zh": "当前 DSH 运行实例无响应。请保持 DSH 开启，然后刷新桥接状态。",
        "es": "Este entorno de ejecución de DSH no responde. Mantén DSH abierto y actualiza el estado del puente."
      },
      "The bridge restarted or its installation changed. Refresh before trying again.": {
        "zh": "桥接服务已重启，或其安装发生了变化。请刷新后再试。",
        "es": "El puente se ha reiniciado o su instalación ha cambiado. Actualiza antes de volver a intentarlo."
      },
      "A secure phone connection is not ready. Open desktop controls and check encryption and the tunnel.": {
        "zh": "安全的手机连接尚未就绪。请打开桌面控制面板，检查加密和隧道状态。",
        "es": "La conexión segura del teléfono aún no está lista. Abre los controles de escritorio y comprueba el cifrado y el túnel."
      },
      "Local authorization was rejected. Refresh this panel’s status, then retry. If it continues, reopen the authenticated DSH interface on this computer.": {
        "zh": "本地授权被拒绝。请刷新此面板的状态后重试。如果问题持续，请在本机重新打开已通过身份验证的 DSH 界面。",
        "es": "La autorización local fue rechazada. Actualiza el estado de este panel y vuelve a intentarlo. Si persiste, vuelve a abrir la interfaz autenticada de DSH en este equipo."
      },
      "Local authorization is not ready. Refresh this panel’s status, then retry your action. No write request was sent.": {
        "zh": "本地授权尚未就绪。请刷新此面板的状态后重试。未发送任何写入请求。",
        "es": "La autorización local aún no está lista. Actualiza el estado de este panel y vuelve a intentar la acción. No se envió ninguna solicitud de escritura."
      },
      "The local service did not respond in time. Refresh to check what actually happened before trying again.": {
        "zh": "本地服务未及时响应。请先刷新并确认实际结果，再重试。",
        "es": "El servicio local no respondió a tiempo. Actualiza para comprobar qué ocurrió antes de volver a intentarlo."
      },
      "The bridge service is unavailable. Refresh its status, then use Start bridge if it is stopped.": {
        "zh": "桥接服务不可用。请刷新状态；如果已停止，请点击“启动桥接”。",
        "es": "El servicio del puente no está disponible. Actualiza su estado y pulsa «Iniciar puente» si está detenido."
      },
      "This plugin was reloaded or removed. Reload the DSH page before trying again.": {
        "zh": "此插件已重新加载或被移除。请重新加载 DSH 页面后再试。",
        "es": "Este plugin se ha recargado o eliminado. Recarga la página de DSH antes de volver a intentarlo."
      },
      "Refresh the status. If the problem continues, run diagnostics or open desktop controls.": {
        "zh": "请刷新状态。如果问题持续，请运行诊断或打开桌面控制面板。",
        "es": "Actualiza el estado. Si el problema persiste, ejecuta el diagnóstico o abre los controles de escritorio."
      },
      "The private connection has been hidden automatically. Show it again when needed.": {
        "zh": "私密连接信息已自动隐藏。需要时可再次显示。",
        "es": "La conexión privada se ha ocultado automáticamente. Vuelve a mostrarla cuando la necesites."
      },
      "The bridge is running. DSH stays open.": {
        "zh": "桥接服务正在运行。DSH 将保持开启。",
        "es": "El puente está en ejecución. DSH permanece abierto."
      },
      "The bridge is stopped. DSH stays open; phone connections are paused.": {
        "zh": "桥接服务已停止。DSH 将保持开启；手机连接已暂停。",
        "es": "El puente está detenido. DSH permanece abierto; las conexiones del teléfono están en pausa."
      },
      "Starting the bridge…": {
        "zh": "正在启动桥接服务…",
        "es": "Iniciando el puente…"
      },
      "Stopping the bridge…": {
        "zh": "正在停止桥接服务…",
        "es": "Deteniendo el puente…"
      },
      "Start requested. Checking the bridge status…": {
        "zh": "已请求启动。正在检查桥接状态…",
        "es": "Inicio solicitado. Comprobando el estado del puente…"
      },
      "Stop requested. Checking the bridge status…": {
        "zh": "已请求停止。正在检查桥接状态…",
        "es": "Parada solicitada. Comprobando el estado del puente…"
      },
      "The request was accepted. The bridge has not confirmed its new state yet; refresh to check.": {
        "zh": "请求已接受。桥接服务尚未确认新状态，请刷新查看。",
        "es": "La solicitud se ha aceptado. El puente aún no ha confirmado su nuevo estado; actualiza para comprobarlo."
      },
      "Private phone connection QR code": {
        "zh": "手机私密连接二维码",
        "es": "Código QR de conexión privada del teléfono"
      },
      "Starting…": {
        "zh": "正在启动…",
        "es": "Iniciando…"
      },
      "Stopping…": {
        "zh": "正在停止…",
        "es": "Deteniendo…"
      },
      "Checking…": {
        "zh": "正在检查…",
        "es": "Comprobando…"
      },
      "Running": {
        "zh": "运行中",
        "es": "En ejecución"
      },
      "Stopped": {
        "zh": "已停止",
        "es": "Detenido"
      },
      "Setup needed": {
        "zh": "需要设置",
        "es": "Requiere configuración"
      },
      "Unavailable": {
        "zh": "不可用",
        "es": "No disponible"
      },
      "Not connected": {
        "zh": "未连接",
        "es": "Sin conexión"
      },
      "Private link copied. Share it only with someone you trust.": {
        "zh": "私密链接已复制。请仅与信任的人分享。",
        "es": "Enlace privado copiado. Compártelo solo con personas de confianza."
      },
      "Clipboard access is unavailable. The private link is selected; copy it manually.": {
        "zh": "无法访问剪贴板。私密链接已选中，请手动复制。",
        "es": "No se puede acceder al portapapeles. El enlace privado está seleccionado; cópialo manualmente."
      },
      "No verified local controls address is available. Use Start bridge and check the prerequisites below.": {
        "zh": "暂无经过验证的本地控制面板地址。请点击“启动桥接”，并检查下方的运行要求。",
        "es": "No hay una dirección verificada de los controles locales. Pulsa «Iniciar puente» y revisa los requisitos que aparecen abajo."
      },
      "Pocket Bridge controls": {
        "zh": "Pocket Bridge 控制面板",
        "es": "Controles de Pocket Bridge"
      },
      "Pocket Bridge": {
        "zh": "Pocket Bridge",
        "es": "Pocket Bridge"
      },
      "Your DSH workspace, within reach.": {
        "zh": "你的 DSH 工作区，随手可及。",
        "es": "Tu espacio de trabajo de DSH, al alcance de la mano."
      },
      "Open this panel in the DSH desktop app or its authenticated localhost web interface on this computer. Remote pages cannot read or change the private bridge connection.": {
        "zh": "请在本机的 DSH 桌面应用或已通过身份验证的 localhost 网页界面中打开此面板。远程页面无法读取或更改桥接服务的私密连接。",
        "es": "Abre este panel en la aplicación de escritorio de DSH o en su interfaz web localhost autenticada en este equipo. Las páginas remotas no pueden leer ni cambiar la conexión privada del puente."
      },
      "Refresh status": {
        "zh": "刷新状态",
        "es": "Actualizar estado"
      },
      "Open desktop controls": {
        "zh": "打开桌面控制面板",
        "es": "Abrir controles de escritorio"
      },
      "Bridge status": {
        "zh": "桥接状态",
        "es": "Estado del puente"
      },
      "These controls manage Pocket Bridge. They do not close DSH.": {
        "zh": "这些控件用于管理 Pocket Bridge，不会关闭 DSH。",
        "es": "Estos controles gestionan Pocket Bridge. No cierran DSH."
      },
      "Before starting: install genuine Node.js 24 or newer. Public internet tunnels also need cloudflared; private HTTPS does not. The Windows installer includes Node.js and cloudflared, but the plugin package does not.": {
        "zh": "启动前，请安装标准 Node.js 24 或更高版本。公网隧道还需要 cloudflared；私有 HTTPS 不需要。Windows 安装程序包含 Node.js 和 cloudflared，但插件包不包含。",
        "es": "Antes de iniciar: instala una distribución genuina de Node.js 24 o posterior. Los túneles públicos de internet también necesitan cloudflared; HTTPS privado no. El instalador de Windows incluye Node.js y cloudflared, pero el paquete del plugin no."
      },
      "Connection": {
        "zh": "连接",
        "es": "Conexión"
      },
      "Internet tunnel": {
        "zh": "互联网隧道",
        "es": "Túnel de internet"
      },
      "Private HTTPS": {
        "zh": "私有 HTTPS",
        "es": "HTTPS privado"
      },
      "Not ready": {
        "zh": "未就绪",
        "es": "No está listo"
      },
      "Not checked": {
        "zh": "未检查",
        "es": "Sin comprobar"
      },
      "Available": {
        "zh": "可用",
        "es": "Disponible"
      },
      "Bridge version": {
        "zh": "桥接版本",
        "es": "Versión del puente"
      },
      "Message encryption": {
        "zh": "消息加密",
        "es": "Cifrado de mensajes"
      },
      "Start bridge": {
        "zh": "启动桥接",
        "es": "Iniciar puente"
      },
      "Stop bridge": {
        "zh": "停止桥接",
        "es": "Detener puente"
      },
      "Refreshing…": {
        "zh": "正在刷新…",
        "es": "Actualizando…"
      },
      "Disabling or uninstalling this plugin does not stop a running bridge. Use Stop bridge first to pause phone access. Stopping does not revoke paired devices or shared links. Tunnel addresses may change after restart. Manage or revoke access in desktop controls.": {
        "zh": "禁用或卸载此插件不会停止正在运行的桥接服务。要暂停手机访问，请先点击“停止桥接”。停止服务不会撤销已配对设备或已分享链接的访问权限。重启后，隧道地址可能改变。请在桌面控制面板中管理或撤销访问权限。",
        "es": "Desactivar o desinstalar este plugin no detiene un puente en ejecución. Pulsa primero «Detener puente» para pausar el acceso desde el teléfono. Detenerlo no revoca los dispositivos vinculados ni los enlaces compartidos. Las direcciones del túnel pueden cambiar tras reiniciar. Gestiona o revoca el acceso en los controles de escritorio."
      },
      "Confirm stop bridge": {
        "zh": "确认停止桥接",
        "es": "Confirmar detención del puente"
      },
      "Pause phone access?": {
        "zh": "暂停手机访问？",
        "es": "¿Pausar el acceso desde el teléfono?"
      },
      "Stopping the bridge stops serving phone connections. DSH stays open, and its running tasks continue.": {
        "zh": "停止桥接服务后，将不再提供手机连接。DSH 会保持开启，其中正在运行的任务会继续。",
        "es": "Detener el puente deja de atender las conexiones del teléfono. DSH permanece abierto y sus tareas en curso continúan."
      },
      "Cancel": {
        "zh": "取消",
        "es": "Cancelar"
      },
      "Connect your phone": {
        "zh": "连接手机",
        "es": "Conecta tu teléfono"
      },
      "Open the secure link in your phone browser. Connection details stay hidden until you ask to see them.": {
        "zh": "请在手机浏览器中打开安全链接。连接信息默认隐藏，点击后才会显示。",
        "es": "Abre el enlace seguro en el navegador del teléfono. Los datos de conexión permanecen ocultos hasta que decidas verlos."
      },
      "The secure phone entrance is not ready. Keep the bridge running, then refresh or run diagnostics.": {
        "zh": "手机安全入口尚未就绪。请保持桥接服务运行，然后刷新或运行诊断。",
        "es": "El acceso seguro del teléfono aún no está listo. Mantén el puente en ejecución y actualiza o ejecuta el diagnóstico."
      },
      "Hide connection": {
        "zh": "隐藏连接信息",
        "es": "Ocultar conexión"
      },
      "Preparing connection…": {
        "zh": "正在准备连接…",
        "es": "Preparando conexión…"
      },
      "Show connection": {
        "zh": "显示连接信息",
        "es": "Mostrar conexión"
      },
      "This link is too long for the local QR code. Copy the private link instead.": {
        "zh": "此链接太长，无法生成本地二维码。请改为复制私密链接。",
        "es": "Este enlace es demasiado largo para el código QR local. Copia el enlace privado."
      },
      "Scan with your phone camera": {
        "zh": "用手机相机扫描",
        "es": "Escanea con la cámara del teléfono"
      },
      "This QR code contains a private access link. Anyone with the link can connect. Keep it out of screenshots and public posts.": {
        "zh": "此二维码包含私密访问链接。任何持有链接的人都能连接。请勿将其放入截图或公开发布。",
        "es": "Este código QR contiene un enlace de acceso privado. Cualquiera que tenga el enlace puede conectarse. No lo incluyas en capturas de pantalla ni en publicaciones públicas."
      },
      "Private phone connection link": {
        "zh": "手机私密连接链接",
        "es": "Enlace de conexión privada del teléfono"
      },
      "Copy private link": {
        "zh": "复制私密链接",
        "es": "Copiar enlace privado"
      },
      "Generated locally. No QR service receives your link. Hidden after two minutes; hiding does not revoke copied links.": {
        "zh": "二维码在本地生成，不会将链接发送给任何二维码服务。两分钟后自动隐藏；隐藏不会使已复制的链接失效。",
        "es": "Generado localmente. Ningún servicio de códigos QR recibe tu enlace. Se oculta tras dos minutos; ocultarlo no revoca los enlaces copiados."
      },
      "Connection diagnostics": {
        "zh": "连接诊断",
        "es": "Diagnóstico de conexión"
      },
      "Check the local bridge, DSH runtime and secure connection.": {
        "zh": "检查本地桥接服务、DSH 运行实例和安全连接。",
        "es": "Comprueba el puente local, el entorno de ejecución de DSH y la conexión segura."
      },
      "Run diagnostics": {
        "zh": "运行诊断",
        "es": "Ejecutar diagnóstico"
      },
      "Run diagnostics again for the current bridge state.": {
        "zh": "请再次运行诊断，检查桥接服务的当前状态。",
        "es": "Vuelve a ejecutar el diagnóstico para comprobar el estado actual del puente."
      },
      "Check": {
        "zh": "检查项",
        "es": "Comprobación"
      },
      "No additional information.": {
        "zh": "暂无更多信息。",
        "es": "No hay información adicional."
      },
      "Unofficial integration for DeepSeek Harness. Phone controls remain in Pocket Bridge’s lightweight web interface.": {
        "zh": "DeepSeek Harness 的非官方集成。手机端操作仍通过 Pocket Bridge 的轻量网页界面进行。",
        "es": "Integración no oficial para DeepSeek Harness. Los controles del teléfono siguen en la interfaz web ligera de Pocket Bridge."
      },
      "The selected bridge is already running.": {
        "zh": "所选桥接服务已在运行。",
        "es": "El puente seleccionado ya está en ejecución."
      },
      "Starting the bridge. Connection status will confirm when it is ready.": {
        "zh": "正在启动桥接服务。就绪后，连接状态会显示确认结果。",
        "es": "Iniciando el puente. El estado de conexión confirmará cuando esté listo."
      },
      "Pausing phone connections. DSH and its tasks keep running.": {
        "zh": "正在暂停手机连接。DSH 及其任务会继续运行。",
        "es": "Pausando las conexiones del teléfono. DSH y sus tareas siguen en ejecución."
      },
      "Node.js 24+ startup runtime": {
        "zh": "启动所需的 Node.js 24+ 运行时",
        "es": "Entorno de Node.js 24+ para el inicio"
      },
      "The last start attempt found only an older Node.js runtime. Install Node.js 24 or newer, restart DSH, then retry Start bridge.": {
        "zh": "上次启动时只找到了较旧的 Node.js 运行时。请安装 Node.js 24 或更高版本，重启 DSH 后再次点击“启动桥接”。",
        "es": "En el último intento de inicio solo se encontró una versión antigua del entorno de ejecución de Node.js. Instala Node.js 24 o posterior, reinicia DSH y vuelve a pulsar «Iniciar puente»."
      },
      "The last start attempt could not find a usable genuine Node.js 24+ runtime. Install Node.js 24 or newer, restart DSH, then retry Start bridge.": {
        "zh": "上次启动时未找到可用的标准 Node.js 24+ 运行时。请安装 Node.js 24 或更高版本，重启 DSH 后再次点击“启动桥接”。",
        "es": "En el último intento de inicio no se encontró un entorno de ejecución genuino y utilizable de Node.js 24+. Instala Node.js 24 o posterior, reinicia DSH y vuelve a pulsar «Iniciar puente»."
      },
      "Not probed by read-only diagnostics. Start bridge checks for a usable genuine Node.js 24+ runtime; DSH’s embedded runtime alone does not confirm it.": {
        "zh": "只读诊断不会探测此项。点击“启动桥接”时会检查可用的标准 Node.js 24+ 运行时；仅有 DSH 内置运行时不能确认满足要求。",
        "es": "El diagnóstico de solo lectura no comprueba este requisito. «Iniciar puente» busca un entorno de ejecución genuino y utilizable de Node.js 24+; el entorno integrado en DSH por sí solo no lo confirma."
      },
      "Selected bridge installation": {
        "zh": "所选桥接安装",
        "es": "Instalación del puente seleccionada"
      },
      "Choose a complete Pocket Bridge installation in this plugin configuration.": {
        "zh": "请在此插件的配置中选择完整的 Pocket Bridge 安装。",
        "es": "Elige una instalación completa de Pocket Bridge en la configuración de este plugin."
      },
      "Bridge listener": {
        "zh": "桥接监听服务",
        "es": "Servicio de escucha del puente"
      },
      "The selected installation and current gateway identity match.": {
        "zh": "所选安装与当前网关的身份匹配。",
        "es": "La instalación seleccionada coincide con la identidad del gateway actual."
      },
      "This bridge targets a different DSH instance. Select the matching installation or adjust its desktop controls.": {
        "zh": "此桥接服务指向另一个 DSH 实例。请选择匹配的安装，或在其桌面控制面板中调整设置。",
        "es": "Este puente apunta a otra instancia de DSH. Selecciona la instalación correspondiente o ajusta sus controles de escritorio."
      },
      "Start the bridge or open its desktop controls.": {
        "zh": "请启动桥接服务，或打开其桌面控制面板。",
        "es": "Inicia el puente o abre sus controles de escritorio."
      },
      "This DSH runtime": {
        "zh": "当前 DSH 运行实例",
        "es": "Este entorno de ejecución de DSH"
      },
      "The bridge targets this running DSH host.": {
        "zh": "桥接服务指向当前正在运行的 DSH 主机。",
        "es": "El puente apunta a este host de DSH en ejecución."
      },
      "The current DSH listener has not been confirmed by the bridge.": {
        "zh": "桥接服务尚未确认当前的 DSH 监听服务。",
        "es": "El puente aún no ha confirmado el servicio de escucha actual de DSH."
      },
      "Phone content encryption": {
        "zh": "手机内容加密",
        "es": "Cifrado del contenido del teléfono"
      },
      "The gateway reports an encryption key. Only a phone round trip verifies delivery.": {
        "zh": "网关报告已有加密密钥。只有完成与手机的一次往返通信，才能确认内容送达。",
        "es": "El gateway informa de una clave de cifrado. Solo un intercambio de ida y vuelta con el teléfono verifica la entrega."
      },
      "Encryption readiness has not been confirmed. No plaintext connection will be offered.": {
        "zh": "尚未确认加密是否就绪。不会提供明文连接。",
        "es": "Aún no se ha confirmado que el cifrado esté listo. No se ofrecerá ninguna conexión sin cifrar."
      },
      "Secure phone entrance": {
        "zh": "手机安全入口",
        "es": "Acceso seguro del teléfono"
      },
      "A secure entrance is configured. Open it on a phone to verify connectivity.": {
        "zh": "已配置安全入口。请在手机上打开，验证能否连接。",
        "es": "Hay un acceso seguro configurado. Ábrelo en un teléfono para verificar la conectividad."
      },
      "A complete HTTPS connection is not ready; use the desktop controls to configure it.": {
        "zh": "完整的 HTTPS 连接尚未就绪，请在桌面控制面板中配置。",
        "es": "La conexión HTTPS completa aún no está lista; configúrala en los controles de escritorio."
      },
      "Public entrance reachability": {
        "zh": "公网入口可达性",
        "es": "Accesibilidad del acceso público"
      },
      "Public tunnel startup and probing are disabled. Existing tunnel processes have not been checked or stopped by this setting; verify and stop any existing tunnel separately before relying on local-only operation.": {
        "zh": "公网隧道的启动和探测已禁用。此设置不会检查或停止已有的隧道进程；在确认服务仅限本地使用前，请另行检查并停止所有已有隧道。",
        "es": "El inicio y las comprobaciones del túnel público están desactivados. Este ajuste no ha comprobado ni detenido los procesos de túnel existentes; comprueba y detén por separado cualquier túnel existente antes de confiar en un funcionamiento exclusivamente local."
      },
      "Private HTTPS does not require cloudflared or a public tunnel. Test the private address on your phone.": {
        "zh": "私有 HTTPS 不需要 cloudflared 或公网隧道。请在手机上测试私有地址。",
        "es": "HTTPS privado no necesita cloudflared ni un túnel público. Prueba la dirección privada en tu teléfono."
      },
      "The last gateway probe succeeded; it does not prove current phone connectivity.": {
        "zh": "网关上次探测成功；这不代表手机当前可以连接。",
        "es": "La última comprobación del gateway tuvo éxito; esto no demuestra que el teléfono pueda conectarse ahora."
      },
      "The last gateway probe failed. Keep the address and retry before requesting a replacement.": {
        "zh": "网关上次探测失败。请保留当前地址并重试，再考虑请求更换地址。",
        "es": "La última comprobación del gateway falló. Conserva la dirección y vuelve a intentarlo antes de solicitar otra."
      },
      "Public internet tunnels require cloudflared, which is not bundled in the plugin package. Read-only diagnostics do not probe its executable. No current public reachability result is available.": {
        "zh": "公网隧道需要 cloudflared，插件包中未包含此程序。只读诊断不会探测其可执行文件。目前没有公网可达性的检查结果。",
        "es": "Los túneles públicos de internet requieren cloudflared, que no se incluye en el paquete del plugin. El diagnóstico de solo lectura no comprueba su ejecutable. No hay un resultado actual sobre la accesibilidad pública."
      },
      "Panel language": {
        "zh": "面板语言",
        "es": "Idioma del panel"
      },
      "Follow page/browser": {
        "zh": "跟随页面或浏览器",
        "es": "Usar el idioma de la página o del navegador"
      },
      "Setup and access notes": {
        "zh": "设置与访问须知",
        "es": "Notas de configuración y acceso"
      },
      "Requires Node.js 24+. Public tunnels also require cloudflared.": {
        "zh": "需要 Node.js 24+。公网隧道还需要 cloudflared。",
        "es": "Requiere Node.js 24+. Los túneles públicos también requieren cloudflared."
      },
      "Code: ": {
        "zh": "代码：",
        "es": "Código: "
      },
      "Checked ": {
        "zh": "检查时间：",
        "es": "Comprobado: "
      },
      "pass": {
        "zh": "通过",
        "es": "Correcto"
      },
      "fail": {
        "zh": "失败",
        "es": "Fallo"
      },
      "unknown": {
        "zh": "未知",
        "es": "Desconocido"
      }
    };
    function panelLanguage(doc, nav, choice = 'auto') {
      if (['zh', 'en', 'es'].includes(choice)) return choice;
      const candidates = [doc && doc.documentElement && doc.documentElement.lang,
        ...(nav && Array.isArray(nav.languages) ? nav.languages : []), nav && nav.language];
      for (const value of candidates) {
        const code = String(value || '').toLowerCase().split('-')[0];
        if (['zh', 'en', 'es'].includes(code)) return code;
      }
      return 'en';
    }
    function translate(value, language) {
      return typeof value === 'string' && TRANSLATIONS[value] && TRANSLATIONS[value][language] || value;
    }
    function localizedElement(createElement, language) {
      const child = value => Array.isArray(value) ? value.map(child) : translate(value, language);
      return (tag, props, ...children) => {
        if (props) {
          props = { ...props };
          for (const key of ['aria-label', 'title', 'placeholder']) if (typeof props[key] === 'string') props[key] = translate(props[key], language);
        }
        return createElement(tag, props, ...children.map(child));
      };
    }

    function localHttpOrigin(location) {
      return !!location && /^(http:|https:)$/.test(location.protocol) &&
        ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
    }
    function localOrigin(location) {
      if (localHttpOrigin(location)) return true;
      if (!location || location.protocol !== 'dsh-app:' || location.hostname !== 'app' || location.port || location.username || location.password) return false;
      try {
        const native = new URL(location.href || 'dsh-app://app/');
        return native.protocol === 'dsh-app:' && native.hostname === 'app' && !native.port && !native.username && !native.password;
      } catch (_) { return false; }
    }
    function text(value, limit = 220) {
      return typeof value === 'string' ? value.replace(/(?:https?:\/\/[^\s]*?(?:\/k\/|#k=)[^\s]*|\b(?:sk-|Bearer\s+)[A-Za-z0-9_-]+|[?&#](?:key|token|k)=[^\s&#]+)/gi, '[private value omitted]').slice(0, limit) : '';
    }
    function consoleUrl(value) {
      try {
        if (typeof value !== 'string' || !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\//i.test(value)) return null;
        const parsed = new URL(value);
        if (!localHttpOrigin(parsed) || parsed.username || parsed.password || parsed.hash ||
            !/^\/console(?:\/)?$/.test(parsed.pathname) || parsed.search) return null;
        return parsed.href;
      } catch (_) { return null; }
    }
    function pairingUrl(value) {
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || value.length > 4096 ||
            !/^#k=[A-Za-z0-9_-]{16,256}$/.test(parsed.hash)) return null;
        return parsed.href;
      } catch (_) { return null; }
    }
    function identity(gateway) {
      if (!gateway || typeof gateway.bootId !== 'string' || typeof gateway.instanceId !== 'string') return '';
      return gateway.bootId + ':' + gateway.instanceId;
    }
    function encryptionLabel(status) {
      return status && status.connection && status.connection.encrypted === true ? 'Key ready; phone delivery not tested' : 'Encryption key not confirmed';
    }
    function transportChanged(connection, transport) {
      if (!connection || !transport) return false;
      return (typeof transport.mode === 'string' && transport.mode !== connection.mode) ||
        (typeof transport.host === 'string' && transport.host !== connection.host);
    }
    function diagnosticContext(status) {
      if (!status) return '';
      const gateway = status.gateway || {}, runtime = status.runtime || {}, connection = status.connection || {}, tunnel = status.tunnel || {};
      // Time-of-poll fields are deliberately excluded. These are the identities
      // and readiness signals that the diagnostic checklist actually describes.
      return JSON.stringify([status.state, status.version || '', status.code || '', gateway.bootId || '', gateway.instanceId || '', gateway.port || 0, gateway.pid || 0,
        runtime.port || 0, runtime.kind || '', runtime.version || '', runtime.available === true,
        connection.mode || '', connection.host || '', connection.available === true, connection.encrypted === true,
        tunnel.running === true, tunnel.disabled === true, typeof tunnel.reachable === 'boolean' ? tunnel.reachable : null,
        status.operation && status.operation.phase || '', status.operation && status.operation.code || '']);
    }
    const RECOVERY = {
      'dsh-target-mismatch': 'This bridge is connected to a different DSH runtime. Open desktop controls and select this DSH instance, then refresh.',
      'unconfigured': 'Open desktop controls to finish the bridge setup, then refresh.',
      'not-configured': 'Open desktop controls to finish the bridge setup, then refresh.',
      'gateway-unavailable': 'Use Start bridge below. If startup fails, check the prerequisites and run diagnostics.',
      'gateway-not-running': 'Start the bridge, then try again.',
      'not-running': 'Start the bridge, then try again.',
      'tunnel-unavailable': 'The internet tunnel is not ready. Wait a moment, then refresh. Desktop controls show tunnel errors.',
      'connection-unavailable': 'The secure connection is not ready. Refresh the status or open desktop controls.',
      'stale-instance': 'The bridge restarted. Refresh before trying again.',
      'identity-mismatch': 'The bridge changed while this request was running. Refresh before trying again.',
      'forbidden': 'Open this panel in DSH on this computer using a localhost address.',
      'origin-forbidden': 'Open this panel in DSH on this computer using a localhost address.',
      'timeout': 'The bridge did not respond in time. Refresh to check what actually happened before trying again.',
      'network': 'The local connection was interrupted. Check that DSH and Pocket Bridge are running, then refresh.'
    };
    Object.assign(RECOVERY, {
      'installation-unavailable': 'Select a complete Pocket Bridge installation in this plugin’s configuration, then refresh.',
      'installation-not-configured': 'Select your Pocket Bridge installation in this plugin’s configuration, then refresh.',
      'node-24-required': 'The last start attempt found only an older Node.js runtime. Install genuine Node.js 24 or newer, restart DSH, then try Start bridge again.',
      'node-unavailable': 'The last start attempt could not find a usable genuine Node.js 24+ runtime. Install Node.js 24 or newer, restart DSH, then try Start bridge again. The DSH desktop app’s embedded runtime may not be usable.',
      'operation-pending': 'The bridge is already starting or stopping. Refresh to check its progress; do not repeat the request.',
      'operation-unconfirmed': 'The last operation was not confirmed. Refresh to check its state before retrying Start bridge; open desktop controls if available.',
      'start-unconfirmed': 'The bridge did not finish starting. Refresh before retrying Start bridge; open desktop controls if available.',
      'gateway-stopped': 'Start the bridge, then show the phone connection again.',
      'dsh-unavailable': 'This DSH runtime is not responding. Keep DSH open, then refresh the bridge status.',
      'gateway-identity-changed': 'The bridge restarted or its installation changed. Refresh before trying again.',
      'secure-connection-unavailable': 'A secure phone connection is not ready. Open desktop controls and check encryption and the tunnel.',
      'local-authenticated-request-required': 'Local authorization was rejected. Refresh this panel’s status, then retry. If it continues, reopen the authenticated DSH interface on this computer.',
      'control-token-unavailable': 'Local authorization is not ready. Refresh this panel’s status, then retry your action. No write request was sent.',
      'request-timeout': 'The local service did not respond in time. Refresh to check what actually happened before trying again.',
      'bridge-unavailable': 'The bridge service is unavailable. Refresh its status, then use Start bridge if it is stopped.',
      'plugin-unloaded': 'This plugin was reloaded or removed. Reload the DSH page before trying again.'
    });
    function recovery(code) { return RECOVERY[code] || 'Refresh the status. If the problem continues, run diagnostics or open desktop controls.'; }

    /* A small, original byte-mode QR encoder (ISO/IEC 18004 model 2, level L,
     * versions 1–10). No network request ever receives the pairing secret.
     * Longer links keep the Copy link option rather than truncating a QR. */
    function qrMatrix(value) {
      const bytes = new TextEncoder().encode(value);
      const specs = [null, [19, 7, [19]], [34, 10, [34]], [55, 15, [55]], [80, 20, [80]],
        [108, 26, [108]], [136, 18, [68, 68]], [156, 20, [78, 78]], [194, 24, [97, 97]],
        [232, 30, [116, 116]], [274, 18, [68, 68, 69, 69]]];
      let version = 1;
      while (version <= 10 && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > specs[version][0] * 8) version++;
      if (version > 10) throw new Error('qr-too-long');
      const [capacity, ecc, sizes] = specs[version], bits = [];
      function append(n, width) { for (let i = width - 1; i >= 0; i--) bits.push((n >>> i) & 1); }
      append(4, 4); append(bytes.length, version < 10 ? 8 : 16);
      for (const byte of bytes) append(byte, 8);
      append(0, Math.min(4, capacity * 8 - bits.length));
      while (bits.length % 8) bits.push(0);
      const data = [];
      for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, bit) => n * 2 + bit, 0));
      while (data.length < capacity) data.push((data.length - Math.ceil(bits.length / 8)) % 2 ? 0x11 : 0xec);
      function multiply(a, b) {
        let result = 0;
        for (let i = 7; i >= 0; i--) { result = (result << 1) ^ ((result >>> 7) * 0x11d); result ^= ((b >>> i) & 1) * a; }
        return result;
      }
      let generator = [1], power = 1;
      for (let i = 0; i < ecc; i++) {
        const next = new Array(generator.length + 1).fill(0);
        for (let j = 0; j < generator.length; j++) { next[j] ^= generator[j]; next[j + 1] ^= multiply(generator[j], power); }
        generator = next; power = multiply(power, 2);
      }
      const blocks = [], parity = []; let offset = 0;
      for (const count of sizes) {
        const block = data.slice(offset, offset + count), rem = new Array(ecc).fill(0); offset += count;
        for (const byte of block) { const factor = byte ^ rem.shift(); rem.push(0); for (let i = 0; i < ecc; i++) rem[i] ^= multiply(generator[i + 1], factor); }
        blocks.push(block); parity.push(rem);
      }
      const words = [];
      for (let i = 0; i < Math.max(...sizes); i++) for (const block of blocks) if (i < block.length) words.push(block[i]);
      for (let i = 0; i < ecc; i++) for (const block of parity) words.push(block[i]);
      const size = version * 4 + 17;
      const matrix = Array.from({ length: size }, () => new Array(size).fill(false));
      const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
      function put(x, y, dark) { if (x >= 0 && y >= 0 && x < size && y < size) { matrix[y][x] = !!dark; reserved[y][x] = true; } }
      for (let i = 0; i < size; i++) { put(6, i, i % 2 === 0); put(i, 6, i % 2 === 0); }
      for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const distance = Math.max(Math.abs(dx), Math.abs(dy)); put(cx + dx, cy + dy, distance !== 2 && distance !== 4); }
      const centers = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]][version];
      for (let i = 0; i < centers.length; i++) for (let j = 0; j < centers.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === centers.length - 1) || (i === centers.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) put(centers[i] + dx, centers[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
      let format = 8;
      for (let i = 0; i < 10; i++) format = (format << 1) ^ ((format >>> 9) * 0x537);
      format = ((8 << 10) | format) ^ 0x5412;
      const fbit = (i) => (format >>> i) & 1;
      for (let i = 0; i <= 5; i++) put(8, i, fbit(i));
      put(8, 7, fbit(6)); put(8, 8, fbit(7)); put(7, 8, fbit(8));
      for (let i = 9; i < 15; i++) put(14 - i, 8, fbit(i));
      for (let i = 0; i < 8; i++) put(size - 1 - i, 8, fbit(i));
      for (let i = 8; i < 15; i++) put(8, size - 15 + i, fbit(i));
      put(8, size - 8, true);
      if (version >= 7) {
        let remainder = version;
        for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
        const versionBits = (version << 12) | remainder;
        for (let i = 0; i < 18; i++) { const a = size - 11 + i % 3, b = Math.floor(i / 3), bit = (versionBits >>> i) & 1; put(a, b, bit); put(b, a, bit); }
      }
      let index = 0;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
          const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
          for (let j = 0; j < 2; j++) { const x = right - j; if (!reserved[y][x]) { const bit = index < words.length * 8 ? (words[index >>> 3] >>> (7 - (index & 7))) & 1 : 0; matrix[y][x] = !!(bit ^ ((x + y) % 2 === 0)); index++; } }
        }
      }
      return matrix;
    }

    function createController(env) {
      let disposed = false, generation = 0, diagnosticsEpoch = 0, timer = null, expiryTimer = null, statusPending = false, expectedAction = '', controlToken = '';
      const controllers = new Set(), subscribers = new Set();
      const now = () => typeof env.now === 'function' ? env.now() : Date.now();
      let state = { local: localOrigin(env.location), controlsReady: false, status: null, busy: '', error: '', code: '', note: '', connection: null, diagnostics: null, diagnosticsStale: false, confirmStop: false, loading: false };
      const emit = (patch) => { if (disposed) return; state = { ...state, ...patch }; for (const fn of subscribers) fn(state); };
      function clearConnection() { if (expiryTimer !== null) env.clearTimeout(expiryTimer); expiryTimer = null; if (state.connection) emit({ connection: null }); }
      function invalidate() { generation++; clearConnection(); }
      function clearAuthorization() { controlToken = ''; emit({ controlsReady: false }); }
      function clearDiagnostics() {
        diagnosticsEpoch++;
        if (state.diagnostics || state.busy === 'diagnostics') emit({ diagnostics: null, diagnosticsStale: true });
      }
      function expireIfNeeded() {
        if (!state.connection || Date.parse(state.connection.expiresAt) > now()) return;
        invalidate(); emit({ note: 'The private connection has been hidden automatically. Show it again when needed.' });
      }
      function armExpiry(expiresAt) {
        if (expiryTimer !== null) env.clearTimeout(expiryTimer);
        const token = generation;
        expiryTimer = env.setTimeout(() => {
          if (disposed || token !== generation) return;
          expiryTimer = null;
          // The elapsed timer also covers a clock moved backward after reveal.
          invalidate(); emit({ note: 'The private connection has been hidden automatically. Show it again when needed.' });
        }, Math.max(0, Date.parse(expiresAt) - now()));
      }
      async function request(route, body, timeout = 8000) {
        if (body !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(controlToken)) throw Object.assign(new Error('authorization'), { code: 'control-token-unavailable' });
        const abort = new env.AbortController(); controllers.add(abort);
        let timedOut = false;
        const deadline = env.setTimeout(() => { timedOut = true; abort.abort(); }, timeout);
        try {
          const response = await env.fetch('/pocket-bridge/' + route, {
            method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Pocket-Bridge-Control-Token': controlToken },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal
          });
          let result = await response.json();
          if (!response.ok || !result || (result.ok !== true && !(route === 'status' && ['unconfigured', 'unavailable'].includes(result.state)))) {
            const error = new Error('request'); error.code = text(result && result.code, 60) || (response.status === 403 ? 'forbidden' : 'request-failed'); throw error;
          }
          return result;
        } catch (error) {
          if (abort.signal.aborted && !timedOut) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
          if (!error.code) error.code = timedOut ? 'timeout' : 'network';
          throw error;
        } finally { env.clearTimeout(deadline); controllers.delete(abort); }
      }
      function failed(error) {
        if (error.code === 'cancelled' || disposed) return;
        invalidate(); clearAuthorization(); clearDiagnostics(); emit({ error: recovery(error.code), code: error.code, note: '' });
      }
      async function refresh(options = {}) {
        if (!state.local || disposed || statusPending || env.document.hidden) return;
        statusPending = true; const token = generation;
        if (!options.quiet) emit({ loading: true });
        try {
          const packet = await request('status');
          if (disposed || token !== generation || env.document.hidden) return;
          if (!['running', 'stopped', 'unconfigured', 'unavailable'].includes(packet.state)) throw Object.assign(new Error('status'), { code: 'invalid-status' });
          // Only a current, authenticated status response can refresh the local
          // carrier capability. Strip it before anything enters React state.
          const { controlToken: supplied, ...result } = packet;
          const nextControlToken = typeof supplied === 'string' && /^[A-Za-z0-9_-]{43}$/.test(supplied) ? supplied : '';
          if (controlToken && controlToken !== nextControlToken) { invalidate(); clearDiagnostics(); }
          controlToken = nextControlToken; emit({ controlsReady: !!controlToken });
          if (diagnosticContext(state.status) !== diagnosticContext(result)) clearDiagnostics();
          if (identity(state.status && state.status.gateway) !== identity(result.gateway) || result.state !== 'running' || !result.connection || result.connection.available !== true || transportChanged(state.connection, result.connection) || (result.runtime && !result.runtime.available)) invalidate();
          expireIfNeeded();
          emit({ status: result, ...(!controlToken ? { error: recovery('control-token-unavailable'), code: 'control-token-unavailable' } : options.preserveError ? {} : { error: '', code: '' }) });
          if (expectedAction && result.state === (expectedAction === 'start' ? 'running' : 'stopped')) {
            emit({ note: expectedAction === 'start' ? 'The bridge is running. DSH stays open.' : 'The bridge is stopped. DSH stays open; phone connections are paused.' });
            expectedAction = '';
          } else if (expectedAction && result.operation && result.operation.phase === 'failed') {
            const code = result.operation.code || 'operation-unconfirmed';
            emit({ error: recovery(code), code, note: '' }); expectedAction = '';
          }
        } catch (error) { failed(error); emit({ status: null }); }
        finally { statusPending = false; emit({ loading: false }); }
      }
      function schedule() {
        if (timer) env.clearTimeout(timer);
        timer = null;
        if (disposed || !state.local || env.document.hidden) return;
        timer = env.setTimeout(async () => { await refresh({ quiet: true }); schedule(); }, 5000);
      }
      const visibility = () => {
        invalidate(); clearAuthorization(); diagnosticsEpoch++;
        if (env.document.hidden) { if (timer) env.clearTimeout(timer); timer = null; for (const abort of controllers) abort.abort(); }
        else { refresh(); schedule(); }
      };
      const leave = () => { invalidate(); clearAuthorization(); diagnosticsEpoch++; for (const abort of controllers) abort.abort(); };
      async function reveal() {
        expireIfNeeded();
        if (!state.local || state.busy || !state.status || ['starting', 'stopping'].includes(state.status.operation && state.status.operation.phase) || state.status.state !== 'running' || !state.status.connection || state.status.connection.available !== true || state.status.connection.encrypted !== true) return;
        invalidate(); const token = generation, expected = identity(state.status.gateway);
        emit({ busy: 'connection', error: '', note: '' });
        try {
          const result = await request('connection', {});
          if (disposed || token !== generation || env.document.hidden) return;
          const url = pairingUrl(result.url);
          if (!url || !expected || identity(result.gateway) !== expected || !['tunnel', 'private-https'].includes(result.mode)) throw Object.assign(new Error('connection'), { code: 'identity-mismatch' });
          const host = new URL(url).host;
          if (transportChanged({ host, mode: result.mode }, state.status.connection)) throw Object.assign(new Error('transport'), { code: 'connection-unavailable' });
          if (result.expiresAt && (!Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= now())) throw Object.assign(new Error('expired'), { code: 'connection-unavailable' });
          const expiresAt = new Date(Math.min(result.expiresAt ? Date.parse(result.expiresAt) : now() + 120000, now() + 120000)).toISOString();
          let matrix = null; try { matrix = qrMatrix(url); } catch (_) { /* Copy remains available for unusually long links. */ }
          if (Date.parse(expiresAt) <= now()) throw Object.assign(new Error('expired'), { code: 'connection-unavailable' });
          emit({ connection: { url, matrix, expiresAt, host, mode: result.mode }, note: '' }); armExpiry(expiresAt);
        } catch (error) { failed(error); }
        finally { emit({ busy: '' }); }
      }
      async function diagnostics() {
        if (state.busy || !state.local) return;
        const epoch = diagnosticsEpoch, context = diagnosticContext(state.status);
        emit({ busy: 'diagnostics', error: '', note: '' });
        try {
          const result = await request('diagnostics', {}, 12000);
          if (disposed || env.document.hidden || epoch !== diagnosticsEpoch || context !== diagnosticContext(state.status)) { emit({ diagnosticsStale: true }); return; }
          if (!Array.isArray(result.checks)) throw Object.assign(new Error('diagnostics'), { code: 'invalid-response' });
          const checkedAt = typeof result.checkedAt === 'string' && Number.isFinite(Date.parse(result.checkedAt)) ? new Date(Date.parse(result.checkedAt)).toISOString() : new Date(now()).toISOString();
          emit({ diagnosticsStale: false, diagnostics: { checkedAt, checks: result.checks.slice(0, 30).map((check) => ({ id: text(check.id, 80), label: text(check.label, 100), state: ['pass', 'fail', 'unknown'].includes(check.state) ? check.state : 'unknown', detail: text(check.detail, 500) })) } });
        } catch (error) {
          if (disposed || env.document.hidden || epoch !== diagnosticsEpoch || context !== diagnosticContext(state.status)) { emit({ diagnosticsStale: true }); return; }
          failed(error);
        }
        finally { emit({ busy: '' }); }
      }
      async function action(action) {
        if (state.busy || !state.local || ['starting', 'stopping'].includes(state.status && state.status.operation && state.status.operation.phase) || !['start', 'stop'].includes(action)) return;
        if (action === 'stop' && !state.confirmStop) { emit({ confirmStop: true }); return; }
        expectedAction = action; invalidate(); clearDiagnostics(); emit({ busy: action, confirmStop: false, error: '', note: action === 'start' ? 'Starting the bridge…' : 'Stopping the bridge…' });
        const gateway = state.status && state.status.gateway;
        try {
          const result = await request('action', { action, ...(action === 'stop' && gateway && gateway.bootId ? { expectedBootId: gateway.bootId } : {}), ...(action === 'stop' && gateway && gateway.instanceId ? { expectedInstanceId: gateway.instanceId } : {}) }, 16000);
          emit({ note: text(result.message, 180) || (action === 'start' ? 'Start requested. Checking the bridge status…' : 'Stop requested. Checking the bridge status…') });
          // HTTP success is only acknowledgement; the fresh status is the source of truth.
          await refresh();
          const expected = action === 'start' ? 'running' : 'stopped';
          // Fresh failure/connection errors already carry recovery guidance.
          // Never replace them with an acknowledgement that sounds successful.
          if (!state.error) emit({ note: state.status && state.status.state === expected ? (action === 'start' ? 'The bridge is running. DSH stays open.' : 'The bridge is stopped. DSH stays open; phone connections are paused.') : 'The request was accepted. The bridge has not confirmed its new state yet; refresh to check.' });
        } catch (error) { expectedAction = ''; failed(error); await refresh({ quiet: true, preserveError: true }); }
        finally { emit({ busy: '' }); schedule(); }
      }
      return {
        getState() { expireIfNeeded(); return state; },
        subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
        start() { disposed = false; env.document.addEventListener('visibilitychange', visibility); env.window.addEventListener('pagehide', leave); refresh(); schedule(); },
        dispose() { if (disposed) return; invalidate(); clearAuthorization(); clearDiagnostics(); disposed = true; if (timer) env.clearTimeout(timer); for (const abort of controllers) abort.abort(); env.document.removeEventListener('visibilitychange', visibility); env.window.removeEventListener('pagehide', leave); subscribers.clear(); state = { ...state, connection: null, controlsReady: false, diagnostics: null }; },
        refresh, reveal, diagnostics, action,
        hide() { invalidate(); }, cancelStop() { emit({ confirmStop: false }); },
        setNote(note) { emit({ note: text(note) }); }
      };
    }

    function Logo() {
      return h('svg', { className: 'pb-logo', viewBox: '0 0 44 44', 'aria-hidden': true },
        h('rect', { x: 1, y: 1, width: 42, height: 42, rx: 13, fill: '#3269e8' }),
        h('path', { d: 'M12 31V22a10 10 0 0 1 20 0v9M8 27h28M17 27v7M27 27v7', fill: 'none', stroke: '#fff', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }
    function Qr({ matrix, label = 'Private phone connection QR code' }) {
      const size = matrix.length, path = [];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (matrix[y][x]) path.push(`M${x + 4} ${y + 4}h1v1h-1z`);
      return h('svg', { className: 'pb-qr', viewBox: `0 0 ${size + 8} ${size + 8}`, role: 'img', 'aria-label': label, shapeRendering: 'crispEdges' },
        h('rect', { width: size + 8, height: size + 8, fill: '#fff' }), h('path', { d: path.join(''), fill: '#000' }));
    }
    function Panel() {
      const [languageChoice, setLanguageChoice] = React.useState('auto');
      const [, refreshLanguage] = React.useState(0);
      const language = panelLanguage(document, window.navigator, languageChoice);
      const h = localizedElement(React.createElement, language);
      React.useEffect(() => {
        const refresh = () => refreshLanguage(value => value + 1);
        window.addEventListener('languagechange', refresh);
        const observer = typeof window.MutationObserver === 'function' ? new window.MutationObserver(refresh) : null;
        if (observer && document.documentElement) observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
        return () => { window.removeEventListener('languagechange', refresh); if (observer) observer.disconnect(); };
      }, []);
      const controllerRef = React.useRef(null), linkRef = React.useRef(null);
      if (!controllerRef.current) controllerRef.current = createController({ location: window.location, window, document, fetch: window.fetch.bind(window), AbortController: window.AbortController, setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) });
      const controller = controllerRef.current;
      const [state, setState] = React.useState(controller.getState());
      React.useEffect(() => { const unsubscribe = controller.subscribe(setState); controller.start(); return () => { unsubscribe(); controller.dispose(); }; }, [controller]);
      const status = state.status, running = status && status.state === 'running', busy = !!state.busy;
      const operationPhase = status && status.operation && status.operation.phase;
      const operationPending = ['starting', 'stopping'].includes(operationPhase);
      const secure = !!(status && status.connection && status.connection.available === true && status.connection.encrypted === true);
      const desktop = status && status.gateway && consoleUrl(status.gateway.consoleUrl);
      const phase = state.busy === 'start' || operationPhase === 'starting' ? 'Starting…' : state.busy === 'stop' || operationPhase === 'stopping' ? 'Stopping…' : state.loading && !status ? 'Checking…' : status ? ({ running: 'Running', stopped: 'Stopped', unconfigured: 'Setup needed', unavailable: 'Unavailable' }[status.state]) : 'Not connected';
      const button = (label, handler, disabled, cls = '') => h('button', { type: 'button', className: cls, onClick: handler, disabled }, label);
      async function copy() {
        const current = controller.getState().connection;
        if (!current) return;
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard-unavailable');
          await navigator.clipboard.writeText(current.url);
          if (controller.getState().connection === current) controller.setNote('Private link copied. Share it only with someone you trust.');
        } catch (_) {
          if (controller.getState().connection !== current) return;
          if (linkRef.current) { linkRef.current.focus(); linkRef.current.select(); }
          controller.setNote('Clipboard access is unavailable. The private link is selected; copy it manually.');
        }
      }
      function openDesktop() {
        const latest = controller.getState().status;
        const url = latest && latest.gateway && consoleUrl(latest.gateway.consoleUrl);
        if (!url) { controller.setNote('No verified local controls address is available. Use Start bridge and check the prerequisites below.'); return; }
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      return h('section', { className: 'pb-plugin', lang: language === 'zh' ? 'zh-CN' : language, 'aria-label': 'Pocket Bridge controls' },
        h('style', null, CSS),
        h('header', { className: 'pb-header' }, h(Logo), h('div', null, h('h2', null, 'Pocket Bridge'), h('p', { className: 'pb-muted' }, 'Your DSH workspace, within reach.'))),
        h('label', { className: 'pb-language' }, h('span', { className: 'pb-muted' }, 'Panel language'),
          h('select', { value: languageChoice, 'aria-label': 'Panel language', onChange: event => { const next = event.target.value; if (['auto', 'zh', 'en', 'es'].includes(next)) setLanguageChoice(next); } },
            h('option', { value: 'auto' }, 'Follow page/browser'), h('option', { value: 'zh', lang: 'zh-CN' }, '中文'), h('option', { value: 'en', lang: 'en' }, 'English'), h('option', { value: 'es', lang: 'es' }, 'Español'))),
        !state.local && h('div', { className: 'pb-notice', role: 'status' }, 'Open this panel in the DSH desktop app or its authenticated localhost web interface on this computer. Remote pages cannot read or change the private bridge connection.'),
        state.error && h('div', { className: 'pb-notice error', role: 'alert' }, state.error, state.code && h('div', { className: 'pb-muted' }, 'Code: ', state.code), h('div', null, button('Refresh status', () => controller.refresh(), busy || state.loading), desktop && button('Open desktop controls', openDesktop, busy))),
        state.note && h('div', { className: 'pb-notice', role: 'status', 'aria-live': 'polite' }, busy && h('span', { className: 'pb-spinner', 'aria-hidden': true }), state.note),
        h('div', { className: 'pb-card' },
          h('div', { className: 'pb-row' }, h('div', null, h('h3', null, 'Bridge status'), h('p', { className: 'pb-muted' }, 'These controls manage Pocket Bridge. They do not close DSH.')), h('span', { className: 'pb-badge', role: 'status' }, h('span', { className: 'pb-dot ' + (status ? status.state : 'unavailable'), 'aria-hidden': true }), phase)),
          h('p', { className: 'pb-hint' }, 'Requires Node.js 24+. Public tunnels also require cloudflared.'),
          h('div', { className: 'pb-actions' },
            button(state.busy === 'start' || operationPhase === 'starting' ? 'Starting…' : 'Start bridge', () => controller.action('start'), !state.local || !state.controlsReady || busy || operationPending || state.loading || !!running, 'pb-primary'),
            button(state.busy === 'stop' || operationPhase === 'stopping' ? 'Stopping…' : 'Stop bridge', () => controller.action('stop'), !state.local || !state.controlsReady || busy || operationPending || !running, 'pb-danger'),
            button(state.loading ? 'Refreshing…' : 'Refresh status', () => controller.refresh(), !state.local || busy || state.loading),
            button('Open desktop controls', openDesktop, !state.local || busy || !desktop)),
          h('div', { className: 'pb-fields' },
            h('div', null, h('div', { className: 'pb-muted' }, 'Connection'), h('div', { className: 'pb-value' }, status && status.connection ? (status.connection.mode === 'tunnel' ? 'Internet tunnel' : status.connection.mode === 'private-https' ? 'Private HTTPS' : 'Not ready') : 'Not checked')),
            h('div', null, h('div', { className: 'pb-muted' }, 'DSH runtime'), h('div', { className: 'pb-value' }, status && status.runtime ? [status.runtime.available ? 'Available' : 'Unavailable', status.runtime.version ? ' · ' : '', status.runtime.version ? text(status.runtime.version, 40) : ''] : 'Not checked')),
            status && status.version && h('div', null, h('div', { className: 'pb-muted' }, 'Bridge version'), h('div', { className: 'pb-value' }, text(status.version, 60))),
            h('div', null, h('div', { className: 'pb-muted' }, 'Message encryption'), h('div', { className: 'pb-value' }, encryptionLabel(status)))),
          status && status.code && h('p', { className: 'pb-hint' }, recovery(status.code)),
          status && status.operation && status.operation.code && h('p', { className: 'pb-hint' }, recovery(status.operation.code)),
          h('details', { className: 'pb-details' }, h('summary', null, 'Setup and access notes'),
          h('p', { className: 'pb-hint' }, 'Before starting: install genuine Node.js 24 or newer. Public internet tunnels also need cloudflared; private HTTPS does not. The Windows installer includes Node.js and cloudflared, but the plugin package does not.'),
          h('p', { className: 'pb-hint' }, 'Disabling or uninstalling this plugin does not stop a running bridge. Use Stop bridge first to pause phone access. Stopping does not revoke paired devices or shared links. Tunnel addresses may change after restart. Manage or revoke access in desktop controls.')),
          state.confirmStop && h('div', { className: 'pb-confirm', role: 'group', 'aria-label': 'Confirm stop bridge' },
            h('h3', null, 'Pause phone access?'), h('p', { className: 'pb-hint' }, 'Stopping the bridge stops serving phone connections. DSH stays open, and its running tasks continue.'),
            h('div', { className: 'pb-actions' }, button('Cancel', () => controller.cancelStop(), busy), button('Stop bridge', () => controller.action('stop'), busy, 'pb-danger')))),
        h('div', { className: 'pb-card' },
          h('h3', null, 'Connect your phone'), h('p', { className: 'pb-hint' }, 'Open the secure link in your phone browser. Connection details stay hidden until you ask to see them.'),
          running && !secure && h('p', { className: 'pb-hint' }, 'The secure phone entrance is not ready. Keep the bridge running, then refresh or run diagnostics.'),
          h('div', { className: 'pb-actions' }, state.connection ? button('Hide connection', () => controller.hide(), false) : button(state.busy === 'connection' ? 'Preparing connection…' : 'Show connection', () => controller.reveal(), !state.local || !state.controlsReady || busy || operationPending || !running || !secure, 'pb-primary')),
          state.connection && h('div', { className: 'pb-pairing' },
            state.connection.matrix ? h(Qr, { matrix: state.connection.matrix, label: translate('Private phone connection QR code', language) }) : h('p', { className: 'pb-muted' }, 'This link is too long for the local QR code. Copy the private link instead.'),
            h('div', null, h('h3', null, 'Scan with your phone camera'), h('p', { className: 'pb-hint' }, 'This QR code contains a private access link. Anyone with the link can connect. Keep it out of screenshots and public posts.'),
              h('input', { ref: linkRef, className: 'pb-private-link', value: state.connection.url, readOnly: true, type: 'text', 'aria-label': 'Private phone connection link', autoComplete: 'off', spellCheck: false }),
              h('div', { className: 'pb-actions' }, button('Copy private link', copy, busy)), h('p', { className: 'pb-muted' }, 'Generated locally. No QR service receives your link. Hidden after two minutes; hiding does not revoke copied links.')))),
        h('div', { className: 'pb-card' },
          h('div', { className: 'pb-row' }, h('div', null, h('h3', null, 'Connection diagnostics'), h('p', { className: 'pb-muted' }, 'Check the local bridge, DSH runtime and secure connection.')), button(state.busy === 'diagnostics' ? 'Checking…' : 'Run diagnostics', () => controller.diagnostics(), !state.local || !state.controlsReady || busy)),
          state.diagnosticsStale && h('p', { className: 'pb-hint' }, 'Run diagnostics again for the current bridge state.'),
          state.diagnostics && h('p', { className: 'pb-hint' }, h('time', { dateTime: state.diagnostics.checkedAt }, 'Checked ', new Date(state.diagnostics.checkedAt).toLocaleString(language === 'zh' ? 'zh-CN' : language, { dateStyle: 'medium', timeStyle: 'short' }))),
          state.diagnostics && h('ul', { className: 'pb-checks' }, state.diagnostics.checks.map((check, i) => h('li', { key: check.id + '-' + i, className: 'pb-check ' + check.state },
            h('span', { className: 'pb-check-mark', 'aria-label': check.state }, check.state === 'pass' ? '✓' : check.state === 'fail' ? '!' : '–'),
            h('div', null, h('div', { className: 'pb-check-title' }, check.label || check.id || 'Check'), h('p', { className: 'pb-muted' }, check.detail || 'No additional information.')))))),
        h('p', { className: 'pb-footer' }, 'Unofficial integration for DeepSeek Harness. Phone controls remain in Pocket Bridge’s lightweight web interface.'));
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'pocket-bridge', order: 60, label: () => 'Pocket Bridge' }, Panel));
      },
      // Export pure helpers for dependency-free isolated regression checks.
      createController, qrMatrix, localOrigin, consoleUrl, pairingUrl, encryptionLabel, panelLanguage, translate, localizedElement
    };
  }
});
