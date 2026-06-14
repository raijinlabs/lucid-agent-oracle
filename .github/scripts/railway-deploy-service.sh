#!/usr/bin/env bash
set -euo pipefail

service="${1:?Usage: railway-deploy-service.sh <service>}"
project_id="${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID is required}"
environment_id="${RAILWAY_ENVIRONMENT_ID:?RAILWAY_ENVIRONMENT_ID is required}"

message="${RAILWAY_DEPLOY_MESSAGE:-github:${GITHUB_SHA:-local}}"

echo "Deploying ${service} to Railway production"
railway link \
  --project "${project_id}" \
  --environment "${environment_id}" \
  --service "${service}" \
  --json >/tmp/railway-link.json

railway up . \
  --detach \
  --service "${service}" \
  --message "${message}"

echo "Waiting for ${service} to become healthy"
for attempt in $(seq 1 80); do
  status_json="$(railway service status --json --environment "${environment_id}" --service "${service}" 2>/dev/null || true)"
  status="$(printf '%s' "${status_json}" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(s).status||'UNKNOWN')}catch{console.log('UNKNOWN')}})")"
  echo "Attempt ${attempt}: ${service}=${status}"
  case "${status}" in
    SUCCESS) exit 0 ;;
    FAILED|CRASHED|REMOVED) echo "${status_json}"; exit 1 ;;
  esac
  sleep 10
done

echo "Timed out waiting for ${service}"
railway logs --environment "${environment_id}" --service "${service}" --latest --lines 120 || true
exit 1
