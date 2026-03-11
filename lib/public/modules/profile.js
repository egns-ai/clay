// User profile module — Discord-style popover for name, language, avatar color
// Stores profile server-side in ~/.clay/profile.json

import { iconHtml, refreshIcons } from './icons.js';
import { setSTTLang, getSTTLang } from './stt.js';

var ctx;
var profile = { name: '', lang: 'en-US', avatarColor: '#7c3aed' };
var popoverEl = null;
var saveTimer = null;

var LANGUAGES = [
  { code: 'en-US', name: 'English' },
  { code: 'ko-KR', name: 'Korean' },
  { code: 'ja-JP', name: 'Japanese' },
  { code: 'zh-CN', name: 'Chinese' },
  { code: 'es-ES', name: 'Spanish' },
  { code: 'fr-FR', name: 'French' },
  { code: 'de-DE', name: 'German' },
];

var COLORS = [
  '#7c3aed', '#4f46e5', '#2563eb', '#0891b2',
  '#059669', '#65a30d', '#d97706', '#dc2626',
  '#db2777', '#6366f1',
];

// --- API ---
function fetchProfile() {
  return fetch('/api/profile').then(function(r) { return r.json(); });
}

function saveProfile() {
  return fetch('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  }).then(function(r) { return r.json(); });
}

function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function() {
    saveProfile();
    saveTimer = null;
  }, 400);
}

// --- DOM updates ---
function applyToIsland() {
  var letterEl = document.querySelector('.user-island-avatar-letter');
  var nameEl = document.querySelector('.user-island-name');
  if (!letterEl || !nameEl) return;

  var displayName = profile.name || 'Anonymous';
  var letter = profile.name ? profile.name.charAt(0).toUpperCase() : '?';

  letterEl.textContent = letter;
  letterEl.style.background = profile.avatarColor || '#7c3aed';
  nameEl.childNodes[0].textContent = displayName + ' ';
}

// --- Popover ---
function showPopover() {
  if (popoverEl) {
    hidePopover();
    return;
  }

  popoverEl = document.createElement('div');
  popoverEl.className = 'profile-popover';

  var displayName = profile.name || '';
  var currentLang = profile.lang || 'en-US';
  var currentColor = profile.avatarColor || '#7c3aed';
  var avatarLetter = profile.name ? profile.name.charAt(0).toUpperCase() : '?';

  var html = '';

  // Header with large avatar
  html += '<div class="profile-popover-header">';
  html += '<div class="profile-popover-avatar" style="background:' + currentColor + '">';
  html += '<span class="profile-popover-avatar-letter">' + avatarLetter + '</span>';
  html += '</div>';
  html += '</div>';

  // Name field
  html += '<div class="profile-field">';
  html += '<label class="profile-field-label">Display Name</label>';
  html += '<input type="text" class="profile-field-input" id="profile-name-input" value="' + escapeAttr(displayName) + '" placeholder="Enter your name..." maxlength="50" spellcheck="false" autocomplete="off">';
  html += '</div>';

  // Language
  html += '<div class="profile-field">';
  html += '<label class="profile-field-label">Language</label>';
  html += '<div class="profile-lang-grid">';
  for (var i = 0; i < LANGUAGES.length; i++) {
    var l = LANGUAGES[i];
    var active = (currentLang === l.code) ? ' profile-option-active' : '';
    html += '<button class="profile-lang-btn' + active + '" data-lang="' + l.code + '">' + l.name + '</button>';
  }
  html += '</div>';
  html += '</div>';

  // Avatar color
  html += '<div class="profile-field">';
  html += '<label class="profile-field-label">Color</label>';
  html += '<div class="profile-color-grid">';
  for (var j = 0; j < COLORS.length; j++) {
    var c = COLORS[j];
    var activeC = (currentColor === c) ? ' profile-color-active' : '';
    html += '<button class="profile-color-swatch' + activeC + '" data-color="' + c + '" style="background:' + c + '"></button>';
  }
  html += '</div>';
  html += '</div>';

  popoverEl.innerHTML = html;

  // --- Events ---
  var nameInput = popoverEl.querySelector('#profile-name-input');
  nameInput.addEventListener('input', function() {
    profile.name = nameInput.value.trim();
    applyToIsland();
    updatePopoverAvatar();
    debouncedSave();
  });

  nameInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      hidePopover();
    }
    e.stopPropagation();
  });

  // Prevent keyboard shortcuts from firing while typing
  nameInput.addEventListener('keyup', function(e) { e.stopPropagation(); });
  nameInput.addEventListener('keypress', function(e) { e.stopPropagation(); });

  popoverEl.querySelectorAll('.profile-lang-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      profile.lang = btn.dataset.lang;
      setSTTLang(profile.lang);
      popoverEl.querySelectorAll('.profile-lang-btn').forEach(function(b) {
        b.classList.remove('profile-option-active');
      });
      btn.classList.add('profile-option-active');
      debouncedSave();
    });
  });

  popoverEl.querySelectorAll('.profile-color-swatch').forEach(function(btn) {
    btn.addEventListener('click', function() {
      profile.avatarColor = btn.dataset.color;
      applyToIsland();
      updatePopoverAvatar();
      popoverEl.querySelectorAll('.profile-color-swatch').forEach(function(b) {
        b.classList.remove('profile-color-active');
      });
      btn.classList.add('profile-color-active');
      debouncedSave();
    });
  });

  var island = document.getElementById('user-island');
  island.appendChild(popoverEl);

  // Focus name input if empty
  if (!profile.name) {
    nameInput.focus();
  }

  setTimeout(function() {
    document.addEventListener('click', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
  }, 0);
}

function updatePopoverAvatar() {
  if (!popoverEl) return;
  var avatarEl = popoverEl.querySelector('.profile-popover-avatar');
  var letterEl = popoverEl.querySelector('.profile-popover-avatar-letter');
  if (avatarEl) avatarEl.style.background = profile.avatarColor || '#7c3aed';
  if (letterEl) letterEl.textContent = profile.name ? profile.name.charAt(0).toUpperCase() : '?';
}

function closeOnOutside(e) {
  var island = document.getElementById('user-island');
  if (popoverEl && !popoverEl.contains(e.target) && !island.contains(e.target)) {
    hidePopover();
  }
}

function closeOnEscape(e) {
  if (e.key === 'Escape' && popoverEl) {
    hidePopover();
  }
}

function hidePopover() {
  if (popoverEl) {
    popoverEl.remove();
    popoverEl = null;
  }
  document.removeEventListener('click', closeOnOutside);
  document.removeEventListener('keydown', closeOnEscape);
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// --- Init ---
export function initProfile(_ctx) {
  ctx = _ctx;

  var island = document.getElementById('user-island');
  if (!island) return;

  island.style.cursor = 'pointer';
  island.addEventListener('click', function(e) {
    e.stopPropagation();
    showPopover();
  });

  // Fetch profile and apply
  fetchProfile().then(function(data) {
    if (data.name !== undefined) profile.name = data.name;
    if (data.lang) profile.lang = data.lang;
    if (data.avatarColor) profile.avatarColor = data.avatarColor;

    applyToIsland();

    // Sync language to STT
    if (profile.lang) {
      setSTTLang(profile.lang);
    }
  }).catch(function(err) {
    console.warn('[Profile] Failed to load:', err);
  });
}

export function getProfile() {
  return profile;
}

export function getProfileLang() {
  return profile.lang;
}
