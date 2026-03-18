'use strict';

/* ============================================================
   CONSTANTS
============================================================ */
const MULTIPLIERS = [1.00, 1.25, 1.55, 1.90, 2.35, 2.85, 3.45, 4.15, 5.00];
const MAX_STEPS   = 8;
const MIN_BET     = 100;

/* ============================================================
   STATE
============================================================ */
const STATE = {
  loggedIn: false,
  user:     { id: 0, username: '', tornId: 0 },
  wallet:   { balance: 0, totalDeposited: 0, totalWithdrawn: 0, transactions: [] },
  stats:    { games: 0, wins: 0, losses: 0, totalWagered: 0, totalWon: 0, bestMult: 0, biggestWin: 0 },
  _token:   null,
  leaderboard: [],

  game: {
    activeGameId:   null,
    betAmount:      0,
    stepsReached:   0,
    status:         'IDLE',   // IDLE | ACTIVE | BUSTED | CASHED_OUT
    locked:         false,    // true while API call in flight
    history:        [],
  },
};


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
const apiGet  = path        => api(path, { method: 'GET' });
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
  if (!username) return _showErr(errEl, 'Please enter your Torn username.');
  if (!apiKey)   return _showErr(errEl, 'Please enter your Torn API key.');
  if (apiKey.length < 16) return _showErr(errEl, 'API key looks too short.');

  btn.disabled  = true;
  btn.innerHTML = '<span class="btn-spinner"></span> VERIFYING…';

  try {
    const data   = await apiPost('/api/auth/login', { username, apiKey });
    STATE._token = data.token;
    await _onLoginSuccess(data.user);
  } catch (err) {
    btn.disabled  = false;
    btn.innerHTML = 'ACCESS NEXUS';
    _showErr(errEl, err.message);
  }
}

