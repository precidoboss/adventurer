// ================================================================
// AQ — Supabase Auth + Stats + Leaderboard Module
// ================================================================
(function() {
'use strict';

// ---- CONFIG: paste your Supabase URL and anon key here ----
const SUPABASE_URL  = 'https://zigtdrhriwhsorbvxrho.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppZ3RkcmhyaXdoc29yYnZ4cmhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1OTA0NTEsImV4cCI6MjA5MjE2NjQ1MX0.xtmzajqqMlXTaN-h-vJrLxdcbhUawzJyTHE1C6tsFPg';
// -----------------------------------------------------------

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON);

// Session stored in localStorage
let _session = null; // { id, username, total_coins }
let _isGuest  = false;
let _isAdmin  = false; // server-confirmed only; never read from localStorage

function loadSession() {
    try {
        const s = localStorage.getItem('aq_session');
        if (s) _session = JSON.parse(s);
    } catch(e) { _session = null; }
}
function saveSession(s) {
    _session = s;
    if (s) localStorage.setItem('aq_session', JSON.stringify(s));
    else    localStorage.removeItem('aq_session');
}

// ---- Run stats accumulated this session ----
const _runStats = {
    sc: { kills:0, damageDone:0, damageTaken:0, deaths:0, coinsEarned:0, coinsSpent:0, distance:0, startMs:0 },
    endless: { kills:0, coinsEarned:0, distance:0, startMs:0 }
};

// ---- ACHIEVEMENTS catalog (mirrors DB) ----
const ACH_CATALOG = [
    { key:'first_run',    name:'First Step',      desc:'Complete your first Shadow Chronicle run',    icon:'👣' },
    { key:'speed_demon',  name:'Speed Demon',      desc:'Finish Shadow Chronicle in under 10 minutes', icon:'⚡' },
    { key:'untouchable',  name:'Untouchable',      desc:'Finish Shadow Chronicle taking 0 damage',     icon:'🛡️' },
    { key:'coin_hoarder', name:'Coin Hoarder',     desc:'Bank 1,000 coins total',                     icon:'💰' },
    { key:'rich',         name:'Rich',             desc:'Bank 10,000 coins total',                    icon:'🏦' },
    { key:'exterminator', name:'Exterminator',     desc:'Kill 500 enemies across all runs',           icon:'💀' },
    { key:'endless_100',  name:'Century Runner',   desc:'Reach distance 100 in Endless mode',         icon:'🏃' },
    { key:'endless_500',  name:'Marathon',         desc:'Reach distance 500 in Endless mode',         icon:'🏅' },
    { key:'deathless',    name:'Deathless',        desc:'Complete Shadow Chronicle with 0 deaths',    icon:'👑' },
    { key:'veteran',      name:'10x Veteran',      desc:'Complete Shadow Chronicle 10 times',         icon:'🎖️' },
];

// ---- RPC helper: every database call goes through a server-side function ----
async function rpc(name, args) {
    const { data, error } = await db.rpc(name, args || {});
    if (error) {
        if ((error.message || '').includes('invalid_session')) {
            saveSession(null); _isAdmin = false; _isGuest = false; updateHomeBar();
        }
        throw error;
    }
    return data;
}
const nInt = v => Math.max(0, Math.floor(Number(v) || 0));

// ---- UI helpers ----
function el(id)    { return document.getElementById(id); }
function hide(id)  { const e=el(id); if(e) e.style.display='none'; }
function show(id, disp) { const e=el(id); if(e) e.style.display = disp||'flex'; }

function updateHomeBar() {
    if (_session && !_isGuest) {
        hide('aq-home-auth');
        el('aq-home-username').textContent = _session.username;
        el('aq-home-bank').textContent = (_session.total_coins||0).toLocaleString();
        show('aq-home-user', 'block');
        show('aq-topbar', 'flex');
        // In-game bank display
        show('aq-game-coins-display', 'block');
        el('aq-bank-val').textContent = (_session.total_coins||0).toLocaleString();
    } else {
        show('aq-home-auth', 'flex');
        hide('aq-home-user');
        hide('aq-topbar');
        hide('aq-game-coins-display');
    }
}

// ---- AUTH PANEL ----
function renderAuthPanel(mode) {
    const p = el('aq-auth-panel');
    const isLogin = (mode === 'login');
    p.innerHTML = `
        <div class="aq-panel-title">${isLogin ? '⚔ LOGIN' : '📜 REGISTER'}</div>
        <div class="aq-divider"></div>
        <div class="aq-label">Username</div>
        <input class="aq-input" id="aq-uname" placeholder="Enter username" maxlength="20" autocomplete="off">
        <div class="aq-label">Password</div>
        <input class="aq-input" id="aq-pwd" type="password" placeholder="Enter password" maxlength="40">
        <div class="aq-err" id="aq-auth-err" style="display:none;"></div>
        <button class="aq-btn primary" id="aq-auth-submit">${isLogin ? 'Login' : 'Create Account'}</button>
        <button class="aq-btn ghost" onclick="AQ.showAuth('${isLogin?'register':'login'}')">
            ${isLogin ? "Don't have an account? Sign Up" : 'Already have an account? Login'}
        </button>
        <button class="aq-btn ghost" onclick="AQ.guestMode()">Continue as Guest (no saves)</button>
        <button class="aq-btn ghost" onclick="AQ.closeAuth()">✕ Close</button>
    `;
    el('aq-auth-submit').onclick = () => {
        if (isLogin) doLogin();
        else doRegister();
    };
    // Enter key
    [el('aq-uname'), el('aq-pwd')].forEach(inp => {
        inp && inp.addEventListener('keydown', e => { if(e.key==='Enter') el('aq-auth-submit').click(); });
    });
}

function authErr(msg) {
    const e = el('aq-auth-err');
    if (e) { e.textContent = msg; e.style.display = 'block'; }
}

function setAuthBusy(busy, busyText, idleText) {
    const b = el('aq-auth-submit');
    if (!b) return;
    b.textContent = busy ? busyText : idleText;
    b.disabled = busy;
}

function applyAuthResult(res) {
    saveSession({ id: res.user.id, username: res.user.username, total_coins: res.user.total_coins || 0, token: res.token });
    _isAdmin = !!res.user.is_admin;
    _isGuest = false;
    closeAllOverlays();
    updateHomeBar();
}

async function doRegister() {
    const username = (el('aq-uname').value||'').trim();
    const pwd      = (el('aq-pwd').value||'').trim();
    if (!username || username.length < 3) { authErr('Username must be at least 3 characters.'); return; }
    if (!pwd || pwd.length < 4) { authErr('Password must be at least 4 characters.'); return; }
    setAuthBusy(true, 'Creating...', 'Create Account');
    try {
        applyAuthResult(await rpc('register_user', { p_username: username, p_password: pwd }));
    } catch (e) {
        const m = e.message || '';
        if (m.includes('username_taken')) authErr('Username already taken.');
        else if (m.includes('invalid_username')) authErr('Username must be 3 to 20 characters.');
        else if (m.includes('invalid_password')) authErr('Password must be 4 to 40 characters.');
        else authErr('Error creating account. Try again.');
        setAuthBusy(false, '', 'Create Account');
    }
}

async function doLogin() {
    const username = (el('aq-uname').value||'').trim();
    const pwd      = (el('aq-pwd').value||'').trim();
    if (!username || !pwd) { authErr('Please fill in all fields.'); return; }
    setAuthBusy(true, 'Logging in...', 'Login');
    try {
        applyAuthResult(await rpc('login_user', { p_username: username, p_password: pwd }));
    } catch (e) {
        if ((e.message || '').includes('invalid_credentials')) authErr('Incorrect username or password.');
        else authErr('Could not reach the server. Try again.');
        setAuthBusy(false, '', 'Login');
    }
}

function closeAllOverlays() {
    hide('aq-auth-overlay');
    hide('aq-profile-overlay');
    hide('aq-lb-overlay');
}

// ---- RUN STATS HOOKS (called by game code) ----
function startSCRun() {
    if (!_session || _isGuest) return;
    _runStats.sc = { kills:0, damageDone:0, damageTaken:0, deaths:0, coinsEarned:0, coinsSpent:0, distance:0, startMs: Date.now() };
}

function startEndlessRun() {
    if (!_session || _isGuest) return;
    _runStats.endless = { kills:0, coinsEarned:0, distance:0, startMs: Date.now() };
}

function trackSCKill()              { _runStats.sc.kills++; }
function trackSCDamageDealt(d)     { _runStats.sc.damageDone  += (d||0); }
function trackSCDamageTaken(d)     { _runStats.sc.damageTaken += (d||0); }
function trackSCDeath()            { _runStats.sc.deaths++; }
function trackSCCoin()             { _runStats.sc.coinsEarned++; }
function trackSCSpend(cost)        { _runStats.sc.coinsSpent += (cost||0); }
function trackSCDist(d)            { _runStats.sc.distance = Math.max(_runStats.sc.distance, d||0); }

function trackEndlessKill()        { _runStats.endless.kills++; }
function trackEndlessCoin()        { _runStats.endless.coinsEarned++; }
function trackEndlessDist(d)       { _runStats.endless.distance = Math.max(_runStats.endless.distance, d||0); }

async function finishSCRun(completed) {
    if (!_session || _isGuest) return;
    const s = _runStats.sc;
    const time_ms = completed ? (Date.now() - s.startMs) : null;
    // Use max of tracked vs actual player coins as safety net
    const actualCoins = (typeof player !== 'undefined' ? player.coins : 0);
    const coinsEarned = Math.max(s.coinsEarned, actualCoins + s.coinsSpent);
    try {
        const res = await rpc('submit_shadow_run', {
            p_token:          _session.token,
            p_completed:      !!completed,
            p_time_ms:        time_ms === null ? null : nInt(time_ms),
            p_coins_earned:   nInt(coinsEarned),
            p_coins_spent:    nInt(s.coinsSpent),
            p_enemies_killed: nInt(s.kills),
            p_damage_dealt:   nInt(s.damageDone),
            p_damage_taken:   nInt(s.damageTaken),
            p_deaths:         nInt(s.deaths),
            p_distance:       nInt(s.distance),
        });
        // The server does the banking; just mirror its new total locally
        if (res && typeof res.total_coins === 'number') {
            _session.total_coins = res.total_coins;
            saveSession(_session);
            updateHomeBar();
            const bv = el('aq-bank-val');
            if (bv) bv.textContent = _session.total_coins.toLocaleString();
        }
    } catch(e) { console.warn('SC run save error', e); return; }
    await checkAchievements();
}

async function finishEndlessRun() {
    if (!_session || _isGuest) return;
    const s = _runStats.endless;
    try {
        await rpc('submit_endless_run', {
            p_token:          _session.token,
            p_distance:       nInt(s.distance),
            p_coins_earned:   nInt(s.coinsEarned),
            p_enemies_killed: nInt(s.kills),
        });
    } catch(e) { console.warn('Endless run save error', e); return; }
    await checkAchievements();
}

function startGauntletRun() {
    if (!_session || _isGuest) return;
    _runStats.gauntlet = { startMs: Date.now() };
}

async function finishGauntletRun(ch2Data) {
    if (!_session || _isGuest) return;
    // ch2Data: { character, totalTimeMs, deaths, perfectStages, stageTimes }
    try {
        await rpc('submit_gauntlet_run', {
            p_token:         _session.token,
            p_character:     ch2Data.character,
            p_total_time_ms: nInt(ch2Data.totalTimeMs),
            p_deaths:        nInt(ch2Data.deaths),
            p_perfect_stages: nInt(ch2Data.perfectStages),
            p_stage_times:   ch2Data.stageTimes || [],
        });
        await checkAchievements();
    } catch(e) { console.warn('Gauntlet run save error', e); }
}

// Achievements are unlocked by the server from stored run data
async function checkAchievements() {
    if (!_session || _isGuest) return;
    try {
        await rpc('check_achievements', { p_token: _session.token });
    } catch(e) { console.warn('Ach check err', e); }
}

// ---- PROFILE PANEL ----
async function showProfile() {
    if (!_session) { showAuth('login'); return; }
    const p = el('aq-profile-panel');
    p.innerHTML = '<div class="aq-panel-title">👤 PROFILE</div><div style="color:#7a5830;font-family:Cinzel,serif;font-size:12px;">Loading...</div>';
    show('aq-profile-overlay');

    try {
        const stats = await rpc('get_my_stats', { p_token: _session.token });
        const user   = stats.user || {};
        const scRuns = stats.sc_runs || [];
        const eRuns  = stats.endless_runs || [];
        const gRuns  = stats.gauntlet_runs || [];
        const unlockedAchs = new Set(stats.unlocked_ids || []);
        const achDefs = stats.achievements || [];

        const completions     = scRuns.filter(r=>r.completed);
        const bestSCTime      = completions.length ? Math.min(...completions.map(r=>r.time_taken_ms||Infinity)) : null;
        const totalSCKills    = scRuns.reduce((s,r)=>s+(r.enemies_killed||0),0);
        const totalSCDmgDone  = scRuns.reduce((s,r)=>s+(r.damage_dealt||0),0);
        const totalSCDmgTaken = scRuns.reduce((s,r)=>s+(r.damage_taken||0),0);
        const bestEndDist     = eRuns.length ? Math.max(...eRuns.map(r=>r.distance||0)) : 0;
        const totalEndRuns    = eRuns.length;

        // Gauntlet stats
        const gCompleted      = gRuns.filter(r => r.completed);
        const bestGTime       = gCompleted.length ? Math.min(...gCompleted.map(r=>r.total_time_ms||Infinity)) : null;
        const totalGDeaths    = gRuns.reduce((s,r) => s + (r.deaths||0), 0);
        const bestGPerfect    = gRuns.length ? Math.max(...gRuns.map(r=>r.perfect_stages||0)) : 0;
        const knightRuns      = gCompleted.filter(r=>r.character==='knight').length;
        const ninjaRuns       = gCompleted.filter(r=>r.character==='ninja').length;

        function fmtMs(ms) {
            if (!ms || ms===Infinity) return '—';
            const m=Math.floor(ms/60000), s=Math.floor((ms%60000)/1000);
            return `${m}m ${s<10?'0'+s:s}s`;
        }

        p.innerHTML = `
            <div class="aq-panel-title">👤 ${user.username||_session.username}</div>
            <div class="aq-divider"></div>
            <div class="aq-coin-bank">
                <div class="big">🏦 ${(user.total_coins||0).toLocaleString()}</div>
                <div class="lbl">Coin Bank</div>
            </div>
            <div class="aq-section-title">✦ Shadow Chronicle</div>
            <div class="aq-stat-grid">
                <div class="aq-stat-card"><div class="aq-stat-lbl">Total Runs</div><div class="aq-stat-val">${scRuns.length}</div></div>
                <div class="aq-stat-card"><div class="aq-stat-lbl">Completions</div><div class="aq-stat-val">${completions.length}</div></div>
                <div class="aq-stat-card"><div class="aq-stat-lbl">Best Time</div><div class="aq-stat-val" style="font-size:14px;">${fmtMs(bestSCTime)}</div></div>
                <div class="aq-stat-card"><div class="aq-stat-lbl">Enemies Killed</div><div class="aq-stat-val">${totalSCKills.toLocaleString()}</div></div>
                <div class="aq-stat-card"><div class="aq-stat-lbl">Damage Dealt</div><div class="aq-stat-val">${totalSCDmgDone.toLocaleString()}</div></div>
                <div class="aq-stat-card"><div class="aq-stat-lbl">Damage Taken</div><div class="aq-stat-val">${totalSCDmgTaken.toLocaleString()}</div></div>
            </div>
            <div class="aq-section-title">⚔ Endless Mode</div>
            <div class="aq-stat-grid">
                <div class="aq-stat-card"><div class="aq-stat-lbl">Total Runs</div><div class="aq-stat-val">${totalEndRuns}</div></div>
                <div class="aq-stat-card"><div class="aq-stat-lbl">Best Distance</div><div class="aq-stat-val">${bestEndDist.toLocaleString()}m</div></div>
            </div>
            <div class="aq-section-title">⚡ The Gauntlet</div>
            <div class="aq-stat-grid">
                <div class="aq-stat-card"><div class="aq-stat-lbl">Total Attempts</div><div class="aq-stat-val">${gRuns.length}</div></div>
                <div class="aq-stat-card"><div class="aq-stat-lbl">Completions</div><div class="aq-stat-val">${gCompleted.length}</div></div>
                <div class="aq-stat-card"><div class="aq-stat-lbl">Best Clear Time</div><div class="aq-stat-val" style="font-size:13px;">${fmtMs(bestGTime)}</div></div>
                <div class="aq-stat-card"><div class="aq-stat-lbl">Lives Lost</div><div class="aq-stat-val">${totalGDeaths}</div></div>
                <div class="aq-stat-card"><div class="aq-stat-lbl">Best Perfect Stages</div><div class="aq-stat-val">${bestGPerfect} / 5 ⭐</div></div>
                <div class="aq-stat-card"><div class="aq-stat-lbl">Knight Clears</div><div class="aq-stat-val">⚔ ${knightRuns}</div></div>
                <div class="aq-stat-card"><div class="aq-stat-lbl">Ninja Clears</div><div class="aq-stat-val">⚡ ${ninjaRuns}</div></div>
            </div>
            <div class="aq-section-title">🏅 Achievements (${unlockedAchs.size}/${achDefs.length})</div>
            <div class="aq-achievements">
                ${achDefs.map(a=>{
                    const cat = ACH_CATALOG.find(c=>c.key===a.key)||{};
                    const unlocked = unlockedAchs.has(a.id);
                    return `<div class="aq-ach ${unlocked?'':'locked'}">
                        <div class="aq-ach-icon">${a.icon||cat.icon||'🏅'}</div>
                        <div><div class="aq-ach-name">${a.name}</div><div class="aq-ach-desc">${a.description}</div></div>
                    </div>`;
                }).join('')}
            </div>
            <div class="aq-divider"></div>
            <button class="aq-btn secondary" onclick="document.getElementById('aq-profile-overlay').style.display='none'">Close</button>
        `;
    } catch(e) {
        p.innerHTML += `<div class="aq-err">Error loading profile: ${e.message}</div><button class="aq-btn ghost" onclick="document.getElementById('aq-profile-overlay').style.display='none'">Close</button>`;
    }
}

// ---- LEADERBOARD PANEL ----
let _lbMode = 'shadow';
let _lbPage = 0;

async function showLeaderboard() {
    show('aq-lb-overlay');
    _lbPage = 0;
    renderLB();
}

async function renderLB() {
    const p = el('aq-lb-panel');
    const PAGE_SIZE = 10;
    p.innerHTML = `
        <div class="aq-panel-title">🏆 LEADERBOARD</div>
        <div class="aq-lb-tabs">
            <div class="aq-lb-tab ${_lbMode==='shadow'?'active':''}" onclick="AQ._lbMode='shadow';AQ._lbPage=0;AQ.renderLB()">✦ Shadow Chronicle</div>
            <div class="aq-lb-tab ${_lbMode==='endless'?'active':''}" onclick="AQ._lbMode='endless';AQ._lbPage=0;AQ.renderLB()">⚔ Endless Mode</div>
            <div class="aq-lb-tab ${_lbMode==='gauntlet'?'active':''}" onclick="AQ._lbMode='gauntlet';AQ._lbPage=0;AQ.renderLB()">⚡ The Gauntlet</div>
        </div>
        <div id="aq-lb-content" style="width:100%;"><div style="color:#7a5830;font-family:Cinzel,serif;font-size:12px;text-align:center;padding:20px;">Loading...</div></div>
        <button class="aq-btn secondary" style="margin-top:8px;" onclick="document.getElementById('aq-lb-overlay').style.display='none'">Close</button>
    `;

    try {
        let rows, total;
        if (_lbMode === 'shadow') {
            const { data } = await db.from('leaderboard_shadow').select('*');
            rows  = (data||[]).slice(_lbPage*PAGE_SIZE, (_lbPage+1)*PAGE_SIZE);
            total = (data||[]).length;
        } else if (_lbMode === 'endless') {
            const { data } = await db.from('leaderboard_endless').select('*');
            rows  = (data||[]).slice(_lbPage*PAGE_SIZE, (_lbPage+1)*PAGE_SIZE);
            total = (data||[]).length;
        } else {
            const { data } = await db.from('leaderboard_gauntlet').select('*');
            rows  = (data||[]).slice(_lbPage*PAGE_SIZE, (_lbPage+1)*PAGE_SIZE);
            total = (data||[]).length;
        }

        function fmtMs(ms) {
            if (!ms) return '—';
            const m=Math.floor(ms/60000), s=Math.floor((ms%60000)/1000);
            return `${m}m ${s<10?'0'+s:s}s`;
        }

        const tableHTML = _lbMode === 'shadow' ? `
            <table class="aq-lb-table">
                <tr><th>#</th><th>Player</th><th>Best Time</th><th>Completions</th></tr>
                ${rows.map(r=>`<tr class="${r.username===(_session&&_session.username)?'me':''}">
                    <td class="aq-lb-rank">${r.rank}</td>
                    <td>${r.username}</td>
                    <td>${fmtMs(r.best_time_ms)}</td>
                    <td>${r.total_completions||0}</td>
                </tr>`).join('')}
            </table>
        ` : _lbMode === 'endless' ? `
            <table class="aq-lb-table">
                <tr><th>#</th><th>Player</th><th>Best Distance</th><th>Runs</th></tr>
                ${rows.map(r=>`<tr class="${r.username===(_session&&_session.username)?'me':''}">
                    <td class="aq-lb-rank">${r.rank}</td>
                    <td>${r.username}</td>
                    <td>${(r.best_distance||0).toLocaleString()}m</td>
                    <td>${r.total_runs||0}</td>
                </tr>`).join('')}
            </table>
        ` : `
            <table class="aq-lb-table">
                <tr><th>#</th><th>Player</th><th>Char</th><th>Best Time</th><th>Deaths</th><th>Perfect</th></tr>
                ${rows.map(r=>`<tr class="${r.username===(_session&&_session.username)?'me':''}">
                    <td class="aq-lb-rank">${r.rank}</td>
                    <td>${r.username}</td>
                    <td style="font-size:10px;">${r.best_character==='knight'?'⚔':'⚡'} ${r.best_character||'—'}</td>
                    <td>${fmtMs(r.best_time_ms)}</td>
                    <td>${r.total_deaths||0}</td>
                    <td>${r.best_perfect_stages||0}/5 💀</td>
                </tr>`).join('')}
            </table>
        `;

        const totalPages = Math.ceil(total/PAGE_SIZE);
        el('aq-lb-content').innerHTML = `
            ${tableHTML}
            ${totalPages>1?`<div class="aq-lb-page">
                <button onclick="AQ._lbPage=Math.max(0,AQ._lbPage-1);AQ.renderLB()">◀</button>
                <span>Page ${_lbPage+1} / ${totalPages}</span>
                <button onclick="AQ._lbPage=Math.min(${totalPages-1},AQ._lbPage+1);AQ.renderLB()">▶</button>
            </div>`:''}
        `;
    } catch(e) {
        el('aq-lb-content').innerHTML = `<div class="aq-err">Error loading leaderboard.</div>`;
    }
}

// ---- PUBLIC API ----
window.AQ = {
    _lbMode, _lbPage,
    showAuth(mode) {
        renderAuthPanel(mode||'login');
        show('aq-auth-overlay');
    },
    closeAuth() { hide('aq-auth-overlay'); },
    guestMode() {
        _isGuest = true;
        _session = null; _isAdmin = false;
        saveSession(null);
        hide('aq-auth-overlay');
        updateHomeBar();
    },
    logout() {
        if (_session && _session.token) db.rpc('logout_user', { p_token: _session.token }).catch(() => {});
        saveSession(null);
        _session = null; _isAdmin = false;
        _isGuest = false;
        updateHomeBar();
    },
    showProfile, showLeaderboard,
    renderLB,
    get _lbMode() { return _lbMode; }, set _lbMode(v) { _lbMode=v; },
    get _lbPage()  { return _lbPage;  }, set _lbPage(v)  { _lbPage=v; },

    // Hooks for game code
    startSCRun, finishSCRun,
    startEndlessRun, finishEndlessRun,
    startGauntletRun, finishGauntletRun,
    trackSCKill, trackSCDamageDealt, trackSCDamageTaken, trackSCDeath,
    trackSCCoin, trackSCSpend, trackSCDist,
    trackEndlessKill, trackEndlessCoin, trackEndlessDist,

    getSession() { return _session; },
    isGuest()    { return _isGuest; },
    isAdmin()    { return _isAdmin && !!(_session && _session.token); },
    // Re-checks admin rights with the server (token-checked RPC) — used before every stage warp
    async verifyAdmin() {
        if (!_session || !_session.token) { _isAdmin = false; return false; }
        try { _isAdmin = (await rpc('admin_check', { p_token: _session.token })) === true; }
        catch (e) { _isAdmin = false; }
        return _isAdmin;
    },
    getBankCoins() { return _session ? (_session.total_coins||0) : 0; },
    getDb() { return db; },
};

// ---- INIT ----
loadSession();
// Sessions saved by the old client-side login have no token and can't be used
if (_session && !_session.token) saveSession(null);
window.addEventListener('DOMContentLoaded', async () => {
    updateHomeBar();
    if (_session && _session.token) {
        try {
            const me = await rpc('get_me', { p_token: _session.token });
            _session.total_coins = me.total_coins || 0;
            _session.username = me.username;
            _isAdmin = !!me.is_admin;
            saveSession(_session);
        } catch(e) { /* rpc() clears a rejected session */ }
        updateHomeBar();
    }
});

})();
