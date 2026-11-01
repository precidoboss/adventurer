// ================================================================
// ADMIN: Shadow Chronicle stage warp menu
// Shown ONLY while the server confirms the logged-in user is an admin
// (users.is_admin in Supabase, returned by login_user / get_me and
// re-checked through admin_check before every warp). Everyone else
// never gets the button and the warp function refuses to run.
// ================================================================
(function () {
'use strict';

const STAGES = [
    ['objectives', '1 · Objectives (fresh start)'],
    ['encounter1', '2 · Encounter: Zephira'],
    ['encounter2', '3 · Encounter: Sentinel Kael'],
    ['portal',     '4 · Dimensional Portal'],
    ['boss',       '5 · Final Boss: Void-Warden'],
];

const css = document.createElement('style');
css.textContent = `
#adm-root { position: fixed; z-index: 22; top: calc(env(safe-area-inset-top, 0px) + 58px); right: calc(env(safe-area-inset-right, 0px) + 8px);
            display: none; flex-direction: column; align-items: flex-end; gap: 6px; font-family: 'Cinzel', serif; }
#adm-btn { width: 42px; height: 42px; border-radius: 10px; border: 2px solid #66ddff; background: rgba(8,24,34,.82); color: #aeeaff;
           font-size: 18px; cursor: pointer; opacity: .8; }
#adm-menu { display: none; flex-direction: column; gap: 6px; padding: 10px; border: 2px solid #66ddff; border-radius: 10px;
            background: rgba(6,18,28,.94); box-shadow: 0 6px 24px rgba(0,0,0,.6); }
#adm-menu .adm-title { color: #66ddff; font-size: 11px; letter-spacing: 2px; text-align: center; margin-bottom: 2px; }
#adm-menu button { min-height: 44px; padding: 0 14px; border-radius: 6px; border: 1.5px solid #2f8fb0; background: #0b2433; color: #d8f4ff;
                   font-family: inherit; font-size: 13px; text-align: left; cursor: pointer; }
#adm-menu button:hover, #adm-menu button:active { background: #14425c; border-color: #66ddff; }
#adm-menu button[disabled] { opacity: .5; }
`;
document.head.appendChild(css);

const root = document.createElement('div');
root.id = 'adm-root';
root.innerHTML = '<div id="adm-menu"><div class="adm-title">🛠 ADMIN · STAGE WARP</div></div><button id="adm-btn" title="Admin stage warp">🛠</button>';
document.body.appendChild(root);
const menu = root.querySelector('#adm-menu');
const btn = root.querySelector('#adm-btn');

STAGES.forEach(([id, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', async () => {
        b.disabled = true;
        const ok = await (window._adminWarp ? window._adminWarp(id) : false);
        b.disabled = false;
        if (ok) menu.style.display = 'none';
    });
    menu.appendChild(b);
});
btn.addEventListener('click', () => { menu.style.display = menu.style.display === 'flex' ? 'none' : 'flex'; });
// don't let taps on the panel reach the game canvas / touch layer
['pointerdown', 'keydown'].forEach(t => root.addEventListener(t, e => e.stopPropagation()));

function refresh() {
    const api = window._mobileAPI || {};
    const ok = !!(window.AQ && AQ.isAdmin && AQ.isAdmin()) &&
               !!window._gameLoopActive && !!(api.storyActive && api.storyActive()) &&
               !(api.bossArena && api.bossArena()) && !(api.cinematic && api.cinematic());
    root.style.display = ok ? 'flex' : 'none';
    if (!ok) menu.style.display = 'none';
}
setInterval(refresh, 400);

})();
