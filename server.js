// server.js – with authentication and security
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcrypt');
const app = express();
const PORT = 3000;

// ==== Paths ====
const SPEAKERS_FILE = './data/speakers.json';
const CONTENT_FILE = './data/content.json';
const USERS_FILE = './data/users.json';

// ==== Admin Credentials (CHANGE THESE!) ====
// In production, use environment variables or a proper user management system
const ADMIN_CREDENTIALS = {
    username: process.env.ADMIN_USERNAME || 'admin',
    // Password is hashed version of 'changeme123' - CHANGE THIS!
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '$2b$10$rVK5zJ5fqYQZ5gYxJ5qYTe0vZ5qYTe0vZ5qYTe0vZ5qYTe0vZ5qYTe'
};

// ==== Middleware ====
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static('uploads'));

// Session middleware for authentication
app.use(session({
    secret: process.env.SESSION_SECRET || 'change-this-secret-key-in-production',
    resave: false,
    saveUninitialized: false,
    //saveUnsetChanges: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// ==== Authentication Middleware ====
function requireAuth(req, res, next) {
    if (req.session && req.session.isAuthenticated) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized - Please login' });
}

// ==== File Uploads (Images) ====
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const dir = './uploads';
        await fs.mkdir(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /jpeg|jpg|png|gif/;
        const ok = allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype);
        if (ok) cb(null, true);
        else cb(new Error('Only image files are allowed!'));
    }
});

// ==== Initialize Data ====
async function ensureDataFiles() {
    await fs.mkdir('./data', { recursive: true });
    try { await fs.access(SPEAKERS_FILE); } catch { await fs.writeFile(SPEAKERS_FILE, '[]'); }
    try { await fs.access(CONTENT_FILE); } catch { await fs.writeFile(CONTENT_FILE, JSON.stringify({ en: {}, fr: {} }, null, 2)); }
    
    // Initialize users file with default admin if doesn't exist
    try { 
        await fs.access(USERS_FILE); 
    } catch { 
        const defaultHash = await bcrypt.hash('changeme123', 10);
        await fs.writeFile(USERS_FILE, JSON.stringify([{
            username: 'admin',
            passwordHash: defaultHash,
            createdAt: new Date().toISOString()
        }], null, 2));
        console.log('⚠️  Default admin user created. Username: admin, Password: changeme123');
        console.log('⚠️  PLEASE CHANGE THE PASSWORD IMMEDIATELY!');
    }
}

// ==== Cache System ====
let speakersCache = null;
let speakersTimestamp = 0;
let contentCache = null;
let contentTimestamp = 0;
const CACHE_TTL = 1000 * 60; // 1 min

async function readCached(file, cacheRef, timestampRef) {
    const stats = await fs.stat(file);
    const modified = stats.mtimeMs;
    if (!cacheRef.value || modified > timestampRef.value || Date.now() - timestampRef.value > CACHE_TTL) {
        const data = await fs.readFile(file, 'utf8');
        cacheRef.value = JSON.parse(data);
        timestampRef.value = Date.now();
        console.log(`🧠 Cache refreshed: ${path.basename(file)}`);
    }
    return cacheRef.value;
}

async function readSpeakersCached() {
    return readCached(SPEAKERS_FILE, { value: speakersCache }, { value: speakersTimestamp });
}
async function writeSpeakersCached(data) {
    speakersCache = data;
    speakersTimestamp = Date.now();
    await fs.writeFile(SPEAKERS_FILE, JSON.stringify(data, null, 2));
}
async function readContentCached() {
    return readCached(CONTENT_FILE, { value: contentCache }, { value: contentTimestamp });
}
async function writeContentCached(data) {
    contentCache = data;
    contentTimestamp = Date.now();
    await fs.writeFile(CONTENT_FILE, JSON.stringify(data, null, 2));
}

// ==== AUTHENTICATION ROUTES ====
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        // Read users from file
        const usersData = await fs.readFile(USERS_FILE, 'utf8');
        const users = JSON.parse(usersData);
        
        // Find user
        const user = users.find(u => u.username === username);
        
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Verify password
        const isValid = await bcrypt.compare(password, user.passwordHash);
        
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Set session
        req.session.isAuthenticated = true;
        req.session.username = username;
        
        res.json({ 
            success: true, 
            message: 'Login successful',
            username: username 
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Logout failed' });
        }
        res.json({ success: true, message: 'Logged out successfully' });
    });
});

app.get('/api/auth/check', (req, res) => {
    if (req.session && req.session.isAuthenticated) {
        res.json({ 
            authenticated: true, 
            username: req.session.username 
        });
    } else {
        res.json({ authenticated: false });
    }
});

// Change password (requires authentication)
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password required' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }

        const usersData = await fs.readFile(USERS_FILE, 'utf8');
        const users = JSON.parse(usersData);
        
        const userIndex = users.findIndex(u => u.username === req.session.username);
        
        if (userIndex === -1) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Verify current password
        const isValid = await bcrypt.compare(currentPassword, users[userIndex].passwordHash);
        
        if (!isValid) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        // Hash new password
        const newHash = await bcrypt.hash(newPassword, 10);
        users[userIndex].passwordHash = newHash;
        users[userIndex].passwordChangedAt = new Date().toISOString();
        
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
        console.error('Password change error:', err);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// ==== USER MANAGEMENT API (Add these routes to server.js after the auth routes) ====

