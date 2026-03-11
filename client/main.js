'use strict';

/* ============================================================
   STATE
============================================================ */
const STATE = {
  loggedIn: false,
  user:   { id: 0, username: '', tornId: 0 },
  wallet: { balance: 0, totalDeposited: 0, totalWithdrawn: 0, transactions: [] },
  stats:  { rounds: 0, wins: 0, losses: 0, totalWagered: 0, totalWon: 0,
            bestMult: 0, biggestWin: 0, pnlHistory: [], streakHistory: [] },

  game: {
    // Server-authoritative
    phase:            'COOLDOWN',  // COOLDOWN | BETTING | RUNNING | CRASHED
    roundId:          0,
    phaseEndsAt:      null,        // Date | null
    runningStartedAt: null,        // Date | null — anchors client interpolation
    serverMult:       1.00,        // last multiplier from server

    // Derived / UI state
    myBet:        null,   // { amount, cashoutMult, payout, busted } | null
    cashedOut:    false,
    bustShown:    false,  // prevent showing bust message twice

    // Interpolation / polling
    pollId:  null,        // setInterval — polls server ~1s
    rafId:   null,        // requestAnimationFrame id

    // Sidebar
    activePlayers: [],
    roundHistory:  [],
    liveFeed:      [],
  },

  _token:      null,
  leaderboard: [],
};

/* ── Phase ordering (used to detect transitions) ──────────── */
const PHASE_ORDER = { COOLDOWN: 0, BETTING: 1, RUNNING: 2, CRASHED: 3 };


/* ============================================================
   SMOOTH MULTIPLIER INTERPOLATION
   Server writes multiplier every 100ms but HTTP round-trips
   take 200-500ms. We interpolate client-side at 60fps using
   the same formula as the game server.
   Formula: 1 + elapsed^1.5 * 0.25  (must match game-server/index.js)
============================================================ */
function calcMultiplierAt(startedAt) {
  if (!startedAt) return 1.00;
  const elapsedSec = Math.max(0, (Date.now() - startedAt.getTime()) / 1000);
  return 1 + Math.pow(elapsedSec, 1.5) * 0.25;
}

let _rafActive = false;

function startRenderLoop() {
  if (_rafActive) return;
  _rafActive = true;
  _rafTick();
}

function stopRenderLoop() {
  _rafActive = false;
}

function _rafTick() {
  if (!_rafActive) return;

  const G = STATE.game;

  if (G.phase === 'RUNNING' && G.runningStartedAt) {
    const interp = calcMultiplierAt(G.runningStartedAt);
    // Don't go above a sane cap while waiting for server crash confirmation
    G.multiplier = interp;

    _setMultDisplay(interp, false);
    _updateCheckpoints(interp);
    _setProgress(interp);

    // Auto cash-out: checked in RAF so it fires at the exact right multiplier
    if (G.myBet && !G.cashedOut) {
      const acoEnabled = document.getElementById('aco-enabled')?.checked;
      const acoVal     = parseFloat(document.getElementById('aco-value')?.value);
      if (acoEnabled && !isNaN(acoVal) && acoVal >= 1.01 && interp >= acoVal) {
        cashOut();
      }
    }
  }

  STATE.game.rafId = requestAnimationFrame(_rafTick);
}


/* ============================================================
   API LAYER
============================================================ */
async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(STATE._token ? { Authorization: `Bearer ${STATE._token}` } : {}),
    ...(options.headers ?? {}),
  };
  const resp = await fetch(path, { ...options, headers });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error ?? `Request failed (${resp.status})`);
  return data;
}
const apiGet  = path       => api(path, { method: 'GET' });
const apiPost = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });


/* ============================================================
   AUTH
============================================================ */
async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const apiKey   = document.getElementById('login-apikey').value.trim();
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('login-btn');

  errEl.classList.remove('show');
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

function showLoginError(el, msg) { el.textContent = msg; el.classList.add('show'); }

