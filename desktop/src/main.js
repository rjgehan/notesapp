'use strict';
// NotesApp for Windows and macOS (ROADMAP item 41, docs/DESKTOP.md): a thin, hardened Electron shell
// around the user's NotesApp server. It bundles no copy of the web app: the main window loads the
// configured server over Tailscale, so every deploy updates the desktop UI and live sync is the same
// event stream the browser uses. Offline, the app's own service worker serves the cached app.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  net,
  powerMonitor,
  screen,
  session,
  shell,
} = require('electron');
const settingsStore = require('./settings');
const { normalizeServerUrl, checkServer } = require('./serverUrl');
const {
  classifyNavigation,
  isServerUrl,
  allowPermissionRequest,
  allowPermissionCheck,
  isTrustedSender,
  secureWebPreferences,
} = require('./security');
const { restoreBounds, snapshot, captureBounds } = require('./windowState');
const { windowTitle, isConnectionState } = require('./title');

const APP_ID = 'com.rjgehan.notesapp.desktop';
const PAGES_DIR = path.join(__dirname, 'pages');
const PAGES_URL = pathToFileURL(PAGES_DIR).href + '/';
const PRELOAD = path.join(__dirname, 'preload.js');
const ICON = path.join(PAGES_DIR, 'icon.png');
const OFFLINE_RETRY_MS = 15_000;
/** Chromium's ERR_ABORTED: a navigation replaced by another one, not a failure. */
const ERR_ABORTED = -3;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = settingsStore.defaults();

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let captureWindow = null;
/** @type {BrowserWindow | null} */
let setupWindow = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
let pageTitle = 'NotesApp';
/** The main window's connection state: reported by the page, or `offline` while the shell's offline page shows. */
let connection = 'live';
let offlineTimer = null;
let saveTimer = null;
/** Commands for the main window's page, sent once its bridge says it is listening. */
let bridgeReady = false;
const pendingCommands = [];

const serverOrigin = () => settings.serverUrl;
const version = () => app.getVersion();

function windowArgs(kind) {
  return [`--notes-desktop-version=${version()}`, `--notes-window=${kind}`];
}

function saveSettings() {
  try {
    settingsStore.save(settingsFile(), settings);
  } catch (e) {
    console.error('[notesapp-desktop] could not save settings', e);
  }
}

// ---------------------------------------------------------------- security, for every web contents

function openExternal(url) {
  if (classifyNavigation(url, serverOrigin()) === 'external') void shell.openExternal(url);
}

app.on('web-contents-created', (_event, contents) => {
  // No <webview>: nothing may embed another page with its own settings.
  contents.on('will-attach-webview', (e) => e.preventDefault());

  // The main frame stays on the server (or the shell's own pages, which only main.js loads).
  contents.on('will-navigate', (e, url) => {
    const kind = classifyNavigation(url, serverOrigin());
    if (kind === 'allow') return;
    e.preventDefault();
    if (kind === 'external') openExternal(url);
  });
  contents.on('will-redirect', (e, url, _inPlace, isMainFrame) => {
    if (isMainFrame && classifyNavigation(url, serverOrigin()) !== 'allow') e.preventDefault();
  });

  // New windows: the server's own pages open as app windows with the same locked-down settings;
  // other web links go to the default browser.
  contents.setWindowOpenHandler(({ url }) => {
    const kind = classifyNavigation(url, serverOrigin());
    if (kind === 'allow') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, webPreferences: secureWebPreferences(PRELOAD, windowArgs('popup')) },
      };
    }
    if (kind === 'external') openExternal(url);
    return { action: 'deny' };
  });

  contents.on('context-menu', (_e, params) => showContextMenu(contents, params));
});

function installSessionPolicy() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allowPermissionRequest(permission, details.requestingUrl || wc.getURL(), serverOrigin(), details));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    allowPermissionCheck(permission, requestingOrigin, serverOrigin(), details),
  );
  // No device pickers (USB, HID, serial, Bluetooth) for any page.
  ses.setDevicePermissionHandler(() => false);
  ses.on('select-hid-device', (e, _d, cb) => {
    e.preventDefault();
    cb('');
  });
  ses.on('select-serial-port', (e, _p, _wc, cb) => {
    e.preventDefault();
    cb('');
  });
}

