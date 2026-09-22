import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from './config.js';

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const EMOJIS = ['🙂','😎','🦊','🐻','🐼','🦉','🐸','🐙','🌟','⚡','🍕','🎧'];
const SOUNDS = { bell:'Bell', chime:'Chime', alarm:'Alarm', arcade:'Arcade', knock:'Knock', whistle:'Whistle' };
const ACCENTS = {
  coral:  ['#E8503A','#FF7A66'],
  ocean:  ['#1B6FB8','#5BAEEA'],
  forest: ['#2E7D4F','#63C68C'],
  grape:  ['#7A3FB5','#B98BE8'],
  amber:  ['#D98A00','#FFBE4D'],
  rose:   ['#C2306C','#F37BA9'],
};

// A call rings this long, unless it is answered sooner.
const CALL_SECONDS = 20;
// A ping older than this never rings - it is a missed call. A little over the
// call, so a phone clock a few seconds off still rings.
const FRESH_SECONDS = 30;

const S = {
  family: null,
  members: [],
  me: null,
  replies: new Map(),
  excluded: new Set(JSON.parse(localStorage.getItem('excluded') || '[]')),
  emoji: EMOJIS[0],
  audio: null,
  ringTimer: null,
};

// -- tiny helpers ------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $(id).classList.remove('hidden');
};

/** iOS only delivers push to a web app that lives on the Home Screen. */
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const isAndroid = () => /Android/i.test(navigator.userAgent);

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function applyTheme() {
  const mode = localStorage.getItem('theme') || 'auto';
  const dark = mode === 'dark' ||
    (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';

  const key = localStorage.getItem('accent') || 'coral';
  const [light, darkC] = ACCENTS[key] || ACCENTS.coral;
  document.documentElement.style.setProperty('--accent', dark ? darkC : light);
}

function saveExcluded() {
  localStorage.setItem('excluded', JSON.stringify([...S.excluded]));
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// -- ringing -----------------------------------------------------------------

function startRing() {
  stopRing();
  const key = S.me?.sound_key || 'bell';
  S.audio = new Audio(`./sounds/${key}.wav`);
  S.audio.loop = true;
  S.audio.volume = 1;
  // Fails silently if the browser has not seen a user gesture yet; the
  // notification itself still fired, so the phone has already made a noise.
  S.audio.play().catch(() => {});
  if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 600]);
  S.ringTimer = setTimeout(endCall, CALL_SECONDS * 1000);
}

function stopRing() {
  clearTimeout(S.ringTimer);
  S.ringTimer = null;
  if (S.audio) {
    S.audio.pause();
    S.audio = null;
  }
  if (navigator.vibrate) navigator.vibrate(0);
}

/** The call is over here - answered, stopped, or its 20 seconds are up. */
function endCall() {
  stopRing();
  currentPingId = null;
  if (!$('incoming').classList.contains('hidden')) {
    renderMembers();
    show('home');
  }
}

/** First answer wins, like the apps: a second one for the same call is ignored. */
async function sendAnswer(pingId, kind) {
  if (!S.me) return;
  const { error } = await db.from('ping_responses').upsert(
    { ping_id: pingId, member_id: S.me.id, response: kind },
    { ignoreDuplicates: true },
  );
  if (error) alert('Could not send your answer. Check the internet.');
}

function previewSound(key) {
  const a = new Audio(`./sounds/${key}.wav`);
  a.play().catch(() => {});
}

// -- data --------------------------------------------------------------------

async function loadAll() {
  const { data: fams } = await db.from('families').select().limit(1);
  S.family = fams && fams.length ? fams[0] : null;
  if (!S.family) { S.members = []; S.me = null; return; }

  const { data: mem } = await db.from('members').select().order('created_at');
  S.members = mem || [];
  const uid = (await db.auth.getUser()).data.user?.id;
  S.me = S.members.find((m) => m.user_id === uid) || null;
}

