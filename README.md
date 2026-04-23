# Mission Control

Dashboard for openclaw — oppgaver, kalender og chat med Claude/Codex.

## URL

**https://37-27-203-209.sslip.io/mission-control/**

Let's Encrypt-sertifikat via [sslip.io](https://sslip.io). Fornyes automatisk av Caddy.

## Tilgang

Passordet finnes i `/home/clawd/mission-control-creds.txt` — slett filen etter at du har lagret passordet et trygt sted.

## Arkitektur

```
Browser (HTTPS/WSS)
    │
    ▼
Caddy :443  (37-27-203-209.sslip.io)
    ├── /mission-control/  →  statiske filer
    ├── /api/gateway       →  ws://localhost:18789  (openclaw gateway)
    └── /                  →  openclaw canvas
```

## Tjenester

| Tjeneste | Port | Styres av |
|----------|------|-----------|
| Caddy HTTPS | 443 | `systemctl --user start caddy-mc` |
| Openclaw gateway | 18789 (loopback) | openclaw |
| Openclaw canvas | 3000 | python3 http.server |

## Chat-modeller

Velg modell øverst i chat-panelet:
- **Codex (gpt-5.4)** — standard
- **Claude (Opus 4.7)** — alternativ

Begge rutes via openclaw gateway på `localhost:18789`.

## Caddy-kommandoer

```bash
systemctl --user status caddy-mc   # status
systemctl --user restart caddy-mc  # restart
tail -f ~/caddy.log                # logg
```
