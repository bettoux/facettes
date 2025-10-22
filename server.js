// server.js — with caching and content persistence
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const app = express();
const PORT = 3000;

// ==== Paths ====
const SPEAKERS_FILE = './data/speakers.json';
const CONTENT_FILE = './data/content.json';

// ==== Middleware ====
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static('uploads'));
app.use(express.static('public'));


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
async function writeCached(file, cacheRef, timestampRef, data) {
    cacheRef.value = data;
    timestampRef.value = Date.now();
    await fs.writeFile(file, JSON.stringify(data, null, 2));
}

// ==== Helpers for cached reads/writes ====
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

// ==== SPEAKERS API ====
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

app.post('/api/speakers', async (req, res) => {
    const speakers = await readSpeakersCached();
    const newSpeaker = {
        id: speakers.length ? Math.max(...speakers.map(s => s.id)) + 1 : 1,
        ...req.body
    };
    speakers.push(newSpeaker);
    await writeSpeakersCached(speakers);
    res.status(201).json(newSpeaker);
});

app.put('/api/speakers/:id', async (req, res) => {
    const speakers = await readSpeakersCached();
    const index = speakers.findIndex(s => s.id === parseInt(req.params.id));
    if (index === -1) return res.status(404).json({ error: 'Speaker not found' });
    speakers[index] = { ...speakers[index], ...req.body, id: speakers[index].id };
    await writeSpeakersCached(speakers);
    res.json(speakers[index]);
});

app.delete('/api/speakers/:id', async (req, res) => {
    const speakers = await readSpeakersCached();
    const filtered = speakers.filter(s => s.id !== parseInt(req.params.id));
    if (filtered.length === speakers.length) return res.status(404).json({ error: 'Not found' });
    await writeSpeakersCached(filtered);
    res.json({ message: 'Deleted' });
});

// ==== CONTENT API ====
app.get('/api/content', async (req, res) => {
    const content = await readContentCached();
    res.json(content);
});

app.put('/api/content', async (req, res) => {
    const updated = req.body;
    await writeContentCached(updated);
    res.json({ message: 'Content updated successfully' });
});

// ==== File Uploads ====
app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ url: `/uploads/${req.file.filename}` });
});

// ==== Admin Panel ====
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==== Start Server ====
ensureDataFiles().then(() => {
    app.listen(PORT, () => {
        console.log(`✅ Server ready → http://localhost:${PORT}`);
        console.log(`Admin → http://localhost:${PORT}/admin`);
    });
});
