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

  // Where to go back to: only a PadLink address (…/drive/return), with a code PadLink made.
  const args = new URLSearchParams(location.search);
  const back = (() => {
    try {
      const u = new URL(args.get('r') || '');
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.pathname === '/drive/return' && !u.search && !u.hash) return u;
    } catch { /* not an address */ }
    return null;
  })();
  const code = /^[A-Za-z0-9_-]{16,64}$/.test(args.get('c') || '') ? args.get('c') : null;

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
    if (!gis || !picker) return; // still loading Google's parts
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) { say(signInProblem(r.error), true); return; }
        token = r.access_token;
        tokenUntil = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
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
    if (token && Date.now() < tokenUntil) { show(); return; }
    tokenClient.requestAccessToken({ prompt: '' });
  }

  // Signed in with the wrong account (say, a personal one instead of the school's): forget this page's pass and ask
  // Google to show its account list, where another account can be chosen or added. Nothing is signed out of Google.
  function switchAccount() {
    say('');
    token = null; tokenUntil = 0;
    tokenClient.requestAccessToken({ prompt: 'select_account' });
  }

  function show() {
    const P = google.picker;
    const label = (view, text) => (typeof view.setLabel === 'function' ? view.setLabel(text) : view);
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

  function picked(data) {
    const P = google.picker;
    const action = data[P.Response.ACTION];
    if (action === P.Action.CANCEL) { say('Nothing picked. Tap the button to look again, or use a different Google account.'); return; }
    if (action !== P.Action.PICKED) return;
    const doc = data[P.Response.DOCUMENTS][0];
    const reply = new URLSearchParams({
      c: code,
      id: doc[P.Document.ID],
      name: doc[P.Document.NAME] || 'Drive file',
      mime: doc[P.Document.MIME_TYPE] || '',
      token,
      exp: String(Math.round(tokenUntil / 1000)),
    });
    document.body.classList.add('is-done');
    // Replace this page in the history, so Back doesn't return here with the pass in it.
    (window.__pickerGo || ((u) => location.replace(u)))(back.href + '#' + reply.toString());
  }

  $('open').addEventListener('click', open);
  $('switch').addEventListener('click', switchAccount);
  ready();

  return {
    gisLoaded() { gis = true; ready(); },
    gapiLoaded() { gapi.load('picker', () => { picker = true; ready(); }); },
  };
})();