// Get all users (excluding password hashes)
app.get('/api/users', requireAuth, async (req, res) => {
    try {
        const usersData = await fs.readFile(USERS_FILE, 'utf8');
        const users = JSON.parse(usersData);
        
        // Remove password hashes before sending
        const sanitizedUsers = users.map(u => ({
            username: u.username,
            createdAt: u.createdAt,
            passwordChangedAt: u.passwordChangedAt,
            lastLogin: u.lastLogin
        }));
        
        res.json(sanitizedUsers);
    } catch (err) {
        console.error('Get users error:', err);
        res.status(500).json({ error: 'Failed to get users' });
    }
});

// Create new user
app.post('/api/users', requireAuth, async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        
        if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
            return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores, and hyphens' });
        }
        
        const usersData = await fs.readFile(USERS_FILE, 'utf8');
        const users = JSON.parse(usersData);
        
        // Check if username already exists
        if (users.find(u => u.username === username)) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        
        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);
        
        // Create new user
        const newUser = {
            username,
            passwordHash,
            createdAt: new Date().toISOString(),
            createdBy: req.session.username
        };
        
        users.push(newUser);
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        
        // Return user without password hash
        res.status(201).json({
            username: newUser.username,
            createdAt: newUser.createdAt,
            createdBy: newUser.createdBy
        });
    } catch (err) {
        console.error('Create user error:', err);
        res.status(500).json({ error: 'Failed to create user' });
    }
});

// Delete user
app.delete('/api/users/:username', requireAuth, async (req, res) => {
    try {
        const { username } = req.params;
        
        // Prevent deleting yourself
        if (username === req.session.username) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }
        
        const usersData = await fs.readFile(USERS_FILE, 'utf8');
        const users = JSON.parse(usersData);
        
        // Don't allow deleting the last user
        if (users.length <= 1) {
            return res.status(400).json({ error: 'Cannot delete the last user' });
        }
        
        const filteredUsers = users.filter(u => u.username !== username);
        
        if (filteredUsers.length === users.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        await fs.writeFile(USERS_FILE, JSON.stringify(filteredUsers, null, 2));
        
        res.json({ success: true, message: 'User deleted successfully' });
    } catch (err) {
        console.error('Delete user error:', err);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// Reset user password (admin only)
app.post('/api/users/:username/reset-password', requireAuth, async (req, res) => {
    try {
        const { username } = req.params;
        const { newPassword } = req.body;
        
        if (!newPassword) {
            return res.status(400).json({ error: 'New password required' });
        }
        
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        
        const usersData = await fs.readFile(USERS_FILE, 'utf8');
        const users = JSON.parse(usersData);
        
        const userIndex = users.findIndex(u => u.username === username);
        
        if (userIndex === -1) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Hash new password
        const passwordHash = await bcrypt.hash(newPassword, 10);
        users[userIndex].passwordHash = passwordHash;
        users[userIndex].passwordChangedAt = new Date().toISOString();
        users[userIndex].passwordResetBy = req.session.username;
        
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        
        res.json({ success: true, message: 'Password reset successfully' });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// ==== PUBLIC SPEAKERS API (No auth required) ====
app.get('/api/speakers', async (req, res) => {
    const speakers = await readSpeakersCached();
    res.json(speakers);
});

app.get('/api/speakers/:id', async (req, res) => {
    const speakers = await readSpeakersCached();
    const s = speakers.find(sp => sp.id === parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: 'Speaker not found' });
    res.json(s);
});

// ==== PROTECTED SPEAKERS API (Auth required) ====
app.post('/api/speakers', requireAuth, async (req, res) => {
    const speakers = await readSpeakersCached();
    const newSpeaker = {
        id: speakers.length ? Math.max(...speakers.map(s => s.id)) + 1 : 1,
        ...req.body
    };
    speakers.push(newSpeaker);
    await writeSpeakersCached(speakers);
    res.status(201).json(newSpeaker);
});

app.put('/api/speakers/:id', requireAuth, async (req, res) => {
    const speakers = await readSpeakersCached();
    const index = speakers.findIndex(s => s.id === parseInt(req.params.id));
    if (index === -1) return res.status(404).json({ error: 'Speaker not found' });
    speakers[index] = { ...speakers[index], ...req.body, id: speakers[index].id };
    await writeSpeakersCached(speakers);
    res.json(speakers[index]);
});

app.delete('/api/speakers/:id', requireAuth, async (req, res) => {
    const speakers = await readSpeakersCached();
    const filtered = speakers.filter(s => s.id !== parseInt(req.params.id));
    if (filtered.length === speakers.length) return res.status(404).json({ error: 'Not found' });
    await writeSpeakersCached(filtered);
    res.json({ message: 'Deleted' });
});

// ==== PUBLIC CONTENT API (No auth required for reading) ====
app.get('/api/content', async (req, res) => {
    const content = await readContentCached();
    res.json(content);
});

// ==== PROTECTED CONTENT API (Auth required for updating) ====
app.put('/api/content', requireAuth, async (req, res) => {
    const updated = req.body;
    await writeContentCached(updated);
    res.json({ message: 'Content updated successfully' });
});

// ==== PROTECTED File Uploads (Auth required) ====
app.post('/api/upload', requireAuth, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ url: `/uploads/${req.file.filename}` });
});

// ==== Admin Panel (Protected) ====
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==== Start Server ====
ensureDataFiles().then(() => {
    app.listen(PORT, () => {
        console.log(`✅ Server ready → http://localhost:${PORT}`);
        console.log(`🔒 Admin → http://localhost:${PORT}/admin`);
        console.log(`⚠️  Remember to change default admin credentials!`);
    });
});