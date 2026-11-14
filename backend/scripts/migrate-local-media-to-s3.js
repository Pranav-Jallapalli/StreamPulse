require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const fs = require('fs/promises');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const storage = require('../src/storage');

const dataDir = path.resolve(process.env.DATA_DIR || path.resolve(__dirname, '../data'));
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.resolve(__dirname, '../uploads'));
const sourceDir = path.join(uploadDir, 'originals');
const hlsDir = path.join(uploadDir, 'hls');
const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(dataDir, 'streampulse.db'));

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => (error ? reject(error) : resolve()));
  });
}

async function migrate() {
  if (!storage.isS3Enabled()) {
    throw new Error('Set S3_BUCKET in backend/.env before migrating media.');
  }

  const db = new sqlite3.Database(dbPath);
  try {
    const videos = await all(
      db,
      'SELECT id, file_name, mime_type, status, hls_dir FROM videos WHERE file_name IS NOT NULL AND file_name != ?',
      [''],
    );

    for (const video of videos) {
      if (video.file_name.startsWith(`originals/${video.id}/`)) {
        console.log(`Original already in S3: ${video.id}`);
      } else {
        const sourcePath = path.resolve(sourceDir, video.file_name);
        if (!sourcePath.startsWith(`${sourceDir}${path.sep}`)) {
          throw new Error(`Invalid local source path for video ${video.id}.`);
        }
        await fs.access(sourcePath);
        const key = storage.originalKey(video.id, video.file_name);
        await storage.putFile(key, sourcePath, video.mime_type);
        await run(db, 'UPDATE videos SET file_name = ? WHERE id = ?', [key, video.id]);
        console.log(`Copied original to S3: ${video.id}`);
      }

      if (video.status !== 'ready') continue;
      const prefix = storage.hlsPrefix(video.id);
      if (video.hls_dir === prefix) {
        console.log(`HLS already in S3: ${video.id}`);
        continue;
      }

      const localHlsPath = path.resolve(hlsDir, video.hls_dir || video.id);
      if (!localHlsPath.startsWith(`${hlsDir}${path.sep}`)) {
        throw new Error(`Invalid local HLS path for video ${video.id}.`);
      }
      try {
        await fs.access(path.join(localHlsPath, 'master.m3u8'));
        await storage.deletePrefix(prefix);
        await storage.uploadDirectory(localHlsPath, prefix);
        await run(db, 'UPDATE videos SET hls_dir = ? WHERE id = ?', [prefix, video.id]);
        console.log(`Copied HLS output to S3: ${video.id}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await run(
          'UPDATE videos SET status = ?, hls_dir = NULL WHERE id = ?',
          ['queued', video.id],
        );
        console.log(`Queued video for HLS regeneration: ${video.id}`);
      }
    }
  } finally {
    db.close();
  }
}

migrate().catch((error) => {
  console.error('Local media migration to S3 failed:', error);
  process.exitCode = 1;
});
