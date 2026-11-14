# AWS deployment

The application can store original uploads and HLS renditions in a private S3 bucket when `S3_BUCKET` and `AWS_REGION` are configured. The current EC2 deployment still uses SQLite for account/video metadata and a local SQLite-backed worker queue. Those local services are suitable only for a single-instance MVP, not a durable or horizontally scalable production setup.

Current deployment: the EC2 app runs in Sydney (`ap-southeast-2`) and is configured to use the private bucket `streampulse-media-prana-20261111-sydney`. HTTP access is enabled for this temporary project demo; do not use real or reused passwords until HTTPS is configured. The EC2 database currently contains no video rows, so there was no existing media to migrate from that instance. Local development data is not automatically copied to EC2.

## Suggested AWS architecture

- React frontend: private S3 origin behind CloudFront
- API: an EC2 instance or container service, with the API and worker deployed as separate processes
- Original uploads and HLS outputs: private S3 bucket (implemented; API proxies media through authenticated routes)
- Metadata: a managed database such as PostgreSQL
- Transcoding jobs: a durable queue such as SQS (or Redis/BullMQ) with a worker service
- Secrets: AWS Secrets Manager or Systems Manager Parameter Store

The S3 storage adapter is implemented. Metadata database and durable queue migration remain future work. Keep the bucket private and grant access to the EC2 instance with a narrowly scoped IAM role; do not put IAM access keys on the instance.

To migrate an existing EC2 deployment, configure the instance role and bucket first, install the updated app, set `S3_BUCKET` and `AWS_REGION` in `backend/.env`, and run `npm run migrate:media-to-s3 --prefix backend` before restarting the API and worker. The migration copies existing originals and ready HLS renditions without deleting their local copies. New originals and HLS outputs are then stored in S3; upload chunks and temporary transcode files remain on EC2 disk.

## Free tier and credits

AWS free-tier eligibility, included quotas, and credits vary by account, region, and signup date. Video uploads, transcoding CPU time, stored originals and HLS segments, CloudFront requests, and internet egress can consume credits or incur charges. Check the AWS Billing console and create a budget alert before provisioning resources. A free-tier EC2 instance alone does not make video storage or delivery free.

## Before deployment

1. Configure a new AWS CLI profile locally. Never place access keys in source files or chat.
2. Confirm account identity with `aws sts get-caller-identity`.
3. Choose a region and check current free-tier/credit eligibility and service pricing.
4. Create a private S3 bucket with public access blocked and attach a least-privilege S3 policy to the EC2 instance role.
5. Generate a unique `JWT_SECRET` and store it in AWS Secrets Manager or Parameter Store.
6. Configure the frontend's `VITE_API_URL` to the deployed API origin.
7. Configure HTTPS, CORS allowlists, restricted security groups, IAM least privilege, backups, logs, and a billing alert.
8. Deploy storage, database, queue, API, worker, then frontend; verify signup, chunk upload, transcode status, and HLS playback.

No AWS resources are created by the local development or Docker commands.
