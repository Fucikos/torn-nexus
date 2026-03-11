'use strict';

/* ============================================================
   STATE
   All game/wallet data now comes from the server.
   JWT token stored in memory only — never localStorage.
============================================================ */
const STATE = {
  loggedIn: false,

  // Set after login, sourced from JWT response
  user: {
    id:          0,
    username:    '',
    tornId:      0,
  },

  // Synced from GET /api/wallet
  wallet: {
    balance:        0,
    totalDeposited: 0,
    totalWithdrawn: 0,
    transactions:   [],
  },

  // Derived from wallet transactions + bet history
  stats: {
    rounds:        0,
    wins:          0,
    losses:        0,
    totalWagered:  0,
    totalWon:      0,
    bestMult:      0,
    biggestWin:    0,
    pnlHistory:    [],
    streakHistory: [],
  },

  // Live game state — synced from GET /api/game/state every ~1s for phase,
  // but multiplier is interpolated client-side at 60fps for smoothness
  game: {
    phase:       'WAITING',   // BETTING | RUNNING | CRASHED | WAITING
    roundId:     0,
    multiplier:  1.00,
    phaseEndsAt: null,
    myBet:       null,        // { amount, cashoutMult, payout, busted } | null

    // Client-side smooth interpolation
    runningStartedAt: null,   // Date — when RUNNING phase began (from server)
    serverMult:       1.00,   // last multiplier value from server (used for sync)

    // UI-only (not from server)
    pollId:        null,      // setInterval for polling server state (~1s)
    rafId:         null,      // requestAnimationFrame id for smooth rendering
    cashedOut:     false,
    activePlayers: [],
    roundHistory:  [],
    liveFeed:      [],
  },

  // JWT — in memory only, never written to localStorage
  _token: null,

  // Leaderboard cache
  leaderboard: [],
};


/* ============================================================
   MULTIPLIER INTERPOLATION
   Server is polled every ~1s. Between polls, we interpolate
   the multiplier client-side using the same formula as the
   game server, keyed off runningStartedAt.
   Formula: mult = 1 + Math.pow(elapsedSec, 1.5) * 0.25
============================================================ */

function calcMultiplierAt(startedAt) {
  if (!startedAt) return 1.00;
  const elapsedSec = (Date.now() - startedAt) / 1000;
  if (elapsedSec <= 0) return 1.00;
  return 1 + Math.pow(elapsedSec, 1.5) * 0.25;
}

let _rafRunning = false;

function startRenderLoop() {
  if (_rafRunning) return;
  _rafRunning = true;
  renderFrame();
}

function stopRenderLoop() {
  _rafRunning = false;
  if (STATE.game.rafId) {
    cancelAnimationFrame(STATE.game.rafId);
    STATE.game.rafId = null;
  }
}

function renderFrame() {
  if (!_rafRunning) return;

  const G = STATE.game;

  if (G.phase === 'RUNNING' && G.runningStartedAt) {
    // Interpolate multiplier client-side — smooth 60fps
    const interp = calcMultiplierAt(G.runningStartedAt);

    // Don't go past server crash point if we know it crashed
    const displayMult = interp;
    G.multiplier = displayMult;

    _setMultDisplay(displayMult, false);
    _updateCheckpoints(displayMult);
    _setProgress(displayMult);
    syncTopbar();

    // Auto cashout check at exact client-side multiplier
    const acoEnabled = document.getElementById('aco-enabled')?.checked;
    const acoVal     = parseFloat(document.getElementById('aco-value')?.value);
    if (acoEnabled && !isNaN(acoVal) && G.myBet && !G.cashedOut && displayMult >= acoVal) {
      cashOut();
    }
  }

  G.rafId = requestAnimationFrame(renderFrame);
}


/* ============================================================
   API LAYER
   Single fetch wrapper — attaches JWT, handles errors uniformly.
============================================================ */

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(STATE._token ? { 'Authorization': `Bearer ${STATE._token}` } : {}),
    ...(options.headers ?? {}),
  };

  const resp = await fetch(path, { ...options, headers });
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(data.error ?? `Request failed (${resp.status})`);
  }

  return data;
}

async function apiGet(path) {
  return api(path, { method: 'GET' });
}

async function apiPost(path, body) {
  return api(path, { method: 'POST', body: JSON.stringify(body) });
}


/* ============================================================
   AUTH — LOGIN / LOGOUT
============================================================ */

async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const apiKey   = document.getElementById('login-apikey').value.trim();
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('login-btn');

  errEl.classList.remove('show');
  errEl.textContent = '';

  if (!username) return showLoginError(errEl, 'Please enter your Torn username.');
  if (!apiKey)   return showLoginError(errEl, 'Please enter your Torn API key.');
  if (apiKey.length < 16) return showLoginError(errEl, 'API key looks too short.');

  btn.disabled  = true;
  btn.innerHTML = '<span class="btn-spinner"></span> VERIFYING…';

  try {
    const data = await apiPost('/api/auth/login', { username, apiKey });

    STATE._token = data.token;
    await loginSuccess(data.user);

  } catch (err) {
    btn.disabled  = false;
    btn.innerHTML = 'ACCESS NEXUS';
    showLoginError(errEl, err.message);
  }
}

