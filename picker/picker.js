// PadLink's Google Drive picker. PadLink (on the PC, or the iPad/iPhone page) opens this page with
//   ?r=<PadLink's own address>/drive/return&c=<a one-time code>
// The teacher picks one file in Google's own picker (folders, Shared with me, shared drives, search). Google gives this
// page a short-lived pass for just that file (the drive.file scope), and the page sends the browser back to PadLink
// with it in the address's #fragment, which never leaves the browser except to PadLink itself.
window.PadLinkPicker = (() => {
  'use strict';

  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  // What the whiteboard can show: PDFs, pictures, and Google Slides, Docs, Sheets and Drawings (they arrive as PDFs).
  const MIMES = [
    'application/pdf',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/heic', 'image/heif',
    'application/vnd.google-apps.presentation',
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.drawing',
  ].join(',');

  const cfg = window.PADLINK_GOOGLE || {};
  const $ = (id) => document.getElementById(id);
  let gis = false, picker = false, tokenClient = null, token = null, tokenUntil = 0;

  // The Google account last used here, kept only in this browser, so Google goes straight to it instead of asking
  // which account every time. "Use a different Google account" forgets it.
  const ACCOUNT = 'padlink-picker.account';
  const savedAccount = () => { try { return localStorage.getItem(ACCOUNT) || ''; } catch { return ''; } };
  const forgetAccount = () => { try { localStorage.removeItem(ACCOUNT); } catch { /* storage unavailable */ } };
  async function rememberAccount(pass) {
    try {
      const api = (window.__driveApi || 'https://www.googleapis.com/drive/v3/files').replace(/\/files$/, '/about');
      const res = await fetch(`${api}?fields=user(emailAddress)`, { headers: { Authorization: 'Bearer ' + pass } });
      const email = res.ok ? ((await res.json()).user || {}).emailAddress : '';
      if (email) { localStorage.setItem(ACCOUNT, email); showAccount(); }
    } catch { /* fine: Google just asks which account next time */ }
  }

  // Which Google account the page will use, before anything is tapped (the one remembered from last time).
  function showAccount() {
    const a = savedAccount(), el = $('account');
    if (!el) return;
    el.hidden = !a;
    $('accountEmail').textContent = a;
  }

  // On an iPad or iPhone, Google's picker inside this page needs double taps and its Select button can do nothing, so
  // there Google's own full-page picker is used instead ("onepick"): sign in, pick, and Google sends the browser back
  // to this page with a pass and the file picked. Where PadLink was and its code go along in `state`.
  const ONEPICK = /iPad|iPhone|iPod|Android/.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))
    || new URLSearchParams(location.search).get('onepick') === '1';
  const SELF = location.origin + location.pathname;
  const fromGoogle = (() => {
    const all = new URLSearchParams(location.search);
    new URLSearchParams(location.hash.slice(1)).forEach((v, k) => all.set(k, v));
    return all.has('state') && (all.has('access_token') || all.has('error') || all.has('picked_file_ids') || all.has('code')) ? all : null;
  })();
  if (fromGoogle) history.replaceState(null, '', location.pathname); // the pass shouldn't stay in the address

  // Where to go back to: only a PadLink address (…/drive/return), with a code PadLink made.
  const args = fromGoogle ? new URLSearchParams(fromGoogle.get('state') || '') : new URLSearchParams(location.search);
  const back = (() => {
    try {
      const u = new URL(args.get('r') || '');
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.pathname === '/drive/return' && !u.search && !u.hash) return u;
    } catch { /* not an address */ }
    return null;
  })();
  const code = /^[A-Za-z0-9_-]{16,64}$/.test(args.get('c') || '') ? args.get('c') : null;

  // ---- Your Drive files: every file already used with PadLink, to open again with no Google screens ----
  // Google lets PadLink see only those files (drive.file), so the list is exactly "files you've used with PadLink".
  const KINDS = [
    ['pdf', 'PDFs', (m) => m === 'application/pdf'],
    ['slides', 'Slides', (m) => m === 'application/vnd.google-apps.presentation'],
    ['docs', 'Docs', (m) => m === 'application/vnd.google-apps.document'],
    ['sheets', 'Sheets', (m) => m === 'application/vnd.google-apps.spreadsheet'],
    ['drawings', 'Drawings', (m) => m === 'application/vnd.google-apps.drawing'],
    ['pictures', 'Pictures', (m) => m.startsWith('image/')],
  ];
  const kindOf = (m) => (KINDS.find(([, , test]) => test(m || '')) || ['other'])[0];
  const BADGE = { pdf: 'PDF', slides: 'SLIDES', docs: 'DOC', sheets: 'SHEET', drawings: 'DRAW', pictures: 'IMG', other: 'FILE' };
  let files = [], filter = 'all';

  // How the files you've used show: grid or list, and sorted A–Z or by most recent. Name A–Z in a list to start with;
  // whatever is chosen is remembered in this browser.
  const VIEW = 'padlink-picker.view', SORT = 'padlink-picker.sort';
  const pref = (k, d, ok) => { try { const v = localStorage.getItem(k); return ok.includes(v) ? v : d; } catch { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, v); } catch { /* not kept: fine */ } };
  let view = pref(VIEW, 'list', ['grid', 'list']);
  $('sort').value = pref(SORT, 'name', ['name', 'recent']);
  function setView(v) {
    view = v;
    keep(VIEW, v);
    $('viewGrid').setAttribute('aria-pressed', String(v === 'grid'));
    $('viewList').setAttribute('aria-pressed', String(v === 'list'));
    renderList();
  }

  // Off to Google and straight back, with no screens when this account already allowed PadLink (prompt=none).
  function quietSignIn(hint) {
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      scope: SCOPE,
      redirect_uri: SELF,
      response_type: 'token',
      prompt: 'none',
      login_hint: hint,
      include_granted_scopes: 'false',
      state: new URLSearchParams({ r: back.href, c: code, m: 'list' }).toString(),
    });
    say('Looking for your Drive files…');
    (window.__pickerGo || ((u) => location.replace(u)))('https://accounts.google.com/o/oauth2/v2/auth?' + q.toString());
  }

  async function finishList() {
    const g = fromGoogle;
    if (g.get('error') || !g.get('access_token')) { say(''); return; } // not signed in, or Google wants a tap: the usual start
    token = g.get('access_token');
    tokenUntil = Date.now() + (Number(g.get('expires_in')) || 3600) * 1000 - 60000;
    say('Looking for your Drive files…');
    try {
      const api = window.__driveApi || 'https://www.googleapis.com/drive/v3/files';
      const kinds = MIMES.split(',').filter((m) => !m.startsWith('image/')).map((m) => `mimeType='${m}'`).concat(["mimeType contains 'image/'"]);
      const all = [];
      let page = '';
      for (let i = 0; i < 10; i++) {
        const q = new URLSearchParams({
          q: `trashed=false and (${kinds.join(' or ')})`,
          fields: 'nextPageToken,files(id,name,mimeType,viewedByMeTime,modifiedTime)',
          pageSize: '1000', corpora: 'allDrives', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true',
        });
        if (page) q.set('pageToken', page);
        const res = await fetch(`${api}?${q}`, { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) throw new Error('http-' + res.status);
        const j = await res.json();
        all.push(...(j.files || []));
        page = j.nextPageToken || '';
        if (!page) break;
      }
      files = all.map((f) => ({ ...f, kind: kindOf(f.mimeType), when: f.viewedByMeTime || f.modifiedTime || '' }));
      say('');
      if (files.length) showList();
    } catch {
      say(''); // the list is a shortcut: without it, the button still works
    }
  }

  function when(f) {
    if (!f.when) return '';
    const d = new Date(f.when), now = new Date();
    const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
    const label = f.viewedByMeTime ? 'Opened' : 'Changed';
    if (days <= 0) return label + ' today';
    if (days === 1) return label + ' yesterday';
    return label + ' ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }

  function showList() {
    document.body.classList.add('has-files');
    $('openLabel').textContent = 'Find a new file in Google Drive';
    const counts = {};
    for (const f of files) counts[f.kind] = (counts[f.kind] || 0) + 1;
    const chips = $('chips');
    chips.textContent = '';
    for (const [k, label] of [['all', 'All'], ...KINDS]) {
      const n = k === 'all' ? files.length : counts[k];
      if (!n) continue; // only the kinds this teacher has
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (k === filter ? ' on' : '');
      b.dataset.kind = k;
      b.append(label + ' ');
      const i = document.createElement('i');
      i.textContent = String(n);
      b.append(i);
      b.addEventListener('click', () => { filter = k; showList(); });
      chips.append(b);
    }
    renderList();
  }

  function renderList() {
    const words = $('find').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const byName = $('sort').value === 'name';
    const shown = files
      .filter((f) => filter === 'all' || f.kind === filter)
      .filter((f) => words.every((w) => (f.name || '').toLowerCase().includes(w)))
      .sort(byName ? (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' })
        : (a, b) => (b.when || '').localeCompare(a.when || ''));
    $('count').textContent = shown.length === files.length
      ? `${files.length} file${files.length === 1 ? '' : 's'} you've used with PadLink · tap one to add it`
      : `${shown.length} of ${files.length} files`;
    const list = $('files');
    list.textContent = '';
    list.classList.toggle('grid', view === 'grid');
    for (const f of shown) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'file';
      const badge = document.createElement('span');
      badge.className = 'badge k-' + f.kind;
      badge.textContent = BADGE[f.kind];
      const text = document.createElement('span');
      text.className = 'text';
      const name = document.createElement('b');
      name.textContent = f.name || 'Untitled';
      const sub = document.createElement('small');
      sub.textContent = when(f);
      text.append(name, sub);
      b.append(badge, text);
      b.addEventListener('click', () => send(f.id, f.name, f.mimeType));
      list.append(b);
    }
    if (!shown.length) {
      const none = document.createElement('p');
      none.className = 'muted none';
      none.textContent = 'No files match. Try other words, or find a new file below.';
      list.append(none);
    }
  }

  function say(text, warn) {
    const m = $('msg');
    m.hidden = !text;
    m.textContent = text || '';
    m.className = warn ? 'warn' : 'muted';
  }

  function ready() {
    if (!back || !code) {
      say('Open Google Drive from PadLink: on the whiteboard, or in Add to the board on the iPad or iPhone.', true);
      return;
    }
    $('where').textContent = `Your file goes to PadLink at ${back.host}.`;
    if (!cfg.clientId || !cfg.apiKey || !cfg.appId) { say('Google Drive isn’t set up for PadLink yet.', true); return; }
    if (ONEPICK) { $('open').disabled = false; $('switch').hidden = false; return; }
    if (!gis || !picker) return; // still loading Google's parts
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) { say(signInProblem(r.error), true); return; }
        token = r.access_token;
        tokenUntil = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
        rememberAccount(token);
        show();
      },
      error_callback: (e) => say(e && e.type === 'popup_closed' ? 'Sign-in was closed. Tap the button to try again.'
        : e && e.type === 'popup_failed_to_open' ? 'Your browser blocked Google’s sign-in window. Allow pop-ups for this site and try again.'
        : 'Google sign-in didn’t finish. Try again.', true),
    });
    $('open').disabled = false;
    $('switch').hidden = false;
  }

  function signInProblem(error) {
    if (error === 'access_denied') return 'Google didn’t let PadLink in. Your school may need to allow PadLink in its Google Admin console.';
    return 'Google sign-in didn’t finish (' + error + '). Try again.';
  }

  // A tap is needed: browsers only open Google's sign-in window from one.
  function open() {
    say('');
    const hint = savedAccount();
    // (Google's full-page picker always shows its "allow access" step: Google requires prompt=consent for it.)
    if (ONEPICK) { onePick('consent', hint); return; }
    if (token && Date.now() < tokenUntil) { show(); return; }
    tokenClient.requestAccessToken(hint ? { prompt: '', login_hint: hint } : { prompt: '' });
  }

  // Signed in with the wrong account (say, a personal one instead of the school's): forget this page's pass and ask
  // Google to show its account list, where another account can be chosen or added. Nothing is signed out of Google.
  function switchAccount() {
    say('');
    token = null; tokenUntil = 0;
    forgetAccount();
    showAccount();
    files = [];
    document.body.classList.remove('has-files');
    if (ONEPICK) { onePick('select_account consent'); return; }
    tokenClient.requestAccessToken({ prompt: 'select_account' });
  }

  function show() {
    const P = google.picker;
    // Google's own grid/list switch stays: setting a view (setMode) would lock it and hide the switch, and Google gives
    // apps no way to choose its starting sort either.
    const label = (v, text) => (typeof v.setLabel === 'function' ? v.setLabel(text) : v);
    const myDrive = label(new P.DocsView(P.ViewId.DOCS).setParent('root').setIncludeFolders(true).setSelectFolderEnabled(false).setMimeTypes(MIMES), 'My Drive');
    const shared = label(new P.DocsView(P.ViewId.DOCS).setOwnedByMe(false).setIncludeFolders(true).setSelectFolderEnabled(false).setMimeTypes(MIMES), 'Shared with me');
    const drives = label(new P.DocsView(P.ViewId.DOCS).setEnableDrives(true).setIncludeFolders(true).setSelectFolderEnabled(false).setMimeTypes(MIMES), 'Shared drives');
    const recent = label(new P.DocsView(P.ViewId.DOCS).setMimeTypes(MIMES), 'All files');
    new P.PickerBuilder()
      .setAppId(cfg.appId)
      .setDeveloperKey(cfg.apiKey)
      .setOAuthToken(token)
      .enableFeature(P.Feature.SUPPORT_DRIVES)
      .addView(myDrive)
      .addView(shared)
      .addView(drives)
      .addView(recent)
      .setTitle('Pick a file for the whiteboard')
      .setCallback(picked)
      .build()
      .setVisible(true);
  }

  // Google's full-page picker (iPad, iPhone): off to Google, back to this page (finishOnePick).
  function onePick(prompt, hint) {
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      scope: SCOPE,
      redirect_uri: SELF,
      response_type: 'token',
      prompt,
      trigger_onepick: 'true',
      mimetypes: MIMES,
      include_granted_scopes: 'false',
      state: new URLSearchParams({ r: back.href, c: code }).toString(),
    });
    if (hint) q.set('login_hint', hint);
    (window.__pickerGo || ((u) => location.assign(u)))('https://accounts.google.com/o/oauth2/v2/auth?' + q.toString());
  }

  async function finishOnePick() {
    const g = fromGoogle;
    if (g.get('error')) {
      say(g.get('error') === 'access_denied' ? 'Nothing picked. Tap the button to look again, or use a different Google account.' : signInProblem(g.get('error')), g.get('error') !== 'access_denied');
      return;
    }
    const id = (g.get('picked_file_ids') || '').split(',').filter(Boolean)[0];
    token = g.get('access_token') || '';
    tokenUntil = Date.now() + (Number(g.get('expires_in')) || 3600) * 1000 - 60000;
    if (!id || !token) { say('Nothing picked. Tap the button to look again, or use a different Google account.'); return; }
    say('Getting the file’s details…');
    try {
      const api = window.__driveApi || 'https://www.googleapis.com/drive/v3/files';
      const [res] = await Promise.all([
        fetch(`${api}/${encodeURIComponent(id)}?fields=id,name,mimeType&supportsAllDrives=true`, { headers: { Authorization: 'Bearer ' + token } }),
        rememberAccount(token),
      ]);
      if (!res.ok) throw new Error('http-' + res.status);
      const f = await res.json();
      send(f.id || id, f.name, f.mimeType);
    } catch {
      say('Google didn’t say what that file is. Tap the button to try again.', true);
    }
  }

  function send(id, name, mime) {
    const reply = new URLSearchParams({
      c: code,
      id,
      name: name || 'Drive file',
      mime: mime || '',
      token,
      exp: String(Math.round(tokenUntil / 1000)),
    });
    document.body.classList.add('is-done');
    // Replace this page in the history, so Back doesn't return here with the pass in it.
    (window.__pickerGo || ((u) => location.replace(u)))(back.href + '#' + reply.toString());
  }

  function picked(data) {
    const P = google.picker;
    const action = data[P.Response.ACTION];
    if (action === P.Action.CANCEL) { say('Nothing picked. Tap the button to look again, or use a different Google account.'); return; }
    if (action !== P.Action.PICKED) return;
    const doc = data[P.Response.DOCUMENTS][0];
    send(doc[P.Document.ID], doc[P.Document.NAME], doc[P.Document.MIME_TYPE]);
  }

  $('open').addEventListener('click', open);
  $('switch').addEventListener('click', switchAccount);
  $('find').addEventListener('input', renderList);
  $('sort').addEventListener('change', () => { keep(SORT, $('sort').value); renderList(); });
  $('viewGrid').addEventListener('click', () => setView('grid'));
  $('viewList').addEventListener('click', () => setView('list'));
  $('viewGrid').setAttribute('aria-pressed', String(view === 'grid'));
  $('viewList').setAttribute('aria-pressed', String(view === 'list'));
  ready();
  showAccount();
  if (fromGoogle && back && code) { if (args.get('m') === 'list') finishList(); else finishOnePick(); }
  else if (ONEPICK && back && code && cfg.clientId && savedAccount()) quietSignIn(savedAccount()); // (on the PC Google's picker opens straight away)

  return {
    gisLoaded() { gis = true; ready(); },
    gapiLoaded() { gapi.load('picker', () => { picker = true; ready(); }); },
  };
})();
