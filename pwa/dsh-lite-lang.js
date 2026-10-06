// DSH 轻量版界面的**三种语言**（中文 / English / Español）
//
// 为什么单独一个文件、而不是把词条塞进 pwa/i18n.js：
//   · i18n.js 是**全站**共用的（配对页、工作台、codex、go 都用它），
//     而这里这些词条只属于手机轻量版。混在一起会让两边都变难改。
//   · i18n.js 自己的字典是空的，各页自己在文件里 register()（go.html 就是这么做的）。
//     这个文件就是轻量版的"自己那一份"。
//
// 为什么用中文原文当 key（这是 i18n.js 定的规矩，跟着走）：
//   · 没翻到就自动退回中文 —— **页面永远不留空洞**，这比显示 `composer.send` 好得多；
//   · 代码里一眼能看出这句是什么，不用来回查对照表。
//
// 语言怎么选：i18n.js 已经实现好了（设备语言列表里挑第一个支持的、手选过以手选为准），
// 这里只负责"有哪些词"。切换入口在设置菜单里（见 dsh-lite-ui.js 的 installSettingsExtras）。
//
// ★ 这个文件在**代码指纹名单**里（/code-manifest.json）。改完它之后，
//   手机要更新一次才会生效 —— 但现在更新是自动的（见 dsh-lite-update.js）。
'use strict';