async function joinFamily() {
  const nickname = $('nickname').value.trim();
  const code = $('code').value.trim().toUpperCase();
  const btn = $('join-btn');
  const err = $('join-error');

  btn.disabled = true;
  err.classList.add('hidden');

  try {
    await db.auth.signInAnonymously();
    const { error } = await db.rpc('join_family', {
      p_code: code, p_nickname: nickname, p_emoji: S.emoji,
    });
    if (error) throw error;
    await start();
  } catch (e) {
    err.textContent = String(e.message || e).includes('no_such_code')
      ? 'That code did not match any family. Check it and try again.'
      : 'Could not connect. Check your internet and try again.';
    err.classList.remove('hidden');
    btn.disabled = false;
  }
}

// -- push --------------------------------------------------------------------

async function setupPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (VAPID_PUBLIC_KEY.startsWith('PASTE')) return;

  const reg = await navigator.serviceWorker.register('./sw.js');
  await navigator.serviceWorker.ready;

  if (Notification.permission === 'default') {
    const res = await Notification.requestPermission();
    if (res !== 'granted') return;
  }
  if (Notification.permission !== 'granted') return;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  await db.from('members').update({
    web_push_sub: sub.toJSON(),
    platform: 'ios_web',
    last_seen_at: new Date().toISOString(),
  }).eq('id', S.me.id);
}

// The service worker forwards Coming / Busy taps here.
navigator.serviceWorker?.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.kind === 'answer' && d.ping_id && d.answer) {
    endCall();
    sendAnswer(d.ping_id, d.answer);
  }
});

// -- realtime ----------------------------------------------------------------

let currentPingId = null;

// Someone else's call while it lasts. The home screen shows who is calling to the
// whole family, not only to the people being rung.
let liveCall = null;

function showLiveCall(ping, sender) {
  liveCall = {
    id: ping.id,
    targets: ping.target_ids || [],
    name: sender?.nickname || 'Someone',
    emoji: sender?.emoji || '📣',
    until: new Date(ping.created_at).getTime() + CALL_SECONDS * 1000,
  };
  renderMembers();
  setTimeout(renderMembers, Math.max(0, liveCall.until - Date.now()) + 100);
}

/** Live until everyone called has answered, or its 20 seconds are up. */
function callIsLive() {
  if (!liveCall || Date.now() >= liveCall.until) return false;
  return !liveCall.targets.every((id) => S.replies.get(id)?.ping_id === liveCall.id);
}

function subscribe() {
  db.channel('familyping-web')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pings' }, async (p) => {
      const ping = p.new;
      if (ping.sender_id === S.me?.id) return;
      // A ping that arrived late is a missed call, not a ring.
      if ((Date.now() - new Date(ping.created_at).getTime()) / 1000 > FRESH_SECONDS) return;

      // Someone who only just joined may not be in the list yet.
      if (!S.members.some((m) => m.id === ping.sender_id)) await loadAll();
      const sender = S.members.find((m) => m.id === ping.sender_id);
      S.replies.clear();
      showLiveCall(ping, sender);

      if (!(ping.target_ids || []).includes(S.me?.id)) return;
      currentPingId = ping.id;
      $('caller').textContent = sender ? sender.nickname : 'Someone';
      // Missing while a phone still shows the previous, cached page: it keeps 📣.
      const face = $('caller-emoji');
      if (face) face.textContent = sender?.emoji || '📣';
      show('incoming');
      startRing();
    })
    // All events, like the apps: an answer can also be updated.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ping_responses' }, (p) => {
      const r = p.new;
      if (!r || !r.member_id) return;
      S.replies.set(r.member_id, r);
      renderMembers();
      // Answers disappear after a minute, unless a newer one replaced this one.
      setTimeout(() => {
        if (S.replies.get(r.member_id) !== r) return;
        S.replies.delete(r.member_id);
        renderMembers();
      }, 60000);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'members' }, async () => {
      await loadAll();
      renderMembers();
    })
    .subscribe();
}

// -- rendering ---------------------------------------------------------------

