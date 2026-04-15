const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

let mainWindow;
let server;
let currentSession = null;
const PORT = 8080;
const SESSION_TIMEOUT = 5 * 60 * 1000;

const BASE_DIR = app.getAppPath();
let UPLOAD_DIR = process.platform === 'win32'
  ? 'C:\\MobileUpload'
  : path.join(os.homedir(), 'MobileUpload');

function startServer(callback) {
  const expressApp = express();

  expressApp.use(cors());
  expressApp.use(express.json());

  const webPath = path.join(BASE_DIR, 'web');
  const electronPath = path.join(BASE_DIR, 'electron');

  expressApp.use('/uploads', express.static(UPLOAD_DIR));
  expressApp.use('/web', express.static(webPath));
  expressApp.use('/static', express.static(electronPath));

  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const date = new Date().toISOString().split('T')[0];
      const uploadDir = path.join(UPLOAD_DIR, date);
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const uniqueName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${path.extname(file.originalname)}`;
      cb(null, uniqueName);
    }
  });

  const upload = multer({ storage: storage, limits: { fileSize: 100 * 1024 * 1024 } });

  function createSession() {
    currentSession = {
      token: uuidv4(),
      createdAt: Date.now(),
      active: true,
      files: []
    };
    return currentSession;
  }

  function validateSession(token) {
    if (!currentSession || !currentSession.active) return { valid: false, error: 'No active session' };
    if (currentSession.token !== token) return { valid: false, error: 'Invalid token' };
    if (Date.now() - currentSession.createdAt > SESSION_TIMEOUT) {
      currentSession.active = false;
      return { valid: false, error: 'Session expired' };
    }
    return { valid: true };
  }

  function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
    return '127.0.0.1';
  }

  expressApp.get('/api/qr', async (req, res) => {
    try {
      const session = createSession();
      const ip = getLocalIP();
      const url = `http://${ip}:${PORT}/web?token=${session.token}`;
      const qrDataURL = await QRCode.toDataURL(url, { width: 350, margin: 2 });
      res.json({ qr: qrDataURL, url, token: session.token, expiresIn: SESSION_TIMEOUT / 1000, ip, uploadDir: UPLOAD_DIR });
      sendToRenderer('session-created', { url, token: session.token });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  expressApp.get('/api/status', (req, res) => {
    if (!currentSession || !currentSession.active) return res.json({ status: 'waiting', uploadDir: UPLOAD_DIR });
    const timeLeft = Math.max(0, SESSION_TIMEOUT - (Date.now() - currentSession.createdAt));
    res.json({ status: 'active', uploadDir: UPLOAD_DIR, session: { token: currentSession.token, files: currentSession.files, timeLeft: Math.floor(timeLeft / 1000) } });
  });

  expressApp.post('/api/upload', upload.array('files', 50), (req, res) => {
    const token = req.query.token;
    const validation = validateSession(token);
    if (!validation.valid) return res.status(401).json({ error: validation.error });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    
    const uploadedFiles = req.files.map(f => ({ name: f.originalname, size: f.size, path: f.path, savedAt: new Date().toISOString() }));
    currentSession.files.push(...uploadedFiles);
    
    res.json({ success: true, count: req.files.length, files: uploadedFiles });
    sendToRenderer('files-received', { count: req.files.length, files: uploadedFiles });
  });

  expressApp.post('/api/reset', (req, res) => {
    currentSession = null;
    res.json({ success: true });
    sendToRenderer('session-reset');
  });

  // Serve web UI
  expressApp.get('/web', (req, res) => {
    res.sendFile(path.join(webPath, 'index.html'));
  });

  // Root - serve electron UI
  expressApp.get('/', (req, res) => {
    res.sendFile(path.join(electronPath, 'index.html'));
  });

  // Handle 404
  expressApp.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  expressApp.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({ error: err.message });
  });

  server = expressApp.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Mobile URL: http://${getLocalIP()}:${PORT}/web`);
    if (callback) callback();
  });
  
  server.on('error', (err) => {
    console.error('Server error:', err);
  });
}

function sendToRenderer(channel, data) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send(channel, data);
  }
}

// IPC: select folder
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select folder to save photos',
    defaultPath: UPLOAD_DIR,
    properties: ['openDirectory', 'createDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    UPLOAD_DIR = result.filePaths[0];
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
  return UPLOAD_DIR;
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 450,
    height: 650,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (server) server.close();
  });
}

app.whenReady().then(() => {
  startServer(() => {
    createWindow();
  });
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (server) server.close();
  app.quit();
});