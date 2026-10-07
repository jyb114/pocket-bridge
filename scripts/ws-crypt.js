// WebSocket 加密变换层 —— 网关在中间改写帧内容用的。
//
// 职责很单一：收到一边的字节流 → 拆帧 → 把「数据帧」的载荷解密/加密 → 拼回去。
//
// 两个必须做对的细节：
//
//   1. **加密后 opcode 要改成 binary(0x2)**。
//      原来的载荷是 JSON 文本，密文不是合法 UTF-8。如果还标成 text(0x1)，
//      有些中间层（代理、日志、调试工具）会按文本去解码，可能报错或改坏数据。
//      标成 binary 谁都不会去动它。
//
//   2. **控制帧原样透传**（ping/pong/close）。
//      那些是协议层面的，加密了对接就会断。而且它们的载荷本来也没有隐私内容。
'use strict';
const wsf = require('./ws-frame.js');
const e2ee = require('./e2ee.js');
const replay = require('./replay-store.js');
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_BUFFER_BYTES = MAX_FRAME_BYTES + 14;
const MAX_FRAMES_PER_BATCH = 4096;

// ── 重放防护 ────────────────────────────────────────────────────────────────
//
// AES-GCM 保证的是「改一个字节就解不开」，**不保证「同一段密文不能重发」**。
// 攻击者（比如中继）抓到一个手机发出的 turn/start 帧，原样再发一次：
// 密钥对、标签对，网关照解、照转发，电脑就把那条命令**又执行一遍**。
// 加密在这里一点忙都帮不上 —— 密文是真的，只是旧的。
//
// 判据用 IV：每帧的 IV 是 12 字节随机数，重复的概率可以忽略。而 IV 是 GCM 的
// 输入之一，**改 IV 就验不过标签**，所以重放必须原样带着同一个 IV。
// 于是「同一个密钥作用域下见过这个 IV」就是重放的铁证 —— 这不是启发式，
// 是 GCM 对 nonce 唯一性的要求本身。
//
// 为什么作用域是「密钥」而不是「连接」：断线重连是新连接，帧还是那些帧。
// 只按连接记的话，攻击者等你重连一次就能重放。所以按密钥记，配时间窗和上限。
//
// Server receipts now persist before forwarding. Their lifetime covers the
// complete current/previous derived-key window; capacity/storage/clock failure
// refuses admission, rather than evicting still-valid receipts. This does not
// add sequence numbers, bind routes, or protect a compromised local filesystem.
const REPLAY_WINDOW_MS = 2 * e2ee.SLOT_MS;

function scopeOf(secret) {
  return replay.scopeOf(secret);
}

/** Legacy fixture hook. False means refused (duplicate or storage failure). */
function noteIv(scope, ivHex, now) {
  return replay.defaultStore.consume(scope, 'body:' + e2ee.slotAt(now) + ':' + ivHex, (e2ee.slotAt(now) + 2) * e2ee.SLOT_MS).ok === true;
}

class WsCrypto {
  /**
   * @param {string} longTermSecret 长期密钥
   * @param {'decrypt'|'encrypt'} mode
   *        decrypt = 这个方向是「手机→电脑」，进来的是密文，要解开再转发
   *        encrypt = 这个方向是「电脑→手机」，进来的是明文，要加密再发出去
   */
  constructor(longTermSecret, mode, options = {}) {
    this.secret = longTermSecret;
    this.mode = mode;
    this.buf = Buffer.alloc(0);
    this.keyCache = null;
    this.keyCacheSlot = -1;
    this.scope = scopeOf(longTermSecret);
    this.replayStore = options.store || replay.defaultStore;
    // 计数给上层记日志用：拦下多少重放、丢掉多少解不开的帧。
    // 不记的话这两种情况都是「静默丢帧」，出事时完全查不出原因。
    this.replayed = 0;
    this.undecryptable = 0;
    this.rejected = 0;
    // Diagnostic only: authorization does not depend on a prior valid frame.
    this.decryptedOk = 0;
  }

