const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');
const storage = require('./storage');

const app = express();
app.set('etag', false);
const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET;
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const dataDir = path.resolve(process.env.DATA_DIR || path.resolve(__dirname, '../data'));
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.resolve(__dirname, '../uploads'));
const sourceDir = path.join(uploadDir, 'originals');
const chunkDir = path.join(uploadDir, 'chunks');
const hlsDir = path.join(uploadDir, 'hls');
const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(dataDir, 'streampulse.db'));
const maxVideoSize = 2 * 1024 * 1024 * 1024;
const chunkSize = 5 * 1024 * 1024;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set to a random secret with at least 32 characters.');
}

for (const directory of [dataDir, sourceDir, chunkDir, hlsDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

const db = new sqlite3.Database(dbPath);
db.run('PRAGMA foreign_keys = ON');

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      return resolve({ id: this.lastID, changes: this.changes });
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) return reject(error);
      return resolve(row);
    });
  });

const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) return reject(error);
      return resolve(rows);
    });
  });

async function initializeDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      original_name TEXT NOT NULL,
      file_name TEXT,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'uploading',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      file_url TEXT,
      hls_dir TEXT,
      failure_reason TEXT,
      views_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS video_likes (
      video_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (video_id, user_id),
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS video_comments (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS upload_chunks (
      upload_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      size INTEGER NOT NULL,
      PRIMARY KEY (upload_id, chunk_index),
      FOREIGN KEY (upload_id) REFERENCES videos(id) ON DELETE CASCADE
    )
  `);

  const columns = await all('PRAGMA table_info(videos)');
  const existingColumns = new Set(columns.map((column) => column.name));

  if (!existingColumns.has('hls_dir')) {
    await run('ALTER TABLE videos ADD COLUMN hls_dir TEXT');
  }

  if (!existingColumns.has('failure_reason')) {
    await run('ALTER TABLE videos ADD COLUMN failure_reason TEXT');
  }

  if (!existingColumns.has('views_count')) {
    await run('ALTER TABLE videos ADD COLUMN views_count INTEGER NOT NULL DEFAULT 0');
  }

  await run(
    'UPDATE videos SET status = ?, hls_dir = NULL WHERE status = ? AND hls_dir IS NULL AND file_url IS NOT NULL',
    ['uploaded', 'ready'],
  );
}

function createToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}

async function authenticate(req, res, next) {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const payload = jwt.verify(authorization.slice(7), JWT_SECRET);
    const user = await get('SELECT id, name, email FROM users WHERE id = ?', [payload.sub]);

    if (!user) {
      return res.status(401).json({ message: 'User not found.' });
    }

    req.user = user;
    return next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ message: 'Invalid or expired token.' });
    }

    console.error('Authentication failed:', error);
    return res.status(500).json({ message: 'Could not verify the session.' });
  }
}

async function authenticateStream(req, res, next) {
  if (req.headers.authorization) return authenticate(req, res, next);

  const ticket = req.query.ticket;

  if (typeof ticket !== 'string') {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const payload = jwt.verify(ticket, JWT_SECRET);

    if (payload.scope !== 'stream' || payload.videoId !== req.params.id) {
      return res.status(401).json({ message: 'Invalid stream ticket.' });
    }

    const user = await get('SELECT id, name, email FROM users WHERE id = ?', [payload.sub]);

    if (!user) {
      return res.status(401).json({ message: 'User not found.' });
    }

    req.user = user;
    return next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ message: 'Invalid or expired stream ticket.' });
    }

    console.error('Stream ticket verification failed:', error);
    return res.status(500).json({ message: 'Could not verify the stream ticket.' });
  }
}

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: chunkSize, files: 1 },
});

function safeVideo(video) {
  return {
    id: video.id,
    title: video.title,
    description: video.description,
    original_name: video.original_name,
    mime_type: video.mime_type,
    size: video.size,
    status: video.status,
    created_at: video.created_at,
    uploader_name: video.uploader_name,
    views_count: video.views_count || 0,
    likes_count: video.likes_count || 0,
    liked_by_user: Boolean(video.liked_by_user),
    file_url: video.status === 'ready' ? `/api/stream/${video.id}/master.m3u8` : null,
    failure_reason: video.failure_reason,
  };
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin is not allowed by CORS.'));
  },
}));
app.use(express.json({ limit: '1mb' }));
morgan.token('safe-url', (req) => req.originalUrl.split('?')[0]);
app.use(morgan(':method :safe-url :status :response-time ms'));

app.get('/health', (_, res) => {
  res.json({ status: 'ok', message: 'StreamPulse API is healthy.' });
});

app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body || {};
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!normalizedName || !normalizedEmail || typeof password !== 'string') {
    return res.status(400).json({ message: 'Name, email, and password are required.' });
  }

  if (normalizedName.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ message: 'Enter a valid name and email address.' });
  }

  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ message: 'Password must be between 8 and 128 characters.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const userId = randomUUID();
    await run('INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)', [
      userId,
      normalizedName,
      normalizedEmail,
      passwordHash,
    ]);

    return res.status(201).json({
      token: createToken(userId),
      user: { id: userId, name: normalizedName, email: normalizedEmail },
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ message: 'An account with that email already exists.' });
    }

    console.error('Signup failed:', error);
    return res.status(500).json({ message: 'Could not create the user account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const user = await get('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    const isValidPassword = user && await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    return res.json({
      token: createToken(user.id),
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (error) {
    console.error('Login failed:', error);
    return res.status(500).json({ message: 'Could not authenticate the user.' });
  }
});

app.get('/api/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/videos', authenticate, async (req, res) => {
  try {
    const videos = await all(`
      SELECT v.*, u.name AS uploader_name,
        (SELECT COUNT(*) FROM video_likes vl WHERE vl.video_id = v.id) AS likes_count,
        EXISTS(
          SELECT 1 FROM video_likes vl
          WHERE vl.video_id = v.id AND vl.user_id = ?
        ) AS liked_by_user
      FROM videos v
      LEFT JOIN users u ON u.id = v.user_id
      ORDER BY v.created_at DESC
    `, [req.user.id]);
    res.json(videos.map(safeVideo));
  } catch (error) {
    console.error('Listing videos failed:', error);
    res.status(500).json({ message: 'Could not load videos.' });
  }
});

app.get('/api/videos/:id', authenticate, async (req, res) => {
  try {
    const video = await get(`
      SELECT v.*, u.name AS uploader_name,
        (SELECT COUNT(*) FROM video_likes vl WHERE vl.video_id = v.id) AS likes_count,
        EXISTS(
          SELECT 1 FROM video_likes vl
          WHERE vl.video_id = v.id AND vl.user_id = ?
        ) AS liked_by_user
      FROM videos v
      LEFT JOIN users u ON u.id = v.user_id
      WHERE v.id = ?
    `, [req.user.id, req.params.id]);

    if (!video) {
      return res.status(404).json({ message: 'Video not found.' });
    }

    return res.json(safeVideo(video));
  } catch (error) {
    console.error('Loading video failed:', error);
    return res.status(500).json({ message: 'Could not load the video.' });
  }
});

app.post('/api/videos/:id/like', authenticate, async (req, res) => {
  const { liked } = req.body || {};

  if (typeof liked !== 'boolean') {
    return res.status(400).json({ message: 'A boolean liked value is required.' });
  }

  try {
    const video = await get('SELECT id, status FROM videos WHERE id = ?', [req.params.id]);

    if (!video || video.status !== 'ready') {
      return res.status(404).json({ message: 'Ready video not found.' });
    }

    if (liked) {
      await run('INSERT OR IGNORE INTO video_likes (video_id, user_id) VALUES (?, ?)', [
        video.id,
        req.user.id,
      ]);
    } else {
      await run('DELETE FROM video_likes WHERE video_id = ? AND user_id = ?', [
        video.id,
        req.user.id,
      ]);
    }

    const result = await get(
      'SELECT COUNT(*) AS likes_count FROM video_likes WHERE video_id = ?',
      [video.id],
    );

    return res.json({ liked_by_user: liked, likes_count: result.likes_count });
  } catch (error) {
    console.error('Updating video like failed:', error);
    return res.status(500).json({ message: 'Could not update your like.' });
  }
});

app.get('/api/videos/:id/comments', authenticate, async (req, res) => {
  try {
    const video = await get('SELECT id, status FROM videos WHERE id = ?', [req.params.id]);

    if (!video || video.status !== 'ready') {
      return res.status(404).json({ message: 'Ready video not found.' });
    }

    const comments = await all(`
      SELECT c.id, c.body, c.created_at, u.id AS user_id, u.name AS author_name
      FROM video_comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.video_id = ?
      ORDER BY c.created_at DESC, c.rowid DESC
      LIMIT 100
    `, [video.id]);

    return res.json(comments);
  } catch (error) {
    console.error('Loading video comments failed:', error);
    return res.status(500).json({ message: 'Could not load comments.' });
  }
});

app.post('/api/videos/:id/comments', authenticate, async (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';

  if (!body || body.length > 1000) {
    return res.status(400).json({ message: 'Comments must be between 1 and 1000 characters.' });
  }

  try {
    const video = await get('SELECT id, status FROM videos WHERE id = ?', [req.params.id]);

    if (!video || video.status !== 'ready') {
      return res.status(404).json({ message: 'Ready video not found.' });
    }

    const id = randomUUID();
    await run(
      'INSERT INTO video_comments (id, video_id, user_id, body) VALUES (?, ?, ?, ?)',
      [id, video.id, req.user.id, body],
    );

    const comment = await get(`
      SELECT c.id, c.body, c.created_at, u.id AS user_id, u.name AS author_name
      FROM video_comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.id = ?
    `, [id]);

    return res.status(201).json(comment);
  } catch (error) {
    console.error('Creating video comment failed:', error);
    return res.status(500).json({ message: 'Could not post your comment.' });
  }
});

app.post('/api/videos/:id/view', authenticate, async (req, res) => {
  try {
    const result = await run(
      'UPDATE videos SET views_count = views_count + 1 WHERE id = ? AND status = ?',
      [req.params.id, 'ready'],
    );

    if (!result.changes) {
      return res.status(404).json({ message: 'Ready video not found.' });
    }

    const video = await get('SELECT views_count FROM videos WHERE id = ?', [req.params.id]);
    return res.json({ views_count: video.views_count });
  } catch (error) {
    console.error('Recording video view failed:', error);
    return res.status(500).json({ message: 'Could not record the video view.' });
  }
});

app.get('/api/videos/:id/stream-ticket', authenticate, async (req, res) => {
  try {
    const video = await get(
      'SELECT id, status FROM videos WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id],
    );

    if (!video || video.status !== 'ready') {
      return res.status(404).json({ message: 'Ready video not found.' });
    }

    const ticket = jwt.sign(
      { sub: req.user.id, videoId: video.id, scope: 'stream' },
      JWT_SECRET,
      { expiresIn: '24h' },
    );

    return res.json({ ticket });
  } catch (error) {
    console.error('Creating stream ticket failed:', error);
    return res.status(500).json({ message: 'Could not prepare the video stream.' });
  }
});

app.post('/api/videos/:id/retry', authenticate, async (req, res) => {
  try {
    const video = await get(
      'SELECT id, file_name, status FROM videos WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id],
    );

    if (!video || video.status !== 'failed') {
      return res.status(404).json({ message: 'Failed video not found.' });
    }

    if (storage.isS3Enabled()) {
      await storage.headObject(video.file_name);
    } else {
      const sourcePath = path.resolve(sourceDir, video.file_name || '');
      if (!sourcePath.startsWith(`${sourceDir}${path.sep}`)) {
        return res.status(400).json({ message: 'The source video path is invalid.' });
      }
      await fs.promises.access(sourcePath);
    }

    await run('UPDATE videos SET status = ?, failure_reason = NULL WHERE id = ? AND status = ?', [
      'queued',
      video.id,
      'failed',
    ]);

    return res.status(202).json({ id: video.id, status: 'queued' });
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ message: 'The original uploaded file is no longer available.' });
    }

    console.error('Retrying video processing failed:', error);
    return res.status(500).json({ message: 'Could not retry video processing.' });
  }
});

app.post('/api/videos/uploads/init', authenticate, async (req, res) => {
  const { title, description = '', fileName, fileSize, mimeType } = req.body || {};
  const safeTitle = typeof title === 'string' ? title.trim() : '';
  const safeFileName = typeof fileName === 'string' ? path.basename(fileName) : '';

  if (
    !safeTitle ||
    safeTitle.length > 160 ||
    typeof fileSize !== 'number' ||
    !Number.isSafeInteger(fileSize) ||
    fileSize <= 0 ||
    fileSize > maxVideoSize ||
    typeof mimeType !== 'string' ||
    !mimeType.startsWith('video/') ||
    !safeFileName
  ) {
    return res.status(400).json({ message: 'Video metadata is invalid or exceeds the 2 GB limit.' });
  }

  if (typeof description !== 'string' || description.length > 2000) {
    return res.status(400).json({ message: 'Description must be 2,000 characters or fewer.' });
  }

  try {
    const videoId = randomUUID();
    const totalChunks = Math.ceil(fileSize / chunkSize);
    await run(`
      INSERT INTO videos (id, user_id, title, description, original_name, file_name, mime_type, size, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      videoId,
      req.user.id,
      safeTitle,
      description.trim(),
      safeFileName,
      '',
      mimeType,
      fileSize,
      'uploading',
    ]);
    await fs.promises.mkdir(path.join(chunkDir, videoId), { recursive: true });

    return res.status(201).json({ uploadId: videoId, chunkSize, totalChunks });
  } catch (error) {
    console.error('Starting upload failed:', error);
    return res.status(500).json({ message: 'Could not start the video upload.' });
  }
});

