# Lightsail Deploy Runbook — Bonum services

Learned 2026-07-22/23 while bringing up the dev environments.

## Shared topology

- AWS account `762614731979`, region `us-east-1` for ECR and Lightsail.
- ECR registry: `762614731979.dkr.ecr.us-east-1.amazonaws.com`.
- MongoDB Atlas: single shared cluster; env separation is per database, not per cluster.
- RabbitMQ: single shared broker `amqp://3.144.196.4` (notifications only).

## Per-service topology

### notifications--server (Node)

- ECR repo `notifications`; tags `notifications-dev-<sha>` (dev) / `notifications-<sha>` (prod).
- Dev: Lightsail `notifications-server-dev` (nano/512MB), URL `https://notifications-server-dev.tclik5ai2vodi.us-east-1.cs.amazonlightsail.com/`. Prod: `container-service-1` (small/1GB). Port 3002.
- Workflows: `develop.yml` + `main.yml` (near-clones; differ in branch, GitHub environment, service name).
- Queues `correos` (prod) / `correos_dev` (dev, hardcoded `EMAIL_QUEUE` in develop.yml). Queue is `durable: false`.
- Secrets in GitHub environments `development`/`production`: `AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ONE_SIGNAL_REST_API_KEY, ONE_SIGNAL_API_URL, ONE_SIGNAL_APP_ID, EMAIL_PASSWORD, EMAIL_USER, EMAIL_FROM, SMTP_USER, SMTP_PASS, MONGO_USER, MONGO_PASSWORD, MONGO_DATABASE, MONGO_CLUSTER, NEXUS_API_URL` (+ `PORT`). Bulk upload: `gh secret set -f .env.dev --env development --repo bonumtech1/notifications--server`.
- `RABBITMQ_URL` intentionally absent in dev → falls back to shared prod broker with the `correos_dev` queue.

### reports-server-bonum (Python/Flask)

- ECR repo `reports360`; tags `reports360v1` (prod) / `reports360-dev` (dev) — fixed tags, not per-sha.
- Prod: Lightsail `container-reports360`. Dev: `container-reports360-dev` (nano). Port 8000.
- Single workflow `deploy.yml` triggers on `main` AND `develop`; branch derives `DEPLOY_ENV`, `IMAGE_TAG`, `SERVICE_NAME` at job level.
- Secrets at REPO level (no GitHub environments by design): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `MONGODB_URI`. Same Atlas URI both envs; `config.py` picks DB by `ENVIRONMENT`: production → `bonum_production` with fallback `bonum`; development → `bonum` only, plus dev evaluations URL.
- Tests (`test_config.py`, `test_report_helpers.py`) gate the build; missing `MONGODB_URI` = intentional crashloop (fail-fast).
- Health check path `/`, success codes 200-499.

## New Lightsail service checklist

1. Create the container service (console or API), region us-east-1.
2. Activate ECR pull access:
   ```
   UpdateContainerService {"serviceName":"<svc>","privateRegistryAccess":{"ecrImagePullerRole":{"isActive":true}}}
   ```
   Service goes `UPDATING`/`PROVISIONING_SERVICE` for a few minutes; `principalArn` is empty until it finishes. Poll `GetContainerServices`.
3. MERGE the new `principalArn` into the ECR repo policy as a new statement (`Sid: AllowLightsailPull-<svc>`, actions `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`). Fetch the existing policy first and append — never clobber (other services' statements live there).
4. Ensure the secrets exist where that service expects them (GitHub environment for notifications, repo level for reports360).
5. Push to the trigger branch or `gh run rerun <run-id>`.

## AWS API without local CLI (curl sigv4)

Keys come from local `.env` (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).

```bash
# Lightsail (JSON-RPC): GetContainerServices, GetContainerLog,
# GetContainerServiceDeployments, UpdateContainerService
curl -s "https://lightsail.us-east-1.amazonaws.com/" \
  -H "X-Amz-Target: Lightsail_20161128.<Operation>" \
  -H "Content-Type: application/x-amz-json-1.1" \
  -d '{"serviceName":"<service-name>"}' \
  --aws-sigv4 "aws:amz:us-east-1:lightsail" --user "$KEY:$SECRET"

# ECR: GetRepositoryPolicy / SetRepositoryPolicy
curl -s "https://api.ecr.us-east-1.amazonaws.com/" \
  -H "X-Amz-Target: AmazonEC2ContainerRegistry_V20150921.<Operation>" \
  -H "Content-Type: application/x-amz-json-1.1" \
  -d '{"repositoryName":"<ecr-repo>"}' \
  --aws-sigv4 "aws:amz:us-east-1:ecr" --user "$KEY:$SECRET"
```

`GetContainerLog` needs `serviceName` AND `containerName` (for notifications both equal the service name; for reports360 the container is `reports360-container`).

## Failure signatures

- **`Started 1 new node` ×3 → `Canceled`, zero app log lines**: the container never ran — image pull failure. Check `ecrImagePullerRole.isActive` and the ECR policy statement.
- **Container logs lag several minutes** behind reality; a "Get logs" step right after deploy always prints `logEvents: []` (misleading, not broken — removed from workflows).
- **`nano` power (dev) = 512MB**: if the app OOMs or restarts under load, bump to `small` like prod.

## End-to-end verification

### notifications: test email

Publish to the dev queue with the project's own `amqplib` (payload hits `treatTypes` default case → straight to `sendEmail`; `checking_in` only needs `coacheeName`):

```js
const payload = {
  emails: ["<recipient>"],
  subject: "Dev environment test - correos_dev",
  mailTemplate: "checking_in", // BARE template name — sendEmail appends _<language> itself (checking_in_es would resolve to checking_in_es/checking_in_es_es.hbs and ENOENT)
  clientTheme: "bonum",
  language: "es",
  type: null,
  context: { coacheeName: "Ricardo" },
};
// ch.assertQueue("correos_dev", { durable: false }); ch.sendToQueue(...)
```

Then confirm `📨 MENSAJE RECIBIDO!` / `email to send` in container logs (mind the lag).

### reports360: boot + report

Container must NOT be in crashloop (crashloop right after deploy = missing `MONGODB_URI`). Hit `/` (404 is healthy) and generate a report against a known dev evaluation to confirm Mongo + evaluations API connectivity.

## Gotchas

- Repos live under a personal account (`bonumtech1`): collaborators cannot get admin; only the owner manages environments/secrets. Environments on private personal repos require GitHub Pro.
- Lightsail has no Secrets Manager integration; container env vars are visible in plaintext to anyone with read access to the service. Keep IAM scoped.
- Time floor: ~5 min of Lightsail blue/green (`ACTIVATING`) that no workflow change can reduce.
