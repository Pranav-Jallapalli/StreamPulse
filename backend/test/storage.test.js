const { test } = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../src/storage');

test('S3 media keys are scoped to each video and reject traversal', () => {
  assert.equal(storage.originalKey('video-id', 'sample.mp4'), 'originals/video-id/sample.mp4');
  assert.equal(storage.hlsPrefix('video-id'), 'hls/video-id');
  assert.equal(storage.streamKey('hls/video-id', '480p/segment-00000.ts'), 'hls/video-id/480p/segment-00000.ts');
  assert.throws(
    () => storage.streamKey('hls/video-id', '../../originals/other-video/source.mp4'),
    /Invalid S3 media path/,
  );
});
