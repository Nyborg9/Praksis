import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- konfig ---
const PORT = process.env.PORT || 3001;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- DB (SQLite) ---
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'data.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rec_owner_created ON recordings(owner_id, created_at DESC);
`);

// --- app ---
const app = express();
app.use(cors({ origin: true }));       // tillat localhost-oppsett
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

// Demo: én "owner". Bytt til ekte auth senere.
function getOwnerId(req) { return 'demo-user'; }

// --- Én-fil opplasting (/upload) ---
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `${id}${ext}`);
  }
});
const upload = multer({
  storage: diskStorage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

app.post('/upload', upload.single('file'), (req, res) => {
  try {
    const id = path.parse(req.file.filename).name;
    const url = `/uploads/${req.file.filename}`;
    const mimeType = req.body.mimeType || req.file.mimetype || 'video/webm';
    const durationMs = Number(req.body.durationMs || 0);
    const ownerId = getOwnerId(req);

    db.prepare(`
      INSERT INTO recordings(id, owner_id, url, mime_type, bytes, duration_ms)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(id, ownerId, url, mimeType, req.file.size, durationMs);

    res.json({ id, url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Store failed' });
  }
});

// --- Chunket opplasting (/upload/chunk + /upload/finish) ---
const memUpload = multer({ storage: multer.memoryStorage() });

const inprogress = new Map();      // uploadId -> fs.WriteStream
const inprogressMeta = new Map();  // uploadId -> { ownerId, startedAt, mimeType, filename }

app.post('/upload/chunk', memUpload.single('chunk'), (req, res) => {
  const { uploadId, mimeType } = req.body || {};
  if (!uploadId || !req.file) return res.status(400).json({ error: 'bad request' });

  let meta = inprogressMeta.get(uploadId);
  if (!meta) {
    const ownerId = getOwnerId(req);
    const ext =
      mimeType?.includes('webm') ? '.webm' :
      mimeType?.includes('mp4')  ? '.mp4'  :
      mimeType?.includes('quicktime') ? '.mov' : '.bin';
    const filename = `${uploadId}${ext}`;
    meta = { ownerId, startedAt: Date.now(), mimeType: mimeType || 'application/octet-stream', filename };
    inprogressMeta.set(uploadId, meta);
  }

  let handle = inprogress.get(uploadId);
  if (!handle) {
    const filepath = path.join(UPLOAD_DIR, meta.filename);
    handle = fs.createWriteStream(filepath, { flags: 'a' });
    inprogress.set(uploadId, handle);
  }

  handle.write(req.file.buffer);
  res.json({ ok: true });
});

app.post('/upload/finish', (req, res) => {
  const { uploadId, durationMs = 0 } = req.body || {};
  const handle = inprogress.get(uploadId);
  const meta = inprogressMeta.get(uploadId);
  if (!meta) return res.status(404).json({ error: 'unknown uploadId' });

  if (handle) handle.end();
  inprogress.delete(uploadId);

  const filepath = path.join(UPLOAD_DIR, meta.filename);

  const stats = fs.statSync(filepath);
  const url = `/uploads/${meta.filename}`;
  const { ownerId } = meta;
  const id = uploadId;

  db.prepare(`
    INSERT INTO recordings(id, owner_id, url, mime_type, bytes, duration_ms)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET url=excluded.url, mime_type=excluded.mime_type, bytes=excluded.bytes, duration_ms=excluded.duration_ms
  `).run(id, ownerId, url, meta.mimeType, stats.size, Number(durationMs));

  inprogressMeta.delete(uploadId);
  res.json({ id, url });
});

app.listen(PORT, () => console.log(`SQLite-backend kjører på http://localhost:${PORT}`));
