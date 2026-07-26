'use strict';

// Home / lobby. Instant guest session — no login wall.
// The arena itself lives in game.js (window.BountyGame).

const $ = (sel) => document.querySelector(sel);
const money = (cents) => `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

const state = { user: null };

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function show(screen) {
  for (const el of document.querySelectorAll('.screen')) el.classList.add('hidden');
  const target = $(`#screen-${screen}`);
  if (target) target.classList.remove('hidden');
}

function authError(msg) {
  const el = $('#auth-error');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

// ---------- guest session ----------

async function ensureSession(forceNew = false) {
  if (!forceNew) {
    try {
      const { user } = await api('/api/me');
      state.user = user;
      return user;
    } catch { /* create guest */ }
  }
  const { user } = await api('/api/guest', {
    method: 'POST',
    body: JSON.stringify({ username: localStorage.getItem('bounty.callsign') || '' }),
  });
  state.user = user;
  try { localStorage.setItem('bounty.callsign', user.username); } catch {}
  return user;
}

// ---------- home ----------

let lobbyTimer = null;

function enterLobby() {
  show('lobby');
  renderUser();
  refreshLobby();
  clearInterval(lobbyTimer);
  lobbyTimer = setInterval(refreshArenaStatus, 4000);
}

function leaveLobbyTimers() { clearInterval(lobbyTimer); }

function renderUser() {
  const u = state.user;
  if (!u) return;
  const nameEl = $('#lobby-user');
  if (nameEl) nameEl.textContent = u.username;
  const eloEl = $('#home-elo');
  if (eloEl) eloEl.textContent = `ELO ${u.elo}`;
  const av = $('#home-avatar');
  if (av) av.textContent = (u.username || '?').slice(0, 1).toUpperCase();
  const bal = $('#lobby-balance');
  if (bal) bal.textContent = money(u.balance);
  const mode = $('#payments-mode');
  if (mode) mode.textContent = u.paymentsMode || 'sandbox';
  const play = $('#btn-play');
  if (play) {
    play.disabled = false;
    play.innerHTML = `JOIN MATCH <span class="cta-arrow">→</span>`;
  }
}

async function refreshLobby() {
  await Promise.all([
    refreshMe(),
    refreshProfile(),
    refreshArenaStatus(),
  ]);
}

async function refreshMe() {
  try {
    const { user } = await api('/api/me');
    state.user = user;
    renderUser();
  } catch {
    try {
      await ensureSession(true);
      renderUser();
    } catch (err) {
      authError(err.message);
    }
  }
}

async function refreshArenaStatus() {
  try {
    const s = await api('/api/arena');
    const el = $('#arena-status');
    if (!el) return;
    el.textContent = s.players === 0
      ? 'Arena empty — deploy and set the pace.'
      : `${s.players} operator${s.players === 1 ? '' : 's'} live across ${s.matches} sector${s.matches === 1 ? '' : 's'}.`;
    const node = $('#home-node-label');
    if (node) node.textContent = `POC / LOCAL / ${s.players || 0} LIVE`;
  } catch {}
}

async function refreshProfile() {
  try {
    const { profile } = await api('/api/profile');
    const kd = profile.deaths === 0
      ? profile.kills.toFixed(2)
      : (profile.kills / Math.max(1, profile.deaths)).toFixed(2);
    const stats = $('#profile-stats');
    if (stats) {
      stats.innerHTML = [
        ['Elo', profile.elo],
        ['Kills', profile.kills],
        ['Deaths', profile.deaths],
        ['K/D', kd],
      ].map(([l, v]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
    }
    // optional recent list (hidden on new home)
    const recent = $('#profile-recent');
    if (recent && profile.recent) {
      const me = state.user.username;
      recent.innerHTML = profile.recent.length
        ? profile.recent.map((r) => {
            const won = r.killer === me;
            return `<li>${won ? `killed ${esc(r.victim)}` : `killed by ${esc(r.killer)}`}</li>`;
          }).join('')
        : '';
    }
    const pin = $('#pronouns-input');
    if (pin && document.activeElement !== pin) pin.value = profile.pronouns || '';
  } catch {}
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- settings overlay ----------

$('#btn-settings')?.addEventListener('click', () => {
  $('#overlay-settings')?.classList.remove('hidden');
});
$('#btn-settings-close')?.addEventListener('click', () => {
  $('#overlay-settings')?.classList.add('hidden');
});

$('#btn-reset-profile')?.addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {}
  try { localStorage.removeItem('bounty.callsign'); } catch {}
  await ensureSession(true);
  enterLobby();
});

// quiet stubs for removed wallet UI
$('#btn-deposit') && ($('#btn-deposit').onclick = () => {});
$('#btn-withdraw') && ($('#btn-withdraw').onclick = () => {});
$('#btn-logout') && ($('#btn-logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  await ensureSession(true);
  enterLobby();
});

$('#btn-pronouns') && ($('#btn-pronouns').onclick = async () => {
  const pronouns = $('#pronouns-input')?.value.trim() || '';
  const btn = $('#btn-pronouns');
  try {
    const r = await api('/api/pronouns', { method: 'POST', body: JSON.stringify({ pronouns }) });
    if ($('#pronouns-input')) $('#pronouns-input').value = r.pronouns;
    if (btn) { btn.textContent = 'Saved'; setTimeout(() => { btn.textContent = 'Save'; }, 1400); }
  } catch (err) {
    alert(err.message);
  }
});

// ---------- settings bind ----------

function bindSettings() {
  const q = $('#set-quality');
  const sens = $('#set-sens');
  const fov = $('#set-fov');
  const particles = $('#set-particles');
  const fps = $('#set-fps');
  const music = $('#set-music');
  if (!q) return;

  const applyFromUi = () => {
    if (!window.BountyGame?.settings) return;
    const s = window.BountyGame.settings;
    s.quality = q.value;
    s.sens = parseFloat(sens.value) || 1;
    s.fov = parseInt(fov.value, 10) || 78;
    s.particles = particles.checked;
    s.showFps = fps.checked;
    s.music = music ? music.checked : true;
    if ($('#set-sens-val')) $('#set-sens-val').textContent = s.sens.toFixed(2);
    if ($('#set-fov-val')) $('#set-fov-val').textContent = `${s.fov}°`;
    window.BountyGame.saveSettings();
    window.BountyGame.setMusicEnabled?.(s.music);
  };

  const syncFromGame = () => {
    const s = window.BountyGame?.settings;
    if (!s) return false;
    q.value = s.quality || 'high';
    sens.value = s.sens ?? 1;
    fov.value = s.fov ?? 78;
    particles.checked = s.particles !== false;
    fps.checked = !!s.showFps;
    if (music) music.checked = s.music !== false;
    if ($('#set-sens-val')) $('#set-sens-val').textContent = Number(s.sens ?? 1).toFixed(2);
    if ($('#set-fov-val')) $('#set-fov-val').textContent = `${s.fov ?? 78}°`;
    return true;
  };
  if (!syncFromGame()) {
    const t = setInterval(() => { if (syncFromGame()) clearInterval(t); }, 100);
    setTimeout(() => clearInterval(t), 5000);
  }

  q.onchange = applyFromUi;
  sens.oninput = applyFromUi;
  fov.oninput = applyFromUi;
  particles.onchange = applyFromUi;
  fps.onchange = applyFromUi;
  if (music) music.onchange = applyFromUi;
}
bindSettings();

// ---------- play ----------

$('#btn-play').onclick = async () => {
  authError('');
  if (!window.BountyGame) {
    authError('Game is still loading — try again in a moment.');
    return;
  }
  try {
    if (!state.user) await ensureSession();
    // Top up sandbox balance if broke
    if (state.user.balance < (state.user.stakeCents || 300)) {
      try {
        await api('/api/deposit', { method: 'POST', body: JSON.stringify({ amountCents: 5000 }) });
        await refreshMe();
      } catch { /* ignore; server will reject join if still broke */ }
    }
  } catch (err) {
    authError(err.message);
    return;
  }
  leaveLobbyTimers();
  show('game');
  window.BountyGame.connect({
    onBalance: (cents) => { if (state.user) state.user.balance = cents; },
    onExit: () => {
      show('lobby');
      enterLobby();
    },
  });
};

$('#btn-broke-deposit') && ($('#btn-broke-deposit').onclick = async () => {
  try {
    const result = await api('/api/deposit', { method: 'POST', body: JSON.stringify({ amountCents: 1000 }) });
    if (result.checkoutUrl) { window.location = result.checkoutUrl; return; }
    $('#overlay-broke')?.classList.add('hidden');
  } catch (err) {
    alert(err.message);
  }
});
$('#btn-broke-lobby') && ($('#btn-broke-lobby').onclick = () => window.BountyGame?.leave());

// modal stubs
$('#btn-modal-close') && ($('#btn-modal-close').onclick = () => $('#modal-deposit')?.classList.add('hidden'));
$('#btn-modal-go') && ($('#btn-modal-go').onclick = () => {});

// ---------- boot ----------

(async function boot() {
  try {
    await ensureSession(false);
    enterLobby();
  } catch (err) {
    authError(err.message || 'Could not start session');
    show('lobby');
  }
})();
