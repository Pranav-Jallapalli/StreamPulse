const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');
const ffmpegBinary = process.env.FFMPEG_PATH || ffmpegPath;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegBinary, args, { windowsHide: true });
    let errorOutput = '';

    process.stderr.on('data', (data) => {
      errorOutput = `${errorOutput}${data}`.slice(-8000);
    });

    process.once('error', reject);
    process.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`FFmpeg exited with code ${code}: ${errorOutput}`));
    });
  });
}

async function transcodeToHls(sourcePath, destination) {
  const variants = [
    { name: '480p', width: 854, height: 480, bandwidth: 800000 },
    { name: '720p', width: 1280, height: 720, bandwidth: 1800000 },
    { name: '1080p', width: 1920, height: 1080, bandwidth: 3500000 },
  ];

  await fs.promises.rm(destination, { recursive: true, force: true });
  await fs.promises.mkdir(destination, { recursive: true });

  for (const variant of variants) {
    const variantDir = path.join(destination, variant.name);
    await fs.promises.mkdir(variantDir, { recursive: true });

    await runFfmpeg([
      '-y',
      '-i', sourcePath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', `scale=${variant.width}:${variant.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${variant.width}:${variant.height}:(ow-iw)/2:(oh-ih)/2`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-hls_time', '4',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(variantDir, 'segment-%05d.ts'),
      '-f', 'hls',
      path.join(variantDir, 'index.m3u8'),
    ]);
  }

  const masterPlaylist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    ...variants.flatMap((variant) => [
      `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.width}x${variant.height}`,
      `${variant.name}/index.m3u8`,
    ]),
    '',
  ].join('\n');

  await fs.promises.writeFile(path.join(destination, 'master.m3u8'), masterPlaylist);
}

module.exports = { transcodeToHls };