async function _onLoginSuccess(user) {
  STATE.loggedIn      = true;
  STATE.user.id       = user.id;
  STATE.user.username = user.username;
  STATE.user.tornId   = user.tornId;

  await refreshWallet();
  await refreshGameState();

  document.getElementById('topbar').style.display = 'flex';
  navigate('home');
  updateAllUI();
  showToast(`Welcome back, ${STATE.user.username}!`, 'success');

  const btn = document.getElementById('login-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = 'ACCESS NEXUS'; }
}

function logout() {
  if (!confirm('Log out of Torn Nexus?')) return;
  STATE.loggedIn   = false;
  STATE._token     = null;
  STATE.user       = { id: 0, username: '', tornId: 0 };
  STATE.wallet     = { balance: 0, totalDeposited: 0, totalWithdrawn: 0, transactions: [] };
  STATE.game       = { activeGameId: null, betAmount: 0, stepsReached: 0, status: 'IDLE', locked: false, history: [] };
  document.getElementById('topbar').style.display = 'none';
  showPage('login');
  showToast('Logged out successfully.', 'info');
}


/* ============================================================
   WALLET
============================================================ */
async function refreshWallet() {
  try {
    const data = await apiGet('/api/wallet');
    STATE.wallet.balance        = Number(data.balance);
    STATE.wallet.totalDeposited = Number(data.totalDeposited);
    STATE.wallet.totalWithdrawn = Number(data.totalWithdrawn);
    STATE.wallet.transactions   = (data.transactions ?? []).map(tx => ({
      type:   tx.type?.toLowerCase(),
      amount: Number(tx.amount),
      desc:   tx.description ?? tx.type,
      time:   new Date(tx.createdAt).getTime(),
      status: tx.status,
    }));
    updateWalletUI();
  } catch(e) { console.warn('[wallet]', e.message); }
}

async function doDeposit() {
  const amountEl = document.getElementById('dep-amount');
  const txidEl   = document.getElementById('dep-txid');
  const errEl    = document.getElementById('dep-error');
  const okEl     = document.getElementById('dep-success');
  errEl.classList.remove('show'); okEl.classList.remove('show');

  const amount = parseFloat(amountEl.value);
  const txId   = parseInt(txidEl.value);

  if (!amount || amount < MIN_BET) return _showErr(errEl, `Minimum deposit is $${MIN_BET}.`);
  if (!txId)                       return _showErr(errEl, 'Please enter the Transaction ID.');

  try {
    const data = await apiPost('/api/wallet/deposit', { amount, tornTxId: txId });
    okEl.textContent = `✓ Deposit of $${fmt(amount)} verified!`;
    okEl.classList.add('show');
    amountEl.value = ''; txidEl.value = '';
    await refreshWallet();
    showToast(`Deposited $${fmt(amount)}`, 'success');
  } catch(e) { _showErr(errEl, e.message); }
}

async function doWithdraw() {
  const amountEl = document.getElementById('wd-amount');
  const errEl    = document.getElementById('wd-error');
  const okEl     = document.getElementById('wd-success');
  errEl.classList.remove('show'); okEl.classList.remove('show');

  const amount = parseFloat(amountEl.value);
  if (!amount || amount < MIN_BET) return _showErr(errEl, `Minimum withdrawal is $${MIN_BET}.`);
  if (amount > STATE.wallet.balance) return _showErr(errEl, 'Insufficient balance.');

  try {
    await apiPost('/api/wallet/withdraw', { amount });
    okEl.textContent = `✓ Withdrawal of $${fmt(amount)} requested — within 24h.`;
    okEl.classList.add('show');
    amountEl.value = '';
    await refreshWallet();
    showToast(`Withdrawal of $${fmt(amount)} requested.`, 'info');
  } catch(e) { _showErr(errEl, e.message); }
}


/* ============================================================
   GAME STATE SYNC
============================================================ */
async function refreshGameState() {
  try {
    const data = await apiGet('/api/game/state');
    STATE.game.history = data.history ?? [];

    if (data.activeGame) {
      const g = data.activeGame;
      STATE.game.activeGameId = g.gameId;
      STATE.game.betAmount    = Number(g.betAmount);
      STATE.game.stepsReached = g.stepsReached;
      STATE.game.status       = 'ACTIVE';
      showIngameControls();
    } else {
      STATE.game.status = 'IDLE';
    }

    renderGameHistory();
    renderMiniStats();
    updateMultDisplay();
  } catch(e) { console.warn('[gameState]', e.message); }
}


/* ============================================================
   GAME ACTIONS
============================================================ */
async function startGame() {
  if (STATE.game.locked) return;
  const amountEl = document.getElementById('bet-amount');
  const msgEl    = document.getElementById('game-message');
  const amount   = parseFloat(amountEl.value);

  msgEl.textContent = ''; msgEl.className = 'game-msg';

  if (!amount || amount < MIN_BET) {
    msgEl.textContent = `Minimum bet is $${MIN_BET.toLocaleString()}.`;
    msgEl.className   = 'game-msg err';
    return;
  }
  if (amount > STATE.wallet.balance) {
    msgEl.textContent = 'Insufficient balance.';
    msgEl.className   = 'game-msg err';
    return;
  }

  STATE.game.locked = true;
  const btn = document.getElementById('btn-start');
  btn.disabled = true;
  btn.textContent = 'Starting…';

  try {
    const data = await apiPost('/api/game/start', { amount });
    STATE.game.activeGameId = data.gameId;
    STATE.game.betAmount    = Number(data.betAmount);
    STATE.game.stepsReached = 0;
    STATE.game.status       = 'ACTIVE';
    STATE.wallet.balance    = Number(data.balance);

    updateTopbarBalance();
    renderRoad(0);
    showIngameControls();
    updateMultDisplay();
    updateCashoutBtn();
    showToast(`Bet of $${fmt(amount)} placed. Cross the road!`, 'success');
  } catch(e) {
    msgEl.textContent = e.message;
    msgEl.className   = 'game-msg err';
    btn.disabled  = false;
    btn.innerHTML = '🐔 START CROSSING';
  } finally {
    STATE.game.locked = false;
  }
}

async function doStep() {
  if (STATE.game.locked || STATE.game.status !== 'ACTIVE') return;
  STATE.game.locked = true;

  const stepBtn = document.getElementById('btn-step');
  const msgEl   = document.getElementById('ingame-message');
  stepBtn.disabled  = true;
  stepBtn.textContent = 'Crossing…';
  msgEl.textContent = '';

  animateChickenStep(STATE.game.stepsReached + 1);

  try {
    const data = await apiPost('/api/game/step', {});

    if (data.result === 'BUSTED') {
      STATE.game.stepsReached = data.stepsReached;
      STATE.game.status       = 'BUSTED';
      STATE.game.activeGameId = null;

      animateBust(data.laneHit);
      renderRoadRevealed(data.revealedPath, data.laneHit);

      await refreshWallet();
      await refreshGameState();

      setTimeout(() => showReveal('BUSTED', data), 800);
    } else {
      STATE.game.stepsReached = data.stepsReached;

      if (data.autoComplete) {
        STATE.game.status       = 'CASHED_OUT';
        STATE.game.activeGameId = null;
        STATE.wallet.balance    = Number(data.balance);

        renderRoadRevealed(data.revealedPath, null);
        updateTopbarBalance();
        await refreshGameState();
        setTimeout(() => showReveal('CASHOUT', data), 600);
      } else {
        renderRoad(data.stepsReached);
        updateMultDisplay();
        updateCashoutBtn();
        updateLaneCounter();

        stepBtn.disabled  = false;
        stepBtn.innerHTML = '🚗 CROSS NEXT LANE';

        const cashoutBtn = document.getElementById('btn-cashout');
        cashoutBtn.disabled = false;
      }
    }
  } catch(e) {
    msgEl.textContent = e.message;
    msgEl.className   = 'game-msg err';
    stepBtn.disabled  = false;
    stepBtn.innerHTML = '🚗 CROSS NEXT LANE';
  } finally {
    STATE.game.locked = false;
  }
}

async function doCashout() {
  if (STATE.game.locked || STATE.game.status !== 'ACTIVE') return;
  if (STATE.game.stepsReached === 0) {
    showToast('Cross at least one lane first!', 'error'); return;
  }
  STATE.game.locked = true;

  const btn   = document.getElementById('btn-cashout');
  const msgEl = document.getElementById('ingame-message');
  btn.disabled  = true;
  btn.textContent = 'Cashing out…';

  try {
    const data = await apiPost('/api/game/cashout', {});
    STATE.game.status       = 'CASHED_OUT';
    STATE.game.activeGameId = null;
    STATE.wallet.balance    = Number(data.balance);

    renderRoadRevealed(data.revealedPath, null);
    updateTopbarBalance();
    await refreshGameState();
    showReveal('CASHOUT', data);
  } catch(e) {
    msgEl.textContent = e.message;
    msgEl.className   = 'game-msg err';
    btn.disabled = STATE.game.stepsReached === 0;
  } finally {
    STATE.game.locked = false;
  }
}

function closeReveal() {
  document.getElementById('reveal-overlay').style.display = 'none';
  STATE.game.status = 'IDLE';
  showBetControls();
  renderRoad(0);
  updateMultDisplay();
  document.getElementById('bet-amount').value = '';
  document.getElementById('game-message').textContent = '';
}


/* ============================================================
   ROAD RENDERING
============================================================ */
function renderRoad(stepsReached) {
  const container = document.getElementById('road-lanes');
  container.innerHTML = '';

  // Render lanes 8 down to 1 (top = furthest)
  for (let lane = MAX_STEPS; lane >= 1; lane--) {
    const div = document.createElement('div');
    div.className = 'road-lane';
    div.id = `lane-${lane}`;

    const mult = MULTIPLIERS[lane];

    // Status classes
    if (lane <= stepsReached) {
      div.classList.add('lane-crossed');
    } else if (lane === stepsReached + 1) {
      div.classList.add('lane-next');
    }

    div.innerHTML = `
      <div class="lane-label">Lane ${lane}</div>
      <div class="lane-cars">
        <div class="car car-a">🚗</div>
        <div class="car car-b">🚙</div>
        <div class="car car-c">🚕</div>
      </div>
      <div class="lane-mult">${mult.toFixed(2)}×</div>
    `;
    container.appendChild(div);
  }

  // Position chicken
  positionChicken(stepsReached);
  updateLadder(stepsReached);
}

function renderRoadRevealed(revealedPath, bustLane) {
  for (const step of revealedPath) {
    const el = document.getElementById(`lane-${step.lane}`);
    if (!el) continue;
    el.classList.remove('lane-next', 'lane-crossed');
    if (step.lane === bustLane) {
      el.classList.add('lane-bust');
    } else if (step.safe) {
      el.classList.add('lane-safe-reveal');
    } else {
      el.classList.add('lane-danger-reveal');
    }
  }
}

function positionChicken(steps) {
  const wrap = document.getElementById('chicken-wrap');
  if (!wrap) return;
  // steps=0 → bottom, steps=8 → top
  // Road has 8 lanes each ~56px tall. Chicken sits below lane 1 at start.
  const laneH   = 56;
  const totalH  = MAX_STEPS * laneH;
  const bottomPx = steps * laneH;
  wrap.style.bottom = `${bottomPx}px`;
}

function animateChickenStep(toStep) {
  const wrap = document.getElementById('chicken-wrap');
  if (!wrap) return;
  wrap.style.transition = 'bottom 0.25s ease';
  positionChicken(toStep);
  setTimeout(() => { wrap.style.transition = ''; }, 300);
}

function animateBust(lane) {
  const chicken = document.getElementById('chicken');
  if (chicken) {
    chicken.style.animation = 'none';
    chicken.textContent = '💥';
    setTimeout(() => { chicken.textContent = '🐔'; chicken.style.animation = ''; }, 1500);
  }
}

function updateLadder(stepsReached) {
  const el = document.getElementById('mult-ladder');
  if (!el) return;
  el.innerHTML = MULTIPLIERS.slice(1).map((m, i) => {
    const step = i + 1;
    let cls = 'ml-row';
    if (step < stepsReached)      cls += ' ml-passed';
    else if (step === stepsReached) cls += ' ml-current';
    else if (step === stepsReached + 1) cls += ' ml-next';
    return `<div class="${cls}">
      <span class="ml-lane">Lane ${step}</span>
      <span class="ml-mult">${m.toFixed(2)}×</span>
    </div>`;
  }).join('');
}


/* ============================================================
   UI HELPERS
============================================================ */
function showIngameControls() {
  document.getElementById('bet-controls').style.display   = 'none';
  document.getElementById('ingame-controls').style.display = 'flex';
  renderRoad(STATE.game.stepsReached);
  updateLaneCounter();
  updateCashoutBtn();
  document.getElementById('igc-bet-amt').textContent = `$${fmt(STATE.game.betAmount)}`;

  // Only enable cashout if already crossed a lane
  const cashoutBtn = document.getElementById('btn-cashout');
  cashoutBtn.disabled = STATE.game.stepsReached === 0;
}

function showBetControls() {
  document.getElementById('bet-controls').style.display   = 'flex';
  document.getElementById('ingame-controls').style.display = 'none';
  updateLadder(0);
}

function updateCashoutBtn() {
  const btn = document.getElementById('btn-cashout');
  const steps = STATE.game.stepsReached;
  const mult  = MULTIPLIERS[steps];
  const payout = Math.floor(STATE.game.betAmount * mult);
  const el = document.getElementById('btn-cashout-amt');
  if (el) el.textContent = steps > 0 ? `$${fmt(payout)} (${mult.toFixed(2)}×)` : '';
  if (btn) btn.disabled = steps === 0;
}

function updateLaneCounter() {
  const el = document.getElementById('igc-lane');
  if (el) el.textContent = STATE.game.stepsReached;
}

function updateMultDisplay() {
  const steps = STATE.game.stepsReached;
  const mult  = MULTIPLIERS[steps] ?? 1.00;
  const valEl = document.getElementById('md-value');
  const subEl = document.getElementById('md-sub');
  if (valEl) valEl.textContent = `${mult.toFixed(2)}×`;

  if (STATE.game.status === 'ACTIVE') {
    const next = MULTIPLIERS[steps + 1];
    if (subEl) subEl.textContent = next ? `Next: ${next.toFixed(2)}×` : 'Max reached — cash out!';
  } else if (STATE.game.status === 'IDLE') {
    if (subEl) subEl.textContent = 'Place a bet to start';
  }

  // Color shift
  if (valEl) {
    valEl.style.color = steps === 0 ? 'var(--text-main)' :
                        steps <= 3  ? 'var(--accent)' :
                        steps <= 6  ? 'var(--warn)' : '#ff6b35';
  }
}

function setBetFraction(frac) {
  const el = document.getElementById('bet-amount');
  if (el) el.value = Math.floor(STATE.wallet.balance * frac);
}

function showReveal(type, data) {
  const overlay = document.getElementById('reveal-overlay');
  const icon    = document.getElementById('reveal-icon');
  const title   = document.getElementById('reveal-title');
  const sub     = document.getElementById('reveal-sub');
  const path    = document.getElementById('reveal-path');

  if (type === 'BUSTED') {
    icon.textContent  = '💥';
    title.textContent = 'SPLAT!';
    title.style.color = 'var(--danger)';
    sub.textContent   = `Hit on Lane ${data.laneHit}. Lost $${fmt(STATE.game.betAmount)}.`;
  } else {
    const payout = Number(data.payout);
    const profit = payout - STATE.game.betAmount;
    icon.textContent  = '🏆';
    title.textContent = `CASHED OUT AT ${parseFloat(data.cashoutMult).toFixed(2)}×!`;
    title.style.color = 'var(--accent)';
    sub.textContent   = `Won $${fmt(payout)} (profit: ${profit >= 0 ? '+' : ''}$${fmt(profit)})`;
  }

  // Provably fair path
  if (data.revealedPath) {
    path.innerHTML = `<div class="reveal-path-title">Provably Fair — Full Road Revealed:</div>` +
      data.revealedPath.map(s => `
        <div class="rp-lane ${s.safe ? 'rp-safe' : 'rp-danger'}">
          Lane ${s.lane}: ${s.safe ? '✅ Safe' : '🚗 Car'} (roll ${s.roll} vs ${s.threshold})
        </div>`).join('');
  }

  overlay.style.display = 'flex';
}

function renderGameHistory() {
  const el = document.getElementById('game-history-list');
  if (!el) return;
  const history = STATE.game.history;
  if (!history.length) {
    el.innerHTML = '<div class="empty-state" style="padding:24px 16px"><span class="es-icon">🐔</span>No games yet</div>';
    return;
  }
  el.innerHTML = history.slice(0, 15).map(g => {
    const isBust = g.status === 'BUSTED';
    const mult   = g.cashoutMult ? parseFloat(g.cashoutMult).toFixed(2) : '—';
    const payout = Number(g.payout);
    const bet    = Number(g.betAmount);
    const profit = payout - bet;
    return `<div class="gh-row ${isBust ? 'gh-bust' : 'gh-win'}">
      <span class="gh-icon">${isBust ? '💥' : '✅'}</span>
      <span class="gh-info">
        <span class="gh-bet">$${fmt(bet)}</span>
        <span class="gh-lanes">${g.stepsReached} lane${g.stepsReached === 1 ? '' : 's'}</span>
      </span>
      <span class="gh-mult">${mult}×</span>
      <span class="gh-profit ${profit >= 0 ? 'pos' : 'neg'}">${profit >= 0 ? '+' : ''}$${fmt(Math.abs(profit))}</span>
    </div>`;
  }).join('');
}

function renderMiniStats() {
  const history = STATE.game.history;
  const wins    = history.filter(g => g.status === 'CASHED_OUT');
  const total   = history.length;
  const wr      = total > 0 ? Math.round((wins.length / total) * 100) : 0;
  const bestM   = wins.reduce((m, g) => Math.max(m, parseFloat(g.cashoutMult ?? 0)), 0);
  const bigWin  = wins.reduce((m, g) => Math.max(m, Number(g.payout) - Number(g.betAmount)), 0);

  _setEl('gs-winrate',    `${wr}%`);
  _setEl('gs-rounds',     total);
  _setEl('gs-best-mult',  bestM > 0 ? `${bestM.toFixed(2)}×` : '—');
  _setEl('gs-biggest-win', bigWin > 0 ? `$${fmt(bigWin)}` : '—');

  // Stats page
  _setEl('st-winrate', `${wr}%`);
  _setEl('st-wl',      `${wins.length}W / ${total - wins.length}L`);
  _setEl('st-bestmult', bestM > 0 ? `${bestM.toFixed(2)}×` : '—');
  const avgM = wins.length > 0
    ? (wins.reduce((s, g) => s + parseFloat(g.cashoutMult ?? 0), 0) / wins.length).toFixed(2)
    : null;
  _setEl('st-avgmult', avgM ? `${avgM}×` : '—');

  const totalWagered = history.reduce((s, g) => s + Number(g.betAmount), 0);
  const totalWon     = history.reduce((s, g) => s + Number(g.payout), 0);
  const pnl = totalWon - totalWagered;
  _setEl('st-pnl', `${pnl >= 0 ? '+' : '-'}$${fmt(Math.abs(pnl))}`);
  const pnlCard = document.getElementById('st-pnl-card');
  if (pnlCard) pnlCard.className = `stat-card ${pnl >= 0 ? 'sc-green' : 'sc-red'}`;

  // Streak dots
  renderStreak(history);
}

function renderStreak(history) {
  const dotsEl    = document.getElementById('streak-dots');
  const summaryEl = document.getElementById('streak-summary');
  if (!dotsEl) return;
  const streak = history.slice(0, 40).map(g => g.status === 'CASHED_OUT' ? 'w' : 'l');
  if (!streak.length) {
    dotsEl.innerHTML = '<div class="empty-state" style="width:100%;padding:16px 0"><span class="es-icon">🎯</span>Play some games to build your streak</div>';
    if (summaryEl) summaryEl.textContent = '';
    return;
  }
  dotsEl.innerHTML = streak.map(r => `<div class="streak-dot ${r === 'w' ? 'win' : 'loss'}" title="${r === 'w' ? 'Win' : 'Loss'}"></div>`).join('');
  if (summaryEl && streak.length > 0) {
    const last = streak[0];
    let run = 0;
    for (let i = 0; i < streak.length && streak[i] === last; i++) run++;
    summaryEl.textContent = `${run} ${last === 'w' ? 'win' : 'loss'} streak`;
    summaryEl.style.color = last === 'w' ? 'var(--accent)' : 'var(--danger)';
  }
}


/* ============================================================
   NAVIGATION
============================================================ */
function navigate(page) {
  // Refresh data on navigate
  if (page === 'wallet')      refreshWallet();
  if (page === 'game')        refreshGameState();
  if (page === 'leaderboard') loadLeaderboard();
  if (page === 'stats')       refreshGameState();

  showPage(page);
  updateNav(page);
  updateAllUI();
}

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pg = document.getElementById(`page-${name}`);
  if (pg) pg.classList.add('active');
}