function logout() {
  if (!confirm('Log out of Torn Nexus?')) return;
  stopRenderLoop();
  if (STATE.game.pollId) clearInterval(STATE.game.pollId);
  STATE.loggedIn    = false;
  STATE._token      = null;
  STATE.user        = { id: 0, username: '', tornId: 0 };
  STATE.wallet      = { balance: 0, totalDeposited: 0, totalWithdrawn: 0, transactions: [] };
  STATE.game.phase  = 'COOLDOWN';
  STATE.game.pollId = null;
  STATE.game.runningStartedAt = null;
  document.getElementById('topbar').style.display = 'none';
  hideDemoBanner();
  showPage('login');
  showToast('Logged out.', 'info');
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
  } catch (e) { console.warn('[wallet sync]', e.message); }
}

async function refreshStatsFromServer() {
  try {
    const data = await apiGet('/api/game/history?type=history');
    let rounds = 0, wins = 0, losses = 0, totalWagered = 0, totalWon = 0;
    let bestMult = 0, biggestWin = 0;
    const pnlHistory = [], streakHistory = [];

    for (const r of data) {
      if (!r.myBet) continue;
      rounds++;
      const bet    = Number(r.myBet.amount);
      const payout = Number(r.myBet.payout);
      const mult   = r.myBet.cashoutMult ? parseFloat(r.myBet.cashoutMult) : null;
      totalWagered += bet;
      if (mult !== null) {
        wins++; totalWon += payout;
        const profit = payout - bet;
        pnlHistory.push(profit); streakHistory.push('w');
        if (mult > bestMult) bestMult = mult;
        if (profit > biggestWin) biggestWin = profit;
      } else {
        losses++;
        pnlHistory.push(-bet); streakHistory.push('l');
      }
    }

    STATE.stats = { rounds, wins, losses, totalWagered, totalWon, bestMult, biggestWin, pnlHistory, streakHistory };
    STATE.game.roundHistory = data.slice(0, 20).map(r => ({
      roundId: r.id,
      crash:   parseFloat(r.crashPoint),
      myPnl:   r.myBet
        ? (r.myBet.cashoutMult ? Number(r.myBet.payout) - Number(r.myBet.amount) : -Number(r.myBet.amount))
        : null,
    }));
  } catch (e) { console.warn('[stats sync]', e.message); }
}


/* ============================================================
   GAME POLLING
   Poll server every 1s for authoritative phase/roundId.
   Multiplier is interpolated at 60fps between polls.
============================================================ */
function startGamePolling() {
  if (STATE.game.pollId) clearInterval(STATE.game.pollId);
  pollGameState(); // immediate first poll
  STATE.game.pollId = setInterval(() => {
    if (STATE.loggedIn) pollGameState();
  }, 1000);
}

// Track previous state to detect changes cleanly
let _prev = { phase: '', roundId: 0 };

async function pollGameState() {
  let sv;
  try { sv = await apiGet('/api/game/state'); }
  catch { return; }

  const G           = STATE.game;
  const prevPhase   = G.phase;
  const prevRoundId = G.roundId;

  // ── Update authoritative state ──────────────────────────────
  G.phase       = sv.phase;
  G.roundId     = sv.roundId;
  G.phaseEndsAt = sv.phaseEndsAt ? new Date(sv.phaseEndsAt) : null;
  G.serverMult  = parseFloat(sv.multiplier);

  // ── Sync myBet from server (source of truth) ────────────────
  // Only update myBet if server has data — don't clobber optimistic state
  // during RUNNING phase where we set it locally on bet placement
  if (sv.myBet !== undefined) {
    if (sv.myBet === null && G.phase !== 'RUNNING') {
      // Server says no bet — clear local state (but not mid-round)
      if (G.phase === 'BETTING' && prevPhase === 'BETTING' && G.roundId === prevRoundId) {
        // Same round, same phase — keep local myBet (server lag)
      } else {
        G.myBet = null;
      }
    } else if (sv.myBet !== null) {
      // Server has bet data — sync it (cashout confirmation, bust detection)
      G.myBet = {
        amount:      Number(sv.myBet.amount),
        cashoutMult: sv.myBet.cashoutMult ? parseFloat(sv.myBet.cashoutMult) : null,
        payout:      Number(sv.myBet.payout),
        busted:      sv.myBet.busted ?? false,
      };
      if (G.myBet.cashoutMult) G.cashedOut = true;
    }
  }

  // ── Anchor interpolation clock when RUNNING starts ──────────
  if (G.phase === 'RUNNING') {
    if (sv.runningStartedAt) {
      const serverStart = new Date(sv.runningStartedAt);
      if (!G.runningStartedAt) {
        // First time seeing RUNNING — anchor exactly to server's start time
        G.runningStartedAt = serverStart;
      } else {
        // Already running — drift-correct if off by more than 3%
        const interp = calcMultiplierAt(G.runningStartedAt);
        const drift  = Math.abs(interp - G.serverMult) / Math.max(G.serverMult, 1);
        if (drift > 0.03) {
          G.runningStartedAt = serverStart;
        }
      }
    } else if (!G.runningStartedAt) {
      // Fallback: back-calculate from server multiplier
      const sm = G.serverMult;
      if (sm > 1.001) {
        const elapsed = Math.pow((sm - 1) / 0.25, 2 / 3);
        G.runningStartedAt = new Date(Date.now() - elapsed * 1000);
      } else {
        G.runningStartedAt = new Date();
      }
    }
  } else {
    // Not running — clear anchor, RAF will stop interpolating
    G.runningStartedAt = null;
    // Update display directly for non-running phases
    const crashed = G.phase === 'CRASHED';
    _setMultDisplay(G.serverMult, crashed);
    _updateCheckpoints(G.serverMult);
    _setProgress(G.phase === 'BETTING' || G.phase === 'COOLDOWN' ? 0 : G.serverMult);
  }

  // ── New round detection (roundId changed) ───────────────────
  if (G.roundId !== prevRoundId && G.roundId > 0) {
    _onNewRound(G.roundId);
  }

  // ── Phase change detection ───────────────────────────────────
  if (G.phase !== prevPhase) {
    _onPhaseChange(G.phase, prevPhase, G.roundId);
  }

  // ── Always update controls + topbar ─────────────────────────
  updateBetControls();
  syncTopbar();
  _updatePhaseTimer();
}