function targets() {
  return S.members.filter((m) => m.id !== S.me?.id && !S.excluded.has(m.id));
}

function renderMembers() {
  const ul = $('members');
  const others = S.members.filter((m) => m.id !== S.me?.id);
  ul.innerHTML = '';

  if (!others.length) {
    ul.innerHTML = `<li><div class="who">Nobody else has joined yet
      <small>Share the code ${S.family?.code || ''}</small></div></li>`;
  }

  for (const m of others) {
    const on = !S.excluded.has(m.id);
    const reply = S.replies.get(m.id);
    const li = document.createElement('li');
    if (!on) li.className = 'off';
    li.innerHTML = `
      <input type="checkbox" ${on ? 'checked' : ''} aria-label="Call ${m.nickname}">
      <span style="font-size:24px">${m.emoji || '🙂'}</span>
      <div class="who">${m.nickname}${on ? '' : '<small>Will not be called</small>'}</div>
      ${reply ? `<span class="chip ${reply.response}">${reply.response === 'coming' ? 'Coming' : 'Busy'}</span>` : ''}`;
    li.onclick = () => {
      S.excluded.has(m.id) ? S.excluded.delete(m.id) : S.excluded.add(m.id);
      saveExcluded();
      renderMembers();
    };
    ul.appendChild(li);
  }

  const n = targets().length;
  $('target-count').textContent = callIsLive()
    ? `${liveCall.emoji} ${liveCall.name} is calling...`
    : n === 0 ? 'Nobody to call yet' : n === 1 ? 'Calls 1 person' : `Calls ${n} people`;
  $('call').disabled = n === 0;
  $('family-name').textContent = S.family?.name || 'Family';
}

function renderSettings() {
  $('set-nickname').value = S.me?.nickname || '';
  $('family-code').textContent = S.family?.code || '';

  $('sound-note').textContent = isIOS()
    ? 'On iPhone the notification itself uses the iPhone sound. This ring plays when the app is open.'
    : 'This is what your device plays when someone calls.';

  $('sound-list').innerHTML = '';
  for (const [key, label] of Object.entries(SOUNDS)) {
    const row = document.createElement('div');
    row.className = 'sound-row';
    row.innerHTML = `
      <input type="radio" name="sound" ${S.me?.sound_key === key ? 'checked' : ''}>
      <label>${label}</label>
      <button aria-label="Hear ${label}">▶️</button>`;
    row.querySelector('input').onchange = async () => {
      await db.from('members').update({ sound_key: key }).eq('id', S.me.id);
      S.me.sound_key = key;
      previewSound(key);
    };
    row.querySelector('button').onclick = (e) => { e.stopPropagation(); previewSound(key); };
    $('sound-list').appendChild(row);
  }

  const mode = localStorage.getItem('theme') || 'auto';
  for (const b of document.querySelectorAll('#theme-seg button')) {
    b.setAttribute('aria-pressed', String(b.dataset.theme === mode));
    b.onclick = () => { localStorage.setItem('theme', b.dataset.theme); applyTheme(); renderSettings(); };
  }

  const acc = localStorage.getItem('accent') || 'coral';
  $('accents').innerHTML = '';
  for (const [key, [light]] of Object.entries(ACCENTS)) {
    const b = document.createElement('button');
    b.style.background = light;
    b.setAttribute('aria-pressed', String(key === acc));
    b.setAttribute('aria-label', key);
    b.onclick = () => { localStorage.setItem('accent', key); applyTheme(); renderSettings(); };
    $('accents').appendChild(b);
  }

  renderEmojiRow('set-emoji-row', S.me?.emoji, async (e) => {
    await db.from('members').update({ emoji: e }).eq('id', S.me.id);
    S.me.emoji = e;
    renderSettings();
  });
}

function renderEmojiRow(containerId, selected, onPick) {
  const row = $(containerId);
  row.innerHTML = '';
  for (const e of EMOJIS) {
    const b = document.createElement('button');
    b.textContent = e;
    b.setAttribute('aria-pressed', String(e === selected));
    b.onclick = () => onPick(e);
    row.appendChild(b);
  }
}

