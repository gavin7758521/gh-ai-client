# gh-ai-client

Small Node.js CLI for AI-assisted GitHub management. The current focus is managing starred repositories and GitHub-native Star Lists.

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

ghac lists sync
ghac lists list
ghac lists show "AI Tools"
ghac lists create "AI Tools"
ghac lists create "AI Tools" --description "AI projects and agents" --private
ghac lists add "AI Tools" openai/codex
ghac lists add "AI Tools" openai/codex --create
ghac lists remove "AI Tools" openai/codex

ghac collections list
ghac collections show AI
ghac collections create AI
ghac collections add AI owner/repo
ghac collections remove AI owner/repo
ghac collections export collections.json
ghac collections import collections.json
ghac collections import collections.json --replace

ghac ai
ghac ai plan "帮我把 AI agent 相关仓库整理到 AI-智能体"
ghac ai apply-plan

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
  lists.json
  collections.json
  ai-plan.json
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

## GitHub Star Lists

`ghac stars` uses GitHub REST for starred repositories. `ghac lists` uses GitHub GraphQL `UserList` APIs for GitHub-native Star Lists:

```bash
ghac lists sync
ghac lists list
ghac lists add "AI Tools" openai/codex
```

`lists add` preserves the repository's existing Star List memberships. By default it also stars the repository first if it is not already starred.

`collections` is a local legacy workspace. Use `lists` when you want changes written to GitHub.

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
ghac ai
```

`codex login` uses pi's OpenAI Codex OAuth flow and stores credentials locally in `~/.ghac/pi-auth.json`. `model use codex` selects the recommended OpenAI Codex model exposed by pi, such as `openai-codex/gpt-5.3-codex-spark` when available.

## Suggested workflow

```bash
ghac proxy set http://127.0.0.1:7890
ghac auth set-token
ghac stars sync
ghac lists sync
ghac codex login
ghac model use codex
ghac ai
```

Inside `ghac ai`, natural language produces a GitHub Star Lists plan and asks before applying write actions. Slash commands call concrete GitHub operations:

```text
/help
/model current
/stars sync
/lists list
/lists add "AI Tools" openai/codex
/plan 帮我整理最近 star 的 RAG 仓库
/apply
/exit
```

The older `ai suggest/review/apply` commands still work on local `collections`.

## Secret scanning

This project uses Gitleaks for local secret checks:

```bash
npm run secrets
npm run secrets:dir
npm run secrets:staged
npm run precommit
```

`npm run precommit` scans the staged diff for secrets and then runs the test suite.