function _onNewRound(roundId) {
  const G = STATE.game;
  // Reset per-round client state — but only if this is genuinely a new round
  G.cashedOut = false;
  G.bustShown = false;
  // Don't clear myBet here — it gets cleared when phase → BETTING
  _resetCheckpoints();
  _setProgress(0);
}

function _onPhaseChange(newPhase, prevPhase, roundId) {
  const G = STATE.game;

  if (newPhase === 'COOLDOWN') {
    _setPhaseTag('cooldown', 'Next Round Soon');
    _setMultDisplay(1.00, false);
    _resetCheckpoints();
    _setProgress(0);
    document.querySelector('.arena-panel')?.classList.remove('is-live', 'is-crashed');

    // Show bust message here if we missed it during CRASHED phase
    // (handles the case where client polled RUNNING → COOLDOWN directly)
    if (G.myBet && !G.cashedOut && !G.myBet?.cashoutMult && !G.bustShown) {
      _showBustMessage(G.myBet.amount, G.serverMult);
    }
  }

  if (newPhase === 'BETTING') {
    _setPhaseTag('betting', 'Betting Open');
    _setMultDisplay(1.00, false);
    _resetCheckpoints();
    _setProgress(0);
    document.querySelector('.arena-panel')?.classList.remove('is-live', 'is-crashed');
    // New round is open — clear previous round's bet state
    G.myBet     = null;
    G.cashedOut = false;
    G.bustShown = false;
    const statusEl = document.getElementById('bet-status');
    if (statusEl) {
      statusEl.className   = 'bet-status';
      statusEl.textContent = 'Place your bet before the round starts.';
    }
    renderActivePlayers();
  }

  if (newPhase === 'RUNNING') {
    _setPhaseTag('running', 'Round Live');
    const timerEl = document.getElementById('phase-timer');
    if (timerEl) timerEl.textContent = '';
    document.querySelector('.arena-panel')?.classList.remove('is-crashed');
    document.querySelector('.arena-panel')?.classList.add('is-live');
  }

  if (newPhase === 'CRASHED') {
    _setPhaseTag('crashed', 'Crashed');
    document.querySelector('.arena-panel')?.classList.remove('is-live');
    document.querySelector('.arena-panel')?.classList.add('is-crashed');
    _setMultDisplay(G.serverMult, true);

    const timerEl = document.getElementById('phase-timer');
    if (timerEl) timerEl.textContent = `Crashed at ${G.serverMult.toFixed(2)}×`;

    // Show bust message if player had an active bet and didn't cash out
    if (G.myBet && !G.cashedOut && !G.myBet?.cashoutMult && !G.bustShown) {
      _showBustMessage(G.myBet.amount, G.serverMult);
    }

    // Refresh wallet + stats after crash
    setTimeout(async () => {
      await refreshWalletFromServer();
      await refreshStatsFromServer();
      updateAllUI();
      renderRoundHistory();
      pushToLiveFeed(roundId, G.serverMult);
      if (document.getElementById('page-stats')?.classList.contains('active')) renderStats();
    }, 500);

    renderActivePlayers(true);
  }

  updateBetControls();
}

