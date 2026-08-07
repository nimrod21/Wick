# LLM provider setup

No API keys ship with Wick — register on each provider's free tier, then
store keys in the encrypted vault (below). All providers are optional; the
router simply skips providers without a key.

## Signup URLs (free tiers)

| Provider | Get a key at | Notes |
|---|---|---|
| OpenRouter | https://openrouter.ai/keys | pick a current `:free` model |
| Groq | https://console.groq.com/keys | generous daily free quota |
| Gemini (AI Studio) | https://aistudio.google.com/apikey | limits vary by model |
| Mistral | https://console.mistral.ai/api-keys | enable the free "Experiment" plan |
| Cerebras | https://cloud.cerebras.ai | key under "API Keys" |
| Ollama (optional) | https://ollama.com/download | local, no key — `ollama pull llama3.2` then it just works |

## Storing keys

From the repo root (server must have booted at least once so
`WICK_MASTER_KEY` exists in `.env`):

```
pnpm keys set llm.openrouter.key sk-or-v1-...
pnpm keys set llm.groq.key gsk_...
pnpm keys set llm.gemini.key AIza...
pnpm keys set llm.mistral.key ...
pnpm keys set llm.cerebras.key csk-...
pnpm keys list          # masked overview
```

Keys are AES-GCM-encrypted into the `settings` table (`apikey.<provider>`
rows) — the same vault the Settings page will use later. Ollama needs no key.

## Verify model IDs (they rot!)

Free-tier model names change every few months (PLAN §16.4). Before first
use, check each provider's model list and update the `providers.registry`
setting (models/rpm/rpd are DATA in the settings table, not code):

- OpenRouter: https://openrouter.ai/models?max_price=0 — pick a `:free` id
- Groq: https://console.groq.com/docs/models
- Gemini: https://ai.google.dev/gemini-api/docs/models
- Mistral: https://docs.mistral.ai/getting-started/models/
- Cerebras: https://inference-docs.cerebras.ai/introduction

A wrong/retired model id is handled like a 429 (router falls through to the
next provider), so a stale registry degrades gracefully — but fix it anyway.

## Smoke test

```
pnpm ask --dry --symbol BTCUSDT     # rendered prompt only, no LLM call
pnpm ask --symbol BTCUSDT           # routed decision from first available provider
pnpm ask --symbol BTCUSDT --provider groq
pnpm ask --symbol BTCUSDT --provider stub   # deterministic offline path
```
