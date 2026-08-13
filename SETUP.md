# Local Development Environment Setup

Steps to get Iorio Reloaded running locally. Written so a second developer (or their own Claude Code) can follow it and end up with an identical setup.

If you're using Claude Code, you can just say: *"Read SETUP.md in this repo and set up my local dev environment for Iorio Reloaded, asking for permission before running each command."*

## Prerequisites assumed
- macOS with [Homebrew](https://brew.sh) installed.
- This is one of two repos: `iorio-reloaded-api` (backend, this repo) and `iorio-reloaded-app` (frontend). Clone both as sibling directories.

## 1. Node.js version (via nvm)

We use Node 24 (Active LTS, matches Heroku's current default) for this project specifically, managed via [nvm](https://github.com/nvm-sh/nvm) — **without** changing your system-wide/Homebrew Node, in case you have other projects relying on it.

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
```

Restart your terminal, then install Node 24 under nvm and point nvm's default at your existing system Node (so nothing else on your machine changes):

```sh
nvm install 24
nvm alias default system
```

Add this to the end of your `~/.zshrc` (or `~/.bashrc`) so the correct Node version auto-activates whenever you `cd` into a project with a `.nvmrc` file, and reverts when you leave:

```sh
autoload -U add-zsh-hook
load-nvmrc() {
  local nvmrc_path
  nvmrc_path="$(nvm_find_nvmrc)"

  if [ -n "$nvmrc_path" ]; then
    local nvmrc_node_version
    nvmrc_node_version=$(nvm version "$(cat "${nvmrc_path}")")

    if [ "$nvmrc_node_version" = "N/A" ]; then
      nvm install
    elif [ "$nvmrc_node_version" != "$(nvm version)" ]; then
      nvm use --silent
    fi
  elif [ -n "$(PWD=$OLDPWD nvm_find_nvmrc)" ] && [ "$(nvm version)" != "$(nvm version default)" ]; then
    echo "Reverting to nvm default version"
    nvm use default --silent
  fi
}
add-zsh-hook chpwd load-nvmrc
load-nvmrc
```

Verify: `cd` into `iorio-reloaded-api` or `iorio-reloaded-app` and run `node -v` — should show `v24.x`. `cd` back out — should revert to your normal system Node.

## 2. PostgreSQL (via Postgres.app)

Install [Postgres.app](https://postgresapp.com):

```sh
brew install --cask postgres-app
open -a Postgres
```

On first launch, it prompts to initialize a new server — **pick PostgreSQL 17** (matches Heroku Postgres's current default for new databases), then click Initialize. Runs on port 5432.

Create the databases:

```sh
PG_BIN="/Applications/Postgres.app/Contents/Versions/latest/bin"
"$PG_BIN/createdb" -h localhost -U $(whoami) iorio_reloaded_development
"$PG_BIN/createdb" -h localhost -U $(whoami) iorio_reloaded_test
```

## 3. Environment variables

Copy `.env.example` to `.env` in `iorio-reloaded-api` and fill in your local Mac username:

```sh
cp .env.example .env
```

## 4. Heroku CLI

Needed later for checking config vars/logs on the deployed apps (not for deploying — deploys happen via `git push`, and by agreement Claude does not push code).

```sh
brew tap heroku/brew && brew install heroku
```

## 5. Backend (this repo)

```sh
npm install
cp .env.example .env   # fill in your Mac username if not already done in step 3
npm run migrate:latest              # migrates iorio_reloaded_development
NODE_ENV=test npm run migrate:latest  # migrates iorio_reloaded_test
npm test                            # runs the schema round-trip smoke tests
npm run dev                         # starts the API on http://localhost:3030
```

Create a user to log in with (there's no self-service signup or password reset by design — see PROGRESS.md):

```sh
npm run manage-user -- create you@example.com "Your Name" "your-password"
```

## 6. Frontend (`iorio-reloaded-app`, sibling repo)

```sh
cd ../iorio-reloaded-app
npm install
cp .env.example .env   # points at http://localhost:3001 by default
npm run dev             # starts the app on http://localhost:3031
```

Both dev servers need to be running at once (backend on 3030, frontend on 3031) for login/auth to work — the frontend calls the backend directly via `VITE_API_BASE_URL`.

## Status
This document reflects setup as of 2026-08-12. Both repos have a working local dev setup: backend (Express + TypeScript + Knex/Postgres + session auth) and frontend (React + Vite + TypeScript + Tabler + ApexCharts + lightweight-charts), tested end-to-end including a real login flow. No Redis/caching setup yet — not needed at this stage.