function updateNav(active) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`nav-${active}`);
  if (btn) btn.classList.add('active');
}

function toggleMobileNav() {
  document.getElementById('mobile-nav-dropdown')?.classList.toggle('open');
}
function closeMobileNav() {
  document.getElementById('mobile-nav-dropdown')?.classList.remove('open');
}


/* ============================================================
   UI UPDATE
============================================================ */
function updateAllUI() {
  updateTopbarBalance();
  updateWalletUI();
  updateHomeUI();
  renderMiniStats();

  // Restore game UI if active
  if (STATE.game.status === 'ACTIVE') {
    showIngameControls();
  } else {
    showBetControls();
    renderRoad(0);
  }
}

function updateTopbarBalance() {
  _setEl('topbar-balance', `$${fmt(STATE.wallet.balance)}`);
  _setEl('topbar-username', STATE.user.username);
}

function updateWalletUI() {
  _setEl('wallet-balance-figure', fmt(STATE.wallet.balance));
  _setEl('wallet-total-dep', `$${fmt(STATE.wallet.totalDeposited)}`);
  _setEl('wallet-total-wd',  `$${fmt(STATE.wallet.totalWithdrawn)}`);
  renderTxList();
}

function updateHomeUI() {
  _setEl('home-username', STATE.user.username);
  _setEl('home-balance', `$${fmt(STATE.wallet.balance)}`);

  const history = STATE.game.history;
  const wagered = history.reduce((s, g) => s + Number(g.betAmount), 0);
  const won     = history.reduce((s, g) => s + Number(g.payout), 0);
  const pnl     = won - wagered;

  _setEl('home-wagered', `$${fmt(wagered)}`);
  _setEl('home-pnl', `${pnl >= 0 ? '+' : '-'}$${fmt(Math.abs(pnl))}`);
  const pnlCard = document.getElementById('home-pnl-card');
  if (pnlCard) pnlCard.className = `stat-card ${pnl >= 0 ? 'sc-green' : 'sc-red'}`;

  // Recent games on home
  const homeEl = document.getElementById('home-recent-games');
  if (homeEl) {
    if (!history.length) {
      homeEl.innerHTML = '<div class="empty-state"><span class="es-icon">🐔</span>No games played yet</div>';
    } else {
      homeEl.innerHTML = history.slice(0, 8).map(g => {
        const isBust = g.status === 'BUSTED';
        const mult   = g.cashoutMult ? parseFloat(g.cashoutMult).toFixed(2) : '—';
        const profit = Number(g.payout) - Number(g.betAmount);
        return `<div class="gh-row ${isBust ? 'gh-bust' : 'gh-win'}">
          <span class="gh-icon">${isBust ? '💥' : '✅'}</span>
          <span class="gh-info">
            <span class="gh-bet">$${fmt(Number(g.betAmount))}</span>
            <span class="gh-lanes">${g.stepsReached} lane${g.stepsReached === 1 ? '' : 's'}</span>
          </span>
          <span class="gh-mult">${mult}×</span>
          <span class="gh-profit ${profit >= 0 ? 'pos' : 'neg'}">${profit >= 0 ? '+' : ''}$${fmt(Math.abs(profit))}</span>
        </div>`;
      }).join('');
    }
  }
}

