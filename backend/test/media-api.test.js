const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const net = require('net');
const { once } = require('events');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ffmpegPath = require('ffmpeg-static');
const storage = require('../src/storage');

const backendDir = path.resolve(__dirname, '..');

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

async function getAvailablePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpegProcess = spawn(global.process.env.FFMPEG_PATH || ffmpegPath, args, { windowsHide: true });
    let output = '';
    ffmpegProcess.stderr.on('data', (data) => { output = `${output}${data}`.slice(-4000); });
    ffmpegProcess.once('error', reject);
    ffmpegProcess.once('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`FFmpeg exited with code ${code}: ${output}`));
    });
  });
}

test('signup, chunked upload, background HLS transcode, and authenticated playback', {
  timeout: 120_000,
}, async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'streampulse-test-'));
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    PORT: String(port),
    JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
    DATA_DIR: path.join(temporaryDirectory, 'data'),
    UPLOAD_DIR: path.join(temporaryDirectory, 'uploads'),
    CORS_ORIGINS: 'http://localhost:5173',
  };
  const apiProcess = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const workerProcess = spawn(process.execPath, ['src/worker.js'], {
    cwd: backendDir,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let processOutput = '';
  apiProcess.stdout.on('data', (data) => { processOutput = `${processOutput}${data}`.slice(-8000); });
  apiProcess.stderr.on('data', (data) => { processOutput = `${processOutput}${data}`.slice(-8000); });
  workerProcess.stdout.on('data', (data) => { processOutput = `${processOutput}${data}`.slice(-8000); });
  workerProcess.stderr.on('data', (data) => { processOutput = `${processOutput}${data}`.slice(-8000); });
  const testVideoIds = [];

  t.after(async () => {
    await Promise.all([
      stopChild(apiProcess),
      stopChild(workerProcess),
    ]);
    if (storage.isS3Enabled() && testVideoIds.length) {
      for (const videoId of testVideoIds) {
        try {
          await storage.deleteObject(storage.originalKey(videoId, `${videoId}.mp4`));
        } catch (error) {
          throw new Error(`Could not clean test original for ${videoId}: ${error.message}`);
        }
        try {
          await storage.deletePrefix(storage.hlsPrefix(videoId));
        } catch (error) {
          throw new Error(`Could not clean test HLS for ${videoId}: ${error.message}`);
        }
      }
    }
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  let health;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (apiProcess.exitCode !== null) {
      throw new Error(`API exited before becoming ready:\n${processOutput}`);
    }

    try {
      health = await fetch(`${baseUrl}/health`);
      if (health.ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert.equal(health?.status, 200, `API did not start:\n${processOutput}`);

  const unauthorized = await fetch(`${baseUrl}/api/videos`);
  assert.equal(unauthorized.status, 401);

  const signup = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'StreamPulse Test',
      email: 'stream@example.test',
      password: 'a-secure-test-password',
    }),
  });
  assert.equal(signup.status, 201);
  const { token } = await signup.json();
  const authorization = { Authorization: `Bearer ${token}` };

  const secondSignup = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Second Test User',
      email: 'second@example.test',
      password: 'another-secure-test-password',
    }),
  });
  assert.equal(secondSignup.status, 201);
  const { token: secondToken } = await secondSignup.json();
  const secondAuthorization = { Authorization: `Bearer ${secondToken}` };

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'stream@example.test',
      password: 'a-secure-test-password',
    }),
  });
  assert.equal(login.status, 200);

  const sourcePath = path.join(temporaryDirectory, 'sample.mp4');
  await runFfmpeg([
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=1920x1080:rate=24',
    '-t', '1',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    sourcePath,
  ]);
  const source = await fs.readFile(sourcePath);

  const init = await fetch(`${baseUrl}/api/videos/uploads/init`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Test stream',
      description: 'HLS integration test',
      fileName: 'sample.mp4',
      fileSize: source.length,
      mimeType: 'video/mp4',
    }),
  });
  assert.equal(init.status, 201);
  const { uploadId, totalChunks } = await init.json();
  testVideoIds.push(uploadId);

  const prematureComplete = await fetch(`${baseUrl}/api/videos/uploads/${uploadId}/complete`, {
    method: 'POST',
    headers: authorization,
  });
  assert.equal(prematureComplete.status, 409);

  for (let index = 0; index < totalChunks; index += 1) {
    const form = new FormData();
    const start = index * 5 * 1024 * 1024;
    const chunk = source.subarray(start, Math.min(start + 5 * 1024 * 1024, source.length));
    form.append('chunk', new Blob([chunk]), `chunk-${index}`);
    const response = await fetch(`${baseUrl}/api/videos/uploads/${uploadId}/chunks/${index}`, {
      method: 'PUT',
      headers: authorization,
      body: form,
    });
    assert.equal(response.status, 204);
  }

  const complete = await fetch(`${baseUrl}/api/videos/uploads/${uploadId}/complete`, {
    method: 'POST',
    headers: authorization,
  });
  assert.equal(complete.status, 202);

  let video;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/videos/${uploadId}`, { headers: authorization });
    video = await response.json();
    if (video.status === 'ready' || video.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(video.status, 'ready', `Transcoding did not finish:\n${processOutput}`);
  assert.match(video.file_url, /master\.m3u8$/);
  assert.equal(video.views_count, 0);
  assert.equal(video.likes_count, 0);
  assert.equal(video.liked_by_user, false);

  const unauthenticatedComments = await fetch(`${baseUrl}/api/videos/${uploadId}/comments`);
  assert.equal(unauthenticatedComments.status, 401);

  const emptyComments = await fetch(`${baseUrl}/api/videos/${uploadId}/comments`, {
    headers: authorization,
  });
  assert.equal(emptyComments.status, 200);
  assert.deepEqual(await emptyComments.json(), []);

  const emptyComment = await fetch(`${baseUrl}/api/videos/${uploadId}/comments`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: '   ' }),
  });
  assert.equal(emptyComment.status, 400);

  const oversizedComment = await fetch(`${baseUrl}/api/videos/${uploadId}/comments`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'x'.repeat(1001) }),
  });
  assert.equal(oversizedComment.status, 400);

  const postComment = (headers, body) => fetch(`${baseUrl}/api/videos/${uploadId}/comments`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  const firstCommentResponse = await postComment(authorization, '  Great video!  ');
  assert.equal(firstCommentResponse.status, 201);
  const firstComment = await firstCommentResponse.json();
  assert.equal(firstComment.body, 'Great video!');
  assert.equal(firstComment.author_name, 'StreamPulse Test');
  assert.ok(firstComment.id);

  const secondCommentResponse = await postComment(secondAuthorization, 'Thanks for sharing.');
  assert.equal(secondCommentResponse.status, 201);
  assert.equal((await secondCommentResponse.json()).author_name, 'Second Test User');

  const commentsResponse = await fetch(`${baseUrl}/api/videos/${uploadId}/comments`, {
    headers: authorization,
  });
  const comments = await commentsResponse.json();
  assert.equal(comments.length, 2);
  assert.equal(comments[0].body, 'Thanks for sharing.');
  assert.equal(comments[1].body, 'Great video!');

  const invalidLike = await fetch(`${baseUrl}/api/videos/${uploadId}/like`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ liked: 'yes' }),
  });
  assert.equal(invalidLike.status, 400);

  const like = await fetch(`${baseUrl}/api/videos/${uploadId}/like`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ liked: true }),
  });
  assert.equal(like.status, 200);
  assert.deepEqual(await like.json(), { liked_by_user: true, likes_count: 1 });

  const repeatedLike = await fetch(`${baseUrl}/api/videos/${uploadId}/like`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ liked: true }),
  });
  assert.deepEqual(await repeatedLike.json(), { liked_by_user: true, likes_count: 1 });

  const secondUserLike = await fetch(`${baseUrl}/api/videos/${uploadId}/like`, {
    method: 'POST',
    headers: { ...secondAuthorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ liked: true }),
  });
  assert.deepEqual(await secondUserLike.json(), { liked_by_user: true, likes_count: 2 });

  const currentUserVideo = await fetch(`${baseUrl}/api/videos/${uploadId}`, {
    headers: authorization,
  });
  const currentUserVideoData = await currentUserVideo.json();
  assert.equal(currentUserVideoData.likes_count, 2);
  assert.equal(currentUserVideoData.liked_by_user, true);

  const secondUserVideo = await fetch(`${baseUrl}/api/videos/${uploadId}`, {
    headers: secondAuthorization,
  });
  assert.equal((await secondUserVideo.json()).liked_by_user, true);

  const unlike = await fetch(`${baseUrl}/api/videos/${uploadId}/like`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ liked: false }),
  });
  assert.deepEqual(await unlike.json(), { liked_by_user: false, likes_count: 1 });

  const recordView = () => fetch(`${baseUrl}/api/videos/${uploadId}/view`, {
    method: 'POST',
    headers: authorization,
  });
  const firstView = await recordView();
  assert.deepEqual(await firstView.json(), { views_count: 1 });
  const secondView = await recordView();
  assert.deepEqual(await secondView.json(), { views_count: 2 });

  const videos = await fetch(`${baseUrl}/api/videos`, { headers: authorization });
  const [listedVideo] = await videos.json();
  assert.equal(listedVideo.likes_count, 1);
  assert.equal(listedVideo.liked_by_user, false);
  assert.equal(listedVideo.views_count, 2);

  const master = await fetch(`${baseUrl}${video.file_url}`, { headers: authorization });
  assert.equal(master.status, 200);
  assert.equal(master.headers.get('cache-control'), 'private, no-store');
  assert.equal(master.headers.get('etag'), null);
  const masterText = await master.text();
  assert.match(masterText, /480p\/index\.m3u8/);
  assert.match(masterText, /720p\/index\.m3u8/);
  assert.match(masterText, /1080p\/index\.m3u8/);

  const cachedMaster = await fetch(`${baseUrl}${video.file_url}`, {
    headers: { ...authorization, 'If-None-Match': '"stale-playlist"' },
  });
  assert.equal(cachedMaster.status, 200);

  const segmentPath = `/api/stream/${uploadId}/480p/segment-00000.ts`;
  const segment = await fetch(`${baseUrl}${segmentPath}`, { headers: authorization });
  assert.equal(segment.status, 200);
  assert.equal(segment.headers.get('cache-control'), 'private, no-store');
  assert.equal(segment.headers.get('etag'), null);

  const cachedSegment = await fetch(`${baseUrl}${segmentPath}`, {
    headers: { ...authorization, 'If-Modified-Since': new Date().toUTCString() },
  });
  assert.equal(cachedSegment.status, 200);

  const lowQualitySegment = path.join(temporaryDirectory, 'segment-00000.ts');
  await fs.writeFile(lowQualitySegment, Buffer.from(await segment.arrayBuffer()));
  const segmentInfo = await runFfmpeg([
    '-hide_banner',
    '-i', lowQualitySegment,
    '-frames:v', '1',
    '-f', 'null',
    '-',
  ]);
  assert.match(segmentInfo, /854x480/, '16:9 sources should produce even 480p dimensions');

  const ticketResponse = await fetch(`${baseUrl}/api/videos/${uploadId}/stream-ticket`, {
    headers: authorization,
  });
  assert.equal(ticketResponse.status, 200);
  const { ticket } = await ticketResponse.json();
  const unauthorizedSource = await fetch(`${baseUrl}/api/source/${uploadId}`);
  assert.equal(unauthorizedSource.status, 401);

  const sourceResponse = await fetch(`${baseUrl}/api/source/${uploadId}?ticket=${ticket}`);
  assert.equal(sourceResponse.status, 200);
  assert.equal(sourceResponse.headers.get('content-type'), 'video/mp4');
  assert.equal(Number(sourceResponse.headers.get('content-length')), source.length);

  const sourceRange = await fetch(`${baseUrl}/api/source/${uploadId}?ticket=${ticket}`, {
    headers: { Range: 'bytes=0-31' },
  });
  assert.equal(sourceRange.status, 206);
  assert.equal((await sourceRange.arrayBuffer()).byteLength, 32);

  const ticketPlaylist = await fetch(`${baseUrl}${video.file_url}?ticket=${ticket}`);
  assert.equal(ticketPlaylist.status, 200);
  assert.match(await ticketPlaylist.text(), /ticket=/);
  assert.equal(processOutput.includes(ticket), false, 'stream ticket leaked into API logs');

  const multiChunkSize = 5 * 1024 * 1024 + 1;
  const multiChunkInit = await fetch(`${baseUrl}/api/videos/uploads/init`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Multi-chunk test',
      fileName: 'multi-chunk.mp4',
      fileSize: multiChunkSize,
      mimeType: 'video/mp4',
    }),
  });
  assert.equal(multiChunkInit.status, 201);
  const { uploadId: multiChunkId, totalChunks: multiChunkCount } = await multiChunkInit.json();
  testVideoIds.push(multiChunkId);
  assert.equal(multiChunkCount, 2);

  for (const [index, bytes] of [
    [0, Buffer.alloc(5 * 1024 * 1024, 1)],
    [1, Buffer.from([2])],
  ]) {
    const form = new FormData();
    form.append('chunk', new Blob([bytes]), `chunk-${index}`);
    const response = await fetch(
      `${baseUrl}/api/videos/uploads/${multiChunkId}/chunks/${index}`,
      { method: 'PUT', headers: authorization, body: form },
    );
    assert.equal(response.status, 204);
  }

  const multiChunkComplete = await fetch(
    `${baseUrl}/api/videos/uploads/${multiChunkId}/complete`,
    { method: 'POST', headers: authorization },
  );
  assert.equal(multiChunkComplete.status, 202);

  let multiChunkVideo;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/videos/${multiChunkId}`, { headers: authorization });
    multiChunkVideo = await response.json();
    if (multiChunkVideo.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(multiChunkVideo.status, 'failed');
  if (storage.isS3Enabled()) {
    const storedOriginal = await storage.headObject(
      storage.originalKey(multiChunkId, `${multiChunkId}.mp4`),
    );
    assert.equal(storedOriginal.ContentLength, multiChunkSize);
  } else {
    const assembledFile = path.join(
      temporaryDirectory,
      'uploads',
      'originals',
      `${multiChunkId}.mp4`,
    );
    assert.equal((await fs.stat(assembledFile)).size, multiChunkSize);
  }

  const retry = await fetch(`${baseUrl}/api/videos/${multiChunkId}/retry`, {
    method: 'POST',
    headers: authorization,
  });
  assert.equal(retry.status, 202);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/videos/${multiChunkId}`, { headers: authorization });
    multiChunkVideo = await response.json();
    if (multiChunkVideo.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(multiChunkVideo.status, 'failed');
});