async function loginSuccess(user) {
  STATE.loggedIn      = true;
  STATE.user.id       = user.id;
  STATE.user.username = user.username;
  STATE.user.tornId   = user.tornId;

  STATE.wallet.balance = Number(user.balance);

  await refreshWalletFromServer();
  await refreshStatsFromServer();

  document.getElementById('topbar').style.display = 'flex';
  updateVerificationUI(true);
  startGamePolling();
  startRenderLoop();
  seedLeaderboard();
  navigate('home');
  updateAllUI();
  showToast(`Welcome back, ${STATE.user.username}!`, 'success');

  const btn = document.getElementById('login-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = 'ACCESS NEXUS'; }
}

function showLoginError(el, msg) {
  el.textContent = msg;
  el.classList.add('show');
}

function logout() {
  if (!confirm('Log out of Torn Nexus?')) return;

  stopRenderLoop();
  if (STATE.game.pollId) clearInterval(STATE.game.pollId);

  STATE.loggedIn   = false;
  STATE._token     = null;
  STATE.user       = { id: 0, username: '', tornId: 0 };
  STATE.wallet     = { balance: 0, totalDeposited: 0, totalWithdrawn: 0, transactions: [] };
  STATE.game.phase = 'WAITING';
  STATE.game.pollId = null;
  STATE.game.runningStartedAt = null;

  document.getElementById('topbar').style.display = 'none';
  hideDemoBanner();
  showPage('login');
  showToast('Logged out successfully.', 'info');
}


/* ============================================================
   SERVER DATA SYNC
============================================================ */

async function refreshWalletFromServer() {
  try {
    const data = await apiGet('/api/wallet');

    STATE.wallet.balance        = Number(data.balance);
    STATE.wallet.totalDeposited = Number(data.totalDeposited);
    STATE.wallet.totalWithdrawn = Number(data.totalWithdrawn);
    STATE.wallet.transactions   = data.transactions.map(tx => ({
      id:     tx.id,
      type:   tx.type.toLowerCase(),
      desc:   tx.description ?? '',
      amount: Number(tx.amount),
      status: tx.status,
      time:   new Date(tx.createdAt).getTime(),
    }));
  } catch (e) {
    console.warn('[wallet sync]', e.message);
  }
}

async function refreshStatsFromServer() {
  try {
    const data = await apiGet('/api/game/history?type=history');

    let rounds = 0, wins = 0, losses = 0;
    let totalWagered = 0, totalWon = 0;
    let bestMult = 0, biggestWin = 0;
    const pnlHistory    = [];
    const streakHistory = [];

    for (const r of data) {
      if (!r.myBet) continue;
      rounds++;
      const bet    = Number(r.myBet.amount);
      const payout = Number(r.myBet.payout);
      const mult   = r.myBet.cashoutMult ? parseFloat(r.myBet.cashoutMult) : null;

      totalWagered += bet;

      if (mult !== null) {
        wins++;
        totalWon += payout;
        const profit = payout - bet;
        pnlHistory.push(profit);
        streakHistory.push('w');
        if (mult > bestMult) bestMult = mult;
        if (profit > biggestWin) biggestWin = profit;
      } else {
        losses++;
        pnlHistory.push(-bet);
        streakHistory.push('l');
      }
    }

    STATE.stats = { rounds, wins, losses, totalWagered, totalWon, bestMult, biggestWin, pnlHistory, streakHistory };

    STATE.game.roundHistory = data.slice(0, 20).map(r => ({
      roundId: r.id,
      crash:   parseFloat(r.crashPoint),
      myPnl:   r.myBet
        ? (r.myBet.cashoutMult
          ? Number(r.myBet.payout) - Number(r.myBet.amount)
          : -Number(r.myBet.amount))
        : null,
    }));

  } catch (e) {
    console.warn('[stats sync]', e.message);
  }
}


/* ============================================================
   GAME POLLING — polls server every 1s for phase/roundId,
   multiplier is interpolated client-side between polls.
============================================================ */

function startGamePolling() {
  if (STATE.game.pollId) clearInterval(STATE.game.pollId);

  // Poll immediately then every 1000ms
  // Phase changes + round IDs need server truth; multiplier is interpolated
  pollGameState();
  STATE.game.pollId = setInterval(async () => {
    if (!STATE.loggedIn) return;
    await pollGameState();
  }, 1000);
}

let _lastRoundId = 0;
let _lastPhase   = '';

async function pollGameState() {
  let state;
  try {
    state = await apiGet('/api/game/state');
  } catch {
    return;
  }

  const G = STATE.game;

  const prevPhase   = G.phase;
  G.phase           = state.phase;
  G.roundId         = state.roundId;
  G.phaseEndsAt     = state.phaseEndsAt ? new Date(state.phaseEndsAt) : null;
  G.myBet           = state.myBet ?? null;
  G.serverMult      = parseFloat(state.multiplier);

  // When RUNNING phase starts, record the server's start time so we can interpolate.
  // The server sends runningStartedAt (when the running phase began).
  if (state.phase === 'RUNNING') {
    if (prevPhase !== 'RUNNING') {
      // Phase just transitioned to RUNNING — anchor our interpolation start
      // Use server-provided runningStartedAt if available, else approximate from server mult
      if (state.runningStartedAt) {
        G.runningStartedAt = new Date(state.runningStartedAt);
      } else {
        // Back-calculate start time from server multiplier:
        // mult = 1 + elapsed^1.5 * 0.25 → elapsed = ((mult-1)/0.25)^(2/3)
        const serverMult = G.serverMult;
        if (serverMult > 1.001) {
          const elapsed = Math.pow((serverMult - 1) / 0.25, 2 / 3);
          G.runningStartedAt = new Date(Date.now() - elapsed * 1000);
        } else {
          G.runningStartedAt = new Date();
        }
      }
    }
    // Keep interpolation going — don't override G.multiplier here,
    // the RAF loop handles that. But sync if we're drifting > 5%
    const interp = calcMultiplierAt(G.runningStartedAt);
    const drift  = Math.abs(interp - G.serverMult) / Math.max(G.serverMult, 1);
    if (drift > 0.05) {
      // Re-anchor to server truth to prevent drift accumulation
      const elapsed = Math.pow((G.serverMult - 1) / 0.25, 2 / 3);
      G.runningStartedAt = new Date(Date.now() - elapsed * 1000);
    }
  } else {
    G.runningStartedAt = null;
    // For non-RUNNING phases, use server multiplier directly
    G.multiplier = G.serverMult;
    _setMultDisplay(G.multiplier, state.phase === 'CRASHED');
    _updateCheckpoints(G.multiplier);
    _setProgress(G.multiplier);
  }

  if (G.myBet?.cashoutMult) G.cashedOut = true;

  updateBetControls();
  syncTopbar();

  // Phase change detection
  if (state.phase !== _lastPhase) {
    _onPhaseChange(state.phase, state.roundId);
    _lastPhase = state.phase;
  }

  // New round detection
  if (state.roundId !== _lastRoundId && state.roundId > 0) {
    _lastRoundId = state.roundId;
    G.cashedOut  = false;
    G.myBet      = null;
    _resetCheckpoints();
    _setProgress(0);
  }

  // Phase countdown timer
  if (G.phaseEndsAt) {
    const secsLeft = Math.max(0, Math.ceil((G.phaseEndsAt - Date.now()) / 1000));
    const timerEl  = document.getElementById('phase-timer');
    if (timerEl) {
      if (state.phase === 'BETTING') {
        timerEl.textContent = secsLeft > 0 ? `Round starts in ${secsLeft}s` : 'Launching…';
      } else if (state.phase === 'CRASHED') {
        timerEl.textContent = secsLeft > 0 ? `Next round in ${secsLeft}s` : 'Starting…';
      } else {
        timerEl.textContent = '';
      }
    }
  }
}

function _onPhaseChange(phase, roundId) {
  const G = STATE.game;

  if (phase === 'BETTING') {
    _setPhaseTag('betting', 'Betting Open');
    _setMultDisplay(1.00, false);
    _resetCheckpoints();
    _setProgress(0);
    document.querySelector('.arena-panel')?.classList.remove('is-live', 'is-crashed');
    const statusEl = document.getElementById('bet-status');
    if (statusEl && !G.myBet) {
      statusEl.className   = 'bet-status';
      statusEl.textContent = 'Place your bet before the round starts.';
    }
    renderActivePlayers();
  }

  if (phase === 'RUNNING') {
    _setPhaseTag('running', 'Round Live');
    document.getElementById('phase-timer').textContent = '';
    document.querySelector('.arena-panel')?.classList.remove('is-crashed');
    document.querySelector('.arena-panel')?.classList.add('is-live');
  }

  if (phase === 'CRASHED') {
    G.runningStartedAt = null;
    _setPhaseTag('crashed', 'Crashed');
    document.querySelector('.arena-panel')?.classList.remove('is-live');
    document.querySelector('.arena-panel')?.classList.add('is-crashed');

    const crashedMult = G.serverMult;
    document.getElementById('phase-timer').textContent = `Crashed at ${crashedMult.toFixed(2)}×`;
    _setMultDisplay(crashedMult, true);

    if (G.myBet && !G.cashedOut && !G.myBet.cashoutMult) {
      const lost     = Number(G.myBet?.amount ?? 0);
      const statusEl = document.getElementById('bet-status');
      if (statusEl && lost > 0) {
        statusEl.className   = 'bet-status busted';
        statusEl.textContent = `💀 Busted at ${crashedMult.toFixed(2)}× — lost $${fmt(lost)}`;
        showResultFlash('loss', `-$${fmt(lost)}`);
      }
    }

    setTimeout(async () => {
      await refreshWalletFromServer();
      await refreshStatsFromServer();
      updateAllUI();
      renderRoundHistory();
      pushToLiveFeed(roundId, crashedMult);
      if (document.getElementById('page-stats')?.classList.contains('active')) renderStats();
    }, 300);

    renderActivePlayers(true);
  }

  updateBetControls();
}


/* ============================================================
   PAGE ROUTING
============================================================ */

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${id}`)?.classList.add('active');
}

function navigate(page) {
  if (!STATE.loggedIn && page !== 'login') return;
  showPage(page);

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`nav-${page}`)?.classList.add('active');
  syncTopbar();

  if (page === 'home')        { updateAllUI(); renderHomeFeed(); }
  if (page === 'wallet')      { refreshWalletFromServer().then(() => refreshWalletUI()); }
  if (page === 'game')        { updateAllUI(); renderRoundHistory(); renderActivePlayers(); }
  if (page === 'leaderboard') { loadLeaderboard(); }
  if (page === 'stats')       { refreshStatsFromServer().then(() => renderStats()); }
}


/* ============================================================
   TOPBAR SYNC
============================================================ */

function syncTopbar() {
  document.getElementById('topbar-balance').textContent  = `$${fmt(STATE.wallet.balance)}`;
  document.getElementById('topbar-username').textContent = STATE.user.username || '—';
}

function toggleMobileNav() {
  document.getElementById('mobile-nav-dropdown')?.classList.toggle('open');
}
function closeMobileNav() {
  document.getElementById('mobile-nav-dropdown')?.classList.remove('open');
}
function showDemoBanner() {
  document.getElementById('demo-banner')?.classList.add('show');
}
function hideDemoBanner() {
  document.getElementById('demo-banner')?.classList.remove('show');
}


/* ============================================================
   UTILITIES
============================================================ */

function fmt(n) {
  if (n == null || isNaN(n)) return '0';
  const abs = Math.abs(n);
  let s;
  if      (abs >= 1e9) s = (n / 1e9).toFixed(2) + 'B';
  else if (abs >= 1e6) s = (n / 1e6).toFixed(2) + 'M';
  else if (abs >= 1e3) s = (n / 1e3).toFixed(1) + 'K';
  else                 s = Math.floor(n).toString();
  return s;
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s <   5) return 'just now';
  if (s <  60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/* ============================================================
   TOAST SYSTEM
============================================================ */

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons     = { success: '✓', error: '✕', info: 'ℹ️' };
  const toast     = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] ?? '·'}</span>
    <span class="toast-msg">${msg}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, 3500);
}


/* ============================================================
   HOME PAGE
============================================================ */

function renderHomeFeed() {
  const feed     = STATE.game.liveFeed;
  const feedEl   = document.getElementById('home-live-feed');
  const recentEl = document.getElementById('home-recent-games');
  const countEl  = document.getElementById('home-round-count');

  if (feed.length === 0) {
    feedEl.innerHTML = `<div class="empty-state"><span class="es-icon">📡</span>Waiting for round activity…</div>`;
  } else {
    feedEl.innerHTML = feed.slice(0, 12).map(entry => {
      const isWin     = entry.pnl > 0;
      const resultTxt = isWin
        ? `+$${fmt(entry.pnl)} @ ${entry.crash.toFixed(2)}×`
        : `BUST @ ${entry.crash.toFixed(2)}×`;
      const initial   = (entry.username || '?')[0].toUpperCase();
      return `
        <div class="bet-item">
          <div class="bi-avatar">${initial}</div>
          <span class="bi-user">${entry.username}</span>
          <span class="bi-result ${isWin ? 'win' : 'loss'}">${resultTxt}</span>
          <span class="bi-time">${timeAgo(entry.time)}</span>
        </div>`;
    }).join('');
  }

  const seen   = new Set();
  const rounds = [];
  for (const e of feed) {
    if (!seen.has(e.roundId)) {
      seen.add(e.roundId);
      rounds.push(e);
      if (rounds.length >= 8) break;
    }
  }

  if (rounds.length === 0) {
    recentEl.innerHTML = `<div class="empty-state"><span class="es-icon">🎮</span>No rounds played yet</div>`;
    if (countEl) countEl.textContent = '';
  } else {
    if (countEl) countEl.textContent = `${rounds.length} rounds`;
    recentEl.innerHTML = rounds.map(e => {
      const c   = e.crash;
      const cls = c >= 3 ? 'high' : c >= 1.5 ? 'mid' : 'low';
      return `
        <div class="game-row">
          <span class="gr-round">Round #${e.roundId}</span>
          <span class="gr-mult ${cls}">${c.toFixed(2)}×</span>
          <span class="gr-time">${timeAgo(e.time)}</span>
        </div>`;
    }).join('');
  }
}

function updateAllUI() {
  const w   = STATE.wallet;
  const st  = STATE.stats;
  const pnl = st.totalWon - st.totalWagered;

  syncTopbar();

  _setEl('home-balance', `$${fmt(w.balance)}`);
  _setEl('home-wagered', `$${fmt(st.totalWagered)}`);

  const homePnlEl   = document.getElementById('home-pnl');
  const homePnlCard = document.getElementById('home-pnl-card');
  if (homePnlEl) {
    homePnlEl.textContent = `${pnl >= 0 ? '+' : '-'}$${fmt(Math.abs(pnl))}`;
  }
  if (homePnlCard) {
    homePnlCard.className = `stat-card ${pnl >= 0 ? 'sc-green' : 'sc-red'}`;
  }

  _setEl('home-username', (STATE.user.username || 'PLAYER').toUpperCase());

  const wr = st.rounds > 0 ? Math.round((st.wins / st.rounds) * 100) : 0;
  _setEl('gs-winrate',     `${wr}%`);
  _setEl('gs-rounds',      st.rounds);
  _setEl('gs-best-mult',   st.bestMult > 0 ? `${st.bestMult.toFixed(2)}×` : '—');
  _setEl('gs-biggest-win', st.biggestWin > 0 ? `$${fmt(st.biggestWin)}` : '—');

  refreshWalletUI();
}


/* ============================================================
   WALLET PAGE
============================================================ */

function setDepAmt(amt) {
  const input = document.getElementById('wallet-amount');
  if (input) input.value = amt;
}

function _walletError(msg) {
  const el = document.getElementById('wallet-error');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.style.display = 'block';
    el.classList.add('show');
  } else {
    el.style.display = 'none';
    el.classList.remove('show');
    el.textContent = '';
  }
}

function _walletBusy(busy) {
  const dep   = document.getElementById('btn-deposit');
  const with_ = document.getElementById('btn-withdraw');
  if (dep)   dep.disabled   = busy;
  if (with_) with_.disabled = busy;
}

/**
 * Deposit flow:
 * Player must have already sent Torn $ to house account.
 * They enter the amount — server auto-scans the house Torn log for a match.
 * No manual Transaction ID needed.
 */
async function doDeposit() {
  _walletError(null);

  const amountRaw = document.getElementById('wallet-amount').value;
  const amount    = parseFloat(amountRaw);

  if (isNaN(amount) || amount <= 0) return _walletError('Please enter a valid amount.');
  if (amount < 1000)                return _walletError('Minimum deposit is $1,000.');

  _walletBusy(true);
  showToast('Scanning house account for your transfer…', 'info');

  try {
    const data = await apiPost('/api/wallet/deposit', { amount });
    STATE.wallet.balance = Number(data.balance);
    await refreshWalletFromServer();
    updateAllUI();
    refreshWalletUI();
    document.getElementById('wallet-amount').value = '';
    showToast(data.message, 'success');
  } catch (e) {
    _walletError(e.message);
  } finally {
    _walletBusy(false);
  }
}

async function doWithdraw() {
  _walletError(null);

  const amountRaw = document.getElementById('wallet-amount').value;
  const amount    = parseFloat(amountRaw);

  if (isNaN(amount) || amount <= 0) return _walletError('Please enter a valid amount.');
  if (amount < 1000)                return _walletError('Minimum withdrawal is $1,000.');
  if (amount > STATE.wallet.balance) {
    return _walletError(`Insufficient balance. You have $${fmt(STATE.wallet.balance)}.`);
  }

  _walletBusy(true);
  showToast('Processing withdrawal…', 'info');

  try {
    const data = await apiPost('/api/wallet/withdraw', { amount });
    STATE.wallet.balance = Number(data.balance);
    await refreshWalletFromServer();
    updateAllUI();
    refreshWalletUI();
    document.getElementById('wallet-amount').value = '';
    showToast(data.message, 'success');
  } catch (e) {
    _walletError(e.message);
  } finally {
    _walletBusy(false);
  }
}

function refreshWalletUI() {
  const w  = STATE.wallet;
  const st = STATE.stats;

  _setEl('wallet-balance-figure', fmt(w.balance));
  _setEl('wallet-total-dep',  `$${fmt(w.totalDeposited)}`);
  _setEl('wallet-total-with', `$${fmt(w.totalWithdrawn)}`);

  const pnl   = st.totalWon - st.totalWagered;
  const pnlEl = document.getElementById('wallet-net-pnl');
  if (pnlEl) {
    pnlEl.textContent = `${pnl >= 0 ? '+' : '-'}$${fmt(Math.abs(pnl))}`;
    pnlEl.className   = `wbc-stat-val ${pnl >= 0 ? 'pos' : 'neg'}`;
  }

  const tornBalEl = document.getElementById('wallet-torn-bal');
  if (tornBalEl) tornBalEl.textContent = 'Verified server-side';

  const listEl  = document.getElementById('tx-list');
  const countEl = document.getElementById('tx-count');
  if (!listEl) return;

  const txs = w.transactions.slice(0, 50);
  if (countEl) countEl.textContent = txs.length ? `${txs.length} records` : '';

  if (txs.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><span class="es-icon">📋</span>No transactions yet</div>`;
    return;
  }

  const iconMap = {
    deposit:    { el: '↓', cls: 'dep' },
    withdrawal: { el: '↑', cls: 'with' },
    bet_win:    { el: '★', cls: 'win' },
    bet_loss:   { el: '✕', cls: 'loss' },
  };

  listEl.innerHTML = txs.map(tx => {
    const ic        = iconMap[tx.type] ?? { el: '·', cls: '' };
    const isPos     = (tx.type === 'deposit' || tx.type === 'bet_win');
    const isPending = tx.status === 'PENDING';
    return `
      <div class="tx-item">
        <div class="tx-icon ${ic.cls}">${ic.el}</div>
        <div class="tx-info">
          <div class="tx-desc">${tx.desc}${isPending ? ' <span style="color:var(--warn);font-size:10px">[PENDING]</span>' : ''}</div>
          <div class="tx-time">${timeAgo(tx.time)}</div>
        </div>
        <div class="tx-amount ${isPos ? 'pos' : 'neg'}">
          ${isPos ? '+' : '-'}$${fmt(tx.amount)}
        </div>
      </div>`;
  }).join('');
}

