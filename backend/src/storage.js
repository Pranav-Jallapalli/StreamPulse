const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const {
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');

const bucket = process.env.S3_BUCKET;
const client = bucket
  ? new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' })
  : null;

function isS3Enabled() {
  return Boolean(bucket);
}

function originalKey(videoId, fileName) {
  return `originals/${videoId}/${path.basename(fileName)}`;
}

function hlsPrefix(videoId) {
  return `hls/${videoId}`;
}

function streamKey(prefix, relativePath) {
  const normalizedPath = relativePath.split(path.sep).join('/');
  const key = path.posix.normalize(`${prefix}/${normalizedPath}`);
  if (!key.startsWith(`${prefix}/`) || key.includes('/../')) {
    throw new Error('Invalid S3 media path.');
  }
  return key;
}

async function putFile(key, filePath, contentType) {
  if (!client) throw new Error('S3 storage is not configured.');

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentType: contentType || 'application/octet-stream',
  }));
}

async function downloadFile(key, filePath) {
  if (!client) throw new Error('S3 storage is not configured.');

  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await pipeline(response.Body, fs.createWriteStream(filePath));
}

async function headObject(key) {
  if (!client) throw new Error('S3 storage is not configured.');
  return client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}

async function getObject(key, range) {
  if (!client) throw new Error('S3 storage is not configured.');
  return client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(range ? { Range: range } : {}),
  }));
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.m3u8':
      return 'application/vnd.apple.mpegurl';
    case '.ts':
      return 'video/mp2t';
    default:
      return 'application/octet-stream';
  }
}

async function uploadDirectory(directory, prefix) {
  if (!client) throw new Error('S3 storage is not configured.');

  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await uploadDirectory(localPath, `${prefix}/${entry.name}`);
    } else if (entry.isFile()) {
      await putFile(`${prefix}/${entry.name}`, localPath, contentTypeFor(localPath));
    }
  }
}

async function deletePrefix(prefix) {
  if (!client) throw new Error('S3 storage is not configured.');

  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${prefix}/`,
      ContinuationToken: continuationToken,
    }));
    const objects = (page.Contents || []).map(({ Key }) => ({ Key }));
    if (objects.length) {
      await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects, Quiet: true },
      }));
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
}

async function deleteObject(key) {
  if (!client) throw new Error('S3 storage is not configured.');
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

module.exports = {
  contentTypeFor,
  deleteObject,
  deletePrefix,
  downloadFile,
  getObject,
  hlsPrefix,
  headObject,
  isS3Enabled,
  originalKey,
  putFile,
  streamKey,
  uploadDirectory,
};
