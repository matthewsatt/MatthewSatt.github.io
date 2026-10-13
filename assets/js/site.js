// Site chrome: theme, nav state, reveal-on-scroll, command palette, small niceties.

const EMAIL = 'matthewsatterwhitems@gmail.com';
const LINKS = {
  github: 'https://github.com/MatthewSatt',
  linkedin: 'https://www.linkedin.com/in/matthew-satterwhite-008970211/',
  resume: 'resume.pdf',
};
const THEME_KEY = 'ms-theme';

const root = document.documentElement;
const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- Theme ---------- */

function applyTheme(theme, persist) {
  root.dataset.theme = theme;
  $('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f3ee' : '#09090a');
  if (persist) {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable */ }
  }
}

function toggleTheme() {
  applyTheme(root.dataset.theme === 'light' ? 'dark' : 'light', true);
}

applyTheme(root.dataset.theme || 'dark', false);
$$('[data-theme-toggle]').forEach((btn) => btn.addEventListener('click', toggleTheme));
matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch { /* storage unavailable */ }
  if (!stored) applyTheme(e.matches ? 'light' : 'dark', false);
});

/* ---------- Nav ---------- */

const nav = $('[data-nav]');
const onScroll = () => nav?.classList.toggle('is-scrolled', window.scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

const navLinks = new Map($$('.nav-links a').map((a) => [a.getAttribute('href').slice(1), a]));
if ('IntersectionObserver' in window && navLinks.size) {
  const spy = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      navLinks.forEach((a, id) => a.toggleAttribute('aria-current', id === entry.target.id));
      navLinks.get(entry.target.id)?.setAttribute('aria-current', 'true');
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  navLinks.forEach((_, id) => { const el = document.getElementById(id); if (el) spy.observe(el); });
}

/* ---------- Reveal on scroll ---------- */

const revealables = $$('[data-reveal]');
if (!('IntersectionObserver' in window) || reducedMotion.matches) {
  revealables.forEach((el) => el.classList.add('is-in'));
} else {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  revealables.forEach((el) => io.observe(el));
}

/* ---------- Dates ---------- */

function monthsSince(ym) {
  const [y, m] = ym.split('-').map(Number);
  const now = new Date();
  return (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
}

$$('[data-years-since]').forEach((el) => {
  el.textContent = String(Math.max(1, Math.floor(monthsSince(el.dataset.yearsSince) / 12)));
});

$$('[data-duration-since]').forEach((el) => {
  const total = monthsSince(el.dataset.durationSince) + 1; // inclusive, the way résumés count
  const y = Math.floor(total / 12);
  const m = total % 12;
  const parts = [];
  if (y) parts.push(`${y} yr${y === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} mo${m === 1 ? '' : 's'}`);
  el.textContent = parts.join(' ');
});

$$('[data-year]').forEach((el) => { el.textContent = String(new Date().getFullYear()); });

/* ---------- Platform-aware shortcut label ---------- */

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
if (!isMac) $$('[data-mod-key]').forEach((el) => { el.textContent = 'Ctrl K'; });

/* ---------- Copy email ---------- */

async function copyEmail() {
  try {
    await navigator.clipboard.writeText(EMAIL);
    return true;
  } catch {
    return false;
  }
}

$$('[data-copy-email]').forEach((btn) => {
  const status = $('[data-copy-status]', btn);
  let timer;
  btn.addEventListener('click', async () => {
    const ok = await copyEmail();
    if (!ok) { location.href = `mailto:${EMAIL}`; return; }
    btn.classList.add('is-copied');
    if (status) status.textContent = 'Email address copied';
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.classList.remove('is-copied');
      if (status) status.textContent = '';
    }, 2000);
  });
});

/* ---------- Card spotlight ---------- */

if (matchMedia('(hover: hover)').matches) {
  $$('.card').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });
}

/* ---------- Command palette ---------- */

const palette = $('[data-palette]');
const input = $('[data-palette-input]');
const list = $('[data-palette-list]');

const go = (hash) => () => {
  const el = document.querySelector(hash);
  if (!el) return;
  el.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  history.replaceState(null, '', hash);
};
const openLink = (url) => () => window.open(url, '_blank', 'noopener');

