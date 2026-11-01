// ================================================================
// 1V1 MULTIPLAYER
// Lobbies: token-checked Supabase RPCs (public list, private codes).
// Match: Supabase Realtime broadcast between the two players.
// Each player simulates their own fighter and reports it; hits are
// reported by the attacker and applied by the victim.
// ================================================================
(function () {
'use strict';

const ROUNDS_TO_WIN  = 2;
const READY_MS       = 1500;  // countdown before inputs unlock
const FIGHT_MS       = 700;   // "FIGHT!" banner after countdown
const ROUND_END_MS   = 2600;  // pause between rounds
const DRAW_WINDOW_MS = 400;   // both deaths within this window = draw
const DISCONNECT_MS  = 8000;  // no messages for this long = forfeit
const SEND_EVERY     = 3;     // 60 ticks/s -> 20 state updates/s
const INVULN_TICKS   = 14;
const BLOCK_MULT     = 0.2;
const POLL_MS        = 1500;
const BROWSE_MS      = 3000;
const FLOOR_Y        = 440;
const GRAVITY        = 0.65;
const MAX_FALL       = 16;
const NO_INPUT      = { left:false, right:false, jump:false, block:false, attackPressed:false };

const CHAR = {
    knight: { hp:150, speed:4.6, jump:-13, dmg:14, reach:62, w:48, h:62, fo:18, pad:37, drawW:160, drawH:140,
              fw:96, fh:83, attackFrameTicks:4, attackTicks:24, hitStart:8, hitEnd:16,
              anim: { idle:['ch2_knight_idle',7], walk:['ch2_knight_walk',8], jump:['ch2_knight_jump',5],
                      attack:['ch2_knight_atk1',6], block:['ch2_knight_defend',6], dead:['ch2_knight_atk2',5] } },
    ninja:  { hp:110, speed:5.5, jump:-13.5, dmg:12, reach:58, w:44, h:64, fo:0, pad:32, drawW:128, drawH:128,
              fw:128, fh:128, attackFrameTicks:1, attackTicks:20, hitStart:6, hitEnd:12,
              anim: { idle:['ch2_ninja_idle',8], walk:['ch2_ninja_walk',10], jump:['ch2_ninja_idle',8],
                      attack:['ch2_ninja_attack',20], dead:['ch2_ninja_death',14] } },
};

const ERRORS = {
    lobby_unavailable: 'That lobby is no longer available.',
    lobby_not_found:   'That lobby could not be found.',
    already_in_match:  'You are already in a match. Finish it first.',
    own_lobby:         "You can't join your own lobby.",
    cannot_start:      'Wait for an opponent to join before starting.',
    not_host:          'Only the host can start the match.',
    not_playing:       'This match is no longer active.',
    invalid_session:   'Your session expired. Please log in again.',
};

const S = {
    active: false,          // match running — main loop hands over to versus.js
    phase: 'off',           // off | menu | browse | code | waiting | match | result
    token: null, userId: null, username: null,
    pickChar: 'knight',
    lobbyId: null, code: null, visibility: 'public', role: null,
    myChar: null, opp: null, round: 1, myWins: 0, oppWins: 0,
    me: null, R: null, roundOver: false, matchOver: false, roundStartT: 0,
    ownDeathT: null, oppDeathT: null, resolveTimer: null,
    banner: '', bannerT: 0, resultTitle: '', resultNote: '',
    ch: null, pollTimer: null, browseTimer: null,
    lastRemoteT: 0, prevAttack: false, prevJump: false, tickN: 0,
};

const now = () => performance.now();
const W = () => window.GAME_WIDTH  || 960;
const H = () => window.GAME_HEIGHT || 540;
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

// ---------------- RPC + errors ----------------
async function rpc(name, args) {
    const { data, error } = await AQ.getDb().rpc(name, args || {});
    if (error) {
        if ((error.message || '').includes('invalid_session')) AQ.logout();
        throw error;
    }
    return data;
}
function errText(e) {
    const m = (e && e.message) || '';
    for (const k of Object.keys(ERRORS)) if (m.includes(k)) return ERRORS[k];
    return 'Something went wrong. Please try again.';
}

// ---------------- overlay panels ----------------
function ensureOverlay() {
    let o = document.getElementById('vs-overlay');
    if (!o) {
        o = document.createElement('div');
        o.id = 'vs-overlay';
        o.className = 'aq-overlay';
        o.style.display = 'none';
        document.body.appendChild(o);
    }
    return o;
}
function showPanel(html) {
    const o = ensureOverlay();
    o.innerHTML = `<div class="aq-panel wide">${html}</div>`;
    o.style.display = 'flex';
}
function hidePanel() {
    const o = document.getElementById('vs-overlay');
    if (o) o.style.display = 'none';
}
function setErr(msg) {
    const e = document.getElementById('vs-err');
    if (e) { e.textContent = msg; e.style.display = msg ? 'block' : 'none'; }
}

// ---------------- lobby screens ----------------
function stopPoll()   { if (S.pollTimer)  { clearInterval(S.pollTimer);  S.pollTimer = null; } }
function stopBrowse() { if (S.browseTimer){ clearInterval(S.browseTimer); S.browseTimer = null; } }

function renderMenu(msg) {
    stopBrowse();
    S.phase = 'menu';
    const c = S.pickChar;
    showPanel(`
        <div class="aq-panel-title">⚔ 1V1 MULTIPLAYER</div>
        <div class="aq-divider"></div>
        <div class="aq-label">Your fighter</div>
        <div style="display:flex;gap:8px;justify-content:center;">
            <button class="aq-btn ${c==='knight'?'primary':'ghost'}" onclick="VS._pick('knight')">🛡 Knight</button>
            <button class="aq-btn ${c==='ninja'?'primary':'ghost'}" onclick="VS._pick('ninja')">⚡ Ninja</button>
        </div>
        <div class="aq-label">Host a lobby</div>
        <button class="aq-btn primary" onclick="VS._create('public')">Host Public Lobby</button>
        <button class="aq-btn primary" onclick="VS._create('private')">Host Private Lobby (code only)</button>
        <div class="aq-label">Join a lobby</div>
        <button class="aq-btn secondary" onclick="VS._browse()">Browse Public Lobbies</button>
        <button class="aq-btn secondary" onclick="VS._codeView()">Join with a Code</button>
        <div class="aq-err" id="vs-err" style="display:${msg?'block':'none'};">${esc(msg||'')}</div>
        <button class="aq-btn ghost" onclick="VS.close()">✕ Close</button>
    `);
}

async function renderBrowse() {
    stopBrowse();
    S.phase = 'browse';
    showPanel(`
        <div class="aq-panel-title">🌐 PUBLIC LOBBIES</div>
        <div class="aq-divider"></div>
        <div id="vs-list" style="font-family:Cinzel,serif;font-size:12px;color:#7a5830;">Loading...</div>
        <div class="aq-err" id="vs-err" style="display:none;"></div>
        <button class="aq-btn secondary" onclick="VS._browse()">↻ Refresh</button>
        <button class="aq-btn ghost" onclick="VS._menu()">← Back</button>
    `);
    await loadBrowse();
    if (S.phase === 'browse') S.browseTimer = setInterval(loadBrowse, BROWSE_MS);
}

async function loadBrowse() {
    if (S.phase !== 'browse') return;
    const list = document.getElementById('vs-list');
    try {
        const rows = (await rpc('list_public_lobbies')) || [];
        if (!list) return;
        if (!rows.length) {
            list.innerHTML = 'No public lobbies right now. Host one, or refresh in a moment.';
            return;
        }
        list.innerHTML = rows.map(r => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #3a2810;">
                <span style="color:#ffe8a0;">${esc(r.host_name)} <span style="color:#7a5830;">(${r.host_character==='ninja'?'⚡ Ninja':'🛡 Knight'})</span></span>
                <button class="aq-btn primary" style="width:auto;padding:6px 16px;" onclick="VS._joinPublic('${r.id}')">Join</button>
            </div>`).join('');
    } catch (e) {
        if (list) list.textContent = errText(e);
    }
}

function renderCodeView() {
    stopBrowse();
    S.phase = 'code';
    showPanel(`
        <div class="aq-panel-title">🔑 JOIN WITH CODE</div>
        <div class="aq-divider"></div>
        <div class="aq-label">Lobby code</div>
        <input class="aq-input" id="vs-code" maxlength="6" placeholder="e.g. 1A2B3C" autocomplete="off" style="text-transform:uppercase;">
        <div class="aq-err" id="vs-err" style="display:none;"></div>
        <button class="aq-btn primary" onclick="VS._joinCode()">Join Lobby</button>
        <button class="aq-btn ghost" onclick="VS._menu()">← Back</button>
    `);
}

function renderWaiting(L) {
    S.phase = 'waiting';
    S.lobbyId = L.id;
    S.role = L.you;
    S.visibility = L.visibility;
    if (L.code) S.code = L.code;
    const isHost = L.you === 'host';
    const host = L.host, guest = L.guest;
    const codeBlock = isHost && S.code ? `
        <div class="aq-label">Lobby code (share this)</div>
        <div style="font-family:'Cinzel Decorative',serif;font-size:26px;letter-spacing:6px;color:#ffe8a0;text-align:center;">${esc(S.code)}</div>
        <button class="aq-btn secondary" onclick="VS._copy()">Copy code</button>` : '';
    showPanel(`
        <div class="aq-panel-title">⚔ LOBBY</div>
        <div class="aq-divider"></div>
        <div style="font-family:Cinzel,serif;font-size:11px;color:#7a5830;text-align:center;">
            ${L.visibility==='public' ? 'Public lobby' : 'Private lobby — code only'}</div>
        ${codeBlock}
        <div class="aq-label">Players</div>
        <div style="font-family:Cinzel,serif;font-size:13px;color:#ffe8a0;line-height:1.9;">
            🛡 ${esc(host.username)} <span style="color:#7a5830;">(host · ${esc(host.character)})</span><br>
            ${guest
                ? `⚡ ${esc(guest.username)} <span style="color:#7a5830;">(guest · ${esc(guest.character)})</span>`
                : '<span style="color:#7a5830;">Waiting for an opponent…</span>'}
        </div>
        <div class="aq-err" id="vs-err" style="display:none;"></div>
        ${isHost
            ? `<button class="aq-btn primary" ${guest ? '' : 'disabled style="opacity:.5;cursor:not-allowed;"'} onclick="VS._start()">Start Match</button>`
            : '<div style="font-family:Cinzel,serif;font-size:12px;color:#7a5830;">Waiting for the host to start…</div>'}
        <button class="aq-btn ghost" onclick="VS._leave()">Leave Lobby</button>
    `);
}

function enterLobby(L) {
    renderWaiting(L);
    stopPoll();
    S.pollTimer = setInterval(pollLobby, POLL_MS);
}

async function pollLobby() {
    if (S.phase !== 'waiting' || !S.lobbyId) return;
    try {
        const L = await rpc('lobby_state', { p_token: S.token, p_lobby_id: S.lobbyId });
        if (S.phase !== 'waiting') return;
        if (L.status === 'playing') return beginMatch(L);
        if (L.status === 'closed' || L.status === 'finished') {
            stopPoll(); S.lobbyId = null;
            renderMenu('The lobby was closed.');
            return;
        }
        renderWaiting(L);
    } catch (e) {
        // transient network error: keep polling
    }
}

// ---------------- match setup ----------------
function arenaPlatforms() {
    return [
        { x: 0,   y: FLOOR_Y, w: W(), h: H() - FLOOR_Y },
        { x: 150, y: 330, w: 200, h: 24 },
        { x: 610, y: 330, w: 200, h: 24 },
        { x: 380, y: 230, w: 200, h: 24 },
    ];
}

function makeFighter(charKey, spawnX, facing) {
    const c = CHAR[charKey];
    const f = {
        char: charKey, c, w: c.w, h: c.h, fo: c.fo,
        x: spawnX, y: 0, vx: 0, vy: 0, facing,
        grounded: false, hp: c.hp, maxHp: c.hp,
        invuln: 0, knock: 0, dead: false, blocking: false,
        attacking: false, attackT: 0, hitDone: false,
        anim: 'idle', frame: 0, frameT: 0,
    };
    f.y = FLOOR_Y - (f.h + f.fo);
    return f;
}

function startRound() {
    S.roundOver = false;
    S.ownDeathT = null; S.oppDeathT = null;
    clearTimeout(S.resolveTimer); S.resolveTimer = null;
    const iAmHost = S.role === 'host';
    const leftX = 160, rightX = W() - 160 - 48;
    S.me = makeFighter(S.myChar, iAmHost ? leftX : rightX, iAmHost ? 'right' : 'left');
    S.R  = makeFighter(S.opp.character, iAmHost ? rightX : leftX, iAmHost ? 'left' : 'right');
    S.R.tx = S.R.x; S.R.ty = S.R.y;
    S.roundStartT = now();
    S.banner = `ROUND ${S.round}`; S.bannerT = now();
    S.prevAttack = true;   // ignore an attack key still held from before
    S.prevJump = true;
}

function beginMatch(L) {
    if (S.phase === 'match') return;
    stopPoll();
    S.lobbyId = L.id;
    S.role = L.you;
    const iAmHost = L.you === 'host';
    const meInfo  = iAmHost ? L.host : L.guest;
    const oppInfo = iAmHost ? L.guest : L.host;
    S.myChar = meInfo.character;
    S.opp = oppInfo;
    S.round = 1; S.myWins = 0; S.oppWins = 0;
    S.matchOver = false; S.roundOver = false;
    S.phase = 'match';
    S.active = true;
    hidePanel();
    enterGameScreen();
    connectChannel();
}

function enterGameScreen() {
    const home = document.getElementById('home-screen');
    if (window._cancelHomeAnim) window._cancelHomeAnim();
    if (home) home.classList.add('fade-out');
    setTimeout(() => {
        if (home) home.style.display = 'none';
        if (window.resetGame) window.resetGame();
        const cv = document.getElementById('gameCanvas');
        if (cv) cv.style.pointerEvents = 'auto';
        window._gameLoopActive = true;
        if (window._ch2SetLoopVars) window._ch2SetLoopVars(0, 0);
        requestAnimationFrame(window._gameLoopTick);
    }, 300);
}

// ---------------- realtime channel ----------------
function connectChannel() {
    const ch = AQ.getDb().channel('vs:' + S.lobbyId, { config: { broadcast: { self: false } } });
    ch.on('broadcast', { event: 'state' }, ({ payload }) => onState(payload));
    ch.on('broadcast', { event: 'hit'   }, ({ payload }) => onHit(payload));
    ch.on('broadcast', { event: 'died'  }, ({ payload }) => onOppDied(payload));
    ch.on('broadcast', { event: 'leave' }, ({ payload }) => onOppLeft(payload));
    ch.subscribe(status => {
        if (status === 'SUBSCRIBED') {
            S.lastRemoteT = now();
            if (S.phase === 'match') startRound();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            abortMatch('Lost the connection to the match.');
        }
    });
    S.ch = ch;
}

function send(event, payload) {
    if (!S.ch) return;
    S.ch.send({ type: 'broadcast', event, payload: Object.assign({ uid: S.userId, round: S.round }, payload) })
        .catch(() => {});
}

function fromOpp(p) { return p && S.opp && p.uid === S.opp.id; }

function onState(p) {
    if (!fromOpp(p)) return;
    S.lastRemoteT = now();
    if (p.round !== S.round || !S.R) return;
    const R = S.R;
    R.tx = p.x; R.ty = p.y; R.facing = p.facing;
    R.anim = p.anim; R.frame = p.frame; R.hp = p.hp;
    R.blocking = p.blocking; R.attacking = p.attacking; R.dead = p.dead;
}

function onHit(p) {
    if (!fromOpp(p) || p.round !== S.round || p.to !== S.userId) return;
    const me = S.me;
    if (!me || S.roundOver || me.dead || me.invuln > 0) return;
    const dmg = p.dmg * (me.blocking ? BLOCK_MULT : 1);
    me.hp = Math.max(0, me.hp - dmg);
    me.invuln = INVULN_TICKS;
    me.knock = (p.fromX < me.x ? 1 : -1) * 4.5;
    if (me.hp <= 0) killMe();
}

function onOppDied(p) {
    if (!fromOpp(p) || p.round !== S.round) return;
    S.oppDeathT = now();
    if (S.R) S.R.dead = true;
    scheduleResolve();
}

function onOppLeft(p) {
    if (!fromOpp(p) || S.matchOver) return;
    forfeitWin('Your opponent left the match.');
}

function abortMatch(note) {
    if (S.matchOver) return;
    S.matchOver = true;
    rpc('leave_lobby', { p_token: S.token, p_lobby_id: S.lobbyId }).catch(() => {});
    S.resultTitle = 'MATCH ENDED';
    S.resultNote = note;
    showResult();
}

// ---------------- round + match flow ----------------
function killMe() {
    const me = S.me;
    if (!me || me.dead) return;
    me.dead = true; me.hp = 0;
    S.ownDeathT = now();
    send('died', {});
    scheduleResolve();
}

function scheduleResolve() {
    if (S.resolveTimer || S.roundOver) return;
    S.resolveTimer = setTimeout(resolveRound, DRAW_WINDOW_MS);
}

function resolveRound() {
    S.resolveTimer = null;
    if (S.roundOver) return;
    const meDied = S.ownDeathT !== null, oppDied = S.oppDeathT !== null;
    const result = (meDied && oppDied) ? 'draw' : (meDied ? 'opp' : 'me');
    S.roundOver = true;
    if (result === 'me')  S.myWins++;
    if (result === 'opp') S.oppWins++;
    S.banner = result === 'draw' ? 'DRAW — REPLAY' : (result === 'me' ? 'ROUND WON' : 'ROUND LOST');
    S.bannerT = now();
    if (S.myWins >= ROUNDS_TO_WIN || S.oppWins >= ROUNDS_TO_WIN) { endMatch(); return; }
    setTimeout(() => {
        if (S.phase !== 'match' || S.matchOver) return;
        S.round++;
        startRound();
    }, ROUND_END_MS);
}

function forfeitWin(note) {
    if (S.matchOver) return;
    S.myWins = Math.max(S.myWins, ROUNDS_TO_WIN);
    S.resultNote = note;
    endMatch();
}

function endMatch() {
    if (S.matchOver) return;
    S.matchOver = true;
    const iWon = S.myWins > S.oppWins;
    S.resultTitle = iWon ? 'VICTORY' : 'DEFEAT';
    if (!S.resultNote) S.resultNote = iWon ? 'You won the match.' : 'Better luck next time.';
    const hostRounds  = S.role === 'host' ? S.myWins : S.oppWins;
    const guestRounds = S.role === 'host' ? S.oppWins : S.myWins;
    const winnerId = iWon ? S.userId : S.opp.id;
    rpc('finish_lobby', {
        p_token: S.token, p_lobby_id: S.lobbyId, p_winner_id: winnerId,
        p_host_rounds: hostRounds, p_guest_rounds: guestRounds,
    }).catch(() => {});
    showResult();
}

function showResult() {
    S.phase = 'result';
    const opp = S.opp ? esc(S.opp.username) : 'opponent';
    showPanel(`
        <div class="aq-panel-title">${esc(S.resultTitle)}</div>
        <div class="aq-divider"></div>
        <div style="font-family:Cinzel,serif;font-size:14px;color:#ffe8a0;text-align:center;">
            ${S.myWins} – ${S.oppWins} vs ${opp}</div>
        <div style="font-family:Cinzel,serif;font-size:12px;color:#7a5830;text-align:center;">${esc(S.resultNote)}</div>
        <button class="aq-btn primary" onclick="VS._afterMatch()">Back to Lobby Menu</button>
        <button class="aq-btn ghost" onclick="VS._home()">⌂ Home</button>
    `);
}

// ---------------- per-tick simulation ----------------
function readInput() {
    const k = window._keys || {};
    const attackDown = !!(k.KeyK || k.Space);
    const jumpDown   = !!(k.ArrowUp || k.KeyW);
    const input = {
        left:  !!(k.ArrowLeft || k.KeyA),
        right: !!(k.ArrowRight || k.KeyD),
        jump:  jumpDown && !S.prevJump,
        block: !!(k.ArrowDown || k.KeyS),
        attackPressed: attackDown && !S.prevAttack,
    };
    S.prevAttack = attackDown;
    S.prevJump = jumpDown;
    return input;
}

function animDef(c, anim) {
    const d = c.anim[anim] || c.anim.idle;
    return { key: d[0], frames: d[1] };
}

function stepFighter(f, inp, opp, plats) {
    const c = f.c;
    if (f.attacking) {
        f.attackT++;
        if (f.attackT >= c.attackTicks) f.attacking = false;
    }
    f.blocking = false;
    let mx = 0;
    if (!f.dead) {
        f.blocking = !!inp.block && f.grounded && !f.attacking;
        if (!f.blocking) mx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
        if (f.attacking) mx *= 0.3;
        if (inp.jump && f.grounded && !f.blocking && !f.attacking) { f.vy = c.jump; f.grounded = false; }
        if (inp.attackPressed && !f.attacking && !f.blocking) {
            f.attacking = true; f.attackT = 0; f.hitDone = false;
        }
    }
    if (f.knock) {
        f.vx = f.knock;
        f.knock *= 0.82;
        if (Math.abs(f.knock) < 0.4) f.knock = 0;
    } else {
        f.vx = mx * c.speed;
    }
    if (!f.knock) {
        if (mx) f.facing = mx > 0 ? 'right' : 'left';
        else if (!f.attacking && opp) f.facing = (opp.x + opp.w / 2 >= f.x + f.w / 2) ? 'right' : 'left';
    }

    f.vy = Math.min(f.vy + GRAVITY, MAX_FALL);
    f.x = Math.max(0, Math.min(W() - f.w, f.x + f.vx));
    const prevFeet = f.y + f.h + f.fo;
    f.y += f.vy;
    f.grounded = false;
    if (f.vy >= 0) {
        const feet = f.y + f.h + f.fo;
        for (const p of plats) {
            if (f.x + f.w > p.x && f.x < p.x + p.w && prevFeet <= p.y + 2 && feet >= p.y) {
                f.y = p.y - f.h - f.fo;
                f.vy = 0;
                f.grounded = true;
                break;
            }
        }
    }
    if (f.invuln > 0) f.invuln--;

    // animation
    const anim = f.dead ? 'dead' : f.attacking ? 'attack' : f.blocking ? 'block'
               : !f.grounded ? 'jump' : Math.abs(f.vx) > 0.5 ? 'walk' : 'idle';
    if (anim !== f.anim) { f.anim = anim; f.frame = 0; f.frameT = 0; }
    if (anim === 'attack') {
        f.frame = Math.min(Math.floor(f.attackT / c.attackFrameTicks), animDef(c, 'attack').frames - 1);
    } else if (anim === 'jump') {
        f.frame = Math.min(f.vy < -2 ? 0 : f.vy > 2 ? 2 : 1, animDef(c, 'jump').frames - 1);
    } else {
        const def = animDef(c, anim);
        f.frameT++;
        const speed = anim === 'dead' ? 6 : anim === 'walk' ? 5 : 7;
        if (f.frameT >= speed) {
            f.frameT = 0;
            f.frame = anim === 'dead' ? Math.min(f.frame + 1, def.frames - 1) : (f.frame + 1) % def.frames;
        }
    }
}

function hitBox(f) {
    const x1 = f.facing === 'right' ? f.x + f.w : f.x - f.c.reach;
    return { x1, x2: x1 + f.c.reach, y1: f.y + f.h * 0.25, y2: f.y + f.h + f.fo };
}

function overlaps(hb, o) {
    return hb.x1 < o.x + o.w && hb.x2 > o.x && hb.y1 < o.y + o.h + o.fo && hb.y2 > o.y;
}

function tick() {
    if (!S.active || (S.phase !== 'match' && S.phase !== 'result')) return;
    S.tickN++;
    const me = S.me, R = S.R;
    if (!me || !R) return;

    const locked = S.roundOver || S.matchOver || (now() - S.roundStartT) < READY_MS;
    const input = locked ? NO_INPUT : readInput();
    stepFighter(me, input, R, arenaPlatforms());

    // smooth the opponent toward their last reported position
    const dx = R.tx - R.x, dy = R.ty - R.y;
    if (Math.abs(dx) > 300 || Math.abs(dy) > 300) { R.x = R.tx; R.y = R.ty; }
    else { R.x += dx * 0.45; R.y += dy * 0.45; }

    // attacker reports a hit once per swing
    if (me.attacking && !me.hitDone && !me.dead && !locked &&
        me.attackT >= me.c.hitStart && me.attackT <= me.c.hitEnd) {
        if (overlaps(hitBox(me), R)) {
            me.hitDone = true;
            send('hit', { to: S.opp.id, dmg: me.c.dmg, fromX: me.x });
        }
    }

    if (S.tickN % SEND_EVERY === 0) {
        send('state', {
            x: me.x, y: me.y, facing: me.facing, anim: me.anim, frame: me.frame,
            hp: me.hp, blocking: me.blocking, attacking: me.attacking, dead: me.dead,
        });
    }

    if (!S.matchOver && now() - S.lastRemoteT > DISCONNECT_MS) {
        forfeitWin('Your opponent disconnected.');
    }
}

// ---------------- drawing ----------------
function drawPlatform(ctx, p, img) {
    if (img && img.complete && img.naturalWidth) {
        ctx.save();
        ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
        const pw = img.naturalWidth;
        for (let px = p.x; px < p.x + p.w; px += pw) ctx.drawImage(img, px, p.y, pw, p.h);
        ctx.restore();
    } else {
        ctx.fillStyle = '#3a2010';
        ctx.fillRect(p.x, p.y, p.w, p.h);
    }
}

function drawFighter(ctx, f) {
    const c = f.c;
    const def = animDef(c, f.anim);
    const img = window._images && window._images[def.key];
    ctx.save();
    if (f.invuln > 0 && (S.tickN >> 2) % 2 === 0) ctx.globalAlpha = 0.45;
    if (f.anim === 'block' && !c.anim.block) ctx.filter = 'brightness(0.85)';
    if (img && img.complete && img.naturalWidth) {
        const fi = Math.min(f.frame, def.frames - 1);
        const dw = c.drawW, dh = c.drawH;
        const dx = f.x - (dw - f.w) / 2;
        const dy = f.y + f.h - dh + f.fo + c.pad;   // feet land on the floor line
        ctx.imageSmoothingEnabled = false;
        if (f.facing === 'left') {
            ctx.scale(-1, 1);
            ctx.drawImage(img, fi * c.fw, 0, c.fw, c.fh, -(dx + dw), dy, dw, dh);
        } else {
            ctx.drawImage(img, fi * c.fw, 0, c.fw, c.fh, dx, dy, dw, dh);
        }
    } else {
        ctx.fillStyle = f.char === 'ninja' ? '#aaff44' : '#c8a060';
        ctx.fillRect(f.x, f.y, f.w, f.h + f.fo);
    }
    ctx.restore();
}

function drawBar(ctx, x, y, f, name, color, right) {
    const bw = 300, bh = 14;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 4, y - 4, bw + 8, bh + 30);
    ctx.font = 'bold 13px AntiquityPrint, serif';
    ctx.fillStyle = color;
    ctx.textAlign = right ? 'right' : 'left';
    ctx.fillText(name, right ? x + bw : x, y + 9);
    ctx.fillStyle = '#331111';
    ctx.fillRect(x, y + 14, bw, bh);
    const fw = bw * Math.max(0, f.hp) / f.maxHp;
    ctx.fillStyle = color;
    ctx.fillRect(right ? x + bw - fw : x, y + 14, fw, bh);
    ctx.restore();
}

function drawPips(ctx, x, y, wins, color, right) {
    ctx.save();
    for (let i = 0; i < ROUNDS_TO_WIN; i++) {
        const px = right ? x - i * 18 : x + i * 18;
        ctx.beginPath();
        ctx.arc(px + 6, y + 10, 6, 0, Math.PI * 2);
        ctx.fillStyle = i < wins ? color : '#2a1a10';
        ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.restore();
}

function drawBanner(ctx) {
    const t = now() - S.roundStartT;
    let text = null;
    if (S.roundStartT && t < READY_MS) text = `ROUND ${S.round}`;
    else if (S.roundStartT && t < READY_MS + FIGHT_MS && !S.roundOver) text = 'FIGHT!';
    else if (S.roundOver && S.banner) text = S.banner;
    if (!text) return;
    ctx.save();
    ctx.font = 'bold 40px AntiquityPrint, serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 12;
    ctx.fillStyle = '#ffe8a0';
    ctx.fillText(text, W() / 2, H() / 2 - 60);
    ctx.restore();
}

function draw(ctx) {
    if (!S.active || !ctx) return;
    const w = W(), h = H();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0c1a0e');
    g.addColorStop(1, '#030604');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const img = window._images && window._images['arena_platform'];
    arenaPlatforms().forEach(p => drawPlatform(ctx, p, img));

    if (S.R)  drawFighter(ctx, S.R);
    if (S.me) drawFighter(ctx, S.me);

    if (S.me && S.R) {
        drawBar(ctx, 20, 14, S.me, S.username || 'You', '#aaff44', false);
        drawBar(ctx, w - 320, 14, S.R, S.opp ? S.opp.username : 'Opponent', '#ff5566', true);
        drawPips(ctx, 20, 46, S.myWins, '#aaff44', false);
        drawPips(ctx, w - 20 - 12, 46, S.oppWins, '#ff5566', true);
    }
    drawBanner(ctx);
}

// ---------------- public API ----------------
function open() {
    const s = AQ.getSession();
    if (!s || !s.token) { AQ.showAuth('login'); return; }
    S.token = s.token;
    S.userId = s.id;
    S.username = s.username;
    if (S.phase === 'match' || S.phase === 'result') return;
    S.active = false;
    renderMenu();
}

function close() {
    stopPoll(); stopBrowse();
    if (S.phase === 'waiting' && S.lobbyId) {
        rpc('leave_lobby', { p_token: S.token, p_lobby_id: S.lobbyId }).catch(() => {});
        S.lobbyId = null;
    }
    S.phase = 'off';
    hidePanel();
}

function exitMatch() {
    if (S.phase === 'off') { hidePanel(); return; }
    if (S.ch) {
        try { S.ch.send({ type: 'broadcast', event: 'leave', payload: { uid: S.userId, round: S.round } }); } catch (e) {}
        AQ.getDb().removeChannel(S.ch);
        S.ch = null;
    }
    clearTimeout(S.resolveTimer); S.resolveTimer = null;
    if (S.phase === 'match' && !S.matchOver && S.opp) {
        // leaving mid-match counts as a forfeit
        const hostRounds  = S.role === 'host' ? S.myWins : S.oppWins;
        const guestRounds = S.role === 'host' ? S.oppWins : S.myWins;
        rpc('finish_lobby', { p_token: S.token, p_lobby_id: S.lobbyId, p_winner_id: S.opp.id,
            p_host_rounds: hostRounds, p_guest_rounds: guestRounds }).catch(() => {});
        S.matchOver = true;
    } else if (S.phase === 'waiting' && S.lobbyId) {
        rpc('leave_lobby', { p_token: S.token, p_lobby_id: S.lobbyId }).catch(() => {});
    }
    stopPoll(); stopBrowse();
    S.active = false;
    S.phase = 'off';
    S.lobbyId = null; S.code = null; S.me = null; S.R = null; S.opp = null;
    hidePanel();
}

window.VS = {
    open, close, exitMatch,
    isActive: () => S.active,
    _menu: () => renderMenu(),
    _pick(c) { S.pickChar = c; renderMenu(); },
    async _create(vis) {
        try { enterLobby(await rpc('create_lobby', { p_token: S.token, p_visibility: vis, p_character: S.pickChar })); }
        catch (e) { renderMenu(errText(e)); }
    },
    _browse: () => renderBrowse(),
    async _joinPublic(id) {
        try { enterLobby(await rpc('join_lobby', { p_token: S.token, p_lobby_id: id, p_code: null, p_character: S.pickChar })); }
        catch (e) { renderMenu(errText(e)); }
    },
    _codeView: () => renderCodeView(),
    async _joinCode() {
        const el = document.getElementById('vs-code');
        const code = ((el && el.value) || '').trim().toUpperCase();
        if (!code) { setErr('Enter a lobby code.'); return; }
        try { enterLobby(await rpc('join_lobby', { p_token: S.token, p_lobby_id: null, p_code: code, p_character: S.pickChar })); }
        catch (e) { setErr(errText(e)); }
    },
    async _start() {
        try { beginMatch(await rpc('start_lobby', { p_token: S.token, p_lobby_id: S.lobbyId })); }
        catch (e) { setErr(errText(e)); }
    },
    _copy() {
        if (S.code && navigator.clipboard) navigator.clipboard.writeText(S.code).catch(() => {});
    },
    async _leave() {
        const id = S.lobbyId;
        stopPoll();
        S.lobbyId = null;
        if (id) { try { await rpc('leave_lobby', { p_token: S.token, p_lobby_id: id }); } catch (e) {} }
        renderMenu();
    },
    _afterMatch() {
        exitMatch();
        if (window.goHome) window.goHome();
        open();
    },
    _home() {
        exitMatch();
        if (window.goHome) window.goHome();
        hidePanel();
    },
};

window._vsTickHook = tick;
window._vsDrawHook = () => draw(window._ctx);

})();
