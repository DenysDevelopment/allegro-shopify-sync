# Deploy

CI/CD via GitHub Actions: see `.github/workflows/deploy.yml`. On every push to `main` (and manual `workflow_dispatch`) the workflow runs syntax/schema checks, then SSHs to the production server and pulls + restarts PM2.

## Required GitHub Secrets

Add these in the repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret             | Required | Example                                  | Notes                                                              |
| ------------------ | :------: | ---------------------------------------- | ------------------------------------------------------------------ |
| `SSH_HOST`         |    ✓     | `1.2.3.4` or `gurulinker.example.com`    | Hostname or IP of the production server.                           |
| `SSH_USER`         |    ✓     | `deploy` or `ubuntu`                     | User on the server with access to the project directory + PM2.     |
| `SSH_PRIVATE_KEY`  |    ✓     | full private key (begin/end lines incl.) | Paste the **private** key matching an entry in `~/.ssh/authorized_keys` of `SSH_USER`. Generate a dedicated key, do not reuse a personal one. |
| `SSH_PORT`         |          | `22` (default)                           | Set only if SSH runs on a non-standard port.                       |
| `DEPLOY_PATH`      |    ✓     | `/var/www/allegro-shopify-sync`          | Absolute path to the project on the server (where `git pull` will run). |

## Server prerequisites (one-time setup)

Already done if PM2 is currently running. Otherwise on the server:

```bash
# Clone repo into DEPLOY_PATH (as the SSH_USER)
git clone https://github.com/DenysDevelopment/allegro-shopify-sync.git $DEPLOY_PATH
cd $DEPLOY_PATH

# Install runtime
nvm install 20  # or apt install nodejs (>=20)
npm ci --omit=dev
npm i -g pm2

# Configure
cp .env.example .env  # fill in real secrets

# First start
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup  # follow printed instructions to enable boot-time autostart
```

The deployed app must be able to read/write `data/` and `logs/` (already created on demand by the app).

## What the workflow does on each push

1. **check** job — `npm ci`, `node --check` on every JS file outside `node_modules`, and applies `db/schema.sql` to an in-memory sqlite to catch DDL errors before they reach prod.
2. **deploy** job (only if check passes and ref is `main`):
   - `git pull --ff-only origin main` — fails loudly if the server has drifted.
   - `npm ci --omit=dev` — exact install per `package-lock.json`.
   - `pm2 reload ecosystem.config.js --update-env` — zero-downtime restart, picks up new `.env`. Falls back to `pm2 start` if the app isn't registered yet.
   - `pm2 save` — persists current process list.
   - `npm run register-webhooks` — idempotent (skips already-registered topics). Non-fatal: deploy succeeds even if it fails (e.g., Shopify rate-limit).

## Manual rollback

```bash
ssh $SSH_USER@$SSH_HOST
cd $DEPLOY_PATH
git log --oneline -10                  # find previous good SHA
git reset --hard <sha>
npm ci --omit=dev
pm2 reload ecosystem.config.js --update-env
```

## First deploy after adding CI

1. Add the five secrets in GitHub.
2. Push to `main` — the workflow will trigger automatically. Or use **Actions → Deploy → Run workflow** to trigger manually.
3. Watch the run in the Actions tab. The deploy job streams the SSH script output.
