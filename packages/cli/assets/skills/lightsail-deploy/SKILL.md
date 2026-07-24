---
name: lightsail-deploy
description: Operate and debug Bonum service deploys to AWS Lightsail (notifications, reports360). Trigger: deploy, despliegue, Lightsail, dev environment, deployment failed, container canceled, ECR pull.
---

## Activation Contract

Use when deploying any Bonum service to Lightsail, creating a new Lightsail service, debugging a failed/canceled deployment, or verifying a deploy end-to-end.

## Hard Rules

- Deploys go through GitHub Actions only: push to `develop` (development) or `main` (production). No manual Lightsail deploys.
- Every NEW Lightsail service MUST have `ecrImagePullerRole` activated and its `principalArn` MERGED into the ECR repo policy — never overwrite existing statements. Without it, containers never start and logs stay empty.
- Never commit `.env`; local copies hold real credentials.
- Health checks accept success codes 200-499. A 404 on `/` is healthy.
- Docker builds use buildx with `cache-from/to: type=gha`.

## Decision Gates

| Service | ECR repo | Secrets model |
|---|---|---|
| notifications--server | `notifications` | GitHub environments `development`/`production`, same secret names, env-scoped values |
| reports-server-bonum | `reports360` | Repo-level secrets (`MONGODB_URI`, AWS keys); env split happens in `config.py` via `ENVIRONMENT` |

| Symptom | Cause / Action |
|---|---|
| `Started 1 new node` ×3 then `Canceled`, empty logs | Image pull failure → check `ecrImagePullerRole` + ECR policy (runbook) |
| Logs empty right after deploy | Lightsail log lag is minutes — wait, don't rediagnose |
| App logs errors on boot | Check env vars/secrets for that service (runbook lists them) |
| Need AWS API without local CLI | Use `curl --aws-sigv4` recipes in runbook |

## Execution Steps

1. Merge/push to the target branch; the workflow tests (where applicable), builds, pushes to ECR, and calls `create-container-service-deployment`.
2. Poll deployment state until `ACTIVE` (~5 min floor; Lightsail blue/green is not compressible).
3. Verify end-to-end per service (runbook: test email payload for notifications, report endpoint for reports360).

## Output Contract

Report deployment state (`ACTIVE`/`FAILED`), service URL, and log evidence of the service's external connections (Mongo, RabbitMQ, evaluations API).

## References

- `references/runbook.md` — per-service topology, sigv4 curl recipes, new-service checklist, secret lists, known gotchas.
