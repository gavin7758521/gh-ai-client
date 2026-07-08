# gh-ai-client

Small Node.js CLI for AI-assisted GitHub management. The first version only manages starred repositories and local collections.

## Install locally

```bash
cd ~/workspace/repos/gh-ai-client
npm install
npm link
```

After linking, use the installed command:

```bash
ghac help
```

## Commands

```bash
ghac help
ghac help stars

ghac auth set-token
ghac auth status
ghac auth clear-token

ghac proxy set http://127.0.0.1:7890
ghac proxy set --http http://127.0.0.1:7890 --https http://127.0.0.1:7890 --no-proxy localhost,127.0.0.1
ghac proxy status
ghac proxy clear

ghac codex login
ghac codex status
ghac codex logout

ghac model list
ghac model list codex
ghac model list pi openai
ghac model list local
ghac model use codex
ghac model use pi:openai/gpt-4o-mini
ghac model use openai-compatible:env
ghac model current
ghac model test

ghac stars sync
ghac stars list --limit 20
ghac stars search agent

ghac collections list
ghac collections show AI
ghac collections create AI
ghac collections add AI owner/repo
ghac collections remove AI owner/repo
ghac collections export collections.json
ghac collections import collections.json
ghac collections import collections.json --replace

ghac ai suggest
ghac ai status
ghac ai step
ghac ai step --apply
ghac ai skip
ghac ai review
ghac ai apply
ghac ai clear

ghac data path
ghac data doctor
```

## Data

Data is stored in:

```text
~/.ghac/
  config.json
  stars.json
  collections.json
  suggestions.json
  history.jsonl
```

Set `GHAC_HOME` to use a different directory for tests. `GH_AI_CLIENT_HOME` is still accepted as a legacy override.

## Proxy

If GitHub, OpenAI, or pi requests need a local proxy, configure it before login or sync:

```bash
ghac proxy set http://127.0.0.1:7890
ghac proxy status
ghac codex login
```

The short `proxy set <url>` form sets both `HTTP_PROXY` and `HTTPS_PROXY`. `proxy status` redacts credentials in proxy URLs, but the local config file stores the proxy URL you enter.

## GitHub Star API boundary

GitHub REST supports listing, starring, unstarring, and checking starred repositories. GitHub's web Star Lists do not have a clearly documented stable write API in the REST starring docs, so this CLI starts with local collections.

## AI providers

`mock` works offline and groups by repo metadata. It is hidden from the default model list; use `ghac model list local` if you need the offline fallback.

`openai-compatible` uses these environment variables:

```bash
OPENAI_COMPATIBLE_BASE_URL=https://your-model-host/v1
OPENAI_COMPATIBLE_API_KEY=...
OPENAI_COMPATIBLE_MODEL=...
```

`pi` uses `@earendil-works/pi-ai`:

```bash
ghac codex login
ghac model list pi
ghac model list pi anthropic --limit 10
ghac model list codex
ghac model use codex
ghac model use pi:openai/gpt-4o-mini
ghac ai suggest
```

`codex login` uses pi's OpenAI Codex OAuth flow and stores credentials locally in `~/.ghac/pi-auth.json`. `model use codex` selects the recommended OpenAI Codex model exposed by pi, such as `openai-codex/gpt-5.3-codex-spark` when available.

## Suggested workflow

```bash
ghac proxy set http://127.0.0.1:7890
ghac auth set-token
ghac stars sync
ghac codex login
ghac model use codex
ghac ai suggest
ghac ai review
```

Use `ai review` when you want to approve or skip one model-generated action at a time. Use `ai step --apply` when you want to apply only the next pending action from a script.

## Secret scanning

This project uses Gitleaks for local secret checks:

```bash
npm run secrets
npm run secrets:dir
npm run secrets:staged
npm run precommit
```

`npm run precommit` scans the staged diff for secrets and then runs the test suite.
