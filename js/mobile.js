// ================================================================
// MOBILE / TOUCH CONTROLS
// Pure add-on layer: turns touches into the same keyboard events the
// game already listens for, so single-player, Chapter 2 and 1v1
// multiplayer all work without touching their input code.
//   ?touch=1 forces the controls on (desktop testing), ?touch=0 off.
// ================================================================
(function () {
'use strict';

const qs = new URLSearchParams(location.search);
const force = qs.get('touch');
const looksTouch = ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
                   window.matchMedia && matchMedia('(pointer: coarse)').matches;
if (force === '0' || (force !== '1' && !looksTouch)) return;

document.documentElement.classList.add('touch');

// ---------------- synthetic key helpers ----------------
function kev(type, code, key) {
    window.dispatchEvent(new KeyboardEvent(type, { code, key: key || code, bubbles: true, cancelable: true }));
}
const heldKeys = new Set();
function keyDown(code, key) { heldKeys.add(code); kev('keydown', code, key); }
function keyUp(code, key)   { heldKeys.delete(code); kev('keyup', code, key); }
// tap: press and release (min hold so 60Hz game ticks always see it)
function tapKey(code, key, ms) { keyDown(code, key); setTimeout(() => keyUp(code, key), ms || 90); }
function releaseAll() { Array.from(heldKeys).forEach(c => keyUp(c)); }

const API = () => window._mobileAPI || {};
const inVersus = () => !!(window.VS && window.VS.isActive && window.VS.isActive());

// ---------------- DOM ----------------
const root = document.createElement('div');
root.className = 'tc-root';
root.style.display = 'none';
root.innerHTML = `
  <div class="tc-pad" id="tc-pad">
      <div class="tc-pad-half left">◀</div><div class="tc-pad-half right">▶</div>
  </div>
  <div class="tc-btn tc-attack" id="tc-attack">⚔</div>
  <div class="tc-btn tc-jump"   id="tc-jump">⤒</div>
  <div class="tc-btn tc-alt"    id="tc-alt">»</div>
  <div class="tc-btn tc-act"    id="tc-act">F</div>
  <div class="tc-top">
      <div class="tc-btn tc-small" id="tc-fs" style="display:none">⛶</div>
      <div class="tc-btn tc-small" id="tc-pause">❚❚</div>
  </div>
  <div class="tc-arts" id="tc-arts"></div>
  <div class="tc-market" id="tc-market">
      <div class="tc-btn tc-pill" id="tc-mprev">◀ Page</div>
      <div class="tc-btn tc-pill" id="tc-mclose">✕ Close</div>
      <div class="tc-btn tc-pill" id="tc-mnext">Page ▶</div>
  </div>
`;
document.body.appendChild(root);

const input = document.createElement('div');
input.className = 'tc-input';
input.style.display = 'none';
input.innerHTML = `<input id="tc-text" maxlength="10" autocomplete="off" autocorrect="off"
    autocapitalize="characters" spellcheck="false" placeholder="Type the password"><button id="tc-ok">OK</button>`;
document.body.appendChild(input);

const rotate = document.createElement('div');
rotate.className = 'tc-rotate';
rotate.style.display = 'none';
rotate.innerHTML = '<div class="tc-rotate-icon">📱</div><div>Rotate your phone to landscape</div><small>The game plays sideways</small>';
document.body.appendChild(rotate);

const $ = id => document.getElementById(id);

// ---------------- generic hold button ----------------
function bindHold(el, down, up) {
    let active = false;
    const on = e => {
        e.preventDefault();
        if (active) return;
        active = true; el.classList.add('on');
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        down();
    };
    const off = e => {
        if (!active) return;
        active = false; el.classList.remove('on');
        up();
    };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('lostpointercapture', off);
    el._forceUp = () => off();
}

// ---------------- movement pad (slide left / right) ----------------
const pad = $('tc-pad');
let dir = 0, padPointer = null;
function setDir(d) {
    if (d === dir) return;
    if (dir === -1) keyUp('KeyA', 'a');
    if (dir === 1)  keyUp('KeyD', 'd');
    dir = d;
    if (dir === -1) keyDown('KeyA', 'a');
    if (dir === 1)  keyDown('KeyD', 'd');
    pad.classList.toggle('l', dir === -1);
    pad.classList.toggle('r', dir === 1);
}
function padMove(e) {
    const r = pad.getBoundingClientRect();
    const rel = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    setDir(rel < -0.16 ? -1 : rel > 0.16 ? 1 : 0);
}
pad.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (padPointer !== null) return;
    padPointer = e.pointerId;
    try { pad.setPointerCapture(e.pointerId); } catch (_) {}
    padMove(e);
});
pad.addEventListener('pointermove', e => { if (e.pointerId === padPointer) { e.preventDefault(); padMove(e); } });
const padEnd = e => { if (e.pointerId === padPointer) { padPointer = null; setDir(0); } };
pad.addEventListener('pointerup', padEnd);
pad.addEventListener('pointercancel', padEnd);
pad.addEventListener('lostpointercapture', padEnd);