app.put('/api/videos/uploads/:uploadId/chunks/:chunkIndex', authenticate, chunkUpload.single('chunk'), async (req, res) => {
  const chunkIndex = Number(req.params.chunkIndex);

  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !req.file) {
    return res.status(400).json({ message: 'A valid chunk and chunk index are required.' });
  }

  try {
    const video = await get('SELECT id, size, status FROM videos WHERE id = ? AND user_id = ?', [
      req.params.uploadId,
      req.user.id,
    ]);

    if (!video || video.status !== 'uploading') {
      return res.status(404).json({ message: 'Active upload not found.' });
    }

    const totalChunks = Math.ceil(video.size / chunkSize);

    if (chunkIndex >= totalChunks) {
      return res.status(400).json({ message: 'Chunk index is outside the upload range.' });
    }

    const expectedSize = chunkIndex === totalChunks - 1
      ? video.size - chunkIndex * chunkSize
      : chunkSize;

    if (req.file.size !== expectedSize) {
      return res.status(400).json({ message: 'Chunk size does not match the expected size.' });
    }

    const directory = path.join(chunkDir, video.id);
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, `chunk-${chunkIndex}`), req.file.buffer);
    await run(
      'INSERT OR REPLACE INTO upload_chunks (upload_id, chunk_index, size) VALUES (?, ?, ?)',
      [video.id, chunkIndex, req.file.size],
    );

    return res.status(204).end();
  } catch (error) {
    console.error('Saving upload chunk failed:', error);
    return res.status(500).json({ message: 'Could not save the upload chunk.' });
  }
});