function showContextMenu(contents, params) {
  const items = [];
  for (const s of params.dictionarySuggestions || []) {
    items.push({ label: s, click: () => contents.replaceMisspelling(s) });
  }
  if (params.misspelledWord) {
    items.push({ label: 'Add to dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    items.push({ type: 'separator' });
  }
  if (params.linkURL && classifyNavigation(params.linkURL, serverOrigin()) === 'external') {
    items.push({ label: 'Open link in browser', click: () => openExternal(params.linkURL) });
    items.push({ type: 'separator' });
  }
  const f = params.editFlags;
  if (params.isEditable) items.push({ role: 'cut', enabled: f.canCut });
  if (params.isEditable || params.selectionText) items.push({ role: 'copy', enabled: f.canCopy });
  if (params.isEditable) items.push({ role: 'paste', enabled: f.canPaste });
  if (params.isEditable) items.push({ role: 'selectAll', enabled: f.canSelectAll });
  if (items.length === 0) return;
  Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) || undefined });
}

// ---------------------------------------------------------------- IPC

function senderUrl(event) {
  return (event.senderFrame && event.senderFrame.url) || '';
}

function fromApp(event) {
  return isTrustedSender(senderUrl(event), 'app', serverOrigin(), PAGES_URL);
}

function fromShell(event) {
  return isTrustedSender(senderUrl(event), 'shell', serverOrigin(), PAGES_URL);
}

function installIpc() {
  ipcMain.handle('shell:get-state', (event) => {
    if (!fromShell(event)) return null;
    return {
      serverUrl: settings.serverUrl,
      captureHotkey: settings.captureHotkey,
      launchAtLogin: settings.launchAtLogin,
      platform: process.platform,
      version: version(),
      firstRun: !settings.serverUrl,
      offlineReason: lastOfflineReason,
    };
  });

  ipcMain.handle('shell:submit', async (event, form) => {
    if (!fromShell(event) || !form || typeof form !== 'object') return { ok: false, error: 'Not allowed.' };
    const n = normalizeServerUrl(form.serverUrl);
    if (!n.ok) return { ok: false, error: n.error, field: 'serverUrl' };
    const hotkey = typeof form.captureHotkey === 'string' ? form.captureHotkey.trim() : '';
    if (hotkey && !settingsStore.isAccelerator(hotkey)) {
      return { ok: false, error: 'That shortcut is not valid. Example: CommandOrControl+Shift+Space.', field: 'captureHotkey' };
    }
    if (!form.skipCheck) {
      const check = await checkServer(n.origin, (url, init) => net.fetch(url, init));
      if (!check.ok) return { ok: false, error: check.error, field: 'serverUrl', canSkip: !check.reachable };
    }
    const serverChanged = n.origin !== settings.serverUrl;
    settings = { ...settings, serverUrl: n.origin, captureHotkey: hotkey, launchAtLogin: !!form.launchAtLogin };
    saveSettings();
    applyLaunchAtLogin();
    const hotkeyOk = registerHotkey();
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
    if (serverChanged) {
      // A different server: fresh windows, so nothing of the old origin lingers.
      if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy();
      captureWindow = null;
      loadServer();
    }
    showMain();
    if (!hotkeyOk) warnHotkey();
    return { ok: true };
  });

  ipcMain.on('shell:retry', (event) => {
    if (!fromShell(event)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === captureWindow) loadCapture();
    else void retryServer();
  });
  ipcMain.on('shell:open-setup', (event) => {
    if (fromShell(event)) openSetup();
  });
  ipcMain.on('shell:cancel-setup', (event) => {
    if (!fromShell(event)) return;
    if (!settings.serverUrl) app.quit();
    else if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
  });

  ipcMain.on('app:connection', (event, state) => {
    if (!fromApp(event) || !mainWindow || event.sender !== mainWindow.webContents || !isConnectionState(state)) return;
    connection = state;
    updateTitle();
    if (!bridgeReady) {
      // The page's bridge reports its state once it is listening: send what was waiting.
      bridgeReady = true;
      for (const cmd of pendingCommands.splice(0)) mainWindow.webContents.send('app:command', cmd);
    }
  });

  ipcMain.on('app:notify', (event, n) => {
    if (!fromApp(event) || !n || typeof n !== 'object') return;
    notify(String(n.title || 'NotesApp'), typeof n.body === 'string' ? n.body : '', typeof n.path === 'string' ? n.path : null);
  });

  // The page's window.focus() (a notification's click handler, e.g. a reminder) brings the window
  // back even when it was closed to the tray (frontend/src/desktop/bridge.ts).
  ipcMain.on('app:focus', (event) => {
    if (fromApp(event) && mainWindow && event.sender === mainWindow.webContents) showMain();
  });

  ipcMain.on('app:close-capture', (event) => {
    if (fromApp(event) && captureWindow && event.sender === captureWindow.webContents) hideCapture();
  });
}

