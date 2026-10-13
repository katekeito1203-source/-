(function () {
    'use strict';

    const C = window.CardCodec;
    const $ = (id) => document.getElementById(id);

    let current = emptyData();   // いま閲覧画面に出している(または編集の元になっている)データ
    let tagLimit = 492;
    let timer = null;
    let seq = 0;

    function emptyData() {
        return {
            guardianName: '', guardianPhone: '', hospitalName: '', hospitalPhone: '',
            allergies: [], symptomsText: '', medicineLocation: '', responseStep3: ''
        };
    }

    // ---------- 起動 ----------
    window.addEventListener('DOMContentLoaded', async () => {
        buildAllergenList();

        $('toggleModeBtn').addEventListener('click', toggleMode);
        $('addAllergyBtn').addEventListener('click', () => { addAllergyField(); scheduleUpdate(); });
        $('allergyForm').addEventListener('submit', (e) => e.preventDefault());
        $('allergyForm').addEventListener('input', scheduleUpdate);
        $('allergyForm').addEventListener('change', scheduleUpdate);
        $('edit-allergy-container').addEventListener('click', (ev) => {
            if (ev.target.classList.contains('btn-remove')) {
                ev.target.parentElement.remove();
                scheduleUpdate();
            }
        });
        $('tagType').addEventListener('change', () => { tagLimit = Number($('tagType').value); updateOutput(); });
        $('copyBtn').addEventListener('click', copyUrl);
        $('nfcBtn').addEventListener('click', writeNfc);
        window.addEventListener('hashchange', () => location.reload());

        const payload = location.hash.slice(1);
        if (payload) {
            try {
                current = await C.decode(payload);
                showView();
            } catch (e) {
                showNotice('このカードのデータを読み取れませんでした。タグへの書き込みが途中で切れているか、URLが壊れている可能性があります。', true);
                $('newLink').classList.remove('hidden');
            }
        } else {
            showEdit();
            showNotice('新しい緊急カードを作成します。入力すると、下にNFCタグ用のURLが自動で作られます。');
        }
    });

    // ---------- 画面切り替え ----------
    function showView() {
        renderView();
        $('viewMode').classList.remove('hidden');
        $('editMode').classList.add('hidden');
        $('toggleModeBtn').classList.remove('hidden');
        $('toggleModeBtn').textContent = '編集する';
    }

    function showEdit() {
        populateForm();
        $('viewMode').classList.add('hidden');
        $('editMode').classList.remove('hidden');
        $('toggleModeBtn').classList.remove('hidden');
        $('toggleModeBtn').textContent = 'プレビュー';
        updateOutput();
    }

    function toggleMode() {
        if ($('editMode').classList.contains('hidden')) {
            showEdit();
        } else {
            current = readForm();
            showView();
        }
        window.scrollTo(0, 0);
    }

    function showNotice(msg, isError) {
        const el = $('systemNotice');
        el.textContent = msg;
        el.classList.toggle('error', !!isError);
        el.classList.remove('hidden');
    }

    // ---------- 閲覧画面 ----------
    function formatPhone(p) {
        const d = String(p || '').replace(/[^0-9]/g, '');
        if (/^0[5789]0\d{8}$/.test(d)) return d.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
        if (/^0[36]\d{8}$/.test(d)) return d.replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3');
        return p;
    }

    function telHref(p) {
        const d = String(p || '').replace(/[^0-9+]/g, '');
        return d ? 'tel:' + d : '#';
    }

    function renderView() {
        const d = current;
        $('view-guardian-name').textContent = d.guardianName || '未登録';
        $('view-guardian-phone').textContent = d.guardianPhone ? formatPhone(d.guardianPhone) : '未登録';
        $('view-guardian-phone-link').href = telHref(d.guardianPhone);
        $('view-hospital-name').textContent = d.hospitalName || '未登録';
        $('view-hospital-phone').textContent = d.hospitalPhone ? formatPhone(d.hospitalPhone) : '未登録';
        $('view-hospital-phone-link').href = telHref(d.hospitalPhone);
        $('view-symptoms-text').textContent = d.symptomsText || '（記載なし）';
        $('view-medicine-location').textContent = d.medicineLocation || '指定なし（本人の所持品をご確認ください）';
        $('view-response-step3').textContent = d.responseStep3 || '（記載なし）';

        const list = $('view-allergy-list');
        list.textContent = '';
        if (d.allergies.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-notice';
            empty.textContent = 'アレルギー情報が未登録です。';
            list.appendChild(empty);
            return;
        }
        const badges = { severe: ['badge-severe', '重度'], moderate: ['badge-moderate', '中等度'], mild: ['badge-mild', '軽度'] };
        d.allergies.forEach((item) => {
            const level = badges[item.level] ? item.level : 'mild';
            const box = document.createElement('div');
            box.className = 'allergy-item ' + level;

            const header = document.createElement('div');
            header.className = 'allergy-header';
            const name = document.createElement('span');
            name.className = 'allergy-name';
            name.textContent = item.name;               // 必ずtextContentで入れる(HTMLとして解釈させない)
            const badge = document.createElement('span');
            badge.className = 'badge ' + badges[level][0];
            badge.textContent = badges[level][1];
            header.appendChild(name);
            header.appendChild(badge);
            box.appendChild(header);

            if (item.note) {
                const note = document.createElement('div');
                note.className = 'allergy-note';
                note.textContent = item.note;
                box.appendChild(note);
            }
            list.appendChild(box);
        });
    }

    // ---------- 入力フォーム ----------
    function buildAllergenList() {
        // 候補に出す名前が「定義済みアレルゲン」と完全一致すると、URLが短く(1項目 約3文字)なる
        const dl = document.createElement('datalist');
        dl.id = 'allergen-list';
        C.PRESETS.forEach((n) => {
            const o = document.createElement('option');
            o.value = n;
            dl.appendChild(o);
        });
        document.body.appendChild(dl);
    }

    function addAllergyField(name, level, note) {
        const div = document.createElement('div');
        div.className = 'dynamic-item';

        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn-remove';
        rm.textContent = '削除';
        div.appendChild(rm);

        const g1 = document.createElement('div');
        g1.className = 'form-group mb-8';
        const l1 = document.createElement('label');
        l1.textContent = 'アレルゲン(候補から選ぶと容量を節約できます)';
        const i1 = document.createElement('input');
        i1.type = 'text';
        i1.className = 'form-control item-name';
        i1.maxLength = 50;
        i1.setAttribute('list', 'allergen-list');
        i1.placeholder = '例: 卵、落花生、乳';
        i1.value = name || '';
        g1.appendChild(l1);
        g1.appendChild(i1);

        const g2 = document.createElement('div');
        g2.className = 'form-group mb-8';
        const l2 = document.createElement('label');
        l2.textContent = '重症度';
        const sel = document.createElement('select');
        sel.className = 'form-control item-level';
        [['severe', '重度（アナフィラキシー注意）'], ['moderate', '中等度（症状が出る場合あり）'], ['mild', '軽度']].forEach((p) => {
            const o = document.createElement('option');
            o.value = p[0];
            o.textContent = p[1];
            sel.appendChild(o);
        });
        sel.value = ['severe', 'moderate', 'mild'].indexOf(level) >= 0 ? level : 'severe';
        g2.appendChild(l2);
        g2.appendChild(sel);

        const g3 = document.createElement('div');
        g3.className = 'form-group mb-0';
        const l3 = document.createElement('label');
        l3.textContent = '条件・注意事項(省略可)';
        const i3 = document.createElement('input');
        i3.type = 'text';
        i3.className = 'form-control item-note';
        i3.maxLength = 200;
        i3.placeholder = '例: 微量でも不可';
        i3.value = note || '';
        g3.appendChild(l3);
        g3.appendChild(i3);

        div.appendChild(g1);
        div.appendChild(g2);
        div.appendChild(g3);
        $('edit-allergy-container').appendChild(div);
    }

    function populateForm() {
        const d = current;
        $('edit-guardian-name').value = d.guardianName;
        $('edit-guardian-phone').value = d.guardianPhone;
        $('edit-hospital-name').value = d.hospitalName;
        $('edit-hospital-phone').value = d.hospitalPhone;
        $('edit-symptoms-text').value = d.symptomsText;
        $('edit-medicine-location').value = d.medicineLocation;
        $('edit-response-step3').value = d.responseStep3;
        $('edit-allergy-container').textContent = '';
        if (d.allergies.length) d.allergies.forEach((a) => addAllergyField(a.name, a.level, a.note));
        else addAllergyField();
    }

    function readForm() {
        const allergies = [];
        document.querySelectorAll('#edit-allergy-container .dynamic-item').forEach((node) => {
            const name = node.querySelector('.item-name').value.trim();
            if (!name) return;
            allergies.push({
                name: name,
                level: node.querySelector('.item-level').value,
                note: node.querySelector('.item-note').value.trim()
            });
        });
        return {
            guardianName: $('edit-guardian-name').value.trim(),
            guardianPhone: $('edit-guardian-phone').value.trim(),
            hospitalName: $('edit-hospital-name').value.trim(),
            hospitalPhone: $('edit-hospital-phone').value.trim(),
            allergies: allergies,
            symptomsText: $('edit-symptoms-text').value.trim(),
            medicineLocation: $('edit-medicine-location').value.trim(),
            responseStep3: $('edit-response-step3').value.trim()
        };
    }

    // ---------- URLの生成とNFC書き込み ----------
    function baseUrl() {
        return location.origin + location.pathname.replace(/index\.html$/, '');
    }

    function scheduleUpdate() {
        clearTimeout(timer);
        timer = setTimeout(updateOutput, 150);
    }

    async function updateOutput() {
        const mine = ++seq;
        const payload = await C.encode(readForm());
        if (mine !== seq) return;   // 古い計算結果は捨てる

        const url = baseUrl() + '#' + payload;
        const bytes = C.estimateTagBytes(url);
        const left = tagLimit - bytes;
        const over = left < 0;
        const warn = !over && left < 12;

        $('urlOut').value = url;
        const meter = $('meter');
        meter.max = tagLimit;
        meter.value = Math.min(bytes, tagLimit);
        meter.className = over ? 'over' : (warn ? 'warn' : '');

        const text = $('meterText');
        text.className = 'meter-text' + (over ? ' over' : (warn ? ' warn' : ''));
        if (over) text.textContent = '約' + bytes + 'バイト → ' + (-left) + 'バイト超過しています。メモを短くするか、項目を減らしてください。';
        else if (warn) text.textContent = '約' + bytes + ' / ' + tagLimit + 'バイト(余裕が少ないです。書き込みアプリによっては入らないことがあります)';
        else text.textContent = '約' + bytes + ' / ' + tagLimit + 'バイト(あと約' + left + 'バイト)';

        $('nfcBtn').disabled = over;
        $('outNotice').textContent = location.protocol === 'https:'
            ? ''
            : '※ https:// で公開したページから作ったURLを使ってください(いまのページは https ではありません)。';
    }

    async function copyUrl() {
        const url = $('urlOut').value;
        try {
            await navigator.clipboard.writeText(url);
            $('outNotice').textContent = 'コピーしました。NFC Toolsなどのアプリに貼り付けて書き込めます。';
        } catch (e) {
            $('urlOut').select();
            $('outNotice').textContent = 'URLを選択しました。コピーしてください。';
        }
    }

    async function writeNfc() {
        if (!('NDEFReader' in window)) {
            $('outNotice').textContent = 'この端末のブラウザはWeb NFCに対応していません。Android版Chromeで開くか、URLをコピーしてNFC Toolsなどのアプリで書き込んでください。';
            return;
        }
        try {
            $('outNotice').textContent = 'スマホの背面をNFCタグにかざしてください…';
            const ndef = new NDEFReader();
            await ndef.write({ records: [{ recordType: 'url', data: $('urlOut').value }] });
            $('outNotice').textContent = '書き込みました。読み取りを確認してから、必要ならタグをロックしてください。';
        } catch (e) {
            $('outNotice').textContent = '書き込めませんでした: ' + (e && e.message ? e.message : e);
        }
    }
})();