app.post('/api/videos/uploads/:uploadId/complete', authenticate, async (req, res) => {
  const videoId = req.params.uploadId;

  try {
    const video = await get('SELECT * FROM videos WHERE id = ? AND user_id = ?', [videoId, req.user.id]);

    if (!video || video.status !== 'uploading') {
      return res.status(404).json({ message: 'Active upload not found.' });
    }

    const chunks = await all(
      'SELECT chunk_index, size FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index',
      [videoId],
    );
    const totalChunks = Math.ceil(video.size / chunkSize);

    if (
      chunks.length !== totalChunks ||
      chunks.some((chunk, index) => chunk.chunk_index !== index)
    ) {
      return res.status(409).json({ message: 'Upload is incomplete. Send all chunks before completing.' });
    }

    const sessionDir = path.join(chunkDir, videoId);
    const extension = path.extname(video.original_name).slice(0, 12) || '.video';
    const fileName = `${videoId}${extension}`;
    const sourcePath = path.join(sourceDir, fileName);

    for (const chunk of chunks) {
      await pipeline(
        fs.createReadStream(path.join(sessionDir, `chunk-${chunk.chunk_index}`)),
        fs.createWriteStream(sourcePath, {
          flags: chunk.chunk_index === 0 ? 'w' : 'a',
        }),
      );
    }

    const stats = await fs.promises.stat(sourcePath);

    if (stats.size !== video.size) {
      await fs.promises.rm(sourcePath, { force: true });
      return res.status(500).json({ message: 'Assembled file size does not match the upload.' });
    }

    const storedFileName = storage.isS3Enabled()
      ? storage.originalKey(videoId, fileName)
      : fileName;
    if (storage.isS3Enabled()) {
      await storage.putFile(storedFileName, sourcePath, video.mime_type);
    }
    await run(
      'UPDATE videos SET status = ?, file_name = ? WHERE id = ?',
      ['queued', storedFileName, videoId],
    );
    await run('DELETE FROM upload_chunks WHERE upload_id = ?', [videoId]);
    await fs.promises.rm(sessionDir, { recursive: true, force: true });
    if (storage.isS3Enabled()) await fs.promises.rm(sourcePath, { force: true });
    return res.status(202).json({ id: videoId, status: 'queued' });
  } catch (error) {
    console.error('Completing video upload failed:', error);
    return res.status(500).json({ message: 'Could not complete the video upload.' });
  }
});