function _showBustMessage(amount, crashMult) {
  const G = STATE.game;
  G.bustShown = true;
  const lost     = Number(amount ?? 0);
  const statusEl = document.getElementById('bet-status');
  if (statusEl && lost > 0) {
    statusEl.className   = 'bet-status busted';
    statusEl.textContent = `💀 Busted at ${crashMult.toFixed(2)}× — lost $${fmt(lost)}`;
    showResultFlash('loss', `-$${fmt(lost)}`);
  }
}

function _updatePhaseTimer() {
  const G      = STATE.game;
  const timerEl = document.getElementById('phase-timer');
  if (!timerEl) return;

  if (!G.phaseEndsAt || G.phase === 'RUNNING' || G.phase === 'CRASHED') return;

  const secsLeft = Math.max(0, Math.ceil((G.phaseEndsAt - Date.now()) / 1000));

  if (G.phase === 'BETTING') {
    timerEl.textContent = secsLeft > 0 ? `Round starts in ${secsLeft}s` : 'Launching…';
  } else if (G.phase === 'COOLDOWN') {
    timerEl.textContent = secsLeft > 0 ? `Next round in ${secsLeft}s` : 'Starting…';
  }
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
   TOPBAR
============================================================ */
function syncTopbar() {
  document.getElementById('topbar-balance').textContent  = `$${fmt(STATE.wallet.balance)}`;
  document.getElementById('topbar-username').textContent = STATE.user.username || '—';
}
function toggleMobileNav() { document.getElementById('mobile-nav-dropdown')?.classList.toggle('open'); }
function closeMobileNav()  { document.getElementById('mobile-nav-dropdown')?.classList.remove('open'); }
function showDemoBanner()  { document.getElementById('demo-banner')?.classList.add('show'); }
function hideDemoBanner()  { document.getElementById('demo-banner')?.classList.remove('show'); }


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
  if (s <  5)    return 'just now';
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}


/* ============================================================
   TOAST
============================================================ */
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons     = { success: '✓', error: '✕', info: 'ℹ️' };
  const toast     = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] ?? '·'}</span><span class="toast-msg">${msg}</span>`;
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

  feedEl.innerHTML = feed.length === 0
    ? `<div class="empty-state"><span class="es-icon">📡</span>Waiting for round activity…</div>`
    : feed.slice(0, 12).map(e => {
        const isWin = e.pnl > 0;
        const txt   = isWin ? `+$${fmt(e.pnl)} @ ${e.crash.toFixed(2)}×` : `BUST @ ${e.crash.toFixed(2)}×`;
        return `<div class="bet-item">
          <div class="bi-avatar">${(e.username||'?')[0].toUpperCase()}</div>
          <span class="bi-user">${e.username}</span>
          <span class="bi-result ${isWin?'win':'loss'}">${txt}</span>
          <span class="bi-time">${timeAgo(e.time)}</span>
        </div>`;
      }).join('');

  const seen = new Set(), rounds = [];
  for (const e of feed) {
    if (!seen.has(e.roundId)) { seen.add(e.roundId); rounds.push(e); if (rounds.length >= 8) break; }
  }

  if (rounds.length === 0) {
    recentEl.innerHTML = `<div class="empty-state"><span class="es-icon">🎮</span>No rounds played yet</div>`;
    if (countEl) countEl.textContent = '';
  } else {
    if (countEl) countEl.textContent = `${rounds.length} rounds`;
    recentEl.innerHTML = rounds.map(e => {
      const cls = e.crash >= 3 ? 'high' : e.crash >= 1.5 ? 'mid' : 'low';
      return `<div class="game-row">
        <span class="gr-round">Round #${e.roundId}</span>
        <span class="gr-mult ${cls}">${e.crash.toFixed(2)}×</span>
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
  if (homePnlEl)   homePnlEl.textContent   = `${pnl >= 0 ? '+' : '-'}$${fmt(Math.abs(pnl))}`;
  if (homePnlCard) homePnlCard.className   = `stat-card ${pnl >= 0 ? 'sc-green' : 'sc-red'}`;
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
  if (msg) { el.textContent = msg; el.style.display = 'block'; el.classList.add('show'); }
  else     { el.style.display = 'none'; el.classList.remove('show'); el.textContent = ''; }
}

