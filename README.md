# aside-telegram-bridge

Text your [Aside](https://aside.so) browser agent from your phone.

Your full Aside agent -- tools, memory, everything -- living in a Telegram
chat. Ask it things, send it photos, give it multi-step tasks, watch live
progress fold into a tidy collapsible worklog when it's done.

## Install (2 minutes)

Open Terminal and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/SaiAmartya/aside-telegram-bridge/main/install.sh | bash
```

The setup wizard walks you through the rest:

1. It asks for a bot token -- message [@BotFather](https://t.me/botfather)
   in Telegram, send `/newbot`, copy the token it gives you.
2. You text your new bot once -- the wizard detects you automatically.
3. Pick a reply style. Done. The bridge installs itself as a background
   service and your bot answers from then on, even after reboots.

No dependencies, no pip installs, no webhooks, no ports. Plain Python that
ships with macOS, talking outbound to Telegram only.

Requirements: a Mac with [Aside](https://aside.so) installed, and a
Telegram account.

## What it feels like

```
you:   what's on my plate today
aside: Three things: the 7pm walkthrough with Josh, SAT prep at
       9:30, and that email from Vercel you've been ignoring.

you:   handle the email
aside: On it.
       ⏳ working · 45s · 3 steps      <- one live status line
aside: Drafted a reply. Want to see it before I send?
```

- Replies come as short chat bubbles, plain text, no markdown walls.
- Long tasks: one ack, one live status line (elapsed time + current step),
  then the result. When it finishes, the status line collapses into a
  tap-to-expand worklog of everything it did.
- Subagents get their own live roster inside that status line: each
  spawned subagent shows as a row (running/done/failed, elapsed time,
  and a one-line snippet of its result once it finishes), so parallel
  or background research doesn't just disappear into a generic
  "subagent_wait" tool call. The full history (spawn -> wait -> result
  per subagent) is preserved in the tap-to-expand worklog too.
- Send a photo and the agent opens and looks at it.
- Messages sent mid-task queue politely and run next.

## Chat commands

| command | what it does |
|---|---|
| `/status` | model, session, busy/idle, queue (instant, even mid-task) |
| `/model sonnet\|fable\|opus` | switch model |
| `/effort` | pick thinking effort for the next message (inline buttons: off, minimal, low, medium, high, xhigh, ultrabrowse -- same levels as the aside browser) |
| `/effort <level>` | set it directly without the button menu |
| `/usage` | Claude subscription usage + context-window fill + cost |
| `/new` | fresh persona-primed session |
| `/sessions` | list recent Aside sessions, tap a button to switch into one |

## Managing it

Setup links a `bridgemon` command into `~/bin`:

- `bridgemon watch` -- live timeline of everything the bridge and agent do,
  plus a one-key kill switch.
- `bridgemon update` -- pull the latest version, syntax-check, restart, and
  auto-rollback if anything looks broken.
- `bridgemon status` / `logs` / `rollback` -- the rest.

To stop everything: `bridgemon watch --kill`.

## Security, the short version

- Your bot token is a credential. `config.json` is chmod 600 and gitignored.
- Hard allowlist: the bridge ignores every Telegram chat except yours.
  Strangers get silence.
- Bridge sessions run with full tool access so the agent can actually do
  things unattended -- understand what that means on your machine. Switch
  the grant to `guard` in `bridge.py` if you want confirmation-gated
  behavior.
- Kill switch always works, and messages sent while the bridge is down are
  recovered on restart.

<details>
<summary><b>Architecture</b> (for the curious)</summary>

```
Telegram  <--long poll-->  bridge.py (launchd daemon)  <--aside CLI-->  Aside agent
                            |  poller thread: getUpdates, commands, photos
                            |  worker thread: one turn at a time, batching
                            |  TurnStream: ack / status-fold / final routing
                            +--reads replies from the session's messages.jsonl
```

Three layers:

1. **Bridge daemon** (`bridge.py`): long-polls the Telegram Bot API
   (outbound only), shells out to the `aside` CLI, reads replies from the
   session transcript, streams them back as bubbles.
2. **Persona layer**: a persistent Aside session primed with a texting-mode
   persona (auto-created on first run, re-created via `/new`). Full agent,
   adapted voice.
3. **Proactive layer** (optional): an Aside routine that pushes a morning
   digest or alerts into the same chat via the Bot API. Prompt sketch: pull
   calendar + important unread email, read token/chat_id from
   `config.json`, POST 2-4 short plain-text messages to `sendMessage`,
   never print the token.

The reply source of truth is the session's `messages.jsonl`, not CLI
stdout, which stays clean when turns involve tool calls and thinking.

</details>

<details>
<summary><b>Status folding</b> (how the worklog collapse works)</summary>

Telegram can't collapse "thought for 4 mins" like a native UI, so the
bridge approximates it: narration and tool-call titles go into one
notification-silent message edited in place (elapsed timer + step count +
latest note). When the turn ends, that message is edited into a collapsed
`<blockquote expandable>` containing the full timestamped worklog -- tap
to expand, ignore otherwise. Chat history keeps: ack → questions/blockers
→ folded worklog → result. Anything that genuinely needs you (a decision,
an approval, a blocker) escapes the fold and pings for real.

</details>

<details>
<summary><b>Design limits</b> (read before filing issues)</summary>

- **No mid-turn steering.** Messages sent while the agent is working queue
  and run as the next turn; they never redirect the current one. We tested
  every path to real steering: the `aside` CLI silently drops prompts sent
  to a busy session, and Aside's daemon contains a full native Telegram
  channel system with a real steering queue -- but its delivery path
  doesn't call `steer()` yet and drops mid-turn messages. Until that
  ships, queueing is the honest behavior. (We ran the native system in
  production for an evening and reverted.)
- **Serial by design.** One turn at a time; adjacent messages batch.
- **macOS only** as written (launchd, Aside's file layout). The Telegram
  and transcript logic is portable if someone wants to PR Linux support.
- `/usage` reads Anthropic's OAuth usage endpoint via the claude-code
  token Aside stores locally; on other providers that section silently
  degrades and the rest still works.

</details>

<details>
<summary><b>Manual setup</b> (if you'd rather not pipe curl to bash)</summary>

```bash
git clone https://github.com/SaiAmartya/aside-telegram-bridge
cd aside-telegram-bridge
python3 setup.py
```

The wizard is the same either way. Fully manual (no wizard): copy
`config.example.json` to `config.json`, fill in `token` / `chat_id` /
`owner_name`, chmod 600 it, then install
`com.aside.telegram-bridge.plist` into `~/Library/LaunchAgents` with the
paths corrected, and `launchctl bootstrap gui/$(id -u) <plist>`.

Style: `config.json`'s `"style"` is `"formal"` (default) or `"casual"`;
you can fully override with your own `"persona_prompt"` / `"style_tag"`.
Persona changes take effect on the next `/new` since it's baked in at
session creation. `default_effort` (default `high`) sets the thinking
effort every normal turn runs at; use `/effort` in chat to bump a single
upcoming turn to any level (off through ultrabrowse).

</details>

<details>
<summary><b>Files</b></summary>

| file | purpose |
|---|---|
| `install.sh` | the one-line installer (clone/update + run wizard) |
| `setup.py` | interactive setup wizard |
| `bridge.py` | the daemon (poller + worker + streaming) |
| `bridgemon.py` | deploy/update/rollback CLI + `watch` |
| `monitor.py` | live monitor + kill switch (via `bridgemon watch`) |
| `config.example.json` | reference config |
| `com.aside.telegram-bridge.plist` | launchd template (manual installs) |

</details>

## Credits

Designed, built, tested, and documented by an Aside agent, working as a
digital co-founder for [@SaiAmartya](https://github.com/SaiAmartya), who had
the good ideas, caught the UX regressions, and made the executive calls.