function updateVerificationUI(valid) {
  const apiEl   = document.getElementById('v-api');
  const identEl = document.getElementById('v-identity');
  if (apiEl)   { apiEl.textContent   = valid ? '✓ Valid'     : '✕ Invalid';  apiEl.className   = `verif-val ${valid ? 'ok' : 'fail'}`; }
  if (identEl) { identEl.textContent = valid ? '✓ Confirmed' : '✕ Mismatch'; identEl.className = `verif-val ${valid ? 'ok' : 'fail'}`; }
}


/* ============================================================
   GAME — PLAYER ACTIONS
============================================================ */

async function placeBet() {
  const G   = STATE.game;
  const raw = parseFloat(document.getElementById('bet-amount').value);

  if (G.phase !== 'BETTING') { showToast('Betting is closed for this round.', 'error'); return; }
  if (G.myBet)               { showToast('You already have a bet this round.', 'error'); return; }
  if (isNaN(raw) || raw < 100) { showToast('Minimum bet is $100.', 'error'); return; }
  if (raw > STATE.wallet.balance) { showToast('Insufficient balance.', 'error'); return; }

  try {
    const data = await apiPost('/api/game/bet', { amount: raw });
    STATE.wallet.balance = Number(data.balance);
    G.myBet = { amount: raw, cashoutMult: null, payout: 0, busted: false };
    syncTopbar();

    const statusEl = document.getElementById('bet-status');
    statusEl.className   = 'bet-status active-bet';
    statusEl.textContent = `⚡ Bet placed: $${fmt(raw)} — cash out before it crashes!`;

    updateBetControls();
    showToast(`Bet of $${fmt(raw)} placed!`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function cashOut() {
  const G = STATE.game;

  if (G.phase !== 'RUNNING') { showToast('Round not in progress.', 'error'); return; }
  if (!G.myBet)              { showToast('No active bet.', 'error'); return; }
  if (G.cashedOut)           { return; }

  G.cashedOut = true;
  updateBetControls();

  try {
    const data   = await apiPost('/api/game/cashout', {});
    const mult   = parseFloat(data.cashoutMult);
    const profit = Number(data.profit);

    STATE.wallet.balance = Number(data.balance);
    G.myBet = { ...G.myBet, cashoutMult: mult, payout: Number(data.payout) };

    const statusEl = document.getElementById('bet-status');
    statusEl.className   = 'bet-status cashed-out';
    statusEl.textContent = `✓ Cashed out at ${mult.toFixed(2)}× — won $${fmt(profit)}!`;

    showResultFlash('win', `+$${fmt(profit)}`);
    syncTopbar();
    updateAllUI();

    STATE.stats.wins++;
    STATE.stats.rounds++;
    STATE.stats.totalWon     += Number(data.payout);
    STATE.stats.totalWagered += G.myBet.amount;
    if (mult > STATE.stats.bestMult)     STATE.stats.bestMult   = mult;
    if (profit > STATE.stats.biggestWin) STATE.stats.biggestWin = profit;

    if (document.getElementById('page-stats')?.classList.contains('active')) renderStats();

  } catch (e) {
    G.cashedOut = false;
    updateBetControls();
    showToast(e.message, 'error');
  }
}


/* ============================================================
   NPC PLAYERS  (visual only)
============================================================ */

const NPC_NAMES = [
  'Phantom_X','VoidRunner','Kira_J','TornKing99',
  'Blitz','NightHawk','CryptoViper','Renegade_K',
  'Ghost404','Apex_Z','DarkMatter','ZeroHour',
];

function generateFakePlayers() {
  const count = 3 + Math.floor(Math.random() * 6);
  return [...NPC_NAMES]
    .sort(() => Math.random() - 0.5)
    .slice(0, count)
    .map(name => ({
      name,
      bet:         Math.floor(5_000 + Math.random() * 500_000),
      isMe:        false,
      status:      'active',
      autoCashout: parseFloat((1.2 + Math.random() * 4.8).toFixed(2)),
    }));
}

function maybeAutoFakeCashouts(mult) {
  let changed = false;
  STATE.game.activePlayers.forEach(p => {
    if (p.isMe || p.status !== 'active') return;
    const overTarget = mult >= p.autoCashout;
    const prob = overTarget ? 0.18 : 0.015;
    if (Math.random() < prob) { p.status = 'cashed'; p.multAt = mult; changed = true; }
  });
  if (changed) renderActivePlayers();
}


/* ============================================================
   RENDER HELPERS
============================================================ */

function renderRoundHistory() {
  const el      = document.getElementById('round-history');
  const counter = document.getElementById('round-counter');
  if (!el) return;

  const history = STATE.game.roundHistory;
  if (counter) counter.textContent = `${history.length} rounds`;

  if (history.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:24px 16px"><span class="es-icon"></span>No rounds yet</div>`;
    return;
  }

  el.innerHTML = history.map(r => {
    const cls  = r.crash >= 3 ? 'high' : r.crash >= 1.5 ? 'mid' : 'low';
    let pnlHtml = '<span class="rh-pnl none">—</span>';
    if (r.myPnl !== null && r.myPnl !== undefined) {
      const sign = r.myPnl >= 0 ? '+' : '-';
      pnlHtml = `<span class="rh-pnl ${r.myPnl >= 0 ? 'win' : 'loss'}">${sign}$${fmt(Math.abs(r.myPnl))}</span>`;
    }
    return `
      <div class="rh-item">
        <span class="rh-round">#${r.roundId}</span>
        <span class="rh-mult ${cls}">${r.crash.toFixed(2)}×</span>
        ${pnlHtml}
      </div>`;
  }).join('');
}

function renderActivePlayers(crashed = false) {
  const el = document.getElementById('active-players');
  if (!el) return;

  if (STATE.game.phase === 'BETTING' && !crashed) {
    STATE.game.activePlayers = generateFakePlayers();
    if (STATE.game.myBet) {
      STATE.game.activePlayers.unshift({
        name: STATE.user.username, bet: STATE.game.myBet.amount,
        isMe: true, status: 'active',
      });
    }
  }

  if (STATE.game.phase === 'RUNNING') {
    maybeAutoFakeCashouts(STATE.game.multiplier);
  }

  const players = STATE.game.activePlayers;
  if (players.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:24px 16px"><span class="es-icon">⌛</span>Waiting for next round</div>`;
    return;
  }

  el.innerHTML = players.map(p => {
    const effectiveStatus = (crashed && p.status === 'active') ? 'lost' : p.status;
    let statusHtml;
    if (effectiveStatus === 'active') statusHtml = `<span class="ap-status active">IN</span>`;
    else if (effectiveStatus === 'cashed') statusHtml = `<span class="ap-status cashed">✓ ${p.multAt?.toFixed(2) ?? '?'}×</span>`;
    else statusHtml = `<span class="ap-status lost">✕ BUST</span>`;

    const initial = (p.name || '?')[0].toUpperCase();
    return `
      <div class="ap-item ${p.isMe ? 'is-me' : ''}">
        <div class="ap-avatar">${initial}</div>
        <span class="ap-name">${p.isMe ? '▶ ' : ''}${p.name}</span>
        <span class="ap-bet">$${fmt(p.bet)}</span>
        ${statusHtml}
      </div>`;
  }).join('');
}

function pushToLiveFeed(roundId, crash) {
  const G = STATE.game;
  let pnl = 0;
  if (G.myBet?.cashoutMult) {
    pnl = Math.floor(G.myBet.amount * G.myBet.cashoutMult) - G.myBet.amount;
  }

  G.liveFeed.unshift({
    roundId,
    crash,
    username: STATE.user.username,
    pnl,
    time: Date.now(),
  });
  if (G.liveFeed.length > 8) G.liveFeed.pop();

  if (document.getElementById('page-home')?.classList.contains('active')) renderHomeFeed();
}

function showResultFlash(type, text) {
  const overlay = document.getElementById('result-flash');
  const inner   = document.getElementById('result-flash-inner');
  if (!overlay || !inner) return;
  inner.className   = `result-flash-inner ${type}`;
  inner.textContent = text;
  overlay.classList.add('show');
  setTimeout(() => overlay.classList.remove('show'), 2000);
}


/* ============================================================
   BET CONTROLS STATE MACHINE
============================================================ */

function updateBetControls() {
  const G        = STATE.game;
  const betBtn   = document.getElementById('btn-bet');
  const cashBtn  = document.getElementById('btn-cashout');
  const betInput = document.getElementById('bet-amount');
  if (!betBtn || !cashBtn || !betInput) return;

  const showCashout = G.phase === 'RUNNING' && G.myBet && !G.cashedOut;

  if (showCashout) {
    betBtn.style.display  = 'none';
    cashBtn.style.display = 'inline-flex';
    cashBtn.disabled      = false;
    betInput.disabled     = true;
  } else {
    betBtn.style.display  = 'inline-flex';
    cashBtn.style.display = 'none';
    betInput.disabled     = G.phase !== 'BETTING' || !!G.myBet;
    betBtn.disabled       = G.phase !== 'BETTING' || !!G.myBet;
  }
}


/* ============================================================
   ARENA VISUAL HELPERS
============================================================ */

function _setPhaseTag(phase, label) {
  const tag = document.getElementById('phase-tag');
  const lbl = document.getElementById('phase-label');
  if (tag) tag.className   = `phase-tag ${phase}`;
  if (lbl) lbl.textContent = label;
}

function _setMultDisplay(mult, crashed) {
  const el  = document.getElementById('mult-value');
  const sub = document.getElementById('mult-sub');
  if (!el || !sub) return;

  el.textContent = `${mult.toFixed(2)}×`;

  if (crashed) {
    el.className    = 'mult-value crashed';
    sub.textContent = 'CRASHED';
    return;
  }

  if      (mult < 1.5) el.className = 'mult-value green';
  else if (mult < 3)   el.className = 'mult-value gold';
  else                 el.className = 'mult-value red';

  sub.textContent = STATE.game.phase === 'RUNNING' ? 'LIVE' : 'WAITING FOR ROUND';
}

function _resetCheckpoints() {
  document.querySelectorAll('#checkpoints .checkpoint')
    .forEach(cp => cp.className = 'checkpoint');
}

function _updateCheckpoints(mult) {
  document.querySelectorAll('#checkpoints .checkpoint').forEach(cp => {
    if (mult >= parseFloat(cp.dataset.target)) cp.className = 'checkpoint reached';
  });
}

function _setProgress(mult) {
  const fill = document.getElementById('progress-fill');
  if (!fill) return;
  const pct = mult <= 1 ? 0 : Math.min(100, (Math.log(mult) / Math.log(10)) * 100);
  fill.style.width = `${pct}%`;
  if      (mult < 1.5) fill.className = 'progress-fill green';
  else if (mult < 3)   fill.className = 'progress-fill gold';
  else                 fill.className = 'progress-fill red';
}


/* ============================================================
   LEADERBOARD
============================================================ */

let _currentLbSort = 'profit';

async function loadLeaderboard() {
  try {
    const data = await apiGet(`/api/game/history?type=leaderboard&sort=${_currentLbSort}`);
    STATE.leaderboard = data;
    renderLeaderboard(_currentLbSort);
  } catch (e) {
    console.warn('[leaderboard]', e.message);
  }
}

function seedLeaderboard() {
  const LB_NPC_NAMES = ['Phantom_X','VoidRunner','TornKing99','Blitz','NightHawk','CryptoViper','Renegade_K','Ghost404'];
  STATE.leaderboard = LB_NPC_NAMES.map(name => {
    const rounds  = 50  + Math.floor(Math.random() * 501);
    const wins    = Math.round(rounds * (0.35 + Math.random() * 0.25));
    const wagered = Math.round(rounds * (15_000 + Math.random() * 185_000));
    const profit  = Math.round(wagered * ((Math.random() < 0.55 ? 1 : -1) * (0.10 + Math.random() * 0.20)));
    return { username: name, isMe: false, rounds, wins, wagered, profit, bestMult: parseFloat((1.5 + Math.random() * 15).toFixed(2)) };
  });
}

function renderLeaderboard(sortBy = 'profit') {
  _currentLbSort = sortBy;

  const sorted = [...STATE.leaderboard].sort((a, b) => {
    if (sortBy === 'wins')    return b.wins    - a.wins;
    if (sortBy === 'wagered') return b.wagered - a.wagered;
    return b.profit - a.profit;
  });

  const tbody = document.getElementById('lb-tbody');
  if (!tbody) return;

  tbody.innerHTML = sorted.map((entry, i) => {
    const rank     = i + 1;
    const rankCls  = rank === 1 ? 'r1' : rank === 2 ? 'r2' : rank === 3 ? 'r3' : 'rn';
    const wr       = entry.rounds > 0 ? Math.round((entry.wins / entry.rounds) * 100) : 0;
    const profSign = entry.profit >= 0 ? '+' : '-';
    const profCls  = entry.profit >= 0 ? 'pos' : 'neg';
    return `
      <tr class="${entry.isMe ? 'lb-me-row' : ''}">
        <td><span class="rank-badge ${rankCls}">${rank}</span></td>
        <td>
          ${entry.isMe ? '<span class="lb-me-star">▶</span>' : ''}
          <span class="lb-player-name ${entry.isMe ? 'lb-me' : ''}">${entry.username}</span>
        </td>
        <td>${entry.rounds.toLocaleString()}</td>
        <td class="lb-wins">${entry.wins.toLocaleString()}</td>
        <td>
          <div class="lb-wr-wrap">
            <div class="lb-wr-bar"><div class="lb-wr-fill" style="width:${Math.min(100,wr)}%"></div></div>
            <span>${wr}%</span>
          </div>
        </td>
        <td>$${fmt(entry.wagered)}</td>
        <td class="lb-profit ${profCls}">${profSign}$${fmt(Math.abs(entry.profit))}</td>
        <td class="lb-bestmult ${entry.bestMult >= 5 ? 'notable' : ''}">${entry.bestMult > 0 ? entry.bestMult.toFixed(2) + '×' : '—'}</td>
      </tr>`;
  }).join('');
}

function setLbTab(type, el) {
  document.querySelectorAll('.lb-tab').forEach(btn => btn.classList.remove('active'));
  el.classList.add('active');
  _currentLbSort = type;
  loadLeaderboard();
}


/* ============================================================
   STATS PAGE
============================================================ */

function renderStats() {
  const st  = STATE.stats;
  const txs = STATE.wallet.transactions;

  const wr = st.rounds > 0 ? Math.round((st.wins / st.rounds) * 100) : 0;
  _setEl('st-winrate', `${wr}%`);
  _setEl('st-wl',      `${st.wins}W / ${st.losses}L`);
  _setEl('st-bestmult', st.bestMult > 0 ? `${st.bestMult.toFixed(2)}×` : '—');

  const winTxs   = txs.filter(t => t.type === 'bet_win');
  const multVals = winTxs.map(t => {
    const m = t.desc?.match(/at ([\d.]+)[×x]/);
    return m ? parseFloat(m[1]) : null;
  }).filter(v => v !== null && !isNaN(v));

  _setEl('st-avgmult', multVals.length > 0
    ? `${(multVals.reduce((a, b) => a + b, 0) / multVals.length).toFixed(2)}×`
    : '—');

  const pnl = st.totalWon - st.totalWagered;
  _setEl('st-pnl', `${pnl >= 0 ? '+' : '-'}$${fmt(Math.abs(pnl))}`);

  const pnlCard = document.getElementById('st-pnl-card');
  if (pnlCard) pnlCard.className = `stat-card ${pnl >= 0 ? 'sc-green' : 'sc-red'}`;

  const chartEl = document.getElementById('pnl-chart');
  if (chartEl) {
    const history = st.pnlHistory.slice(-30);
    if (history.length === 0) {
      chartEl.innerHTML = `<div class="chart-empty"><span class="ce-icon"></span>No round data yet</div>`;
    } else {
      const maxAbs = Math.max(...history.map(Math.abs), 1);
      chartEl.innerHTML = history.map(val => {
        const logH = val === 0 ? 4 : Math.round(4 + (Math.log(Math.abs(val) + 1) / Math.log(maxAbs + 1)) * 106);
        const cls  = val >= 0 ? 'pos' : 'neg';
        return `<div class="chart-bar ${cls}" style="height:${logH}px" data-val="${val >= 0 ? '+' : '-'}$${fmt(Math.abs(val))}"></div>`;
      }).join('');
    }
  }

  const dotsEl    = document.getElementById('streak-dots');
  const summaryEl = document.getElementById('streak-summary');
  const streak    = st.streakHistory.slice(-40);

  if (!dotsEl) return;

  if (streak.length === 0) {
    dotsEl.innerHTML = `<div class="empty-state" style="width:100%;padding:16px 0"><span class="es-icon"></span>Play some rounds to build your streak</div>`;
    if (summaryEl) summaryEl.textContent = '';
    return;
  }

  dotsEl.innerHTML = streak
    .map(r => `<div class="streak-dot ${r === 'w' ? 'win' : 'loss'}" title="${r === 'w' ? 'Win' : 'Loss'}"></div>`)
    .join('');

  if (summaryEl && streak.length > 0) {
    const last = streak[streak.length - 1];
    let run = 0;
    for (let i = streak.length - 1; i >= 0; i--) {
      if (streak[i] === last) run++; else break;
    }
    summaryEl.textContent = `${run} ${last === 'w' ? 'win' : 'loss'} streak`;
    summaryEl.style.color = last === 'w' ? 'var(--accent)' : 'var(--danger)';
  }
}


/* ============================================================
   TINY HELPERS
============================================================ */

function _setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}


/* ============================================================
   DOMContentLoaded
============================================================ */

document.addEventListener('DOMContentLoaded', () => {

  ['login-username', 'login-apikey'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') doLogin();
    });
  });

  document.addEventListener('click', e => {
    const dropdown = document.getElementById('mobile-nav-dropdown');
    const btn      = document.getElementById('mobile-menu-btn');
    if (dropdown?.classList.contains('open')) {
      if (!dropdown.contains(e.target) && !btn?.contains(e.target)) {
        dropdown.classList.remove('open');
      }
    }
  });

});