app.get('/api/stream/:id/*filePath', authenticateStream, async (req, res) => {
  try {
    const video = await get('SELECT hls_dir, status FROM videos WHERE id = ?', [req.params.id]);

    if (!video || video.status !== 'ready' || !video.hls_dir) {
      return res.status(404).json({ message: 'Stream is not ready.' });
    }

    const relativePath = Array.isArray(req.params.filePath)
      ? req.params.filePath.join(path.sep)
      : req.params.filePath;

    if (storage.isS3Enabled()) {
      const key = storage.streamKey(video.hls_dir, relativePath);
      if (!key.startsWith(`${video.hls_dir}/`)) {
        return res.status(400).json({ message: 'Invalid stream path.' });
      }

      const object = await storage.getObject(key);
      res.type(storage.contentTypeFor(key));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Pragma', 'no-cache');
      if (path.extname(key) === '.m3u8' && typeof req.query.ticket === 'string') {
        const playlist = await object.Body.transformToString();
        const ticket = encodeURIComponent(req.query.ticket);
        const authenticatedPlaylist = playlist.replace(/^(?!#)(.+)$/gm, (line) => (
          `${line}${line.includes('?') ? '&' : '?'}ticket=${ticket}`
        ));
        return res.send(authenticatedPlaylist);
      }

      if (object.ContentLength !== undefined) res.setHeader('Content-Length', object.ContentLength);
      return await pipeline(object.Body, res);
    }

    const streamRoot = path.resolve(hlsDir, video.hls_dir);
    const filePath = path.resolve(streamRoot, relativePath);

    if (!filePath.startsWith(`${streamRoot}${path.sep}`)) {
      return res.status(400).json({ message: 'Invalid stream path.' });
    }

    const stat = await fs.promises.stat(filePath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });

    if (!stat || !stat.isFile()) {
      return res.status(404).json({ message: 'Stream file not found.' });
    }

    res.type(path.extname(filePath) === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');

    if (path.extname(filePath) === '.m3u8' && typeof req.query.ticket === 'string') {
      const playlist = await fs.promises.readFile(filePath, 'utf8');
      const ticket = encodeURIComponent(req.query.ticket);
      const authenticatedPlaylist = playlist.replace(/^(?!#)(.+)$/gm, (line) => (
        `${line}${line.includes('?') ? '&' : '?'}ticket=${ticket}`
      ));
      return res.send(authenticatedPlaylist);
    }

    return res.sendFile(filePath, {
      cacheControl: false,
      etag: false,
      lastModified: false,
    });
  } catch (error) {
    console.error('Serving HLS stream failed:', error);
    return res.status(500).json({ message: 'Could not serve the stream.' });
  }
});

