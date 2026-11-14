const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const fs = require('fs');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const { transcodeToHls } = require('./media');
const storage = require('./storage');

const dataDir = path.resolve(process.env.DATA_DIR || path.resolve(__dirname, '../data'));
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.resolve(__dirname, '../uploads'));
const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(dataDir, 'streampulse.db'));
const sourceDir = path.join(uploadDir, 'originals');
const hlsDir = path.join(uploadDir, 'hls');

fs.mkdirSync(dataDir, { recursive: true });
const db = new sqlite3.Database(dbPath);
db.run('PRAGMA foreign_keys = ON');

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      return resolve({ changes: this.changes });
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) return reject(error);
      return resolve(row);
    });
  });

async function processNextVideo() {
  const video = await get(
    'SELECT id, file_name FROM videos WHERE status = ? ORDER BY created_at LIMIT 1',
    ['queued'],
  );

  if (!video) return false;

  const claim = await run('UPDATE videos SET status = ? WHERE id = ? AND status = ?', [
    'processing',
    video.id,
    'queued',
  ]);

  if (!claim.changes) return true;

  const workingDirectory = storage.isS3Enabled()
    ? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'streampulse-transcode-'))
    : null;
  const sourcePath = storage.isS3Enabled()
    ? path.join(workingDirectory, path.basename(video.file_name))
    : path.join(sourceDir, video.file_name);
  const outputPath = storage.isS3Enabled()
    ? path.join(workingDirectory, 'hls')
    : path.join(hlsDir, video.id);

  try {
    if (storage.isS3Enabled()) {
      await storage.downloadFile(video.file_name, sourcePath);
    }
    await transcodeToHls(sourcePath, outputPath);
    const hlsLocation = storage.isS3Enabled() ? storage.hlsPrefix(video.id) : video.id;
    if (storage.isS3Enabled()) {
      await storage.deletePrefix(hlsLocation);
      await storage.uploadDirectory(outputPath, hlsLocation);
    }
    await run('UPDATE videos SET status = ?, hls_dir = ? WHERE id = ?', [
      'ready',
      hlsLocation,
      video.id,
    ]);
    console.log(`Transcoding completed: ${video.id}`);
  } catch (error) {
    console.error(`Transcoding failed for ${video.id}:`, error);
    if (storage.isS3Enabled()) {
      await storage.deletePrefix(storage.hlsPrefix(video.id)).catch((cleanupError) => {
        console.error(`Could not clean S3 output for ${video.id}:`, cleanupError);
      });
    } else {
      await fs.promises.rm(outputPath, { recursive: true, force: true });
    }
    await run('UPDATE videos SET status = ?, failure_reason = ? WHERE id = ?', [
      'failed',
      'Transcoding failed. Please try a supported video file.',
      video.id,
    ]);
  } finally {
    if (workingDirectory) {
      await fs.promises.rm(workingDirectory, { recursive: true, force: true });
    }
  }

  return true;
}

async function startWorker() {
  while (true) {
    try {
      const schema = await get(
        'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
        ['table', 'videos'],
      );
      if (schema) break;
    } catch (error) {
      console.error('Waiting for the API database:', error.message);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  await run('UPDATE videos SET status = ? WHERE status = ?', ['queued', 'processing']);
  console.log('StreamPulse transcoding worker is running.');

  while (true) {
    try {
      const processed = await processNextVideo();
      if (!processed) await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (error) {
      console.error('Worker loop failed:', error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

startWorker().catch((error) => {
  console.error('Worker startup failed:', error);
  process.exitCode = 1;
});