// ---------------- action buttons ----------------
let jumpKeyDown = false;
bindHold($('tc-jump'),
    () => { jumpKeyDown = true; keyDown('KeyW', 'w'); },
    () => { jumpKeyDown = false; keyUp('KeyW', 'w'); });

// attack: keydown triggers single-player swing, held state feeds 1v1 + Chapter 2
let atkStart = 0;
bindHold($('tc-attack'),
    () => { atkStart = performance.now(); keyDown('KeyK', 'k'); },
    () => {
        const wait = Math.max(0, 90 - (performance.now() - atkStart));
        setTimeout(() => keyUp('KeyK', 'k'), wait);
    });

// 3rd button: Block in 1v1, Dash everywhere else
bindHold($('tc-alt'),
    () => { if (inVersus()) keyDown('KeyS', 's'); else tapKey('ShiftLeft', 'Shift', 80); },
    () => { if (heldKeys.has('KeyS')) keyUp('KeyS', 's'); });

// context button: talk / interact / continue dialogue
bindHold($('tc-act'),
    () => tapKey('KeyF', 'f', 90),
    () => {});

// pause (single-player / CH2) or leave (1v1)
$('tc-pause').addEventListener('pointerdown', e => {
    e.preventDefault();
    if (inVersus()) {
        if (confirm('Leave the match? This counts as a forfeit.')) window.VS._home();
    } else {
        tapKey('Escape', 'Escape', 60);
    }
});

// fullscreen (Android / desktop browsers; iOS uses Add to Home Screen)
const de = document.documentElement;
const reqFs = de.requestFullscreen || de.webkitRequestFullscreen;
if (reqFs && (document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
    $('tc-fs').style.display = '';
    $('tc-fs').addEventListener('pointerdown', e => {
        e.preventDefault();
        const inFs = document.fullscreenElement || document.webkitFullscreenElement;
        if (inFs) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
        Promise.resolve(reqFs.call(de)).then(() => {
            if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
        }).catch(() => {});
    });
}

// artifacts 1-5 (story mode)
const arts = $('tc-arts');
for (let i = 1; i <= 5; i++) {
    const b = document.createElement('div');
    b.className = 'tc-btn tc-art'; b.textContent = i;
    bindHold(b, () => tapKey('Digit' + i, String(i), 60), () => {});
    arts.appendChild(b);
}

// market page controls
const tapBtn = (id, fn) => $(id).addEventListener('pointerdown', e => { e.preventDefault(); fn(); });
tapBtn('tc-mprev',  () => tapKey('ArrowLeft', 'ArrowLeft', 60));
tapBtn('tc-mnext',  () => tapKey('ArrowRight', 'ArrowRight', 60));
tapBtn('tc-mclose', () => tapKey('Escape', 'Escape', 60));

// password box (story NPC) -> mobile keyboard
const txt = $('tc-text');
txt.addEventListener('input', () => {
    txt.value = txt.value.replace(/[^a-zA-Z]/g, '');
    API().setInput && API().setInput(txt.value);
});
const submitText = () => { API().submitInput && API().submitInput(); txt.value = ''; txt.blur(); };
$('tc-ok').addEventListener('pointerdown', e => { e.preventDefault(); submitText(); });
txt.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') submitText(); });
txt.addEventListener('keyup', e => e.stopPropagation());

// ---------------- state -> visibility ----------------
const shown = id => { const e = $(id); return !!e && getComputedStyle(e).display !== 'none'; };
const BLOCKING = ['aq-auth-overlay', 'aq-profile-overlay', 'aq-lb-overlay', 'vs-overlay',
                  'ch2-select', 'ch2-stage-clear', 'ch2-complete', 'pause-menu', 'game-over'];
let wasPlaying = false, wakeLock = null;

async function setWake(on) {
    try {
        if (on && 'wakeLock' in navigator && !wakeLock) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (_) {}
}
document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll(); else if (wasPlaying) setWake(true);
});
window.addEventListener('blur', releaseAll);