// -- actions -----------------------------------------------------------------

async function sendPing() {
  const btn = $('call');
  btn.disabled = true;
  try {
    S.replies.clear();
    const { error } = await db.functions.invoke('send_ping', {
      body: { exclude: [...S.excluded] },
    });
    if (error) throw error;
  } catch (e) {
    alert('Could not send the call. Check your internet.');
  } finally {
    setTimeout(() => { btn.disabled = targets().length === 0; }, 1200);
  }
}

async function answer(kind) {
  const pingId = currentPingId;
  endCall();
  if (pingId) await sendAnswer(pingId, kind);
}

// -- wiring ------------------------------------------------------------------

function wireUp() {
  $('join-btn').onclick = joinFamily;
  $('android-web').onclick = () => { sessionStorage.setItem('android-web', '1'); start(); };
  $('call').onclick = sendPing;
  $('coming-btn').onclick = () => answer('coming');
  $('busy-btn').onclick = () => answer('busy');
  $('stop-btn').onclick = endCall;
  $('settings-btn').onclick = () => { renderSettings(); show('settings'); };
  $('back-btn').onclick = () => { renderMembers(); show('home'); };

  $('set-nickname').onchange = async (e) => {
    const v = e.target.value.trim();
    if (!v) return;
    await db.from('members').update({ nickname: v }).eq('id', S.me.id);
    S.me.nickname = v;
  };

  $('leave-btn').onclick = async () => {
    if (!confirm('Leave this family? You will stop getting calls.')) return;
    await db.rpc('leave_family');
    localStorage.clear();
    location.reload();
  };

  const enable = () => {
    $('join-btn').disabled =
      $('nickname').value.trim().length === 0 || $('code').value.trim().length < 6;
  };
  $('nickname').oninput = enable;
  $('code').oninput = (e) => { e.target.value = e.target.value.toUpperCase(); enable(); };

  const pickJoinEmoji = (e) => {
    S.emoji = e;
    renderEmojiRow('emoji-row', S.emoji, pickJoinEmoji);
  };
  renderEmojiRow('emoji-row', S.emoji, pickJoinEmoji);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

// -- start -------------------------------------------------------------------

async function start() {
  applyTheme();

  if (SUPABASE_URL.startsWith('PASTE')) {
    document.body.innerHTML =
      '<div class="screen"><h1>Not configured</h1><p>Open config.js and paste the ' +
      'Supabase values from SETUP-2-ACCOUNTS.md.</p></div>';
    return;
  }

  // Android gets offered the native app, which can ring through silent mode.
  if (isAndroid() && !isStandalone() && sessionStorage.getItem('android-web') !== '1') {
    show('android');
    return;
  }

  // iOS refuses to deliver push to a browser tab, only to a Home Screen app.
  if (isIOS() && !isStandalone()) {
    show('install');
    return;
  }

  const { data: sess } = await db.auth.getSession();
  if (!sess.session) await db.auth.signInAnonymously();

  await loadAll();

  if (!S.family || !S.me) {
    show('join');
    return;
  }

  await db.from('members').update({
    platform: 'ios_web',
    last_seen_at: new Date().toISOString(),
  }).eq('id', S.me.id);

  renderMembers();
  show('home');
  subscribe();
  setupPush().catch((e) => console.warn('push setup failed', e));

  // Answer arriving from a notification tap that cold-started the app.
  const params = new URLSearchParams(location.search);
  const a = params.get('answer');
  const pid = params.get('ping');
  if (a && pid) {
    await sendAnswer(pid, a);
    history.replaceState({}, '', location.pathname);
  }
}

wireUp();
start().catch((e) => {
  console.error(e);
  document.body.innerHTML =
    '<div class="screen"><h1>Something went wrong</h1><p>' + String(e.message || e) + '</p></div>';
});