const commands = [
  { group: 'Navigate', label: 'Live demo', hint: 'WebRTC lab', keywords: 'webrtc video lab demo', run: go('#lab') },
  { group: 'Navigate', label: 'Stack', hint: 'Five layers', keywords: 'skills tech frontend backend', run: go('#stack') },
  { group: 'Navigate', label: 'Experience', hint: 'Civicom', keywords: 'job career work history', run: go('#experience') },
  { group: 'Navigate', label: 'Work', hint: 'Selected projects', keywords: 'projects portfolio', run: go('#work') },
  { group: 'Navigate', label: 'Contact', hint: 'Say hello', keywords: 'hire email', run: go('#contact') },
  { group: 'Actions', label: 'Go live with your camera', hint: 'Stays on this device', keywords: 'webcam video webrtc', run: () => { go('#lab')(); window.dispatchEvent(new CustomEvent('lab:camera')); } },
  { group: 'Actions', label: 'Copy email address', hint: EMAIL, keywords: 'contact mail', run: () => { copyEmail(); } },
  { group: 'Actions', label: 'Toggle light / dark theme', hint: 'Theme', keywords: 'dark light mode color', run: toggleTheme },
  { group: 'Links', label: 'Open résumé', hint: 'PDF', keywords: 'resume cv', run: openLink(LINKS.resume) },
  { group: 'Links', label: 'GitHub', hint: 'github.com/MatthewSatt', keywords: 'code source repos', run: openLink(LINKS.github) },
  { group: 'Links', label: 'LinkedIn', hint: 'linkedin.com/in/matthew-satterwhite', keywords: 'profile', run: openLink(LINKS.linkedin) },
  { group: 'Links', label: 'Send an email', hint: 'mailto', keywords: 'contact hire', run: () => { location.href = `mailto:${EMAIL}`; } },
];

let filtered = commands;
let active = 0;

function renderPalette() {
  const q = input.value.trim().toLowerCase();
  filtered = q
    ? commands.filter((c) => `${c.label} ${c.hint} ${c.keywords} ${c.group}`.toLowerCase().includes(q))
    : commands;
  active = Math.min(active, Math.max(0, filtered.length - 1));

  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement('li');
    empty.className = 'palette-empty';
    empty.textContent = 'No matches. Try “video”, “email” or “github”.';
    list.append(empty);
    input.removeAttribute('aria-activedescendant');
    return;
  }

  let group = null;
  filtered.forEach((cmd, i) => {
    if (cmd.group !== group) {
      group = cmd.group;
      const h = document.createElement('li');
      h.className = 'palette-group';
      h.setAttribute('role', 'presentation');
      h.textContent = group;
      list.append(h);
    }
    const li = document.createElement('li');
    li.className = 'palette-item';
    li.id = `cmd-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === active));
    const label = document.createElement('span');
    label.textContent = cmd.label;
    const hint = document.createElement('small');
    hint.textContent = cmd.hint;
    li.append(label, hint);
    li.addEventListener('pointermove', () => { if (active !== i) { active = i; syncActive(); } });
    li.addEventListener('click', () => runCommand(i));
    list.append(li);
  });
  syncActive();
}

function syncActive() {
  $$('.palette-item', list).forEach((li) => li.setAttribute('aria-selected', String(li.id === `cmd-${active}`)));
  const current = $(`#cmd-${active}`, list);
  if (current) {
    input.setAttribute('aria-activedescendant', current.id);
    current.scrollIntoView({ block: 'nearest' });
  }
}

function runCommand(i) {
  const cmd = filtered[i];
  if (!cmd) return;
  closePalette();
  cmd.run();
}

function openPalette() {
  if (!palette || palette.open) return;
  input.value = '';
  active = 0;
  renderPalette();
  palette.showModal();
  input.focus();
}

function closePalette() {
  if (palette?.open) palette.close();
}

if (palette && typeof palette.showModal === 'function') {
  $$('[data-palette-open]').forEach((btn) => btn.addEventListener('click', openPalette));

  input.addEventListener('input', () => { active = 0; renderPalette(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % Math.max(1, filtered.length); syncActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + filtered.length) % Math.max(1, filtered.length); syncActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); runCommand(active); }
  });
  palette.addEventListener('click', (e) => { if (e.target === palette) closePalette(); });

  addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palette.open ? closePalette() : openPalette();
    } else if (e.key === '/' && !typing && !palette.open) {
      e.preventDefault();
      openPalette();
    }
  });
} else {
  // No <dialog> support: the menu buttons fall back to jumping to contact.
  $$('[data-palette-open]').forEach((btn) => btn.addEventListener('click', go('#contact')));
}
