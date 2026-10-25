'use strict';
const $ = (s, scope = document) => scope.querySelector(s);
const $$ = (s, scope = document) => [...scope.querySelectorAll(s)];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const menu = $('.menu-toggle');
menu.addEventListener('click', () => {
  const expanded = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(expanded));
  menu.setAttribute('aria-label', expanded ? 'メニューを閉じる' : 'メニューを開く');
  $('#mobile-nav').hidden = !expanded;
});
$$('#mobile-nav a').forEach((a) =>
  a.addEventListener('click', () => {
    $('#mobile-nav').hidden = true;
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', 'メニューを開く');
  }),
);
const gallery = $('.moment-gallery');
function moveGallery(direction) {
  const distance = $('.moment-card').getBoundingClientRect().width + 15;
  const end = gallery.scrollWidth - gallery.clientWidth;
  const current = gallery.scrollLeft;
  const target =
    direction > 0 && current >= end - 2
      ? 0
      : direction < 0 && current <= 2
        ? end
        : current + distance * direction;
  gallery.scrollTo({ left: target, behavior: reducedMotion ? 'instant' : 'smooth' });
}
$('.gallery-prev').addEventListener('click', () => moveGallery(-1));
$('.gallery-next').addEventListener('click', () => moveGallery(1));
const updateGallery = () => {
  const overflow = gallery.scrollWidth > gallery.clientWidth + 2;
  $('.gallery-prev').hidden = !overflow;
  $('.gallery-next').hidden = !overflow;
};
new ResizeObserver(updateGallery).observe(gallery);
$$('[data-close]').forEach((button) =>
  button.addEventListener('click', () => button.closest('dialog').close()),
);
$$('dialog').forEach((dialog) =>
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (
        e.clientX < bounds.left ||
        e.clientX > bounds.right ||
        e.clientY < bounds.top ||
        e.clientY > bounds.bottom
      )
        dialog.close();
    }
  }),
);
$$('[data-photo]').forEach((button) =>
  button.addEventListener('click', () => {
    $('#photo-preview').src = '/assets/' + button.dataset.photo + '-960.webp';
    $('#photo-preview').alt = $('img', button).alt;
    $('#photo-title').textContent = button.dataset.caption;
    $('#photo-dialog').showModal();
  }),
);
const cameraModes = {
  photo: ['写真', '見た景色を、撮影した画質のまま。対応端末ではHEIF・RAW・HDR写真にも対応します。'],
  video: [
    '動画 · 最大60秒',
    '動きも、声も、そのまま残そう。最大60秒の音声付き動画を、インカメラ・アウトカメラで撮影できます。写真は機能のイメージです。',
  ],
  selfie: [
    'インカメラ',
    '笑った顔も、何気ない表情も。インカメラでも、写真と最大60秒の音声付き動画を撮影できます。',
  ],
};
function selectMode(button) {
  $$('[role=tab]').forEach((tab) => {
    const selected = tab === button;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  const mode = button.dataset.mode;
  $('#camera-panel').dataset.mode = mode;
  $('#camera-panel').setAttribute('aria-labelledby', button.id);
  $('#camera-indicator').textContent = cameraModes[mode][0];
  $('#camera-description').textContent = cameraModes[mode][1];
}
$$('[role=tab]').forEach((button, index, buttons) => {
  button.addEventListener('click', () => selectMode(button));
  button.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? buttons.length - 1
          : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    selectMode(buttons[next]);
    buttons[next].focus();
  });
});
const signup = $('#signup-dialog');
let cancellationToken = '';
$$('[data-signup]').forEach((button) => button.addEventListener('click', () => signup.showModal()));
async function sendRegistration(method, body) {
  const response = await fetch('/public/early-access', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result?.error?.message || '受け付けできませんでした。時間をおいてお試しください。',
    );
  return result;
}
$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget,
    button = $('.signup-submit');
  if (button.disabled || !form.reportValidity()) return;
  const data = new FormData(form);
  button.disabled = true;
  $('#signup-message').textContent = '登録しています…';
  try {
    const result = await sendRegistration('POST', {
      email: data.get('email'),
      platform: data.get('platform'),
      consent: data.get('consent') === 'on',
      website: data.get('website'),
    });
    if (!result.accepted || !/^[A-Za-z0-9_-]{43}$/.test(result.cancellationToken))
      throw new Error('登録結果を確認できませんでした。時間をおいてお試しください。');
    cancellationToken = result.cancellationToken;
    $('.dialog-form-view').hidden = true;
    $('.dialog-success-view').hidden = false;
    signup.setAttribute('aria-labelledby', 'signup-success-title');
    form.reset();
    $('#save-registration').focus();
  } catch (error) {
    $('#signup-message').textContent =
      error instanceof TypeError
        ? '通信できませんでした。接続を確認して、もう一度お試しください。'
        : error.message;
  } finally {
    button.disabled = false;
  }
});
$('#save-registration').addEventListener('click', () => {
  if (!cancellationToken) return;
  const url = location.origin + '/#cancel=' + cancellationToken;
  const content =
    'JustTaken 先行案内の登録控え\n\n登録を取り消す場合は、次のリンクを開いてください。\n' +
    url +
    '\n\nこのリンクを知る人は登録を取り消すことができます。大切に保管してください。\n同じメールアドレスで再度登録した場合、初回の登録控えが引き続き有効です。\n登録情報の保存期間は180日です。\n';
  const blob = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = blob;
  a.download = 'JustTaken-先行登録の控え.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(blob), 30000);
});
let cancelToken = '';
function openCancellation() {
  if (!location.hash.startsWith('#cancel=')) return;
  const value = location.hash.slice(8);
  history.replaceState(null, '', location.pathname + location.search);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    $('#cancel-message').textContent =
      '取り消しリンクが正しくありません。登録控えのリンク全体を確認してください。';
    $('#cancel-registration').disabled = true;
  } else {
    cancelToken = value;
    $('#cancel-registration').disabled = false;
    $('#cancel-message').textContent = '';
  }
  $('#cancel-dialog').showModal();
}
addEventListener('hashchange', openCancellation);
openCancellation();
$('#cancel-registration').addEventListener('click', async (e) => {
  if (!cancelToken) return;
  const button = e.currentTarget;
  button.disabled = true;
  $('#cancel-message').textContent = '取り消しています…';
  try {
    const result = await sendRegistration('DELETE', { cancellationToken: cancelToken });
    if (!result.cancelled) throw new Error('結果を確認できませんでした。もう一度お試しください。');
    $('#cancel-message').textContent =
      '取り消しを受け付けました。このリンクに対応する登録情報があった場合、削除されました。';
    button.hidden = true;
    cancelToken = '';
  } catch (error) {
    $('#cancel-message').textContent =
      error instanceof TypeError
        ? '通信できませんでした。接続を確認して、もう一度お試しください。'
        : error.message;
    button.disabled = false;
  }
});

// This LP demonstration is separate from the app's device preference.
const watermarkToggle = $('#watermark-toggle');
const watermarkKey = 'justtaken.lp.watermark.v1';
function showWatermark(enabled) {
  watermarkToggle.setAttribute('aria-checked', String(enabled));
  $('#watermark-state').textContent = enabled ? 'オン' : 'オフ';
  $$('[data-watermark]').forEach((mark) => {
    mark.hidden = !enabled;
  });
}
try {
  showWatermark(localStorage.getItem(watermarkKey) !== 'off');
} catch {
  $('#watermark-storage-note').textContent =
    'このブラウザでは表示設定を保存できません。このページ内で切り替えられます。';
}
watermarkToggle.addEventListener('click', () => {
  const enabled = watermarkToggle.getAttribute('aria-checked') !== 'true';
  showWatermark(enabled);
  try {
    localStorage.setItem(watermarkKey, enabled ? 'on' : 'off');
  } catch {
    $('#watermark-storage-note').textContent =
      '表示を切り替えました。ブラウザに設定を保存できなかったため、再読み込みすると元に戻ります。';
  }
});