function _walletBusy(busy) {
  const dep  = document.getElementById('btn-deposit');
  const wdw  = document.getElementById('btn-withdraw');
  if (dep) dep.disabled  = busy;
  if (wdw) wdw.disabled  = busy;
}

async function doDeposit() {
  _walletError(null);
  const amount = parseFloat(document.getElementById('wallet-amount').value);
  if (isNaN(amount) || amount <= 0) return _walletError('Please enter a valid amount.');
  if (amount < 1000)                return _walletError('Minimum deposit is $1,000.');
  _walletBusy(true);
  showToast('Scanning house account for your transfer…', 'info');
  try {
    const data = await apiPost('/api/wallet/deposit', { amount });
    STATE.wallet.balance = Number(data.balance);
    await refreshWalletFromServer();
    updateAllUI(); refreshWalletUI();
    document.getElementById('wallet-amount').value = '';
    showToast(data.message, 'success');
  } catch (e) { _walletError(e.message); }
  finally     { _walletBusy(false); }
}

async function doWithdraw() {
  _walletError(null);
  const amount = parseFloat(document.getElementById('wallet-amount').value);
  if (isNaN(amount) || amount <= 0) return _walletError('Please enter a valid amount.');
  if (amount < 1000)                return _walletError('Minimum withdrawal is $1,000.');
  if (amount > STATE.wallet.balance) return _walletError(`Insufficient balance. You have $${fmt(STATE.wallet.balance)}.`);
  _walletBusy(true);
  showToast('Processing withdrawal…', 'info');
  try {
    const data = await apiPost('/api/wallet/withdraw', { amount });
    STATE.wallet.balance = Number(data.balance);
    await refreshWalletFromServer();
    updateAllUI(); refreshWalletUI();
    document.getElementById('wallet-amount').value = '';
    showToast(data.message, 'success');
  } catch (e) { _walletError(e.message); }
  finally     { _walletBusy(false); }
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
    deposit: { el: '↓', cls: 'dep' }, withdrawal: { el: '↑', cls: 'with' },
    bet_win: { el: '★', cls: 'win' }, bet_loss:   { el: '✕', cls: 'loss' },
  };
  listEl.innerHTML = txs.map(tx => {
    const ic    = iconMap[tx.type] ?? { el: '·', cls: '' };
    const isPos = tx.type === 'deposit' || tx.type === 'bet_win';
    const pend  = tx.status === 'PENDING';
    return `<div class="tx-item">
      <div class="tx-icon ${ic.cls}">${ic.el}</div>
      <div class="tx-info">
        <div class="tx-desc">${tx.desc}${pend ? ' <span style="color:var(--warn);font-size:10px">[PENDING]</span>' : ''}</div>
        <div class="tx-time">${timeAgo(tx.time)}</div>
      </div>
      <div class="tx-amount ${isPos ? 'pos' : 'neg'}">${isPos ? '+' : '-'}$${fmt(tx.amount)}</div>
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

  if (G.phase !== 'BETTING')          { showToast('Betting is closed for this round.', 'error'); return; }
  if (G.myBet)                        { showToast('You already have a bet this round.', 'error'); return; }
  if (isNaN(raw) || raw < 100)        { showToast('Minimum bet is $100.', 'error'); return; }
  if (raw > STATE.wallet.balance)     { showToast('Insufficient balance.', 'error'); return; }

  try {
    const data = await apiPost('/api/game/bet', { amount: raw });
    STATE.wallet.balance = Number(data.balance);
    G.myBet = { amount: raw, cashoutMult: null, payout: 0, busted: false };
    syncTopbar();
    const statusEl = document.getElementById('bet-status');
    if (statusEl) {
      statusEl.className   = 'bet-status active-bet';
      statusEl.textContent = `⚡ Bet placed: $${fmt(raw)} — cash out before it crashes!`;
    }
    updateBetControls();
    showToast(`Bet of $${fmt(raw)} placed!`, 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function cashOut() {
  const G = STATE.game;
  if (G.phase !== 'RUNNING')  { showToast('Round not in progress.', 'error'); return; }
  if (!G.myBet)               { showToast('No active bet.', 'error'); return; }
  if (G.cashedOut)            { return; }

  // Optimistic lock — prevents double-tap
  G.cashedOut = true;
  updateBetControls();

  try {
    const data   = await apiPost('/api/game/cashout', {});
    const mult   = parseFloat(data.cashoutMult);
    const profit = Number(data.profit);
    STATE.wallet.balance = Number(data.balance);
    G.myBet = { ...G.myBet, cashoutMult: mult, payout: Number(data.payout) };

    const statusEl = document.getElementById('bet-status');
    if (statusEl) {
      statusEl.className   = 'bet-status cashed-out';
      statusEl.textContent = `✓ Cashed out at ${mult.toFixed(2)}× — won $${fmt(profit)}!`;
    }
    showResultFlash('win', `+$${fmt(profit)}`);
    syncTopbar();

    // Optimistic stats update
    STATE.stats.wins++;
    STATE.stats.rounds++;
    STATE.stats.totalWon     += Number(data.payout);
    STATE.stats.totalWagered += G.myBet.amount;
    if (mult > STATE.stats.bestMult)     STATE.stats.bestMult   = mult;
    if (profit > STATE.stats.biggestWin) STATE.stats.biggestWin = profit;
    updateAllUI();
    if (document.getElementById('page-stats')?.classList.contains('active')) renderStats();

  } catch (e) {
    // Server rejected — revert optimistic lock
    G.cashedOut = false;
    updateBetControls();
    showToast(e.message, 'error');
  }
}


/* ============================================================
   NPC PLAYERS (visual only)
============================================================ */
const NPC_NAMES = [
  'Phantom_X','VoidRunner','Kira_J','TornKing99','Blitz',
  'NightHawk','CryptoViper','Renegade_K','Ghost404','Apex_Z','DarkMatter','ZeroHour',
];

function generateFakePlayers() {
  const count = 3 + Math.floor(Math.random() * 6);
  return [...NPC_NAMES].sort(() => Math.random() - 0.5).slice(0, count).map(name => ({
    name, bet: Math.floor(5_000 + Math.random() * 500_000),
    isMe: false, status: 'active',
    autoCashout: parseFloat((1.2 + Math.random() * 4.8).toFixed(2)),
  }));
}

function maybeAutoFakeCashouts(mult) {
  let changed = false;
  STATE.game.activePlayers.forEach(p => {
    if (p.isMe || p.status !== 'active') return;
    const overTarget = mult >= p.autoCashout;
    if (Math.random() < (overTarget ? 0.18 : 0.015)) {
      p.status = 'cashed'; p.multAt = mult; changed = true;
    }
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
    el.innerHTML = `<div class="empty-state" style="padding:24px 16px"><span class="es-icon">🕐</span>No rounds yet</div>`;
    return;
  }
  el.innerHTML = history.map(r => {
    const cls = r.crash >= 3 ? 'high' : r.crash >= 1.5 ? 'mid' : 'low';
    let pnlHtml = '<span class="rh-pnl none">—</span>';
    if (r.myPnl != null) {
      const sign = r.myPnl >= 0 ? '+' : '-';
      pnlHtml = `<span class="rh-pnl ${r.myPnl >= 0 ? 'win' : 'loss'}">${sign}$${fmt(Math.abs(r.myPnl))}</span>`;
    }
    return `<div class="rh-item">
      <span class="rh-round">#${r.roundId}</span>
      <span class="rh-mult ${cls}">${r.crash.toFixed(2)}×</span>
      ${pnlHtml}
    </div>`;
  }).join('');
}

function renderActivePlayers(crashed = false) {
  const el = document.getElementById('active-players');
  if (!el) return;
  const G = STATE.game;

  if (G.phase === 'BETTING' && !crashed) {
    G.activePlayers = generateFakePlayers();
    if (G.myBet) {
      G.activePlayers.unshift({ name: STATE.user.username, bet: G.myBet.amount, isMe: true, status: 'active' });
    }
  }
  if (G.phase === 'RUNNING') maybeAutoFakeCashouts(G.serverMult);

  const players = G.activePlayers;
  if (players.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:24px 16px"><span class="es-icon">⌛</span>Waiting for next round</div>`;
    return;
  }
  el.innerHTML = players.map(p => {
    const eff = (crashed && p.status === 'active') ? 'lost' : p.status;
    const statusHtml = eff === 'active'
      ? `<span class="ap-status active">IN</span>`
      : eff === 'cashed'
        ? `<span class="ap-status cashed">✓ ${p.multAt?.toFixed(2) ?? '?'}×</span>`
        : `<span class="ap-status lost">✕ BUST</span>`;
    return `<div class="ap-item ${p.isMe ? 'is-me' : ''}">
      <div class="ap-avatar">${(p.name||'?')[0].toUpperCase()}</div>
      <span class="ap-name">${p.isMe ? '▶ ' : ''}${p.name}</span>
      <span class="ap-bet">$${fmt(p.bet)}</span>
      ${statusHtml}
    </div>`;
  }).join('');
}