// ---------------------------------------------------------------- main window

function workAreas() {
  const primary = screen.getPrimaryDisplay();
  return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
}

function createMainWindow({ show }) {
  const b = restoreBounds(settings.window, workAreas());
  mainWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: 'NotesApp',
    icon: ICON,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    // In the tray the page keeps its live-sync stream and timers at full speed, so reminders
    // (ROADMAP item 9's in-app route) arrive on time.
    webPreferences: { ...secureWebPreferences(PRELOAD, windowArgs('main')), backgroundThrottling: false },
  });
  if (show) {
    mainWindow.once('ready-to-show', () => {
      if (b.maximized) mainWindow.maximize();
      mainWindow.show();
    });
  } else if (b.maximized) {
    mainWindow.once('show', () => mainWindow.maximize());
  }

  const wc = mainWindow.webContents;
  mainWindow.on('page-title-updated', (e, title) => {
    e.preventDefault();
    pageTitle = title;
    updateTitle();
  });
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) bridgeReady = false;
  });
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === ERR_ABORTED || !isServerUrl(url, serverOrigin())) return;
    showOffline(mainWindow, description || `Error ${code}`);
  });
  wc.on('did-navigate', (_e, url) => {
    if (isServerUrl(url, serverOrigin())) leaveOffline();
  });

  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) mainWindow.on(ev, scheduleSaveWindow);
  mainWindow.on('close', (e) => {
    saveWindowNow();
    if (!quitting) {
      // Closing keeps the app in the tray (and the capture hotkey working); Quit is in the tray menu.
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function scheduleSaveWindow() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWindowNow, 500);
}

function saveWindowNow() {
  clearTimeout(saveTimer);
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  settings.window = snapshot(mainWindow.getNormalBounds(), mainWindow.isMaximized());
  saveSettings();
}

function updateTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const title = windowTitle(offlineTimer ? 'NotesApp' : pageTitle, connection);
  mainWindow.setTitle(title);
  if (tray) tray.setToolTip(connection === 'live' ? 'NotesApp' : title);
}

function loadServer(appPath = '/') {
  if (!serverOrigin()) return openSetup();
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow({ show: false });
  bridgeReady = false;
  void mainWindow.loadURL(serverOrigin() + appPath).catch(() => undefined);
}

function showMain() {
  if (!serverOrigin()) return openSetup();
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow({ show: true });
    loadServer();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Sends a command to the main window's page, now or once its bridge is listening. */
function sendCommand(cmd) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (bridgeReady && !offlineTimer) mainWindow.webContents.send('app:command', cmd);
  else if (pendingCommands.length < 10) pendingCommands.push(cmd);
}

/** Opens an in-app path in the main window: in the running app if there is one, otherwise by loading it. */
function openInMain(appPath) {
  const target = typeof appPath === 'string' && appPath.startsWith('/') && !appPath.startsWith('//') ? appPath : '/';
  if (!mainWindow || mainWindow.isDestroyed() || offlineTimer || !bridgeReady) {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow({ show: true });
    loadServer(target);
  } else {
    sendCommand({ type: 'navigate', to: target });
  }
  showMain();
}

// ---------------------------------------------------------------- offline page

let lastOfflineReason = null;