  /** 取当前时间段的密钥（每次跨时间段自动换） */
  keys() {
    const slot = e2ee.slotAt();
    if (this.keyCacheSlot !== slot) {
      this.keyCache = e2ee.deriveKeys(this.secret, slot);
      this.keyCacheSlot = slot;
    }
    return this.keyCache;
  }

  /**
   * 处理一段进来的字节，返回该转发出去的字节。
   *
   * 内部会攒缓冲区 —— TCP 不保证一次给你一个完整帧，
   * 可能半个，也可能三个半。所以要拆到拆不动为止，剩下的留到下次。
   */
  push(chunk) {
    if (this.invalidStream) return Buffer.alloc(0);
    if (!Buffer.isBuffer(chunk) || this.buf.length + chunk.length > MAX_BUFFER_BYTES) {
      this.buf = Buffer.alloc(0); this.invalidStream = true; this.rejected++;
      this.lastFailureCode = 'ws-buffer-too-large'; return Buffer.alloc(0);
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

    let parsed;
    try {
      parsed = wsf.parseFrames(this.buf, { strict: true, maxPayloadBytes: MAX_FRAME_BYTES, maxFrames: MAX_FRAMES_PER_BATCH });
    } catch (err) {
      // A malformed encrypted stream must never bypass the transform.
      this.buf = Buffer.alloc(0);
      this.invalidStream = true;
      this.rejected++;
      this.lastFailureCode = /^ws-(?:frame-invalid|frame-too-large|frame-count-limit|control-invalid|fragmentation-unsupported)$/.test(err.code || '') ? err.code : 'ws-frame-invalid';
      return Buffer.alloc(0);
    }

    this.buf = parsed.rest;
    if (!parsed.frames.length) return Buffer.alloc(0);

    const out = [];
    for (const f of parsed.frames) {
      // 控制帧：原样重拼（保留原来的掩码设置）
      if ([wsf.OP_CLOSE, wsf.OP_PING, wsf.OP_PONG].includes(f.opcode)) {
        out.push(wsf.buildFrame(f.opcode, f.payload, f.masked));
        continue;
      }

      if (this.mode === 'decrypt') {
        // 从手机来的：密文 → 明文
        const admission = e2ee.openIncoming(this.secret, f.payload, { store: this.replayStore });
        if (admission.ok) {
          // ★ 重放判定：解开了不等于该收下。见过同一个 IV 就是重放，丢掉。
          //
          // 注意顺序：必须**先解开再判重放**。光看 IV 就丢的话，攻击者随便
          // 编一个 IV 就能把正常帧挤掉（拒绝服务）；而解开之后能确认这一段
          // 密文确实是这条密钥产生的合法帧，此时「IV 见过」才等于重放。
          // 解开了：用明文替换，并且**改回 text**，因为我们知道它是 JSON
          out.push(wsf.buildFrame(wsf.OP_TEXT, admission.plain, f.masked));
          // The HTTP upgrade is handled outside this data-frame transform.
          this.decryptedOk++;
        } else {
          // This transform is installed only for negotiated E2EE connections.
          // Neither first-message status nor binary opcode proves authenticity.
          this.lastFailureCode = admission.code;
          if (admission.code === 'replayed-request') this.replayed++;
          else if (admission.code === 'invalid-ciphertext') { this.undecryptable++; this.rejected++; }
          else { this.rejected++; this.invalidStream = true; break; }
          continue;
        }
      } else {
        // Current encrypted protocol carries text application messages only.
        // Unsupported binary payloads require a versioned authenticated envelope.
        if (f.opcode === wsf.OP_TEXT) {
          const ct = e2ee.encrypt(this.keys().b, f.payload);
          out.push(wsf.buildFrame(wsf.OP_BIN, ct, f.masked));
        } else {
          this.rejected++;
          this.invalidStream = true;
          this.lastFailureCode = 'ws-data-unsupported';
          break;
        }
      }
    }

    return Buffer.concat(out);
  }
}

module.exports = { WsCrypto, _noteIv: noteIv, _scopeOf: scopeOf, REPLAY_WINDOW_MS, MAX_FRAME_BYTES, MAX_BUFFER_BYTES, MAX_FRAMES_PER_BATCH };
