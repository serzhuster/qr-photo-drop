const express = require('express');
const multer = require('multer');
const cors = require('cors');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 8080;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/web', express.static(path.join(__dirname, '..', 'web')));

// Storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const date = new Date().toISOString().split('T')[0];
    const uploadDir = path.join(__dirname, '..', 'uploads', date);
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

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

// Session management
let currentSession = null;
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

function createSession() {
  currentSession = {
    token: uuidv4(),
    createdAt: Date.now(),
    ip: null,
    active: true,
    files: []
  };
  return currentSession;
}

function validateSession(token) {
  if (!currentSession || !currentSession.active) {
    return { valid: false, error: 'No active session' };
  }
  if (currentSession.token !== token) {
    return { valid: false, error: 'Invalid token' };
  }
  if (Date.now() - currentSession.createdAt > SESSION_TIMEOUT) {
    currentSession.active = false;
    return { valid: false, error: 'Session expired' };
  }
  return { valid: true, session: currentSession };
}

function isLocalIP(ip) {
  const cleanIP = ip.replace('::ffff:', '');
  return cleanIP === '127.0.0.1' || 
         cleanIP === '::1' || 
         cleanIP.startsWith('192.168.') || 
         cleanIP.startsWith('10.') ||
         (cleanIP.startsWith('172.') && parseInt(cleanIP.split('.')[1]) >= 16 && parseInt(cleanIP.split('.')[1]) <= 31);
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Generate QR code
app.get('/api/qr', async (req, res) => {
  try {
    const session = createSession();
    const ip = getLocalIP();
    const url = `http://${ip}:${PORT}/web?token=${session.token}`;
    
    const qrDataURL = await QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    
    res.json({
      qr: qrDataURL,
      url: url,
      token: session.token,
      expiresIn: SESSION_TIMEOUT / 1000
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get session status
app.get('/api/status', (req, res) => {
  if (!currentSession || !currentSession.active) {
    return res.json({ status: 'waiting', session: null });
  }
  
  const timeLeft = Math.max(0, SESSION_TIMEOUT - (Date.now() - currentSession.createdAt));
  res.json({
    status: 'active',
    session: {
      token: currentSession.token,
      files: currentSession.files,
      timeLeft: Math.floor(timeLeft / 1000)
    }
  });
});

// Upload endpoint
app.post('/api/upload', upload.array('files', 50), (req, res) => {
  const token = req.query.token;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  if (!isLocalIP(clientIP)) {
    return res.status(403).json({ error: 'Only local network connections allowed' });
  }
  
  const validation = validateSession(token);
  if (!validation.valid) {
    return res.status(401).json({ error: validation.error });
  }
  
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }
  
  const uploadedFiles = req.files.map(f => ({
    name: f.originalname,
    size: f.size,
    path: f.path,
    savedAt: new Date().toISOString()
  }));
  
  currentSession.files.push(...uploadedFiles);
  
  res.json({
    success: true,
    count: req.files.length,
    files: uploadedFiles
  });
});

// Delete session
app.post('/api/reset', (req, res) => {
  currentSession = null;
  res.json({ success: true });
});

// Serve mobile web app
app.get('/web', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`Server running at:`);
  console.log(`  Local: http://localhost:${PORT}`);
  console.log(`  Network: http://${ip}:${PORT}`);
  console.log(`  Mobile: http://${ip}:${PORT}/web`);
});