function showOffline(win, reason) {
  lastOfflineReason = reason;
  void win.loadFile(path.join(PAGES_DIR, 'offline.html')).catch(() => undefined);
  if (win !== mainWindow) return;
  connection = 'offline';
  clearInterval(offlineTimer);
  offlineTimer = setInterval(() => void retryServer({ quiet: true }), OFFLINE_RETRY_MS);
  updateTitle();
}

function leaveOffline() {
  if (!offlineTimer) return;
  clearInterval(offlineTimer);
  offlineTimer = null;
  connection = 'live';
  updateTitle();
}

let retrying = false;
async function retryServer({ quiet = false } = {}) {
  if (retrying || !serverOrigin()) return;
  retrying = true;
  try {
    // Quiet retries only reload once the server answers, so the offline page does not flicker.
    if (quiet) {
      const check = await checkServer(serverOrigin(), (url, init) => net.fetch(url, init), 5000);
      if (!check.ok) return;
    }
    loadServer();
  } finally {
    retrying = false;
  }
}

// ---------------------------------------------------------------- quick capture

function loadCapture() {
  if (!captureWindow || captureWindow.isDestroyed()) return;
  void captureWindow.loadURL(`${serverOrigin()}/capture`).catch(() => undefined);
}

function createCaptureWindow() {
  captureWindow = new BrowserWindow({
    width: 520,
    height: 440,
    minWidth: 360,
    minHeight: 300,
    show: false,
    title: 'Quick capture',
    icon: ICON,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    webPreferences: secureWebPreferences(PRELOAD, windowArgs('capture')),
  });
  if (process.platform === 'darwin') captureWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  captureWindow.setAlwaysOnTop(true, 'floating');
  const wc = captureWindow.webContents;
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== ERR_ABORTED && isServerUrl(url, serverOrigin())) showOffline(captureWindow, description);
  });
  // The capture page's "Open the note" and "Open NotesApp" go to the main window.
  const leaveCapture = (url) => {
    if (!isServerUrl(url, serverOrigin())) return false;
    const u = new URL(url);
    if (u.pathname === '/capture' || u.pathname.startsWith('/capture/')) return false;
    openInMain(u.pathname + u.search + u.hash);
    hideCapture();
    return true;
  };
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) leaveCapture(url);
  });
  wc.on('will-navigate', (e, url) => {
    if (leaveCapture(url)) e.preventDefault();
  });
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && !input.control && !input.meta && !input.alt && !input.shift) hideCapture();
  });
  captureWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideCapture();
    }
  });
  captureWindow.on('closed', () => {
    captureWindow = null;
  });
  loadCapture();
}

function showCapture() {
  if (!serverOrigin()) return openSetup();
  if (!captureWindow || captureWindow.isDestroyed()) createCaptureWindow();
  const cursor = screen.getCursorScreenPoint();
  captureWindow.setBounds(captureBounds(screen.getDisplayNearestPoint(cursor).workArea));
  captureWindow.show();
  captureWindow.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
}

function toggleCapture() {
  if (captureWindow && !captureWindow.isDestroyed() && captureWindow.isVisible() && captureWindow.isFocused()) hideCapture();
  else showCapture();
}

/** Hides the capture window and gets a fresh form ready for next time (closing discards an unsent draft). */
function hideCapture() {
  if (!captureWindow || captureWindow.isDestroyed() || !captureWindow.isVisible()) return;
  captureWindow.hide();
  if (process.platform === 'darwin' && !(mainWindow && mainWindow.isVisible())) app.hide();
  loadCapture();
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!settings.captureHotkey) return true;
  try {
    return globalShortcut.register(settings.captureHotkey, toggleCapture);
  } catch {
    return false;
  }
}

function warnHotkey() {
  notify('Quick-capture shortcut unavailable', `${settings.captureHotkey} is used by another app. Choose another one in Settings.`, null);
}

// ---------------------------------------------------------------- setup window

function openSetup() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 560,
    height: 600,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'NotesApp — Settings',
    icon: ICON,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#1e1e1e',
    webPreferences: secureWebPreferences(PRELOAD, windowArgs('setup')),
  });
  setupWindow.once('ready-to-show', () => setupWindow.show());
  setupWindow.on('closed', () => {
    setupWindow = null;
    // Closing the first-run page without a server leaves nothing to show.
    if (!settings.serverUrl && !quitting) app.quit();
  });
  void setupWindow.loadFile(path.join(PAGES_DIR, 'setup.html'));
}