(function (global) {
  if (!global.DshI18n || typeof global.DshI18n.register !== 'function') return;

  global.DshI18n.register({
    // Router failures can appear before the main UI has mounted.
    '连接不可用': { en: 'Connection unavailable', es: 'Conexión no disponible' },
    '旧版 DSH 连接组件': { en: 'Legacy DSH connector', es: 'Conector de DSH anterior' },
    '新版 DSH 连接组件': { en: 'Current DSH connector', es: 'Conector de DSH actual' },
    '手机界面组件': { en: 'Phone interface', es: 'Interfaz del teléfono' },
    '{name}（{path}）': { en: '{name} ({path})', es: '{name} ({path})' },
    '、': { en: ', ', es: ', ' },
    'DSH 手机组件未加载：{components}。已重试 2 次，请检查连接后刷新桥页面。': {
      en: 'DSH phone components did not load: {components}. Two retries failed. Check the connection, then refresh the bridge page.',
      es: 'No se cargaron los componentes de DSH para el teléfono: {components}. Fallaron dos reintentos. Comprueba la conexión y actualiza la página del puente.' },
    '加密连接或设备授权尚未准备好，请用电脑控制台复制完整地址重新打开。': {
      en: 'The encrypted connection or device authorization is not ready. Copy the full link from the computer console and reopen it.',
      es: 'La conexión cifrada o la autorización del dispositivo no está lista. Copia el enlace completo de la consola del ordenador y vuelve a abrirlo.' },
    '无法识别电脑上的 DSH 版本（HTTP {status}）。': {
      en: 'Could not identify the computer\'s DSH version (HTTP {status}).',
      es: 'No se pudo identificar la versión de DSH del ordenador (HTTP {status}).' },
    '这台电脑的 DSH 协议尚未得到验证。请在电脑上检查 DSH 版本后重新连接；手机不会改用未加密的原版界面。': {
      en: 'This computer\'s DSH protocol is unverified. Check the DSH version on the computer, then reconnect. The phone will not fall back to the unencrypted original interface.',
      es: 'El protocolo de DSH de este ordenador no está verificado. Revisa la versión de DSH en el ordenador y reconecta. El teléfono no usará la interfaz original sin cifrar.' },
    '连接 DSH 失败，请重试。': { en: 'Could not connect to DSH. Please retry.', es: 'No se pudo conectar con DSH. Vuelve a intentarlo.' },
    // ── 连接状态 / 侧栏 ─────────────────────────────────────────────────────
    '正在连接': { en: 'Connecting', es: 'Conectando' },
    '已连接': { en: 'Connected', es: 'Conectado' },
    '我': { en: 'Me', es: 'Yo' },
    '连接断开': { en: 'Disconnected', es: 'Sin conexión' },
    '模型请求失败': { en: 'Model request failed', es: 'Falló la solicitud al modelo' },
    'DSH 的模型服务拒绝了凭据（401）。请在电脑端更新 API key 后重试。': { en: 'The model service rejected DSH\'s credentials (401). Update the API key on your computer, then try again.', es: 'El servicio del modelo rechazó las credenciales de DSH (401). Actualiza la clave API en el ordenador y vuelve a intentarlo.' },
    'DSH 的模型账户余额不足。请在电脑端检查账户后重试。': { en: 'The DSH model account has insufficient balance. Check the account on your computer, then try again.', es: 'La cuenta del modelo de DSH no tiene saldo suficiente. Revisa la cuenta en el ordenador y vuelve a intentarlo.' },
    'DSH 的模型服务请求过于频繁。请稍后重试。': { en: 'DSH\'s model service is rate limiting requests. Try again shortly.', es: 'El servicio del modelo de DSH está limitando las solicitudes. Inténtalo de nuevo más tarde.' },
    '模型请求未完成，请在电脑端检查 DSH 后重试。': { en: 'The model request did not finish. Check DSH on your computer, then try again.', es: 'La solicitud al modelo no finalizó. Revisa DSH en el ordenador y vuelve a intentarlo.' },
    '重连': { en: 'Reconnect', es: 'Reconectar' },
    '重新连接': { en: 'Reconnect', es: 'Reconectar' },
    '正在加载项目…': { en: 'Loading projects…', es: 'Cargando proyectos…' },
    '正在加载对话列表…': { en: 'Loading conversations…', es: 'Cargando conversaciones…' },
    '没有匹配的项目。': { en: 'No matching project.', es: 'Ningún proyecto coincide.' },
    '还没有项目。点击“添加项目”。': { en: 'No projects yet. Tap “Add project”.', es: 'Aún no hay proyectos. Toca «Añadir proyecto».' },
    '先选择项目。': { en: 'Pick a project first.', es: 'Elige un proyecto primero.' },
    '没有匹配的对话。': { en: 'No matching conversation.', es: 'Ninguna conversación coincide.' },
    '这个项目还没有对话。': { en: 'This project has no conversations yet.', es: 'Este proyecto aún no tiene conversaciones.' },
    '未命名项目': { en: 'Untitled project', es: 'Proyecto sin nombre' },
    '未命名对话': { en: 'Untitled conversation', es: 'Conversación sin título' },
    '选择一个对话': { en: 'Pick a conversation', es: 'Elige una conversación' },
    '选择项目和对话，或新建对话。': { en: 'Pick a project and conversation, or start a new one.', es: 'Elige un proyecto y una conversación, o crea una nueva.' },
    '这段对话还没有消息。': { en: 'No messages in this conversation yet.', es: 'Esta conversación aún no tiene mensajes.' },
    '这段对话暂无可显示的轨迹。': { en: 'Nothing to show on the activity tab yet.', es: 'Aún no hay actividad que mostrar.' },
    '正在加载对话内容…': { en: 'Loading conversation…', es: 'Cargando la conversación…' },
    '＋ 新对话': { en: '+ New conversation', es: '+ Nueva conversación' },
    '＋ 添加项目': { en: '+ Add project', es: '+ Añadir proyecto' },
    '项目': { en: 'Projects', es: 'Proyectos' },
    '对话': { en: 'Conversation', es: 'Conversación' },
    '轨迹': { en: 'Activity', es: 'Actividad' },
    '文件': { en: 'Files', es: 'Archivos' },
    '原版界面': { en: 'Full app', es: 'App completa' },
    '停止': { en: 'Stop', es: 'Detener' },
    '正在停止…': { en: 'Stopping…', es: 'Deteniendo…' },
    '加载更早内容': { en: 'Load earlier', es: 'Cargar anteriores' },
    '正在加载…': { en: 'Loading…', es: 'Cargando…' },
    '重试': { en: 'Retry', es: 'Reintentar' },
    '关闭': { en: 'Close', es: 'Cerrar' },
    '查看完整说明': { en: 'Read full details', es: 'Leer detalles completos' },

    // ── 输入区 ─────────────────────────────────────────────────────────────
    '给 DSH 发送消息…': { en: 'Message DSH…', es: 'Escribe a DSH…' },
    '待发送': { en: 'ready to send', es: 'listo para enviar' },
    '上传文件': { en: 'Upload file', es: 'Subir archivo' },
    '语音输入': { en: 'Voice input', es: 'Entrada de voz' },
    '语音输入失败。': { en: 'Voice input failed.', es: 'Falló la entrada de voz.' },
    '语音语言': { en: 'Voice language', es: 'Idioma de voz' },
    '跟着界面语言': { en: 'Same as interface', es: 'Igual que la interfaz' },
    '停止': { en: 'Stop', es: 'Detener' },
    '↑ 回到底部': { en: '↓ Back to bottom', es: '↓ Ir al final' },

    // ── 浮动条 / 设置菜单 ──────────────────────────────────────────────────
    '模型': { en: 'Model', es: 'Modelo' },
    '工具组': { en: 'Tools', es: 'Herramientas' },
    '工具配置': { en: 'Tool setup', es: 'Configuración de herramientas' },
    '模式': { en: 'Mode', es: 'Modo' },
    '计划/目标': { en: 'Plan/Goal', es: 'Plan/Meta' },
    '余额': { en: 'Balance', es: 'Saldo' },
    '余额 …': { en: 'Balance …', es: 'Saldo …' },
    '余额 —': { en: 'Balance —', es: 'Saldo —' },
    '余额 ?': { en: 'Balance ?', es: 'Saldo ?' },
    '点一下刷新': { en: 'Tap to refresh', es: 'Toca para actualizar' },
    '内网/外网': { en: 'LAN/WAN', es: 'LAN/WAN' },
    '压缩上下文': { en: 'Compact', es: 'Compactar' },
    '连接地址（内网/外网）': { en: 'Connection address (LAN/WAN)', es: 'Dirección de conexión (LAN/WAN)' },
    '看余额': { en: 'Check balance', es: 'Ver saldo' },
    '语言': { en: 'Language', es: 'Idioma' },
    '切换到 Codex': { en: 'Switch to Codex', es: 'Cambiar a Codex' },
    '打开原版界面': { en: 'Open the full app', es: 'Abrir la app completa' },
    'DSH 手机版': { en: 'DSH mobile', es: 'DSH móvil' },

    // ── 选择面板 ───────────────────────────────────────────────────────────
    '选择模型': { en: 'Choose model', es: 'Elegir modelo' },
    '此版本不支持选择模型，请在电脑端操作。': { en: 'This DSH version cannot change models here. Use the desktop app.', es: 'Esta versión de DSH no permite cambiar el modelo aquí. Usa la aplicación de escritorio.' },
    '此版本不支持选择工具配置，请在电脑端操作。': { en: 'This DSH version cannot change tool setup here. Use the desktop app.', es: 'Esta versión de DSH no permite cambiar las herramientas aquí. Usa la aplicación de escritorio.' },
    '此版本不支持目标，请在电脑端操作。': { en: 'This DSH version cannot edit goals here. Use the desktop app.', es: 'Esta versión de DSH no permite editar metas aquí. Usa la aplicación de escritorio.' },
    '此版本不支持计划模式，请在电脑端操作。': { en: 'This DSH version cannot change plan mode here. Use the desktop app.', es: 'Esta versión de DSH no permite cambiar el modo plan aquí. Usa la aplicación de escritorio.' },
    '此版本不支持压缩上下文，请在电脑端操作。': { en: 'This DSH version cannot compact context here. Use the desktop app.', es: 'Esta versión de DSH no permite compactar el contexto aquí. Usa la aplicación de escritorio.' },
    '下轮模型': { en: 'Next-turn model', es: 'Modelo para el próximo turno' },
    '上轮模型': { en: 'Last-used model', es: 'Modelo usado anteriormente' },
    '下轮模型未报告。': { en: 'Next-turn model is not reported.', es: 'No se informa el modelo del próximo turno.' },
    '当前工具配置': { en: 'Current tool setup', es: 'Configuración actual de herramientas' },
    '当前工具配置未报告。': { en: 'Current tool setup is not reported.', es: 'No se informa la configuración de herramientas.' },
    '对话开始后不能更换工具配置，请新建对话。': { en: 'Tool setup is locked after the first turn. Start a new conversation to change it.', es: 'La configuración se bloquea tras el primer turno. Crea una conversación nueva para cambiarla.' },
    '此版本未报告能否更换；若被拒绝，请新建对话。': { en: 'This version does not report whether switching is allowed. If rejected, start a new conversation.', es: 'Esta versión no indica si se puede cambiar. Si se rechaza, crea una conversación nueva.' },
    '标准工具': { en: 'Standard tools', es: 'Herramientas estándar' },
    '代码工具': { en: 'Code tools', es: 'Herramientas de código' },
    '精简工具': { en: 'Minimal tools', es: 'Herramientas mínimas' },
    '插件开发': { en: 'Plugin development', es: 'Desarrollo de complementos' },
    '默认配置': { en: 'Default', es: 'Predeterminado' },
    '不可用': { en: 'Unavailable', es: 'No disponible' },
    '正在切换…': { en: 'Switching…', es: 'Cambiando…' },
    '已切换': { en: 'Switched', es: 'Cambiado' },
    '对话已切换，请重新打开。': { en: 'Conversation changed. Reopen this list.', es: 'La conversación cambió. Vuelve a abrir esta lista.' },
    '失败': { en: 'Failed', es: 'Falló' },
    '未知': { en: 'Unknown', es: 'Desconocido' },
    '读不到列表：': { en: 'Could not load options: ', es: 'No se pudieron cargar las opciones: ' },
    '思考强度': { en: 'reasoning effort', es: 'esfuerzo de razonamiento' },
    '选择模式（goal / 计划等）': { en: 'Choose mode (goal / plan…)', es: 'Elegir modo (meta / plan…)' },
    '计划 / 目标模式': { en: 'Plan / goal mode', es: 'Modo plan / meta' },
    '连接地址': { en: 'Connection address', es: 'Dirección de conexión' },
    '正在读取…': { en: 'Reading…', es: 'Leyendo…' },
    '电脑没有报回可选项。': { en: 'The computer reported no options.', es: 'El ordenador no devolvió opciones.' },
    '切到这个地址': { en: 'Switch to this address', es: 'Cambiar a esta dirección' },
    '就是你现在用的这条': { en: 'the one you are using', es: 'la que ya usas' },
    '内网（同一个 WiFi）': { en: 'LAN (same WiFi)', es: 'LAN (mismo WiFi)' },
    '内网（HTTPS，全链路加密）': { en: 'LAN (HTTPS, encrypted end to end)', es: 'LAN (HTTPS, cifrado de extremo a extremo)' },
    '外网（隧道）': { en: 'WAN (tunnel)', es: 'WAN (túnel)' },
    '现在看不到内网地址（不在同一个 WiFi，或者电脑没连内网）。':
      { en: 'No LAN address is visible right now (you are not on the same WiFi, or the computer has no LAN).',
        es: 'Ahora no se ve ninguna dirección LAN (no estás en el mismo WiFi o el ordenador no tiene LAN).' },
    '桥没有报回地址。': { en: 'The bridge reported no address.', es: 'El puente no devolvió direcciones.' },
    '配对码：': { en: 'Pairing code: ', es: 'Código de emparejamiento: ' },

    // ── 加密状态（E3/E4）──────────────────────────────────────────────────
    '已加密': { en: 'Encrypted', es: 'Cifrado' },
    '缺密钥': { en: 'No key', es: 'Sin clave' },
    '未加密': { en: 'Not encrypted', es: 'Sin cifrar' },
    '这条地址里没有加密密钥，所以内容通道用不了 —— 发送键会变灰、对话也加载不出来。请用带 #k= 的完整地址重新打开（电脑控制台里的「复制链接」给出的那条）。':
      { en: 'This address has no encryption key, so the content channel is unavailable — the send button stays grey and conversations will not load. Reopen the full link that contains #k= (use “Copy link” in the desktop console).',
        es: 'Esta dirección no tiene clave de cifrado, así que el canal de contenido no funciona: el botón de enviar queda gris y las conversaciones no cargan. Vuelve a abrir el enlace completo que incluye #k= (usa «Copiar enlace» en la consola del ordenador).' },
    '对话内容在手机和电脑之间是加密的；中间的中继看不到正文。':
      { en: 'Conversation content is encrypted between phone and computer; the relay cannot read it.',
        es: 'El contenido se cifra entre el teléfono y el ordenador; el repetidor no puede leerlo.' },

    // ── 弹窗 / 通知 ────────────────────────────────────────────────────────
    '选择电脑上的文件夹': { en: 'Choose a folder on the computer', es: 'Elige una carpeta del ordenador' },
    '电脑文件夹路径': { en: 'Computer folder path', es: 'Ruta de la carpeta' },
    '取消': { en: 'Cancel', es: 'Cancelar' },
    '选择此文件夹': { en: 'Use this folder', es: 'Usar esta carpeta' },
    '浏览': { en: 'Browse', es: 'Examinar' },
    '电脑工作区文件': { en: 'Computer workspace files', es: 'Archivos del espacio de trabajo' },
    '↑ 上一级': { en: '↑ Up', es: '↑ Subir' },
    '项目根目录': { en: 'project root', es: 'raíz del proyecto' },
    '加载更多文件': { en: 'Load more files', es: 'Cargar más archivos' },
    '筛选当前列表': { en: 'Filter this list', es: 'Filtrar esta lista' },
    '当前列表没有匹配的文件。': { en: 'No matching file in the loaded list.', es: 'No hay archivos coincidentes en la lista cargada.' },
    '文本预览': { en: 'Text preview', es: 'Vista previa del texto' },
    '预览': { en: 'Preview', es: 'Vista previa' },
    '关闭预览': { en: 'Close preview', es: 'Cerrar vista previa' },
    '仅预览前 64 KB，保存可下载完整文件。': { en: 'Preview limited to the first 64 KB. Save to download the complete file.', es: 'La vista previa muestra los primeros 64 KB. Guarda para descargar el archivo completo.' },
    '此文件不支持文本预览，可保存后打开。': { en: 'Text preview is unavailable for this file. Save it to open it.', es: 'Este archivo no admite vista previa de texto. Guárdalo para abrirlo.' },
    '空文本文件。': { en: 'Empty text file.', es: 'Archivo de texto vacío.' },
    '文件已读取，请点“保存”下载到手机。': { en: 'File loaded. Tap Save to download it to your phone.', es: 'Archivo cargado. Pulsa Guardar para descargarlo al teléfono.' },
    '同步旧版 DSH 授权或询问失败，请重连。': { en: 'Could not sync legacy DSH approvals or questions. Reconnect to retry.', es: 'No se pudieron sincronizar los permisos o preguntas de DSH antiguo. Reconecta para reintentar.' },
    '此旧版 DSH 仅支持 PNG、JPEG、WebP 和 GIF 图片附件。': { en: 'This legacy DSH supports only PNG, JPEG, WebP, and GIF image attachments.', es: 'Este DSH antiguo solo admite imágenes PNG, JPEG, WebP y GIF como adjuntos.' },
    '图片超过 4 MB，未上传。': { en: 'Image exceeds 4 MB and was not uploaded.', es: 'La imagen supera los 4 MB y no se ha subido.' },
    '图片附件已过期，请重新上传后发送。': { en: 'Image attachment expired. Upload it again before sending.', es: 'El adjunto de imagen ha caducado. Vuelve a subirlo antes de enviar.' },
    '上传图片失败，请重新选择图片后重试。': { en: 'Image upload failed. Select the image again and retry.', es: 'Falló la subida de la imagen. Selecciónala de nuevo y reintenta.' },
    '上传图片': { en: 'Upload image', es: 'Subir imagen' },
    '复制': { en: 'Copy', es: 'Copiar' },
    '已复制': { en: 'Copied', es: 'Copiado' },
    '复制失败': { en: 'Copy failed', es: 'No se pudo copiar' },
    '进行中': { en: 'running', es: 'en curso' },
    '已完成': { en: 'done', es: 'terminado' },
    '思考': { en: 'Thinking', es: 'Razonamiento' },
    '工具': { en: 'Tool', es: 'Herramienta' },
    '消息': { en: 'Message', es: 'Mensaje' },
    '文件': { en: 'File', es: 'Archivo' },
    '图片': { en: 'Image', es: 'Imagen' },
    '↓ 保存 ': { en: '↓ Save ', es: '↓ Guardar ' },
    '↓ 下载 ': { en: '↓ Download ', es: '↓ Descargar ' },
    '提交回答': { en: 'Submit answer', es: 'Enviar respuesta' },
    '提交全部回答': { en: 'Submit all answers', es: 'Enviar todas las respuestas' },
    '允许': { en: 'Allow', es: 'Permitir' },
    '拒绝': { en: 'Reject', es: 'Rechazar' },

    // ── 静态界面里补挂 data-i18n 时缺的词条 ─────────────────────────────────
    // ★ 这一批的来由：dsh-lite.html 里**大量静态元素压根没挂 data-i18n**，
    //   而 i18n.js 只处理带这个属性的元素 —— 所以切了语言它们还是中文。
    //   使用者的原话：「英语，西班牙语的时候不是所有的都改变」。
    '当前项目': { en: 'Current project', es: 'Proyecto actual' },
    '详情': { en: 'Details', es: 'Detalles' },
    '收起': { en: 'Collapse', es: 'Contraer' },
    // 补齐静态界面那 71 处 data-i18n 之后，扫出来缺的就是下面这些。
    // 属性值（中文原文）就是这里的 key —— 两边必须**一字不差**，包括全角符号。
    'DSH · 手机版': { en: 'DSH · Mobile', es: 'DSH · Móvil' },
    'DSH 导航': { en: 'DSH navigation', es: 'Navegación de DSH' },
    '项目与对话': { en: 'Projects and chats', es: 'Proyectos y conversaciones' },
    '项目和对话': { en: 'Projects and chats', es: 'Proyectos y conversaciones' },
    '新建对话': { en: 'New chat', es: 'Nueva conversación' },
    '查看轨迹': { en: 'View activity', es: 'Ver actividad' },
    '看电脑屏幕': { en: 'View computer screen', es: 'Ver la pantalla del ordenador' },
    '添加项目': { en: 'Add project', es: 'Añadir proyecto' },
    '搜索项目和对话': { en: 'Search projects and chats', es: 'Buscar proyectos y conversaciones' },
    '搜索当前项目和对话': {
      en: 'Search the current project and chat',
      es: 'Buscar el proyecto y la conversación actuales'
    },
    '设置': { en: 'Settings', es: 'Ajustes' },
    '关闭项目列表': { en: 'Close project list', es: 'Cerrar la lista de proyectos' },
    '探索未尽之境': { en: 'Uncharted Realms', es: 'Parajes inexplorados' },
    '项目列表': { en: 'Project list', es: 'Lista de proyectos' },
    '对话列表': { en: 'Chat list', es: 'Lista de conversaciones' },
    '对话视图': { en: 'Chat views', es: 'Vistas de la conversación' },
    '待处理请求': { en: 'Pending requests', es: 'Solicitudes pendientes' },
    '排队中的消息': { en: 'Queued messages', es: 'Mensajes en cola' },
    '发送给 DSH 的消息': { en: 'Message to DSH', es: 'Mensaje para DSH' },
    '模型、工具配置和目标': { en: 'Model, tools and goal', es: 'Modelo, herramientas y meta' },
    '发送': { en: 'Send', es: 'Enviar' },
    '这里选择的是电脑目录，手机文件不会成为项目目录。': {
      en: 'This picks a folder on the computer; files on your phone do not become the project folder.',
      es: 'Aquí eliges una carpeta del ordenador; los archivos del teléfono no se convierten en la carpeta del proyecto.'
    },
    // 注意：JS 里要写两个反斜杠，HTML 属性里是一个 —— t() 拿到的是一个
    '例如 D:\\项目\\我的应用': { en: 'e.g. D:\\Projects\\MyApp', es: 'p. ej. D:\\Proyectos\\MiApp' },
    '只显示当前对话所属项目。点文件读取后，再点“保存”下载到手机。': {
      en: 'Only the current chat’s project is shown. Tap a file to read it, then tap Save to download it to your phone.',
      es: 'Solo se muestra el proyecto de la conversación actual. Toca un archivo para leerlo y luego Guardar para descargarlo al teléfono.'
    },
    '当前连接尚不能在手机端处理 DSH 的授权、选择或询问。遇到这类步骤，请在电脑端完成；对话内容仍可在此查看。': {
      en: 'This connection cannot yet handle DSH approvals, choices or questions from the phone. Finish those steps on the computer; the conversation is still readable here.',
      es: 'Esta conexión todavía no puede gestionar aprobaciones, opciones ni preguntas de DSH desde el teléfono. Complétalas en el ordenador; la conversación sigue siendo visible aquí.'
    },
    // 渲染函数里原本写死中文的那几处（renderControls / renderFiles / 余额面板）
    '正在创建…': { en: 'Creating…', es: 'Creando…' },
    '正在创建对话': { en: 'Creating a chat', es: 'Creando una conversación' },
    '正在添加…': { en: 'Adding…', es: 'Añadiendo…' },
    '正在停止…': { en: 'Stopping…', es: 'Deteniendo…' },
    '正在加载…': { en: 'Loading…', es: 'Cargando…' },
    '添加项目失败。请检查电脑上的文件夹路径。': {
      en: 'Could not add the project. Check the folder path on the computer.',
      es: 'No se pudo añadir el proyecto. Comprueba la ruta de la carpeta en el ordenador.'
    },
    '读取电脑文件夹失败，请重试。': {
      en: 'Could not read the folders on the computer — try again.',
      es: 'No se pudieron leer las carpetas del ordenador; inténtalo de nuevo.'
    },
    '读取电脑文件失败，请重试。': {
      en: 'Could not read files on the computer — try again.',
      es: 'No se pudieron leer los archivos del ordenador; inténtalo de nuevo.'
    },
    '读取文件失败，请重试。': {
      en: 'Could not read the file — try again.',
      es: 'No se pudo leer el archivo; inténtalo de nuevo.'
    },
    '↓ 重试': { en: '↓ Retry', es: '↓ Reintentar' },
    '没有拿到数据': { en: 'No data came back', es: 'No llegaron datos' },
    '读不到余额。这个功能走控制台端点，需要已登录的会话。': {
      en: 'Could not read the balance. This uses the console endpoint and needs a signed-in session.',
      es: 'No se pudo leer el saldo. Usa el endpoint de la consola y necesita una sesión iniciada.'
    },
    // 交互卡片（授权 / 选择 / 提问）和文件列表的兜底文案
    '需要授权': { en: 'Approval needed', es: 'Se necesita autorización' },
    '请选择': { en: 'Choose one', es: 'Elige una opción' },
    '需要回答': { en: 'Answer needed', es: 'Se necesita respuesta' },
    'DSH 请求授权：': { en: 'DSH requests approval: ', es: 'DSH solicita autorización: ' },
    'DSH 正在等待你的回复。': {
      en: 'DSH is waiting for your reply.',
      es: 'DSH está esperando tu respuesta.'
    },
    '当前连接无法从手机回复，请在电脑端处理。': {
      en: 'This connection cannot reply from the phone — please handle it on the computer.',
      es: 'Esta conexión no puede responder desde el teléfono; hazlo en el ordenador.'
    },
    '正在读取文件…': { en: 'Reading files…', es: 'Leyendo archivos…' },
    // C11 的另一半：列表**读失败**时的说明（原来会伪装成"你还没有项目"）
    '读不到项目列表，请重试。': {
      en: 'Could not load the project list — try again.',
      es: 'No se pudo cargar la lista de proyectos; inténtalo de nuevo.'
    },
    '电脑报回来的项目列表格式不对。': {
      en: 'The computer returned an unexpected project list.',
      es: 'El ordenador devolvió una lista de proyectos inesperada.'
    },
    '读不到对话列表，请重试。': {
      en: 'Could not load the chat list — try again.',
      es: 'No se pudo cargar la lista de conversaciones; inténtalo de nuevo.'
    },
    // D1：地址变化 / 任务完成时通知我
    '地址变化时通知我': { en: 'Notify me when the address changes', es: 'Avisarme cuando cambie la dirección' },
    '地址变化时通知我（先「添加到主屏幕」）': {
      en: 'Notify me when the address changes (first: Add to Home Screen)',
      es: 'Avisarme cuando cambie la dirección (primero: Añadir a inicio)'
    },
    '通知已开启': { en: 'Notifications are on', es: 'Las notificaciones están activadas' },
    '正在开启…': { en: 'Turning on…', es: 'Activando…' },
    '通知被拒绝了 —— 去手机「设置」里允许这个网页的通知。': {
      en: 'Notifications were blocked — allow them for this site in your phone settings.',
      es: 'Se bloquearon las notificaciones; permítelas para este sitio en los ajustes del teléfono.'
    },
    '电脑那边还没准备好推送密钥（': {
      en: 'The computer has no push key yet (',
      es: 'El ordenador todavía no tiene clave de notificaciones ('
    },
    '订阅没被接受（': { en: 'The subscription was not accepted (', es: 'No se aceptó la suscripción (' },
    '开启通知失败。': { en: 'Could not turn on notifications.', es: 'No se pudieron activar las notificaciones.' },
    // 复制：助手那条复制的是**整轮**（一轮回复在界面上是好几条 record）
    '复制整轮': { en: 'Copy whole reply', es: 'Copiar toda la respuesta' },
    // 看电脑屏幕（这几条原来都写死成中文，切语言不跟着变）
    '电脑屏幕': { en: 'Computer screen', es: 'Pantalla del ordenador' },
    '再看一次': { en: 'Take another', es: 'Otra captura' },
    '正在抓屏…': { en: 'Capturing…', es: 'Capturando…' },
    '抓屏失败。': { en: 'Screen capture failed.', es: 'La captura de pantalla falló.' },
    '这个版本还不支持看电脑屏幕，请更新桥。': {
      en: 'This version cannot capture the screen yet — update the bridge.',
      es: 'Esta versión aún no puede capturar la pantalla; actualiza el puente.'
    },
    // 授权范围（DSH 的「权限预设」）。中文标签照抄电脑端：
    // 仅可查看 / 工作区内修改 / 完全权限；英文照抄 DSH 内置的
    // Read Only / Workspace Write / Full access。
    '授权范围': { en: 'Access scope', es: 'Alcance de acceso' },
    '选择授权范围': { en: 'Choose access scope', es: 'Elegir el alcance de acceso' },
    '仅可查看': { en: 'Read Only', es: 'Solo lectura' },
    '工作区内修改': { en: 'Workspace Write', es: 'Escritura en el espacio de trabajo' },
    '完全权限': { en: 'Full access', es: 'Acceso total' },
    '只能看，不能改文件、不能执行命令。': {
      en: 'View only — cannot change files or run commands.',
      es: 'Solo ver: no puede cambiar archivos ni ejecutar comandos.'
    },
    '可以在项目目录里改文件、执行命令；越界操作仍会询问。': {
      en: 'Can change files and run commands inside the project folder; anything outside it still asks first.',
      es: 'Puede cambiar archivos y ejecutar comandos dentro del proyecto; fuera de él seguirá preguntando.'
    },
    '减少确认步骤，可直接执行敏感操作、修改文件、运行外部命令。': {
      en: 'Fewer confirmations: sensitive operations, file changes and external commands can run directly.',
      es: 'Menos confirmaciones: puede ejecutar directamente operaciones sensibles, cambios de archivos y comandos externos.'
    },
    '授权范围决定这次对话能做多少事。它只影响当前对话；改完立刻生效，不会重开对话。': {
      en: 'The access scope decides how much this conversation may do. It affects only this conversation, takes effect immediately, and does not restart it.',
      es: 'El alcance de acceso decide cuánto puede hacer esta conversación. Solo afecta a esta conversación, se aplica al momento y no la reinicia.'
    },
    '正在切换…': { en: 'Switching…', es: 'Cambiando…' },
    '已切换为': { en: 'Switched to ', es: 'Cambiado a ' },
    '没能切换：': { en: 'Could not switch: ', es: 'No se pudo cambiar: ' },
    '切换失败：': { en: 'Switch failed: ', es: 'Error al cambiar: ' },
    '此版本不支持切换授权范围，请在电脑端操作。': {
      en: 'This version cannot change the access scope; use the computer.',
      es: 'Esta versión no puede cambiar el alcance de acceso; usa el ordenador.'
    },
    '确认启用完全权限？': { en: 'Turn on Full access?', es: '¿Activar el acceso total?' },
    '仅建议在你信任后续任务时使用。': {
      en: 'Only do this when you trust what the agent will do next.',
      es: 'Hazlo solo si confías en lo que hará el agente a continuación.'
    },
    '保存到手机': { en: 'Save to phone', es: 'Guardar en el teléfono' },
    '已保存': { en: 'Saved', es: 'Guardado' },
    '已开始下载': { en: 'Download started', es: 'Descarga iniciada' },
    '存不了，长按图片试试': {
      en: 'Could not save — try long-pressing the image',
      es: 'No se pudo guardar; mantén pulsada la imagen'
    },
    '重试读取': { en: 'Retry', es: 'Reintentar' },
    '文件列表未加载。请点下方“重试读取”。': {
      en: 'The file list did not load. Tap Retry below.',
      es: 'La lista de archivos no se cargó. Toca Reintentar abajo.'
    },
    '此文件夹没有文件。': { en: 'This folder has no files.', es: 'Esta carpeta no tiene archivos.' },

    // ── 记录里的图片预览（C24）──────────────────────────────────────────────
    // ★ 这三条原来**漏了**：C24 加图片预览时写了文案却没进字典，
    //   于是切到英文 / 西班牙语时，图片那一块还是中文。
    //   使用者的原话就是「英语，西班牙语的时候不是所有的都改变」。
    //   （t() 找不到词条会原样返回中文，这个兜底本身是对的；漏了就是这个表现。）
    '点一下加载图片': { en: 'Tap to load the image', es: 'Toca para cargar la imagen' },
    '图片附件标识无效。': { en: 'Invalid image attachment identifier.', es: 'Identificador de adjunto de imagen no válido.' },
    '这个 DSH 版本尚不支持按附件标识读取图片。': { en: 'This DSH version does not support reading images by attachment ID.', es: 'Esta versión de DSH no permite leer imágenes por su identificador de adjunto.' },
    'DSH 找不到这张图片，或它不属于当前对话。': { en: 'DSH cannot find this image, or it does not belong to this conversation.', es: 'DSH no encuentra esta imagen o no pertenece a esta conversación.' },
    '图片超过安全预览限制。': { en: 'The image exceeds the safe preview limits.', es: 'La imagen supera los límites de vista previa segura.' },
    '图片读取失败，请检查连接后重试。': { en: 'Image read failed. Check the connection and retry.', es: 'Falló la lectura de la imagen. Comprueba la conexión y reintenta.' },
    '图片响应没有通过加密验证。': { en: 'The image response did not pass encryption verification.', es: 'La respuesta de imagen no pasó la verificación de cifrado.' },
    '图片格式不受支持。': { en: 'Unsupported image format.', es: 'Formato de imagen no compatible.' },
    '已有三张图片正在读取，请稍后重试。': { en: 'Three images are already loading. Try again shortly.', es: 'Ya se están cargando tres imágenes. Inténtalo de nuevo en un momento.' },
    '点一下加载手机临时预览': { en: 'Tap to load this phone\'s temporary preview', es: 'Toca para cargar la vista temporal de este teléfono' },
    '临时图片无法显示，点这里重试': { en: 'Temporary image could not be displayed. Tap to retry.', es: 'No se pudo mostrar la imagen temporal. Toca para reintentar.' },
    '仅此手机临时预览；刷新、切换对话或缓存回收后不可用。': { en: 'Temporary preview on this phone only. Refreshing, changing conversations, or cache eviction removes it.', es: 'Vista temporal solo en este teléfono. Se elimina al actualizar, cambiar de conversación o liberar la caché.' },
    '这张图片没有可读取的电脑路径，当前手机也没有临时副本。': { en: 'This image has no readable computer path, and this phone has no temporary copy.', es: 'Esta imagen no tiene una ruta legible en el ordenador ni una copia temporal en este teléfono.' },
    '正在取图…': { en: 'Loading image…', es: 'Cargando imagen…' },
    '取不到这张图，点这里再试': {
      en: 'Could not fetch this image — tap here to retry',
      es: 'No se pudo obtener esta imagen; toca aquí para reintentar'
    },

    // ── 目标条（C26）──────────────────────────────────────────────────────
    // 用词**照电脑端的 goal 词典抄**（phase.active / action.pause / …），
    // 这样两边看到的是同一套说法。
    '目标': { en: 'Goal', es: 'Meta' },
    '进行中的目标': { en: 'Ongoing Goal', es: 'Meta en curso' },
    '已暂停的目标': { en: 'Paused Goal', es: 'Meta en pausa' },
    '受阻的目标': { en: 'Blocked Goal', es: 'Meta bloqueada' },
    '目标内容': { en: 'Goal objective', es: 'Contenido de la meta' },
    '保存目标': { en: 'Save goal', es: 'Guardar meta' },
    '取消编辑': { en: 'Cancel edit', es: 'Cancelar edición' },
    '暂停目标': { en: 'Pause goal', es: 'Pausar meta' },
    '恢复目标': { en: 'Resume goal', es: 'Reanudar meta' },
    '编辑目标': { en: 'Edit goal', es: 'Editar meta' },
    '目标显示在输入框上方那条里，点铅笔可以改。': {
      en: 'The goal is shown in the strip above the input — tap the pencil to edit it.',
      es: 'La meta se muestra en la barra sobre el campo de texto; toca el lápiz para editarla.'
    },
    '还没有设定目标。': { en: 'No goal has been set yet.', es: 'Todavía no hay ninguna meta.' },

    // ── 目标（C26）────────────────────────────────────────────────────────
    '目标 / 计划模式': { en: 'Goal / plan mode', es: 'Meta / modo plan' },
    '正在进行': { en: 'In progress', es: 'En curso' },
    '已暂停': { en: 'Paused', es: 'En pausa' },
    '受阻': { en: 'Blocked', es: 'Bloqueado' },
    '状态不明': { en: 'Unknown state', es: 'Estado desconocido' },
    '现在没有设定目标。': { en: 'No goal is set right now.', es: 'Ahora mismo no hay ninguna meta.' },
    '设定目标': { en: 'Set goal', es: 'Fijar meta' },
    '修改目标': { en: 'Edit goal', es: 'Editar meta' },
    '暂停': { en: 'Pause', es: 'Pausar' },
    '继续': { en: 'Resume', es: 'Reanudar' },
    '标记完成': { en: 'Mark complete', es: 'Marcar como completada' },
    '清除目标': { en: 'Clear goal', es: 'Borrar meta' },
    '目标不能是空的。': { en: 'The goal cannot be empty.', es: 'La meta no puede estar vacía.' },
    '目标操作失败。': { en: 'The goal operation failed.', es: 'La operación sobre la meta falló.' },
    '目标已保存。': { en: 'Goal saved.', es: 'Meta guardada.' },
    '目标状态暂时无法读取。': { en: 'The current goal is unavailable.', es: 'No se puede leer la meta actual.' },
    '上次读取的目标，当前状态未确认。': { en: 'Last retrieved goal; current state is unconfirmed.', es: 'Última meta leída; el estado actual no está confirmado.' },
    '目标请求已发送，当前结果未确认，请重新读取。': { en: 'Goal request sent; the result is unconfirmed. Read it again.', es: 'Solicitud enviada; el resultado no está confirmado. Vuelve a leerlo.' },
    '重试读取': { en: 'Retry reading', es: 'Reintentar lectura' },
    '重新读取目标': { en: 'Read goal again', es: 'Volver a leer la meta' },
    '修改结果未确认，文字已保留。请先重新读取目标。': { en: 'The edit is unconfirmed and your text is retained. Read the goal before saving again.', es: 'La edición no está confirmada y el texto se conserva. Lee la meta antes de volver a guardar.' },
    '已重新读取目标，请检查后保存。': { en: 'Goal read again. Review it before saving.', es: 'La meta se ha vuelto a leer. Revísala antes de guardar.' },
    '正在检查计划模式…': { en: 'Checking plan mode…', es: 'Comprobando el modo plan…' },
    '进入计划模式': { en: 'Enter plan mode', es: 'Entrar en modo plan' },
    '退出计划模式': { en: 'Exit plan mode', es: 'Salir del modo plan' },
    '计划模式已启用。': { en: 'Plan mode is on.', es: 'El modo plan está activado.' },
    '计划模式未启用。': { en: 'Plan mode is off.', es: 'El modo plan está desactivado.' },
    '正在进入计划模式，下一步骤生效。': { en: 'Entering plan mode; this takes effect at the next step.', es: 'Entrando en modo plan; tendrá efecto en el siguiente paso.' },
    '正在退出计划模式，下一步骤生效。': { en: 'Exiting plan mode; this takes effect at the next step.', es: 'Saliendo del modo plan; tendrá efecto en el siguiente paso.' },
    '此对话的工具配置不支持计划模式。': { en: 'This conversation’s tool setup does not support plan mode.', es: 'La configuración de esta conversación no admite el modo plan.' },
    '无法读取当前计划状态，请明确选择操作。': { en: 'Current plan state is unavailable. Choose the action explicitly.', es: 'No se puede leer el estado del plan. Elige una acción explícita.' },
    '计划模式切换失败。': { en: 'Could not change plan mode.', es: 'No se pudo cambiar el modo plan.' },
    '读不到目标：': { en: 'Could not read the goal: ', es: 'No se pudo leer la meta: ' },
    '受阻原因：': { en: 'Blocked because: ', es: 'Bloqueada porque: ' },
    '最多轮次：': { en: 'Max rounds: ', es: 'Rondas máximas: ' },
    '写一句话说明目标': { en: 'Describe the goal in one sentence', es: 'Describe la meta en una frase' },
    '进入 / 离开计划模式': { en: 'Enter / leave plan mode', es: 'Entrar / salir del modo plan' },

    // ── 排队消息（C12）────────────────────────────────────────────────────
    '排队中（会在这一轮结束后发出）': { en: 'Queued (sent after this turn)', es: 'En cola (se enviará tras este turno)' },
    '立即执行': { en: 'Run now', es: 'Ejecutar ya' },
    '修改': { en: 'Edit', es: 'Editar' },
    '删除': { en: 'Delete', es: 'Eliminar' },
    '保存': { en: 'Save', es: 'Guardar' },
    '这条排队消息已经不在队列里了。': { en: 'That queued message is no longer pending.', es: 'Ese mensaje ya no está en la cola.' },
    '这条排队消息不能改成空的。': { en: 'A queued message cannot be emptied.', es: 'Un mensaje en cola no puede quedar vacío.' },
    '排队消息改不了：当前这一轮不再接受插话。': { en: 'Cannot steer: the current turn no longer accepts it.', es: 'No se puede interrumpir: el turno actual ya no lo admite.' },

    // ── 错误 / 兜底 ────────────────────────────────────────────────────────
    '连接 DSH 失败。请确认电脑和隧道在线后重试。': { en: 'Could not connect to DSH. Check that the computer and tunnel are online, then retry.', es: 'No se pudo conectar con DSH. Comprueba que el ordenador y el túnel estén en línea y reintenta.' },
    '加载对话列表失败，请重连后重试。': { en: 'Could not load the conversation list. Reconnect and retry.', es: 'No se pudo cargar la lista de conversaciones. Reconecta y reintenta.' },
    '加载对话内容失败，请重连后重试。': { en: 'Could not load the conversation. Reconnect and retry.', es: 'No se pudo cargar la conversación. Reconecta y reintenta.' },
    '新建对话失败，请重试。': { en: 'Could not start a new conversation. Retry.', es: 'No se pudo crear la conversación. Reintenta.' },
    '发送失败，请重试。': { en: 'Sending failed. Retry.', es: 'No se pudo enviar. Reintenta.' },
    'DSH 请求失败，请重试。': { en: 'The DSH request failed. Retry.', es: 'La solicitud a DSH falló. Reintenta.' },
    '与电脑的连接已断开，请重连。': { en: 'The connection to the computer is down. Reconnect.', es: 'La conexión con el ordenador se perdió. Reconecta.' },
    '缺少加密连接密钥，请重新打开完整地址。': { en: 'Missing the encryption key. Reopen the full address.', es: 'Falta la clave de cifrado. Vuelve a abrir la dirección completa.' },
    '压缩上下文：正在压缩…': { en: 'Compacting context…', es: 'Compactando el contexto…' },
    '压缩上下文：完成': { en: 'Context compacted', es: 'Contexto compactado' },
    '压缩上下文失败。': { en: 'Context compaction failed.', es: 'No se pudo compactar el contexto.' },
    '电脑回应：': { en: 'Computer response:', es: 'Respuesta del ordenador:' },
    '压缩请求已发送，完成状态未确认，请在电脑端核对。': { en: 'Compaction request sent; completion is unconfirmed. Check the desktop.', es: 'Solicitud de compactación enviada; su finalización no está confirmada. Comprueba el escritorio.' },
    '选择这个对话的授权范围。只有电脑返回当前配置后，才会显示已确认。': { en: 'Choose the access scope for this conversation. It is confirmed only after the computer reports its current setting.', es: 'Elige el alcance de acceso de esta conversación. Solo se confirma cuando el ordenador comunica la configuración actual.' },
    '当前授权范围未确认。': { en: 'Current access scope is unconfirmed.', es: 'El alcance de acceso actual no está confirmado.' },
    '电脑当前授权范围：': { en: 'Current access scope on the computer:', es: 'Alcance de acceso actual en el ordenador:' },
    '已确认当前授权范围：': { en: 'Confirmed current access scope:', es: 'Alcance de acceso actual confirmado:' },
    '授权请求已发送，是否生效未确认，请在电脑端核对。': { en: 'Access request sent; its effect is unconfirmed. Check the desktop.', es: 'Solicitud de acceso enviada; su efecto no está confirmado. Comprueba el escritorio.' },
    '授权范围切换失败。': { en: 'Could not change the access scope.', es: 'No se pudo cambiar el alcance de acceso.' },
    '此版本未报告当前授权范围。': { en: 'This version did not report the current access scope.', es: 'Esta versión no comunicó el alcance de acceso actual.' },
    '连接安全': { en: 'Connection security', es: 'Seguridad de la conexión' },
    '加密待验证': { en: 'Encryption pending verification', es: 'Cifrado pendiente de verificación' },
    '加密未就绪': { en: 'Encryption unavailable', es: 'Cifrado no disponible' },
    '已验证内容加密通道和设备授权。被动中继只能转发密文，不能读取对话正文。': { en: 'The encrypted content channel and device authorization are verified. A passive relay forwards ciphertext without reading conversation text.', es: 'El canal de contenido cifrado y la autorización del dispositivo están verificados. Un intermediario pasivo transmite texto cifrado sin leer la conversación.' },
    '页面代码由电脑桥提供；请使用你信任的桥和完整连接地址。加密不代表可以信任被篡改的页面。': { en: 'The computer bridge serves the page code. Use a bridge you trust and its full connection link. Encryption does not make a tampered page trustworthy.', es: 'El puente del ordenador proporciona el código de la página. Usa un puente de confianza y su enlace completo. El cifrado no hace fiable una página alterada.' },
    '加密组件已就绪，正在等待内容连接和设备授权验证。请先检查电脑和连接地址是否在线。': { en: 'Encryption is ready, but the content connection and device authorization are not yet verified. Check that the computer and connection address are online.', es: 'El cifrado está listo, pero la conexión de contenido y la autorización del dispositivo aún no están verificadas. Comprueba que el ordenador y la dirección estén disponibles.' },
    '加密组件尚未就绪。请使用 HTTPS 完整地址，并更新或重新打开桥页面。不会改用明文发送。': { en: 'Encryption is unavailable. Use the full HTTPS link and update or reopen the bridge page. Sending will not fall back to plaintext.', es: 'El cifrado no está disponible. Usa el enlace HTTPS completo y actualiza o vuelve a abrir la página del puente. No se enviará texto sin cifrar.' },
    '已中断': { en: 'Interrupted', es: 'Interrumpido' },
    '准备中': { en: 'Preparing', es: 'Preparando' },
    '待发送': { en: 'Pending send', es: 'Pendiente de envío' },
    '移除附件': { en: 'Remove attachment', es: 'Quitar adjunto' },
    '正在读取电脑文件…': { en: 'Reading computer files…', es: 'Leyendo archivos del ordenador…' },
    '加载图片': { en: 'Load image', es: 'Cargar imagen' },
    '↓ 重试下载': { en: '↓ Retry download', es: '↓ Reintentar descarga' },
    '排队结果暂时无法确认，请重新读取。': { en: 'The queue result is unconfirmed. Read the queue again.', es: 'El resultado de la cola no está confirmado. Vuelve a leerla.' },
    '修改结果未确认，文字已保留。请先重新读取队列。': { en: 'The edit is unconfirmed and your text is retained. Read the queue before saving again.', es: 'La edición no está confirmada y el texto se conserva. Lee la cola antes de volver a guardar.' },
    '重新读取队列': { en: 'Read queue again', es: 'Volver a leer la cola' },
    '已重新读取队列，请检查后保存。': { en: 'Queue read again. Review it before saving.', es: 'La cola se ha vuelto a leer. Revísala antes de guardar.' },
    '压缩上下文：现在不能压缩（正在执行或已经在压缩）': { en: 'Cannot compact right now (a turn or a compaction is running)', es: 'Ahora no se puede compactar (hay un turno o una compactación en curso)' },
    '电脑上的这个 DSH 没有 /compact 命令。': { en: 'This DSH build has no /compact command.', es: 'Esta versión de DSH no tiene el comando /compact.' }
  });

  // ── agent preset（界面上的「模式」）的显示名与说明（C23）──────────────────
  //
  // ★ 为什么**单独一张表**、不走上面那套 t()：
  //   `agentPresets/list` **只回 id、不回 name** —— 实测返回是
  //       [{id:'standard', isDefault:true}, {id:'ptc'}, {id:'minimal'}, {id:'cordis'}]
  //   而 t() 那套的规矩是"中文原文当 key"，这里的 key 却是英文 id，
  //   塞进同一个字典就对不上了。
  //
  // ★ 下面的名字和说明**是从电脑端的词典里抄的，不是我编的**：
  //   电脑端有一套 PresetGuideDialog，key 分别是 preset*Name / guide*Intro。
  //   从 asar 里读出来的对应关系：
  //     presetStandardName → 「标准模式」，guideStandardIntro → 「新建任务时选择…」
  //     presetPtcName      → 「PTC 模式」
  //     presetMinimalName  → 「极简模式」
  //     presetCordisName   → 「创造模式」   ← 注意：id 叫 cordis，中文叫"创造模式"
  //   手机端原来直接把 id 显示出来（"standard / ptc / cordis"），既不是中文
  //   也不是人话 —— 这就是使用者说的「模式列表英文、缺说明」。
  //
  // ★ 不在表里的（自定义预设）**原样显示 id**，绝不瞎翻。
  var PRESETS = {
    standard: {
      zh: '标准模式', en: 'Standard mode', es: 'Modo estándar',
      hint: {
        zh: '新建任务时选择「标准模式」，说明要完成什么、相关文件在哪里，以及怎样判断任务完成。',
        en: 'Choose Standard mode when starting a new task. Describe what you want to accomplish, point to the relevant files, and explain how to check the result.',
        es: 'Elige el modo Estándar al empezar una tarea. Describe qué quieres conseguir, dónde están los archivos y cómo comprobar el resultado.'
      }
    },
    ptc: {
      zh: 'PTC 模式', en: 'PTC mode', es: 'Modo PTC',
      hint: {
        zh: '新建任务时选择「PTC 模式」，说明输入文件、处理规则和输出格式。代码由 Agent 编写。',
        en: 'Choose PTC mode when starting a new task. Specify the input files, processing rules, and output format. The agent writes the code.',
        es: 'Elige el modo PTC al empezar una tarea. Indica los archivos de entrada, las reglas de procesamiento y el formato de salida. El código lo escribe el agente.'
      }
    },
    minimal: {
      zh: '极简模式', en: 'Minimal mode', es: 'Modo mínimo',
      hint: {
        zh: '新建任务时选择「极简模式」。做对照测试时，保持模型、权限、任务输入和工作区起始状态一致。',
        en: 'Choose Minimal mode for a new task. For a comparison, hold the model, permissions, input, and starting workspace state constant across runs.',
        es: 'Elige el modo Mínimo al empezar una tarea. Para comparar, mantén constantes el modelo, los permisos, la entrada y el estado inicial del espacio de trabajo.'
      }
    },
    cordis: {
      zh: '创造模式', en: 'Creator mode', es: 'Modo creador',
      hint: {
        zh: '新建任务时选择「创造模式」，说明希望增加什么能力、从哪里使用，以及怎样验证效果。',
        en: 'Choose Creator mode for a new task. Describe the capability you want, where it should appear, and how you will verify it.',
        es: 'Elige el modo Creador al empezar una tarea. Describe la capacidad que quieres, dónde debe aparecer y cómo la verificarás.'
      }
    }
  };

  var api = (typeof window !== 'undefined' ? window : globalThis);
  api.DshLitePresets = PRESETS;
})(typeof window !== 'undefined' ? window : globalThis);