function refresh() {
    const home = $('home-screen');
    const homeUp = !!home && getComputedStyle(home).display !== 'none';
    const playing = !homeUp && !!window._gameLoopActive;
    const portrait = window.innerHeight > window.innerWidth;

    rotate.style.display = (playing && portrait) ? 'flex' : 'none';

    if (playing !== wasPlaying) {
        wasPlaying = playing;
        setWake(playing);
        if (!playing) { releaseAll(); setDir(0); padPointer = null; }
    }

    const covered = BLOCKING.some(shown);
    const showControls = playing && !covered && !portrait;
    root.style.display = showControls ? 'block' : 'none';
    if (!showControls) {
        if (heldKeys.size) { releaseAll(); setDir(0); }
    }

    const api = API();
    const vs = inVersus();
    const market = !!(api.marketOpen && api.marketOpen());
    const inputMode = !!(api.inputMode && api.inputMode());
    const dialogue = !!(api.dialogueOpen && api.dialogueOpen());
    const story = !!(api.storyActive && api.storyActive()) && !vs;

    // market: only page/close buttons
    root.classList.toggle('market', market);
    $('tc-market').style.display = (showControls && market) ? 'flex' : 'none';

    // third button label by mode
    $('tc-alt').textContent = vs ? '🛡' : '»';
    $('tc-alt').classList.toggle('block', vs);
    // interact / continue button: only where it does something
    const showAct = story || dialogue;
    $('tc-act').style.display = showAct ? '' : 'none';
    $('tc-act').textContent = dialogue ? '▶' : 'F';
    $('tc-arts').style.display = story ? 'flex' : 'none';
    $('tc-pause').textContent = vs ? '✕' : '❚❚';

    // password input
    const wantInput = showControls && inputMode;
    if (wantInput && input.style.display === 'none') {
        input.style.display = 'flex';
        setTimeout(() => { try { txt.focus(); } catch (_) {} }, 50);
    } else if (!wantInput && input.style.display !== 'none') {
        input.style.display = 'none'; txt.value = ''; txt.blur();
    }
}
setInterval(refresh, 150);
window.addEventListener('resize', refresh);
window.addEventListener('orientationchange', () => setTimeout(refresh, 250));

// ---------------- stop the browser from fighting the game ----------------
document.addEventListener('touchmove', e => {
    if (root.style.display !== 'none' && e.target.closest && e.target.closest('.tc-root, #gameCanvas')) e.preventDefault();
}, { passive: false });
['gesturestart', 'gesturechange'].forEach(t => document.addEventListener(t, e => e.preventDefault()));
document.addEventListener('contextmenu', e => { if (e.target.closest && e.target.closest('.tc-root, #gameCanvas')) e.preventDefault(); });
let lastTouchEnd = 0;   // block double-tap zoom on iOS
document.addEventListener('touchend', e => {
    const n = Date.now();
    if (n - lastTouchEnd < 300 && e.target.closest && e.target.closest('.tc-root')) e.preventDefault();
    lastTouchEnd = n;
}, { passive: false });

// the first tap also unlocks music / web audio on iOS & Android
let unlocked = false;
document.addEventListener('pointerdown', () => {
    if (unlocked) return; unlocked = true;
    if (window.startMusic) try { window.startMusic(); } catch (_) {}
}, { passive: true });

})();