function pushToLiveFeed(roundId, crash) {
  const G = STATE.game;
  let pnl = 0;
  if (G.myBet?.cashoutMult) pnl = Math.floor(G.myBet.amount * G.myBet.cashoutMult) - G.myBet.amount;
  G.liveFeed.unshift({ roundId, crash, username: STATE.user.username, pnl, time: Date.now() });
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

  const canBet      = G.phase === 'BETTING' && !G.myBet;
  const showCashout = G.phase === 'RUNNING' && G.myBet && !G.cashedOut;

  if (showCashout) {
    betBtn.style.display  = 'none';
    cashBtn.style.display = 'inline-flex';
    cashBtn.disabled      = false;
    betInput.disabled     = true;
  } else {
    betBtn.style.display  = 'inline-flex';
    cashBtn.style.display = 'none';
    betInput.disabled     = !canBet;
    betBtn.disabled       = !canBet;
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
  if (crashed) { el.className = 'mult-value crashed'; sub.textContent = 'CRASHED'; return; }
  el.className    = mult < 1.5 ? 'mult-value green' : mult < 3 ? 'mult-value gold' : 'mult-value red';
  sub.textContent = STATE.game.phase === 'RUNNING' ? 'LIVE' : 'WAITING FOR ROUND';
}

function _resetCheckpoints() {
  document.querySelectorAll('#checkpoints .checkpoint').forEach(cp => cp.className = 'checkpoint');
}

function _updateCheckpoints(mult) {
  document.querySelectorAll('#checkpoints .checkpoint').forEach(cp => {
    cp.className = mult >= parseFloat(cp.dataset.target) ? 'checkpoint reached' : 'checkpoint';
  });
}

function _setProgress(mult) {
  const fill = document.getElementById('progress-fill');
  if (!fill) return;
  const pct = mult <= 1 ? 0 : Math.min(100, (Math.log(mult) / Math.log(10)) * 100);
  fill.style.width = `${pct}%`;
  fill.className   = mult < 1.5 ? 'progress-fill green' : mult < 3 ? 'progress-fill gold' : 'progress-fill red';
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
  } catch (e) { console.warn('[leaderboard]', e.message); }
}

