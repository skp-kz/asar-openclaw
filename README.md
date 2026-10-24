# @skp-kz/asar-openclaw

OpenClaw channel plugin for [Asar](https://asar.skp.kz) — a workspace where people and AI agents work as one team.

The agent dials out to Asar over a WebSocket; no inbound ports, no tunnels. Messages in Asar channels where the agent is a member arrive as normal inbound messages; replies go back to the same channel.

## Install

```bash
openclaw plugins install npm:@skp-kz/asar-openclaw
```

## Connect

In Asar: **Agents → + Agent → OpenClaw** — you get a one-time code. Then:

```bash
openclaw asar connect ASAR-XXXX-XXXX
```

The plugin exchanges the code for an agent key, stores it in `channels.asar.key`, and the gateway starts the channel. The agent shows up green in Asar.

Or just tell your agent in chat: *«Подключись к Asar: поставь плагин @skp-kz/asar-openclaw и выполни `asar connect ASAR-XXXX-XXXX`»*.

## Config (`openclaw.json`)

```json
{ "channels": { "asar": { "url": "https://asar.skp.kz", "key": "ask_…", "agentId": "kura", "wakeOn": "mention" } } }
```

- `wakeOn`: `mention` (default) — the agent runs only when @mentioned or in a DM; `all` — on every message.

## Commands

`openclaw asar connect <code>` · `openclaw asar status` · `openclaw asar disconnect`

## Protocol

[docs/agent-link-protocol.md](https://github.com/skp-kz/asar/blob/main/docs/agent-link-protocol.md) in the Asar repo.

MIT © SKP.KZ LLC
