/*
 * カード情報 <-> URLの「#」以降の文字列 の相互変換
 *
 * 流れ: データ → 配列(キー名なし) → JSON → (deflate圧縮) → base64url → 先頭にバージョン文字
 *   '0' = 圧縮なしのJSON, '1' = deflate-raw圧縮
 *
 * ブラウザでもNodeでも動くようにしてあります(テスト用)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardCodec = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ★重要: 追加するときは「末尾に足す」だけ。並べ替え・削除をすると、すでに書き込んだタグの表示が壊れます。
  const PRESETS = [
    '卵', '乳', '小麦', 'そば', '落花生', 'えび', 'かに', 'くるみ',
    'アーモンド', 'カシューナッツ', 'マカダミアナッツ', 'ごま', '大豆',
    'さけ', 'さば', 'いか', 'いくら', 'あわび', '牛肉', '豚肉', '鶏肉',
    'ゼラチン', 'オレンジ', 'キウイフルーツ', 'バナナ', 'もも', 'りんご', 'やまいも'
  ];
  const LEVELS = ['severe', 'moderate', 'mild'];

  const MAX_PAYLOAD_CHARS = 4000;  // これより長い入力は読み取らない
  const MAX_JSON_BYTES = 4096;     // 展開後の上限(圧縮爆弾対策)
  const MAX_ALLERGIES = 30;

  // ---------- base64url(環境に依存しない自前実装) ----------
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const B64_REV = {};
  for (let i = 0; i < B64.length; i++) B64_REV[B64[i]] = i;

  function toB64url(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += B64[b0 >> 2];
      out += B64[((b0 & 3) << 4) | ((b1 || 0) >> 4)];
      if (i + 1 < bytes.length) out += B64[((b1 & 15) << 2) | ((b2 || 0) >> 6)];
      if (i + 2 < bytes.length) out += B64[b2 & 63];
    }
    return out;
  }

  function fromB64url(str) {
    if (!/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) throw new Error('bad base64');
    const bytes = [];
    for (let i = 0; i < str.length; i += 4) {
      const c0 = B64_REV[str[i]], c1 = B64_REV[str[i + 1]];
      const c2 = i + 2 < str.length ? B64_REV[str[i + 2]] : undefined;
      const c3 = i + 3 < str.length ? B64_REV[str[i + 3]] : undefined;
      bytes.push((c0 << 2) | (c1 >> 4));
      if (c2 !== undefined) bytes.push(((c1 & 15) << 4) | (c2 >> 2));
      if (c3 !== undefined) bytes.push(((c2 & 3) << 6) | c3);
    }
    return new Uint8Array(bytes);
  }

  // ---------- 圧縮 ----------
  async function deflateRaw(bytes) {
    const cs = new CompressionStream('deflate-raw');
    const w = cs.writable.getWriter();
    w.write(bytes).catch(function () {});
    w.close().catch(function () {});
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }

  async function inflateRaw(bytes, limit) {
    const ds = new DecompressionStream('deflate-raw');
    const w = ds.writable.getWriter();
    w.write(bytes).catch(function () {});
    w.close().catch(function () {});
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      total += r.value.length;
      if (total > limit) { reader.cancel().catch(function () {}); throw new Error('too large'); }
      chunks.push(r.value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    chunks.forEach(function (c) { out.set(c, off); off += c.length; });
    return out;
  }

  // ---------- データ <-> 配列 ----------
  function cleanPhone(p) { return String(p || '').replace(/[^0-9+]/g, ''); }
  function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
  function levelIndex(l) { const i = LEVELS.indexOf(l); return i < 0 ? 2 : i; }

  // 配列の形: [保護者名, 保護者電話, 病院名, 病院電話, 症状メモ, 薬の場所, 応急処置, [アレルギー...]]
  // アレルギー1件: 定義済み&メモなし → 数値(番号*3+重症度) / それ以外 → [名前か番号, 重症度, メモ]
  function toArray(data) {
    const allergies = (data.allergies || []).slice(0, MAX_ALLERGIES).map(function (a) {
      const name = str(a.name, 50);
      const note = str(a.note, 200);
      const lv = levelIndex(a.level);
      const idx = PRESETS.indexOf(name);
      if (idx >= 0 && !note) return idx * 3 + lv;
      const head = idx >= 0 ? idx : name;
      return note ? [head, lv, note] : [head, lv];
    }).filter(function (e) { return !(Array.isArray(e) && e[0] === ''); });

    return [
      str(data.guardianName, 50), cleanPhone(data.guardianPhone),
      str(data.hospitalName, 50), cleanPhone(data.hospitalPhone),
      str(data.symptomsText, 500), str(data.medicineLocation, 200),
      str(data.responseStep3, 500), allergies
    ];
  }

  function fromArray(arr) {
    if (!Array.isArray(arr) || arr.length < 8) throw new Error('bad shape');
    const allergies = (Array.isArray(arr[7]) ? arr[7] : []).slice(0, MAX_ALLERGIES).map(function (e) {
      if (typeof e === 'number' && Number.isInteger(e) && e >= 0) {
        const name = PRESETS[Math.floor(e / 3)];
        return name ? { name: name, level: LEVELS[e % 3], note: '' } : null;
      }
      if (Array.isArray(e)) {
        const name = typeof e[0] === 'number' ? PRESETS[e[0]] : str(e[0], 50);
        if (!name) return null;
        return { name: name, level: LEVELS[levelIndex(LEVELS[e[1]])], note: str(e[2], 200) };
      }
      return null;
    }).filter(Boolean);

    return {
      guardianName: str(arr[0], 50), guardianPhone: cleanPhone(arr[1]),
      hospitalName: str(arr[2], 50), hospitalPhone: cleanPhone(arr[3]),
      symptomsText: str(arr[4], 500), medicineLocation: str(arr[5], 200),
      responseStep3: str(arr[6], 500), allergies: allergies
    };
  }

  // ---------- 公開API ----------
  async function encode(data) {
    const raw = new TextEncoder().encode(JSON.stringify(toArray(data)));
    let best = '0' + toB64url(raw);
    if (typeof CompressionStream !== 'undefined') {
      try {
        const z = '1' + toB64url(await deflateRaw(raw));
        if (z.length < best.length) best = z;
      } catch (e) { /* 圧縮できない環境では無圧縮のまま */ }
    }
    return best;
  }

  async function decode(payload) {
    if (typeof payload !== 'string' || payload.length < 2 || payload.length > MAX_PAYLOAD_CHARS) {
      throw new Error('bad payload');
    }
    const version = payload[0];
    const bytes = fromB64url(payload.slice(1));
    let raw;
    if (version === '0') {
      if (bytes.length > MAX_JSON_BYTES) throw new Error('too large');
      raw = bytes;
    } else if (version === '1') {
      raw = await inflateRaw(bytes, MAX_JSON_BYTES);
    } else {
      throw new Error('unknown version');
    }
    return fromArray(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
  }

  // NFCタグ(NDEF URIレコード)に書き込んだときの使用バイト数の見積もり
  //   「https://」は1バイトに圧縮される前提(NFC Toolsなど多くのアプリがそうする)
  function estimateTagBytes(url) {
    const rest = url.indexOf('https://') === 0 ? url.slice(8) : url;
    const restBytes = new TextEncoder().encode(rest).length;
    const payloadLen = 1 + restBytes;               // 圧縮コード(1) + 残りのURL
    const header = payloadLen <= 255 ? 4 : 7;       // NDEFレコードのヘッダ(長いと7バイト)
    return header + payloadLen;                      // NDEFメッセージ全体のバイト数
  }

  return { PRESETS: PRESETS, LEVELS: LEVELS, encode: encode, decode: decode, estimateTagBytes: estimateTagBytes };
});
