'use strict';

/* ============================================================
   CONSTANTS — must match game-server/index.js exactly
============================================================ */
// mult(t) = 1 + 0.25 * t^1.5
function calcMultiplierAt(startedAtMs) {
  const elapsed = Math.max(0, (Date.now() - startedAtMs) / 1000);
  return 1 + Math.pow(elapsed, 1.5) * 0.25;
}

// Inverse: given mult, solve for elapsed seconds
// t = ((mult - 1) / 0.25) ^ (2/3)
function elapsedFromMult(mult) {
  if (mult <= 1) return 0;
  return Math.pow((mult - 1) / 0.25, 2 / 3);
}


/* ============================================================
   STATE
============================================================ */
const STATE = {
  loggedIn: false,
  user:   { id: 0, username: '', tornId: 0 },
  wallet: { balance: 0, totalDeposited: 0, totalWithdrawn: 0, transactions: [] },
  stats:  { rounds: 0, wins: 0, losses: 0, totalWagered: 0, totalWon: 0, bestMult: 0, biggestWin: 0, pnlHistory: [], streakHistory: [] },
  _token: null,
  leaderboard: [],

  game: {
    // Server-authoritative fields
    phase:            'WAITING',  // BETTING | RUNNING | CRASHED | COOLDOWN | WAITING
    roundId:          0,
    phaseEndsAt:      null,       // Date
    myBet:            null,       // { amount, cashoutMult, payout, busted } | null

    // Interpolation anchor — set once when RUNNING starts, never jittered
    runningStartedAtMs: null,     // number (ms timestamp), null when not running

    // drift smoothing helpers (see _rafTick/_pollOnce)
    _anchorTargetMs:  null,
    _pendingDrift:    0,

    // Derived / UI state
    cashedOut:     false,
    activePlayers: [],
    roundHistory:  [],
    liveFeed:      [],

    // Loop handles
    pollId: null,
    rafId:  null,
  },
};


/* ============================================================
   RENDER LOOP — 60fps, driven by requestAnimationFrame
   Only the multiplier display is updated here.
   Everything else (phase, bet status) is updated on poll.
============================================================ */
let _rafActive = false;

function startRenderLoop() {
  if (_rafActive) return;
  _rafActive = true;
  _rafTick();
}

function stopRenderLoop() {
  _rafActive = false;
  if (STATE.game.rafId) cancelAnimationFrame(STATE.game.rafId);
  STATE.game.rafId = null;
}

function _rafTick() {
  if (!_rafActive) return;

  const G = STATE.game;

  if (G.phase === 'RUNNING' && G.runningStartedAtMs !== null) {
    let mult = calcMultiplierAt(G.runningStartedAtMs);

    // if we have a pending drift adjustment, ease it in over a few frames
    if (G._pendingDrift && Math.abs(G._pendingDrift) > 0.0001) {
      // move 20% of the remaining offset per tick (≈ 60fps) so corrections
      // are noticeable but not jarring
      const adjustment = G._pendingDrift * 0.2;
      mult += adjustment;
      G._pendingDrift -= adjustment;
      if (Math.abs(G._pendingDrift) < 0.0001) G._pendingDrift = 0;
    }

    _renderMult(mult, false);
    _updateCheckpoints(mult);
    _setProgress(mult);

    // Auto cash-out check
    const acoEnabled = document.getElementById('aco-enabled')?.checked;
    const acoVal     = parseFloat(document.getElementById('aco-value')?.value);
    if (acoEnabled && !isNaN(acoVal) && G.myBet && !G.cashedOut && mult >= acoVal) {
      cashOut();
    }
  }

  G.rafId = requestAnimationFrame(_rafTick);
}