function seedLeaderboard() {
  const names = ['Phantom_X','VoidRunner','TornKing99','Blitz','NightHawk','CryptoViper','Renegade_K','Ghost404'];
  STATE.leaderboard = names.map(name => {
    const rounds  = 50 + Math.floor(Math.random() * 501);
    const wins    = Math.round(rounds * (0.35 + Math.random() * 0.25));
    const wagered = Math.round(rounds * (15_000 + Math.random() * 185_000));
    const profit  = Math.round(wagered * ((Math.random() < 0.55 ? 1 : -1) * (0.10 + Math.random() * 0.20)));
    return { username: name, isMe: false, rounds, wins, wagered, profit, bestMult: parseFloat((1.5 + Math.random() * 15).toFixed(2)) };
  });
}

function renderLeaderboard(sortBy = 'profit') {
  _currentLbSort = sortBy;
  const sorted = [...STATE.leaderboard].sort((a, b) =>
    sortBy === 'wins' ? b.wins - a.wins : sortBy === 'wagered' ? b.wagered - a.wagered : b.profit - a.profit
  );
  const tbody = document.getElementById('lb-tbody');
  if (!tbody) return;
  tbody.innerHTML = sorted.map((entry, i) => {
    const rank    = i + 1;
    const rankCls = rank === 1 ? 'r1' : rank === 2 ? 'r2' : rank === 3 ? 'r3' : 'rn';
    const wr      = entry.rounds > 0 ? Math.round((entry.wins / entry.rounds) * 100) : 0;
    const pSign   = entry.profit >= 0 ? '+' : '-';
    const pCls    = entry.profit >= 0 ? 'pos' : 'neg';
    return `<tr class="${entry.isMe ? 'lb-me-row' : ''}">
      <td><span class="rank-badge ${rankCls}">${rank}</span></td>
      <td>${entry.isMe ? '<span class="lb-me-star">▶</span>' : ''}<span class="lb-player-name ${entry.isMe ? 'lb-me' : ''}">${entry.username}</span></td>
      <td>${entry.rounds.toLocaleString()}</td>
      <td class="lb-wins">${entry.wins.toLocaleString()}</td>
      <td><div class="lb-wr-wrap"><div class="lb-wr-bar"><div class="lb-wr-fill" style="width:${Math.min(100,wr)}%"></div></div><span>${wr}%</span></div></td>
      <td>$${fmt(entry.wagered)}</td>
      <td class="lb-profit ${pCls}">${pSign}$${fmt(Math.abs(entry.profit))}</td>
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
  const wr  = st.rounds > 0 ? Math.round((st.wins / st.rounds) * 100) : 0;
  _setEl('st-winrate',  `${wr}%`);
  _setEl('st-wl',       `${st.wins}W / ${st.losses}L`);
  _setEl('st-bestmult', st.bestMult > 0 ? `${st.bestMult.toFixed(2)}×` : '—');

  const multVals = txs.filter(t => t.type === 'bet_win').map(t => {
    const m = t.desc?.match(/at ([\d.]+)[×x]/);
    return m ? parseFloat(m[1]) : null;
  }).filter(v => v !== null && !isNaN(v));

  _setEl('st-avgmult', multVals.length > 0
    ? `${(multVals.reduce((a, b) => a + b, 0) / multVals.length).toFixed(2)}×` : '—');

  const pnl     = st.totalWon - st.totalWagered;
  _setEl('st-pnl', `${pnl >= 0 ? '+' : '-'}$${fmt(Math.abs(pnl))}`);
  const pnlCard = document.getElementById('st-pnl-card');
  if (pnlCard) pnlCard.className = `stat-card ${pnl >= 0 ? 'sc-green' : 'sc-red'}`;

  const chartEl = document.getElementById('pnl-chart');
  if (chartEl) {
    const history = st.pnlHistory.slice(-30);
    chartEl.innerHTML = history.length === 0
      ? `<div class="chart-empty"><span class="ce-icon">📊</span>No round data yet</div>`
      : (() => {
          const maxAbs = Math.max(...history.map(Math.abs), 1);
          return history.map(val => {
            const logH = val === 0 ? 4 : Math.round(4 + (Math.log(Math.abs(val)+1) / Math.log(maxAbs+1)) * 106);
            return `<div class="chart-bar ${val >= 0 ? 'pos' : 'neg'}" style="height:${logH}px" data-val="${val >= 0 ? '+' : '-'}$${fmt(Math.abs(val))}"></div>`;
          }).join('');
        })();
  }

  const dotsEl    = document.getElementById('streak-dots');
  const summaryEl = document.getElementById('streak-summary');
  const streak    = st.streakHistory.slice(-40);
  if (!dotsEl) return;

  if (streak.length === 0) {
    dotsEl.innerHTML = `<div class="empty-state" style="width:100%;padding:16px 0"><span class="es-icon">🎯</span>Play some rounds to build your streak</div>`;
    if (summaryEl) summaryEl.textContent = '';
    return;
  }

  dotsEl.innerHTML = streak.map(r =>
    `<div class="streak-dot ${r === 'w' ? 'win' : 'loss'}" title="${r === 'w' ? 'Win' : 'Loss'}"></div>`
  ).join('');

  if (summaryEl) {
    const last = streak[streak.length - 1];
    let run = 0;
    for (let i = streak.length - 1; i >= 0 && streak[i] === last; i--) run++;
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