function renderTxList() {
  const el = document.getElementById('tx-list');
  if (!el) return;
  const txs = STATE.wallet.transactions;
  if (!txs.length) {
    el.innerHTML = '<div class="empty-state"><span class="es-icon">📋</span>No transactions yet</div>';
    return;
  }
  const icons = {
    deposit:    { el: '↓', cls: 'pos' },
    withdrawal: { el: '↑', cls: 'neg' },
    bet_win:    { el: '✓', cls: 'pos' },
    bet_loss:   { el: '✕', cls: 'neg' },
  };
  el.innerHTML = txs.slice(0, 30).map(tx => {
    const ic    = icons[tx.type] ?? { el: '·', cls: '' };
    const isPos = ['deposit','bet_win'].includes(tx.type);
    return `<div class="tx-item">
      <div class="tx-icon ${ic.cls}">${ic.el}</div>
      <div class="tx-info">
        <div class="tx-desc">${tx.desc}</div>
        <div class="tx-time">${timeAgo(tx.time)}</div>
      </div>
      <div class="tx-amount ${isPos ? 'pos' : 'neg'}">${isPos ? '+' : '-'}$${fmt(tx.amount)}</div>
    </div>`;
  }).join('');
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
  } catch(e) { console.warn('[leaderboard]', e.message); }
}