/* ============================================================
   API
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
  errEl.textContent = '';

  if (!username)        return _showLoginErr(errEl, 'Please enter your Torn username.');
  if (!apiKey)          return _showLoginErr(errEl, 'Please enter your Torn API key.');
  if (apiKey.length < 16) return _showLoginErr(errEl, 'API key looks too short.');

  btn.disabled  = true;
  btn.innerHTML = '<span class="btn-spinner"></span> VERIFYING…';

  try {
    const data   = await apiPost('/api/auth/login', { username, apiKey });
    STATE._token = data.token;
    await _onLoginSuccess(data.user);
  } catch (err) {
    btn.disabled  = false;
    btn.innerHTML = 'ACCESS NEXUS';
    _showLoginErr(errEl, err.message);
  }
}

async function _onLoginSuccess(user) {
  STATE.loggedIn      = true;
  STATE.user.id       = user.id;
  STATE.user.username = user.username;
  STATE.user.tornId   = user.tornId;
  STATE.wallet.balance = Number(user.balance);

  await refreshWallet();
  await refreshStats();

  document.getElementById('topbar').style.display = 'flex';
  updateVerificationUI(true);
  startPoll();
  startRenderLoop();
  seedLeaderboard();
  navigate('home');
  updateAllUI();
  showToast(`Welcome back, ${STATE.user.username}!`, 'success');

  const btn = document.getElementById('login-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = 'ACCESS NEXUS'; }
}

function _showLoginErr(el, msg) {
  el.textContent = msg;
  el.classList.add('show');
}

function logout() {
  if (!confirm('Log out of Torn Nexus?')) return;
  stopRenderLoop();
  if (STATE.game.pollId) clearInterval(STATE.game.pollId);

  STATE.loggedIn       = false;
  STATE._token         = null;
  STATE.user           = { id: 0, username: '', tornId: 0 };
  STATE.wallet         = { balance: 0, totalDeposited: 0, totalWithdrawn: 0, transactions: [] };
  STATE.game.phase     = 'WAITING';
  STATE.game.pollId    = null;
  STATE.game.runningStartedAtMs = null;

  document.getElementById('topbar').style.display = 'none';
  hideDemoBanner();
  showPage('login');
  showToast('Logged out successfully.', 'info');
}


/* ============================================================
   SERVER SYNC
============================================================ */
async function refreshWallet() {
  try {
    const data = await apiGet('/api/wallet');
    STATE.wallet.balance        = Number(data.balance);
    STATE.wallet.totalDeposited = Number(data.totalDeposited);
    STATE.wallet.totalWithdrawn = Number(data.totalWithdrawn);
    STATE.wallet.transactions   = (data.transactions ?? []).map(tx => ({
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

async function refreshStats() {
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
        wins++;
        totalWon += payout;
        const profit = payout - bet;
        pnlHistory.push(profit);
        streakHistory.push('w');
        if (mult   > bestMult)   bestMult   = mult;
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
   GAME POLLING
   - Poll server every 750ms for authoritative phase/bet state
   - Multiplier is NEVER taken from the server during RUNNING;
     it is always interpolated client-side using runningStartedAtMs
   - runningStartedAtMs is anchored ONCE when RUNNING begins and
     never modified again until the phase ends (no jitter)
============================================================ */
let _prevPhase   = '';
let _prevRoundId = 0;

function startPoll() {
  if (STATE.game.pollId) clearInterval(STATE.game.pollId);
  _pollOnce();
  STATE.game.pollId = setInterval(() => {
    if (STATE.loggedIn) _pollOnce();
  }, 750);
}

async function _pollOnce() {
  let sv;
  try { sv = await apiGet('/api/game/state'); }
  catch { return; }

  const G         = STATE.game;
  const now       = Date.now();
  const prevPhase = G.phase;

  // Always update phase/round/bet from server
  G.phase      = sv.phase;
  G.roundId    = sv.roundId;
  G.phaseEndsAt = sv.phaseEndsAt ? new Date(sv.phaseEndsAt) : null;

  // Update myBet only if we don't have a local pending cashout
  // (avoids the server's stale null overwriting our optimistic state)
  if (!G.cashedOut || sv.myBet?.cashoutMult) {
    G.myBet = sv.myBet ?? null;
  }
  if (G.myBet?.cashoutMult) G.cashedOut = true;

  // ── Interpolation anchor management ──────────────────────────────────────
  if (sv.phase === 'RUNNING') {
    if (prevPhase !== 'RUNNING') {
      // RUNNING just started — compute anchor from server's runningStartedAt
      if (sv.runningStartedAt) {
        // Server tells us exactly when it started — use that directly
        G.runningStartedAtMs = new Date(sv.runningStartedAt).getTime();
      } else {
        // Fall back: back-calculate from server multiplier
        const serverMult = parseFloat(sv.multiplier);
        const elapsed    = elapsedFromMult(Math.max(serverMult, 1.001));
        G.runningStartedAtMs = now - elapsed * 1000;
      }
    }

    // Do NOT update runningStartedAtMs on most polls — let it stay anchored.
    // We *only* ever correct if the client is clearly BEHIND the server
    // (serverMult noticeably higher). We never jump the multiplier backwards.
    // drift corrections used to be instantaneous which made the animation
    // feel jumpy on slow connections. instead we store a pending adjustment
    // and ease it into the render loop.
    const clientMult = calcMultiplierAt(G.runningStartedAtMs);
    const serverMult = parseFloat(sv.multiplier);
    if (serverMult > 1 && clientMult < serverMult) {
      const drift = (serverMult - clientMult) / serverMult;
      if (drift > 0.08) {
        // compute the new anchor but don't apply it immediately; keep the
        // amount we need to accelerate by and let _rafTick merge it in
        const elapsed = elapsedFromMult(serverMult);
        G._anchorTargetMs = now - elapsed * 1000;
        G._pendingDrift = (G._anchorTargetMs - G.runningStartedAtMs) || 0;
        console.warn(`[poll] Drift ${(drift * 100).toFixed(1)}% — will ease forward`);
      }
    }
  } else {
    // Not running — clear anchor and always show 1× while bets are open.
    // previously we showed the last crash value during COOLDOWN which led to
    // a big backwards jump when the next round began; just hard‑reset to 1.00
    // so the curve always starts from a known baseline.
    G.runningStartedAtMs = null;
    STATE.game._anchorTargetMs = null;
    STATE.game._pendingDrift = 0;

    const mult = sv.phase === 'CRASHED'
      ? parseFloat(sv.multiplier) // show crash value for a moment
      : 1.00;                    // otherwise just show 1×

    _renderMult(mult, sv.phase === 'CRASHED');
    _updateCheckpoints(mult);
    _setProgress(mult);
  }

  // ── Phase change handling ─────────────────────────────────────────────────
  if (sv.phase !== _prevPhase) {
    _onPhaseChange(sv.phase, sv.roundId, sv);
    _prevPhase = sv.phase;
  }

  if (sv.roundId !== _prevRoundId && sv.roundId > 0) {
    _prevRoundId = sv.roundId;
  }

  // ── Countdown timer ───────────────────────────────────────────────────────
  _updateTimer(sv.phase, G.phaseEndsAt);

  updateBetControls();
  syncTopbar();
}

function _updateTimer(phase, phaseEndsAt) {
  const timerEl = document.getElementById('phase-timer');
  if (!timerEl || !phaseEndsAt) return;
  const secsLeft = Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000));

  if (phase === 'BETTING') {
    timerEl.textContent = secsLeft > 0 ? `Round starts in ${secsLeft}s` : 'Launching…';
  } else if (phase === 'COOLDOWN' || phase === 'CRASHED') {
    timerEl.textContent = secsLeft > 0 ? `Next round in ${secsLeft}s` : 'Starting…';
  } else if (phase === 'RUNNING') {
    timerEl.textContent = '';
  }
}

function _onPhaseChange(phase, roundId, sv = {}) {
  const G = STATE.game;

  if (phase === 'BETTING') {
    // New round — safe to reset all round-local state
    G.cashedOut    = false;
    G.myBet        = sv.myBet ?? null;
    _resetCheckpoints();
    _setProgress(1);
    _renderMult(1.00, false);
    _setPhaseTag('betting', 'Betting Open');
    document.querySelector('.arena-panel')?.classList.remove('is-live', 'is-crashed');
    const statusEl = document.getElementById('bet-status');
    if (statusEl && !G.myBet) {
      statusEl.className   = 'bet-status';
      statusEl.textContent = 'Place your bet before the round starts.';
    }
    renderActivePlayers();
    updateBetControls();
  }

  if (phase === 'RUNNING') {
    _setPhaseTag('running', 'Round Live');
    document.querySelector('.arena-panel')?.classList.remove('is-crashed');
    document.querySelector('.arena-panel')?.classList.add('is-live');
    updateBetControls();
  }

  if (phase === 'CRASHED') {
    G.runningStartedAtMs = null;
    _setPhaseTag('crashed', 'Crashed');
    document.querySelector('.arena-panel')?.classList.remove('is-live');
    document.querySelector('.arena-panel')?.classList.add('is-crashed');

    const crashedMult = parseFloat(sv.multiplier) || G.serverMultiplier || 1.00;
    _renderMult(crashedMult, true);
    document.getElementById('phase-timer').textContent = `Crashed at ${crashedMult.toFixed(4)}×`;

    if (G.myBet && !G.cashedOut && !G.myBet.cashoutMult) {
      const lost     = Number(G.myBet.amount ?? 0);
      const statusEl = document.getElementById('bet-status');
      if (statusEl && lost > 0) {
        statusEl.className   = 'bet-status busted';
        statusEl.textContent = `💀 Busted at ${crashedMult.toFixed(4)}× — lost $${fmt(lost)}`;
        showResultFlash('loss', `-$${fmt(lost)}`);
      }
    }

    renderActivePlayers(true);

    setTimeout(async () => {
      await refreshWallet();
      await refreshStats();
      updateAllUI();
      renderRoundHistory();
      pushToLiveFeed(roundId, crashedMult);
      if (document.getElementById('page-stats')?.classList.contains('active')) renderStats();
    }, 300);
  }

  if (phase === 'COOLDOWN') {
    // Visually stays as crashed — just update tag
    _setPhaseTag('crashed', 'Next Round Soon');
    document.querySelector('.arena-panel')?.classList.remove('is-live');
    document.querySelector('.arena-panel')?.classList.add('is-crashed');
    updateBetControls();
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
  if (page === 'wallet')      { refreshWallet().then(() => refreshWalletUI()); }
  if (page === 'game')        { updateAllUI(); renderRoundHistory(); renderActivePlayers(); }
  if (page === 'leaderboard') { loadLeaderboard(); }
  if (page === 'stats')       { refreshStats().then(() => renderStats()); }
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
   GAME ACTIONS
============================================================ */
async function placeBet() {
  const G   = STATE.game;
  const raw = Math.floor(parseFloat(document.getElementById('bet-amount').value));

  if (G.phase !== 'BETTING')        { showToast('Betting is closed for this round.', 'error'); return; }
  if (G.myBet)                      { showToast('You already have a bet this round.', 'error'); return; }
  if (isNaN(raw) || raw < 100)      { showToast('Minimum bet is $100.', 'error'); return; }
  if (raw > STATE.wallet.balance)   { showToast('Insufficient balance.', 'error'); return; }

  // Disable bet button immediately to prevent double-submit
  const btn = document.getElementById('btn-bet');
  if (btn) btn.disabled = true;

  try {
    const data = await apiPost('/api/game/bet', { amount: raw });
    STATE.wallet.balance = Number(data.balance);
    G.myBet = { amount: raw, cashoutMult: null, payout: 0, busted: false };

    const statusEl = document.getElementById('bet-status');
    if (statusEl) {
      statusEl.className   = 'bet-status active-bet';
      statusEl.textContent = `⚡ Bet placed: $${fmt(raw)} — cash out before it crashes!`;
    }
    updateBetControls();
    syncTopbar();
    showToast(`Bet of $${fmt(raw)} placed!`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
    updateBetControls(); // re-enable
  }
}

async function cashOut() {
  const G = STATE.game;

  if (G.phase !== 'RUNNING') { showToast('Round not in progress.', 'error'); return; }
  if (!G.myBet)              { showToast('No active bet.', 'error'); return; }
  if (G.cashedOut)           { return; }

  // Capture multiplier at the instant the player clicks — before any async delay
  const lockedMult = calcMultiplierAt(G.runningStartedAtMs);

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
      statusEl.textContent = `✓ Cashed out at ${mult.toFixed(4)}× — won $${fmt(profit)}!`;
    }

    showResultFlash('win', `+$${fmt(profit)}`);
    syncTopbar();

    // Optimistic stat update
    STATE.stats.wins++;
    STATE.stats.rounds++;
    STATE.stats.totalWon     += Number(data.payout);
    STATE.stats.totalWagered += G.myBet.amount;
    if (mult > STATE.stats.bestMult)     STATE.stats.bestMult   = mult;
    if (profit > STATE.stats.biggestWin) STATE.stats.biggestWin = profit;

    updateAllUI();
    if (document.getElementById('page-stats')?.classList.contains('active')) renderStats();

  } catch (e) {
    G.cashedOut = false;
    updateBetControls();
    showToast(e.message, 'error');
  }
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
  const canCashout  = G.phase === 'RUNNING' && G.myBet && !G.cashedOut;

  if (canCashout) {
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
   NPC PLAYERS (visual only)
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
      p.status = 'cashed';
      p.multAt = mult;
      changed  = true;
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
    if (r.myPnl !== null && r.myPnl !== undefined) {
      const sign = r.myPnl >= 0 ? '+' : '-';
      pnlHtml = `<span class="rh-pnl ${r.myPnl >= 0 ? 'win' : 'loss'}">${sign}$${fmt(Math.abs(r.myPnl))}</span>`;
    }
    return `
      <div class="rh-item">
        <span class="rh-round">#${r.roundId}</span>
        <span class="rh-mult ${cls}">${r.crash.toFixed(4)}×</span>
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
      G.activePlayers.unshift({
        name: STATE.user.username, bet: G.myBet.amount,
        isMe: true, status: 'active',
      });
    }
  }

  if (G.phase === 'RUNNING') {
    maybeAutoFakeCashouts(calcMultiplierAt(G.runningStartedAtMs));
  }

  const players = G.activePlayers;
  if (players.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:24px 16px"><span class="es-icon">⌛</span>Waiting for next round</div>`;
    return;
  }

  el.innerHTML = players.map(p => {
    const effectiveStatus = (crashed && p.status === 'active') ? 'lost' : p.status;
    let statusHtml;
    if (effectiveStatus === 'active')  statusHtml = `<span class="ap-status active">IN</span>`;
    else if (effectiveStatus === 'cashed') statusHtml = `<span class="ap-status cashed">✓ ${p.multAt?.toFixed(4) ?? '?'}×</span>`;
    else statusHtml = `<span class="ap-status lost">✕ BUST</span>`;

    return `
      <div class="ap-item ${p.isMe ? 'is-me' : ''}">
        <div class="ap-avatar">${(p.name || '?')[0].toUpperCase()}</div>
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
   ARENA VISUAL HELPERS
============================================================ */
function _renderMult(mult, crashed) {
  const el  = document.getElementById('mult-value');
  const sub = document.getElementById('mult-sub');
  if (!el || !sub) return;

  // display four decimal places so the curve looks smooth at high speeds
  el.textContent = `${mult.toFixed(4)}×`;

  if (crashed) {
    el.className    = 'mult-value crashed';
    sub.textContent = 'CRASHED';
    return;
  }

  el.className    = mult < 1.5 ? 'mult-value green' : mult < 3 ? 'mult-value gold' : 'mult-value red';
  sub.textContent = STATE.game.phase === 'RUNNING' ? 'LIVE' : 'WAITING FOR ROUND';
}

function _setPhaseTag(phase, label) {
  const tag = document.getElementById('phase-tag');
  const lbl = document.getElementById('phase-label');
  if (tag) tag.className   = `phase-tag ${phase}`;
  if (lbl) lbl.textContent = label;
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
  fill.className   = `progress-fill ${mult < 1.5 ? 'green' : mult < 3 ? 'gold' : 'red'}`;
}


/* ============================================================
   HOME PAGE
============================================================ */
function renderHomeFeed() {
  const feed    = STATE.game.liveFeed;
  const feedEl  = document.getElementById('home-live-feed');
  const recentEl = document.getElementById('home-recent-games');
  const countEl = document.getElementById('home-round-count');

  if (!feedEl) return;

  if (feed.length === 0) {
    feedEl.innerHTML = `<div class="empty-state"><span class="es-icon">📡</span>Waiting for round activity…</div>`;
  } else {
    feedEl.innerHTML = feed.slice(0, 12).map(entry => {
      const isWin     = entry.pnl > 0;
      const resultTxt = isWin
        ? `+$${fmt(entry.pnl)} @ ${entry.crash.toFixed(4)}×`
        : `BUST @ ${entry.crash.toFixed(4)}×`;
      return `
        <div class="bet-item">
          <div class="bi-avatar">${(entry.username || '?')[0].toUpperCase()}</div>
          <span class="bi-user">${entry.username}</span>
          <span class="bi-result ${isWin ? 'win' : 'loss'}">${resultTxt}</span>
          <span class="bi-time">${timeAgo(entry.time)}</span>
        </div>`;
    }).join('');
  }

  const seen = new Set(), rounds = [];
  for (const e of feed) {
    if (!seen.has(e.roundId)) { seen.add(e.roundId); rounds.push(e); if (rounds.length >= 8) break; }
  }

  if (rounds.length === 0) {
    if (recentEl) recentEl.innerHTML = `<div class="empty-state"><span class="es-icon">🎮</span>No rounds played yet</div>`;
    if (countEl) countEl.textContent = '';
  } else {
    if (countEl) countEl.textContent = `${rounds.length} rounds`;
    if (recentEl) recentEl.innerHTML = rounds.map(e => {
      const cls = e.crash >= 3 ? 'high' : e.crash >= 1.5 ? 'mid' : 'low';
      return `
        <div class="game-row">
          <span class="gr-round">Round #${e.roundId}</span>
          <span class="gr-mult ${cls}">${e.crash.toFixed(4)}×</span>
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
  if (homePnlEl)   homePnlEl.textContent = `${pnl >= 0 ? '+' : '-'}$${fmt(Math.abs(pnl))}`;
  if (homePnlCard) homePnlCard.className = `stat-card ${pnl >= 0 ? 'sc-green' : 'sc-red'}`;

  _setEl('home-username', (STATE.user.username || 'PLAYER').toUpperCase());

  const wr = st.rounds > 0 ? Math.round((st.wins / st.rounds) * 100) : 0;
  _setEl('gs-winrate',     `${wr}%`);
  _setEl('gs-rounds',      st.rounds);
  _setEl('gs-best-mult',   st.bestMult > 0 ? `${st.bestMult.toFixed(4)}×` : '—');
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
  const with_ = document.getElementById('btn-withdraw');
  if (dep)   dep.disabled   = busy;
  if (with_) with_.disabled = busy;
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
    await refreshWallet();
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
  const amount = parseFloat(document.getElementById('wallet-amount').value);
  if (isNaN(amount) || amount <= 0) return _walletError('Please enter a valid amount.');
  if (amount < 1000)                return _walletError('Minimum withdrawal is $1,000.');
  if (amount > STATE.wallet.balance) return _walletError(`Insufficient balance. You have $${fmt(STATE.wallet.balance)}.`);
  _walletBusy(true);
  showToast('Processing withdrawal…', 'info');
  try {
    const data = await apiPost('/api/wallet/withdraw', { amount });
    STATE.wallet.balance = Number(data.balance);
    await refreshWallet();
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
  const sorted = [...STATE.leaderboard].sort((a, b) =>
    sortBy === 'wins' ? b.wins - a.wins : sortBy === 'wagered' ? b.wagered - a.wagered : b.profit - a.profit
  );

  const tbody = document.getElementById('lb-tbody');
  if (!tbody) return;

  tbody.innerHTML = sorted.map((entry, i) => {
    const rank    = i + 1;
    const rankCls = rank === 1 ? 'r1' : rank === 2 ? 'r2' : rank === 3 ? 'r3' : 'rn';
    const wr      = entry.rounds > 0 ? Math.round((entry.wins / entry.rounds) * 100) : 0;
    const profCls = entry.profit >= 0 ? 'pos' : 'neg';
    return `
      <tr class="${entry.isMe ? 'lb-me-row' : ''}">
        <td><span class="rank-badge ${rankCls}">${rank}</span></td>
        <td>${entry.isMe ? '<span class="lb-me-star">▶</span>' : ''}<span class="lb-player-name ${entry.isMe ? 'lb-me' : ''}">${entry.username}</span></td>
        <td>${entry.rounds.toLocaleString()}</td>
        <td class="lb-wins">${entry.wins.toLocaleString()}</td>
        <td>
          <div class="lb-wr-wrap">
            <div class="lb-wr-bar"><div class="lb-wr-fill" style="width:${Math.min(100,wr)}%"></div></div>
            <span>${wr}%</span>
          </div>
        </td>
        <td>$${fmt(entry.wagered)}</td>
        <td class="lb-profit ${profCls}">${entry.profit >= 0 ? '+' : '-'}$${fmt(Math.abs(entry.profit))}</td>
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

  const winTxs   = txs.filter(t => t.type === 'bet_win');
  const multVals = winTxs.map(t => { const m = t.desc?.match(/at ([\d.]+)[×x]/); return m ? parseFloat(m[1]) : null; }).filter(v => v !== null && !isNaN(v));
  _setEl('st-avgmult', multVals.length > 0 ? `${(multVals.reduce((a, b) => a + b, 0) / multVals.length).toFixed(2)}×` : '—');

  const pnl = st.totalWon - st.totalWagered;
  _setEl('st-pnl', `${pnl >= 0 ? '+' : '-'}$${fmt(Math.abs(pnl))}`);
  const pnlCard = document.getElementById('st-pnl-card');
  if (pnlCard) pnlCard.className = `stat-card ${pnl >= 0 ? 'sc-green' : 'sc-red'}`;

  const chartEl = document.getElementById('pnl-chart');
  if (chartEl) {
    const history = st.pnlHistory.slice(-30);
    if (history.length === 0) {
      chartEl.innerHTML = `<div class="chart-empty"><span class="ce-icon">📊</span>No round data yet</div>`;
    } else {
      const maxAbs = Math.max(...history.map(Math.abs), 1);
      chartEl.innerHTML = history.map(val => {
        const logH = val === 0 ? 4 : Math.round(4 + (Math.log(Math.abs(val) + 1) / Math.log(maxAbs + 1)) * 106);
        return `<div class="chart-bar ${val >= 0 ? 'pos' : 'neg'}" style="height:${logH}px" data-val="${val >= 0 ? '+' : '-'}$${fmt(Math.abs(val))}"></div>`;
      }).join('');
    }
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

  dotsEl.innerHTML = streak.map(r => `<div class="streak-dot ${r === 'w' ? 'win' : 'loss'}" title="${r === 'w' ? 'Win' : 'Loss'}"></div>`).join('');

  if (summaryEl && streak.length > 0) {
    const last = streak[streak.length - 1];
    let run = 0;
    for (let i = streak.length - 1; i >= 0 && streak[i] === last; i--) run++;
    summaryEl.textContent = `${run} ${last === 'w' ? 'win' : 'loss'} streak`;
    summaryEl.style.color = last === 'w' ? 'var(--accent)' : 'var(--danger)';
  }
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
  if (s <    5) return 'just now';
  if (s <   60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function _setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}


/* ============================================================
   TOAST SYSTEM
============================================================ */
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icons = { success: '✓', error: '✕', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] ?? '·'}</span><span class="toast-msg">${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, 3500);
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
