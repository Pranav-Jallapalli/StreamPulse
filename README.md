# StreamPulse

StreamPulse is a video upload and adaptive-streaming MVP built with React, Express, SQLite, and FFmpeg.

## Features

- Account signup and login with bcrypt password hashing and expiring JWT sessions
- Authenticated video library and playback
- Per-user video likes with live like counts
- View counts recorded when video playback starts
- Authenticated comments with author names and timestamps
- Resumable-by-chunk upload transport using 5 MiB chunks (maximum file size: 2 GiB)
- Separate background worker that converts uploads to 480p, 720p, and 1080p HLS renditions
- HLS.js playback with automatic quality selection
- SQLite metadata and local persistent media storage by default
- Optional private S3 storage for original uploads and generated HLS renditions

## Run locally

Install dependencies:

```powershell
npm install
npm install --prefix backend
npm install --prefix frontend
```

Create `backend/.env` using `backend/.env.example` and set `JWT_SECRET` to a unique random value of at least 32 characters. The project already has a local development `.env`; do not commit it.

Start the API, worker, and frontend:

```powershell
npm run dev
```

Open http://localhost:5173. The API health check is at http://localhost:5000/health. Create an account on the signup page; passwords must be at least eight characters.

## Docker

Copy `.env.example` to `.env`, replace `JWT_SECRET` with a generated secret, then run:

```powershell
docker compose up --build
```

The API and worker share the SQLite database and media volumes. Run the Vite frontend separately with `npm run dev --prefix frontend`.

To use S3 storage, set `AWS_REGION` and `S3_BUCKET` in `backend/.env`, and provide AWS credentials through an attached EC2 instance role, an AWS CLI profile for local development, or another supported SDK credential provider. Never put access keys in source or environment files. The bucket remains private; video playback is proxied through the authenticated API.

The backend uses the bundled FFmpeg binary by default. Set `FFMPEG_PATH` to an installed FFmpeg executable when a deployment requires a platform-specific system binary.

## Local processing limits

The SQLite-backed worker queue is intended for a single-machine MVP. It processes one transcode job at a time; FFmpeg is bundled with the backend dependency. For a multi-instance AWS deployment, replace local media storage with S3 and the local queue with a durable managed queue, and move metadata to a managed database.

See [AWS_DEPLOYMENT.md](./AWS_DEPLOYMENT.md) for deployment prerequisites and cost notes.