function renderLeaderboard(sortBy = 'profit') {
  _currentLbSort = sortBy;
  const sorted = [...STATE.leaderboard].sort((a, b) =>
    sortBy === 'wins' ? b.wins - a.wins : sortBy === 'wagered' ? b.wagered - a.wagered : b.profit - a.profit
  );
  const tbody = document.getElementById('lb-tbody');
  if (!tbody) return;
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><span class="es-icon">🐔</span>No players yet</div></td></tr>';
    return;
  }
  tbody.innerHTML = sorted.map((entry, i) => {
    const rank    = i + 1;
    const rankCls = rank === 1 ? 'r1' : rank === 2 ? 'r2' : rank === 3 ? 'r3' : 'rn';
    const wr      = entry.rounds > 0 ? Math.round((entry.wins / entry.rounds) * 100) : 0;
    const profCls = entry.profit >= 0 ? 'pos' : 'neg';
    return `<tr class="${entry.isMe ? 'lb-me-row' : ''}">
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
      <td class="lb-bestmult ${entry.bestMult >= 3 ? 'notable' : ''}">${entry.bestMult > 0 ? entry.bestMult.toFixed(2) + '×' : '—'}</td>
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
   UTILITIES
============================================================ */
function fmt(n) {
  if (n == null || isNaN(n)) return '0';
  const abs = Math.abs(n);
  if      (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  else if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  else if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.floor(n).toString();
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

function _showErr(el, msg) {
  el.textContent = msg;
  el.classList.add('show');
}

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
   BOOT
============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  // Set house profile link
  const houseId = '3859772';
  const link = document.getElementById('house-torn-link');
  const name = document.getElementById('house-name');
  if (link) link.href = `https://www.torn.com/profiles.php?XID=${houseId}`;
  if (name) name.textContent = `Torn ID #${houseId}`;

  // Enter key on login
  ['login-username', 'login-apikey'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') doLogin();
    });
  });

  // Close mobile nav on outside click
  document.addEventListener('click', e => {
    const dropdown = document.getElementById('mobile-nav-dropdown');
    const btn      = document.getElementById('mobile-menu-btn');
    if (dropdown?.classList.contains('open')) {
      if (!dropdown.contains(e.target) && !btn?.contains(e.target)) {
        dropdown.classList.remove('open');
      }
    }
  });

  // Init road + ladder on game page
  renderRoad(0);
  renderMiniStats();
});