// ---------------------------------------------------------------- notifications, login item, tray

function notify(title, body, appPath) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: title.slice(0, 200), body: body.slice(0, 1000), icon: ICON });
  if (appPath) n.on('click', () => openInMain(appPath));
  else n.on('click', () => showMain());
  n.show();
}

function applyLaunchAtLogin() {
  // Launched at login, the app starts in the tray; the window opens from the tray or the hotkey.
  app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin, openAsHidden: true, args: ['--hidden'] });
}

function trayIcon() {
  const size = process.platform === 'darwin' ? 18 : 16;
  return nativeImage.createFromPath(ICON).resize({ width: size, height: size, quality: 'best' });
}

function hotkeyLabel() {
  if (!settings.captureHotkey) return 'Quick capture';
  const label = settings.captureHotkey.replace(/CommandOrControl|CmdOrCtrl/g, process.platform === 'darwin' ? 'Cmd' : 'Ctrl');
  return `Quick capture\t${label}`;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: hotkeyLabel(), click: showCapture },
    { label: 'Open NotesApp', click: showMain },
    {
      label: "Open today's note",
      click: () => {
        showMain();
        sendCommand({ type: 'open-today' });
      },
    },
    { type: 'separator' },
    { label: 'Reload', click: () => (offlineTimer ? retryServer() : loadServer(currentAppPath())) },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: !!settings.launchAtLogin,
      click: (item) => {
        settings.launchAtLogin = item.checked;
        saveSettings();
        applyLaunchAtLogin();
      },
    },
    { label: 'Settings…', click: openSetup },
    { type: 'separator' },
    { label: `NotesApp desktop ${version()}`, enabled: false },
    { label: 'Quit NotesApp', click: () => app.quit() },
  ]);
}

function currentAppPath() {
  const url = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : '';
  if (!isServerUrl(url, serverOrigin())) return '/';
  const u = new URL(url);
  return u.pathname + u.search + u.hash;
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('NotesApp');
  const refresh = () => tray.setContextMenu(buildTrayMenu());
  refresh();
  // Windows: a click opens the app; the menu is on right-click. (macOS shows the menu on click.)
  tray.on('click', () => {
    if (process.platform !== 'darwin') showMain();
  });
  tray.on('right-click', refresh);
  return refresh;
}

function buildAppMenu() {
  if (process.platform !== 'darwin') return null;
  // macOS needs an Edit menu for Cmd+C/V/X/A. Undo, redo, reload, close and zoom have no shortcuts here,
  // so the app's own Mod-Z, Mod-R, Mod-W and Mod-- keep working.
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', click: () => loadServer(currentAppPath()) },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { label: 'Quick capture', click: showCapture },
        { label: 'Open NotesApp', click: showMain },
        { label: 'Settings…', click: openSetup },
      ],
    },
  ]);
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  app.on('second-instance', () => showMain());

  app.whenReady().then(() => {
    settings = settingsStore.load(settingsFile());
    installSessionPolicy();
    installIpc();
    Menu.setApplicationMenu(buildAppMenu());
    const refreshTray = createTray();

    const loginSettings = app.getLoginItemSettings();
    const hidden = process.argv.includes('--hidden') || loginSettings.wasOpenedAsHidden === true;
    if (!settings.serverUrl) {
      openSetup();
    } else {
      createMainWindow({ show: !hidden });
      loadServer();
    }
    if (!registerHotkey()) warnHotkey();

    // After sleep, or when the screen is unlocked, the live-sync stream reconnects at once.
    const onResume = () => {
      if (offlineTimer) void retryServer();
      else sendCommand({ type: 'resume' });
    };
    powerMonitor.on('resume', onResume);
    powerMonitor.on('unlock-screen', onResume);

    app.on('activate', () => showMain());
    app.on('browser-window-focus', refreshTray);
  });

  app.on('before-quit', () => {
    quitting = true;
    saveWindowNow();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // The tray keeps the app running with every window closed.
  app.on('window-all-closed', () => undefined);
}
