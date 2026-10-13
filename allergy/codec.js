/*
 * カード情報 <-> URLの「#」以降の文字列 の相互変換
 *
 * 形式(先頭1文字がバージョン):
 *   '2' = 独自のバイナリ形式 + base64url         ← 現在の標準(日本語向けに小さく詰める)
 *   '3' = '2' をさらに deflate 圧縮 + base64url  ← その方が短い場合だけ使う
 *   '0','1' = 旧形式(JSON / JSON+deflate)。すでに書き込んだタグを読めるよう、読み取りだけ残してある
 *
 * ブラウザでもNodeでも動くようにしてあります(テスト用)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.CardCodec = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  // ★重要: 追加するときは「末尾に足す」だけ。並べ替え・削除をすると、すでに書き込んだタグの表示が壊れます。
  // ★上限は42個(番号*3+重症度 を1バイトの 0〜127 に収めているため)。
  const PRESETS = [
    '卵', '乳', '小麦', 'そば', '落花生', 'えび', 'かに', 'くるみ',
    'アーモンド', 'カシューナッツ', 'マカダミアナッツ', 'ごま', '大豆',
    'さけ', 'さば', 'いか', 'いくら', 'あわび', '牛肉', '豚肉', '鶏肉',
    'ゼラチン', 'オレンジ', 'キウイフルーツ', 'バナナ', 'もも', 'りんご', 'やまいも'
  ];
  if (PRESETS.length > 42) throw new Error('PRESETS is too long');
  const LEVELS = ['severe', 'moderate', 'mild'];

  const MAX_PAYLOAD_CHARS = 4000;  // これより長い入力は読み取らない
  const MAX_RAW_BYTES = 4096;      // 展開後の上限(圧縮爆弾対策)
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

  // ---------- 入力の整形 ----------
  function cleanPhone(p) { return String(p || '').replace(/[^0-9+]/g, '').slice(0, 20); }
  function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
  function levelIndex(l) { const i = LEVELS.indexOf(l); return i < 0 ? 2 : i; }

  function normalize(data) {
    data = data || {};
    const allergies = (Array.isArray(data.allergies) ? data.allergies : []).slice(0, MAX_ALLERGIES).map(function (a) {
      return { name: str(a && a.name, 50), level: LEVELS[levelIndex(a && a.level)], note: str(a && a.note, 200) };
    }).filter(function (a) { return a.name; });
    return {
      guardianName: str(data.guardianName, 50), guardianPhone: cleanPhone(data.guardianPhone),
      hospitalName: str(data.hospitalName, 50), hospitalPhone: cleanPhone(data.hospitalPhone),
      symptomsText: str(data.symptomsText, 500), medicineLocation: str(data.medicineLocation, 200),
      responseStep3: str(data.responseStep3, 500), allergies: allergies
    };
  }

  // =====================================================================
  //  v2: 日本語向けの小さいバイナリ形式
  // =====================================================================
  //
  // 文字列のバイト割り当て(UTF-8だと かな/漢字は3バイトのところを、かな=1、漢字=2バイトにする)
  //   0x00        文字列の終わり
  //   0x01 hh ll  上の表にない文字(UTF-16の1文字ぶん, 計3バイト)
  //   0x02        ひらがな/カタカナの切り替え(文字列の始まりはひらがな)
  //   0x0A        改行
  //   0x20-0x7E   ASCII(英数字・記号)
  //   0x80-0xD5   かな86字(ひらがな U+3041〜3096 / カタカナモード中は U+30A1〜30F6)
  //   0xD6-0xDF   よく使う記号10字  SYMS
  //   0xE0-0xFF + 1バイト  漢字(JIS X 0208 の第1・第2水準 約6300字を、区点の並び順で番号づけ。表は kanji-table.js)
  const SYMS = '、。「」ー・（）！？';
  const KANA_N = 86;

  let KANJI_CHARS = null;   // 番号 -> 文字
  let KANJI_INDEX = null;   // 文字 -> 番号

  function buildKanji() {
    if (KANJI_CHARS) return;
    // 同梱の kanji-table.js(JIS X 0208 の16〜84区を区点順に並べた文字列)。ブラウザの機能に頼らない
    const table = (typeof module === 'object' && module.exports) ? require('./kanji-table.js') : root.CARD_KANJI_TABLE;
    if (typeof table !== 'string' || table.length !== 69 * 94) throw new Error('kanji-table.js is missing');
    KANJI_CHARS = new Array(table.length).fill('');
    KANJI_INDEX = new Map();
    for (let i = 0; i < table.length; i++) {
      const ch = table[i];
      if (ch === '\uFFFD') continue;
      KANJI_CHARS[i] = ch;
      if (!KANJI_INDEX.has(ch)) KANJI_INDEX.set(ch, i);
    }
  }

  function encodeText(s, out) {
    buildKanji();
    let kata = false;
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      const ch = s[i];
      if (u >= 0x20 && u <= 0x7E) { out.push(u); continue; }
      if (u === 0x0A) { out.push(0x0A); continue; }
      if (u >= 0x3041 && u <= 0x3096) {
        if (kata) { out.push(0x02); kata = false; }
        out.push(0x80 + u - 0x3041);
        continue;
      }
      if (u >= 0x30A1 && u <= 0x30F6) {
        if (!kata) { out.push(0x02); kata = true; }
        out.push(0x80 + u - 0x30A1);
        continue;
      }
      const si = SYMS.indexOf(ch);
      if (si >= 0) { out.push(0xD6 + si); continue; }
      const k = KANJI_INDEX.get(ch);
      if (k !== undefined) { out.push(0xE0 + (k >> 8), k & 255); continue; }
      out.push(0x01, u >> 8, u & 255);
    }
    out.push(0x00);
  }

  function decodeText(bytes, pos) {
    buildKanji();
    let kata = false;
    let s = '';
    for (;;) {
      if (pos >= bytes.length) throw new Error('unterminated text');
      const b = bytes[pos++];
      if (b === 0x00) return [s, pos];
      if (b >= 0x20 && b <= 0x7E) s += String.fromCharCode(b);
      else if (b === 0x0A) s += '\n';
      else if (b === 0x02) kata = !kata;
      else if (b === 0x01) {
        if (pos + 2 > bytes.length) throw new Error('truncated escape');
        s += String.fromCharCode((bytes[pos] << 8) | bytes[pos + 1]);
        pos += 2;
      } else if (b >= 0x80 && b <= 0xD5) s += String.fromCharCode((kata ? 0x30A1 : 0x3041) + b - 0x80);
      else if (b >= 0xD6 && b <= 0xDF) s += SYMS[b - 0xD6];
      else if (b >= 0xE0) {
        if (pos >= bytes.length) throw new Error('truncated kanji');
        const ch = KANJI_CHARS[((b - 0xE0) << 8) | bytes[pos++]];
        if (!ch) throw new Error('bad kanji');
        s += ch;
      } else throw new Error('bad byte');
      if (s.length > 1000) throw new Error('text too long');
    }
  }

  // 電話番号: 1桁=4ビット(0-9, +=0xA)、終わり=0xF。偶数桁のときは余りを0xFで埋める
  function encodePhone(p, out) {
    const n = [];
    for (let i = 0; i < p.length; i++) n.push(p[i] === '+' ? 0xA : p.charCodeAt(i) - 48);
    n.push(0xF);
    if (n.length % 2) n.push(0xF);
    for (let i = 0; i < n.length; i += 2) out.push((n[i] << 4) | n[i + 1]);
  }

  function decodePhone(bytes, pos) {
    let s = '';
    for (;;) {
      if (pos >= bytes.length) throw new Error('unterminated phone');
      const b = bytes[pos++];
      const hi = b >> 4, lo = b & 15;
      if (hi === 0xF) {
        if (lo !== 0xF) throw new Error('bad phone padding');
        return [s, pos];
      }
      if (hi > 0xA) throw new Error('bad phone');
      s += hi === 0xA ? '+' : String(hi);
      if (lo === 0xF) return [s, pos];
      if (lo > 0xA) throw new Error('bad phone');
      s += lo === 0xA ? '+' : String(lo);
      if (s.length > 20) throw new Error('phone too long');
    }
  }

  // 並び: [有無フラグ1バイト][保護者名][保護者電話][病院名][病院電話][症状][薬の場所][処置][アレルギー]
  //   フラグのbit0〜6が上の7項目(入力があるものだけ書く)、bit7がアレルギー有無
  //   アレルギー: [件数] のあと1件ずつ
  //     0x00-0x7F  定義済み・メモなし(番号*3+重症度)
  //     0x80+重症度  自由入力の名前 (文字列)
  //     0x84+重症度  自由入力の名前 + メモ (文字列2つ)
  //     0x88+重症度  定義済み(次の1バイトが番号) + メモ (文字列)
  function pack(d) {
    const present = [
      !!d.guardianName, !!d.guardianPhone, !!d.hospitalName, !!d.hospitalPhone,
      !!d.symptomsText, !!d.medicineLocation, !!d.responseStep3, d.allergies.length > 0
    ];
    let flags = 0;
    present.forEach(function (p, i) { if (p) flags |= 1 << i; });
    const out = [flags];
    if (present[0]) encodeText(d.guardianName, out);
    if (present[1]) encodePhone(d.guardianPhone, out);
    if (present[2]) encodeText(d.hospitalName, out);
    if (present[3]) encodePhone(d.hospitalPhone, out);
    if (present[4]) encodeText(d.symptomsText, out);
    if (present[5]) encodeText(d.medicineLocation, out);
    if (present[6]) encodeText(d.responseStep3, out);
    if (present[7]) {
      out.push(d.allergies.length);
      d.allergies.forEach(function (a) {
        const lv = levelIndex(a.level);
        const idx = PRESETS.indexOf(a.name);
        if (idx >= 0 && !a.note) out.push(idx * 3 + lv);
        else if (idx >= 0) { out.push(0x88 + lv, idx); encodeText(a.note, out); }
        else if (!a.note) { out.push(0x80 + lv); encodeText(a.name, out); }
        else { out.push(0x84 + lv); encodeText(a.name, out); encodeText(a.note, out); }
      });
    }
    return Uint8Array.from(out);
  }

  function unpack(bytes) {
    if (bytes.length < 1) throw new Error('empty');
    let pos = 0;
    const flags = bytes[pos++];
    const d = {
      guardianName: '', guardianPhone: '', hospitalName: '', hospitalPhone: '',
      symptomsText: '', medicineLocation: '', responseStep3: '', allergies: []
    };
    let r;
    if (flags & 1)   { r = decodeText(bytes, pos);  d.guardianName = r[0];     pos = r[1]; }
    if (flags & 2)   { r = decodePhone(bytes, pos); d.guardianPhone = r[0];    pos = r[1]; }
    if (flags & 4)   { r = decodeText(bytes, pos);  d.hospitalName = r[0];     pos = r[1]; }
    if (flags & 8)   { r = decodePhone(bytes, pos); d.hospitalPhone = r[0];    pos = r[1]; }
    if (flags & 16)  { r = decodeText(bytes, pos);  d.symptomsText = r[0];     pos = r[1]; }
    if (flags & 32)  { r = decodeText(bytes, pos);  d.medicineLocation = r[0]; pos = r[1]; }
    if (flags & 64)  { r = decodeText(bytes, pos);  d.responseStep3 = r[0];    pos = r[1]; }
    if (flags & 128) {
      if (pos >= bytes.length) throw new Error('truncated');
      const count = bytes[pos++];
      if (count < 1 || count > MAX_ALLERGIES) throw new Error('bad count');
      for (let i = 0; i < count; i++) {
        if (pos >= bytes.length) throw new Error('truncated');
        const b = bytes[pos++];
        if (b < 0x80) {
          const idx = Math.floor(b / 3);
          if (idx >= PRESETS.length) throw new Error('bad preset');
          d.allergies.push({ name: PRESETS[idx], level: LEVELS[b % 3], note: '' });
        } else if (b <= 0x82) {
          r = decodeText(bytes, pos); pos = r[1];
          d.allergies.push({ name: r[0], level: LEVELS[b - 0x80], note: '' });
        } else if (b >= 0x84 && b <= 0x86) {
          r = decodeText(bytes, pos); pos = r[1];
          const name = r[0];
          r = decodeText(bytes, pos); pos = r[1];
          d.allergies.push({ name: name, level: LEVELS[b - 0x84], note: r[0] });
        } else if (b >= 0x88 && b <= 0x8A) {
          if (pos >= bytes.length) throw new Error('truncated');
          const idx = bytes[pos++];
          if (idx >= PRESETS.length) throw new Error('bad preset');
          r = decodeText(bytes, pos); pos = r[1];
          d.allergies.push({ name: PRESETS[idx], level: LEVELS[b - 0x88], note: r[0] });
        } else throw new Error('bad allergy entry');
      }
    }
    if (pos !== bytes.length) throw new Error('trailing bytes');  // 余りがある=壊れている/改ざん
    return normalize(d);
  }

  // =====================================================================
  //  旧形式(v0/v1)の読み取り
  //   配列: [保護者名, 保護者電話, 病院名, 病院電話, 症状, 薬の場所, 処置, [アレルギー...]]
  // =====================================================================
  function fromLegacyArray(arr) {
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
    return normalize({
      guardianName: arr[0], guardianPhone: arr[1], hospitalName: arr[2], hospitalPhone: arr[3],
      symptomsText: arr[4], medicineLocation: arr[5], responseStep3: arr[6], allergies: allergies
    });
  }

  // ---------- 公開API ----------
  async function encode(data) {
    const packed = pack(normalize(data));
    let best = '2' + toB64url(packed);
    if (typeof CompressionStream !== 'undefined') {
      try {
        const z = '3' + toB64url(await deflateRaw(packed));
        if (z.length < best.length) best = z;
      } catch (e) { /* 圧縮できない環境ではそのまま */ }
    }
    return best;
  }

  async function decode(payload) {
    if (typeof payload !== 'string' || payload.length < 2 || payload.length > MAX_PAYLOAD_CHARS) {
      throw new Error('bad payload');
    }
    const version = payload[0];
    const bytes = fromB64url(payload.slice(1));
    if (version === '2') {
      if (bytes.length > MAX_RAW_BYTES) throw new Error('too large');
      return unpack(bytes);
    }
    if (version === '3') return unpack(await inflateRaw(bytes, MAX_RAW_BYTES));
    if (version === '0' || version === '1') {
      let raw;
      if (version === '0') {
        if (bytes.length > MAX_RAW_BYTES) throw new Error('too large');
        raw = bytes;
      } else {
        raw = await inflateRaw(bytes, MAX_RAW_BYTES);
      }
      return fromLegacyArray(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
    }
    throw new Error('unknown version');
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
