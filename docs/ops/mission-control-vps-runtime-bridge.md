# Mission Control VPS Runtime Bridge Notes

This captures the working setup for EllaVPS so future changes can repeat the same path without rediscovering it.

## Public URL and proxy

- Use `https://37.27.203.209.nip.io` for Mission Control. Telenor Nettvern blocked the earlier `sslip.io` hostname by DNS/CNAME interception.
- Caddy terminates TLS and proxies:
  - `/api/v1/*` to `127.0.0.1:8000`
  - `/api/gateway*` to the OpenClaw gateway on `127.0.0.1:18789`
  - everything else to the frontend on `127.0.0.1:3000`
- Docker ports for backend/frontend/db/redis are bound to loopback only.

## Runtime chat

- `/cli-chat` is the runtime console.
- `OpenClaw Agent` sends plain board-chat messages with `chat` tags only, so board leads and OpenClaw control commands receive them.
- `ChatGPT 5.5` and `Codex 5.3` send board-chat messages with Codex bridge tags. The host-side systemd bridge picks them up and runs Codex CLI through the existing `~/.codex` OAuth/subscription auth.
- `Claude Code` sends `claude-cli-request` messages. The same host bridge runs `/home/clawd/.npm-global/bin/claude --print` through the existing Claude Code subscription auth. No Anthropic API key is copied into Docker.
- The web UI polls every 3 seconds, but polling only reads backend chat rows. Subscription quota is consumed only when a new bridge request is actually sent to Codex/Claude/OpenClaw.

## Images and speech

- The console accepts image URLs and pasted screenshots. Pasted screenshots are stored in board chat as Markdown data URLs.
- The Codex bridge extracts Markdown images into temporary files and passes them to Codex CLI with `--image` where possible.
- Browser speech-to-text uses the Web Speech API from the user's browser, with `Alt+1` / `1 Norsk` for `nb-NO` and `Alt+2` / `2 English` for `en-US`. This is not an OpenAI or Anthropic API call.

## Gateway pairing

- OpenClaw gateway disconnects after some restarts/domain changes when Mission Control backend needs a new device pairing approval.
- A user systemd timer runs `/home/clawd/.local/bin/openclaw-auto-approve-gateway-client.py` every minute.
- The script approves only pending requests that match `clientId=gateway-client`, `clientMode=backend`, platform `linux`, and expected operator scopes.

## Skills marketplace

- The host timer `mission-control-skill-sync.timer` syncs skill packs every 6 hours.
- Manual sync is still available from the Mission Control UI.

## Auth

- Mission Control local auth still accepts the long `LOCAL_AUTH_TOKEN`.
- It also accepts an optional SHA-256 password hash from `LOCAL_AUTH_PASSWORD_SHA256`, so the user can log in with a memorable password without changing the token fallback.