app.get('/api/source/:id', authenticateStream, async (req, res) => {
  try {
    const video = await get(
      'SELECT file_name, mime_type, status FROM videos WHERE id = ?',
      [req.params.id],
    );

    if (!video || video.status !== 'ready' || !video.file_name) {
      return res.status(404).json({ message: 'Ready source video not found.' });
    }

    res.type(video.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');

    if (storage.isS3Enabled()) {
      const object = await storage.getObject(video.file_name, req.headers.range);
      res.setHeader('Accept-Ranges', 'bytes');
      if (object.ContentLength !== undefined) res.setHeader('Content-Length', object.ContentLength);
      if (object.ContentRange) res.setHeader('Content-Range', object.ContentRange);
      if (req.headers.range && object.ContentRange) res.status(206);
      return await pipeline(object.Body, res);
    }

    const sourcePath = path.resolve(sourceDir, video.file_name);
    if (!sourcePath.startsWith(`${sourceDir}${path.sep}`)) {
      return res.status(400).json({ message: 'Invalid source video path.' });
    }
    await fs.promises.access(sourcePath);
    return res.sendFile(sourcePath, {
      acceptRanges: true,
      cacheControl: false,
      etag: false,
      lastModified: false,
    });
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ message: 'Original source video is not available.' });
    }

    console.error('Serving source video failed:', error);
    return res.status(500).json({ message: 'Could not serve the source video.' });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ message: `Upload error: ${error.message}` });
  }

  if (error) {
    console.error('Request failed:', error);
    return res.status(500).json({ message: 'The request could not be completed.' });
  }

  return next();
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`StreamPulse API listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Database setup failed:', error);
    process.exit(1);
  });
