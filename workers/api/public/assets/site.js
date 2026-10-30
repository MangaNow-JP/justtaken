'use strict';
// No innerHTML or string-to-code sinks: the page is served with Trusted Types enforced.
const $ = (s, scope = document) => scope.querySelector(s);
const $$ = (s, scope = document) => [...scope.querySelectorAll(s)];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

// Header: border once the page scrolls, and the section in view marked in the nav.
const header = $('.site-header');
const markScrolled = () => header.toggleAttribute('data-scrolled', scrollY > 8);
addEventListener('scroll', markScrolled, { passive: true });
markScrolled();
const navLinks = $$('.desktop-nav a');
if ('IntersectionObserver' in window) {
  const sections = navLinks.map((a) => $(a.hash)).filter(Boolean);
  const visible = new Map();
  const spy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
      const current = sections.find((section) => visible.get(section.id));
      for (const a of navLinks) {
        if (current && a.hash === '#' + current.id) a.setAttribute('aria-current', 'location');
        else a.removeAttribute('aria-current');
      }
    },
    { rootMargin: '-35% 0px -60% 0px' },
  );
  sections.forEach((section) => spy.observe(section));
}

const menu = $('.menu-toggle');
const mobileNav = $('#mobile-nav');
function setMenu(open) {
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? 'メニューを閉じる' : 'メニューを開く');
  mobileNav.hidden = !open;
}
menu.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'));
$$('a', mobileNav).forEach((a) => a.addEventListener('click', () => setMenu(false)));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !mobileNav.hidden) {
    setMenu(false);
    menu.focus();
  }
});
addEventListener('click', (e) => {
  if (!mobileNav.hidden && !header.contains(e.target)) setMenu(false);
});
matchMedia('(min-width: 1024px)').addEventListener('change', (e) => e.matches && setMenu(false));

const gallery = $('.moment-gallery');
function moveGallery(direction) {
  const distance = $('.moment-card').getBoundingClientRect().width + 16;
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
    if (e.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      e.clientX < bounds.left ||
      e.clientX > bounds.right ||
      e.clientY < bounds.top ||
      e.clientY > bounds.bottom
    )
      dialog.close();
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
  photo: [
    '写真',
    '見た景色を、撮影した画質のまま残せます。対応端末なら、HEIF・RAW・HDR写真も撮影できます。',
  ],
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
function openSignup() {
  setMenu(false);
  signup.showModal();
  if (!$('.dialog-form-view').hidden) $('#signup-email').focus();
}
$$('[data-signup]').forEach((button) => button.addEventListener('click', openSignup));
// The closing form only carries the address into the full form; it never submits by itself.
$('#closing-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = $('#closing-email');
  if (!email.reportValidity()) return;
  openSignup();
  if ($('.dialog-form-view').hidden) return;
  $('#signup-email').value = email.value.trim();
  $('#signup-form input[name=platform]:checked').focus();
});

const failure = '受け付けられませんでした。時間をおいてお試しください。';
const offline = '通信できませんでした。接続を確認して、もう一度お試しください。';
async function sendRegistration(method, body) {
  const response = await fetch('/public/early-access', {
    method,
    mode: 'same-origin',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout?.(20000),
  });
  // A proxy error page is not JSON; never show a parser message to visitors.
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const message = result?.error?.message;
    throw new Error(typeof message === 'string' && message ? message : failure);
  }
  return result;
}
const errorMessage = (error) =>
  error instanceof TypeError || error?.name === 'TimeoutError' || error?.name === 'AbortError'
    ? offline
    : error?.message || failure;
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
      email: String(data.get('email')).trim(),
      platform: data.get('platform'),
      consent: data.get('consent') === 'on',
      website: data.get('website'),
    });
    if (!result.accepted || !tokenPattern.test(result.cancellationToken))
      throw new Error('登録結果を確認できませんでした。時間をおいてお試しください。');
    cancellationToken = result.cancellationToken;
    $('#signup-message').textContent = '';
    $('.dialog-form-view').hidden = true;
    $('.dialog-success-view').hidden = false;
    signup.setAttribute('aria-labelledby', 'signup-success-title');
    form.reset();
    $('#closing-form').reset();
    $('#save-registration').focus();
  } catch (error) {
    $('#signup-message').textContent = errorMessage(error);
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
  // Remove the secret from the address bar and history before anything else happens.
  history.replaceState(null, '', location.pathname + location.search);
  if (!tokenPattern.test(value)) {
    $('#cancel-message').textContent =
      '取り消しリンクが正しくありません。登録控えのリンク全体を確認してください。';
    $('#cancel-registration').disabled = true;
  } else {
    cancelToken = value;
    $('#cancel-registration').disabled = false;
    $('#cancel-registration').hidden = false;
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
    $('#cancel-message').textContent = errorMessage(error);
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
