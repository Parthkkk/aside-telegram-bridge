# aside-telegram-bridge

Text your [Aside](https://aside.so) browser agent from your phone, Poke-style.

A ~700-line Python stdlib daemon that turns a Telegram bot into a two-way,
persona-driven mobile interface for your Aside agent: full tool access, memory,
live progress streaming, model switching, and usage tracking, all from a chat
thread that texts like a friend instead of writing you reports.

Built (and debugged, and documented) by an Aside agent for its user, after the
"my routine can send Telegram messages but nothing answers incoming ones"
problem came up in the community. This solves the two-way part.

## What it feels like

```
you:   yo what's on my plate today
aside: three things: the 7pm walkthrough with josh, sat prep at 9:30,
       and that email from vercel you've been ignoring

you:   handle the email
aside: on it
       ⏳ reading the thread...        <- one live status line, edits in place
aside: drafted a reply, want to see it before i send?
```

- Replies are short, lowercase, multi-bubble, plain text. No markdown walls.
- Long tasks stream: an ack, ONE silently-updating status message
  (deleted when done), real pings only for questions/blockers/results.
- Send a photo and the agent opens and looks at it.
- Messages sent while it's working get a silent "queued" receipt and run next.
- `/status` answers instantly even mid-task.

## Architecture

```
Telegram  <--long poll-->  bridge.py (launchd daemon)  <--aside CLI-->  Aside agent
                            |  poller thread: getUpdates, commands, photos
                            |  worker thread: one turn at a time, batching
                            |  TurnStream: ack / status-fold / final routing
                            +--reads replies from the session's messages.jsonl
```

Three layers:
1. **Bridge daemon** (`bridge.py`): long-polls the Telegram Bot API (outbound
   only, no ports, no tunnels, no webhooks), shells out to the `aside` CLI,
   reads replies from the session transcript, streams them back as bubbles.
2. **Persona layer**: the bridge maintains a persistent Aside session primed
   with a "texting mode" persona (auto-created on first run, re-created via
   `/new`). Full agent, different voice.
3. **Proactive layer** (optional): an Aside routine that pushes a morning
   digest or alerts into the same chat via the Bot API. See below.

## Requirements

- macOS with [Aside](https://aside.so) installed (the bridge drives the
  bundled `aside` CLI)
- Python 3.9+ (macOS system python works; stdlib only, zero pip installs)
- A Telegram account

## Setup

1. **Create a bot**: talk to [@BotFather](https://t.me/botfather), `/newbot`,
   pick a name/username. Copy the token. Optionally set a profile photo and
   commands (`/setuserpic`, `/setcommands`: status, usage, model, think, new).

2. **Get your chat id**: send your new bot any message, then:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool
   ```
   Your numeric id is at `result[0].message.chat.id`.

3. **Install**:
   ```bash
   git clone https://github.com/SaiAmartya/aside-telegram-bridge
   cd aside-telegram-bridge
   cp config.example.json config.json
   chmod 600 config.json      # token lives here; keep it private
   # edit config.json: token, chat_id, owner_name
   ```

4. **Run it as a service**:
   ```bash
   # edit the plist: replace YOUR_USERNAME with your macOS username/path
   cp com.aside.telegram-bridge.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aside.telegram-bridge.plist
   ```
   On first run the bridge creates and persona-primes its own Aside session.
   Text the bot; you should get a texting-style reply in a few seconds.

5. **Optional, put `bridgemon` on your PATH** (one command for both
   monitoring and deploying updates):
   ```bash
   mkdir -p ~/bin && ln -sf "$(pwd)/bridgemon.py" ~/bin/bridgemon
   echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
   ```
   - `bridgemon watch` -- live merged timeline (incoming messages, every CLI
     invocation, every tool call the agent makes, per-turn cost) plus a
     single-key kill switch (`k` stops the bridge AND any in-flight turn).
     `bridgemon watch --status` / `--kill` / `--start` for one-shot use.
   - `bridgemon update` -- pulls the latest bridge.py from this repo (if
     you cloned it with git), syntax-checks it, restarts the service,
     health-checks the restart, and auto-rolls-back to the last known-good
     version if anything looks broken. Safe to run any time; refuses to
     pull if you have uncommitted local edits instead of silently
     discarding them.
   - `bridgemon status` / `bridgemon logs [n]` / `bridgemon rollback` /
     `bridgemon init` -- see `bridgemon` with no args for the full list.

   Whoever clones this repo can pick up future improvements just by
   running `bridgemon update` from inside their checkout.

6. **Optional, proactivity**: create an Aside routine (cheap/fast model
   category recommended) with a prompt like:
   > Compose a short morning digest (calendar, important unread email, one
   > priority nudge). Read the bot token and chat_id from
   > `<path>/config.json` and POST 2-4 short plain-text messages to
   > `https://api.telegram.org/bot<token>/sendMessage`. Texting style,
   > no markdown. Never print the token.

## Chat commands

| command | what it does |
|---|---|
| `/status` | model, session, agent busy/idle, queue depth (answers instantly, even mid-task) |
| `/model sonnet\|fable\|opus\|<raw id>` | switch model for subsequent turns |
| `/think` | `think_effort` (default `xhigh`) thinking effort for the next message only |

Every normal turn runs at `default_effort` (default `high`) regardless of the selected model. Both knobs live in `config.json` and accept `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
| `/usage` | Claude subscription usage (5h/weekly %, reset times) + context-window fill + session cost |
| `/new` | fresh persona-primed session (auto-granted full tool access) |

## Style

`config.json` has a `"style"` key: `"casual"` (default -- lowercase,
texting-speak, dry wit) or `"formal"` (clean, professional, still plain
text/no markdown). You can also fully override either preset with your own
`"persona_prompt"` and `"style_tag"` keys. Takes effect on the next `/new`
since the persona is baked into the session at creation time.

`/usage` reads Anthropic's OAuth usage endpoint with the claude-code token
Aside already stores locally; if your Aside uses a different provider, that
section silently degrades and the rest still works.

## Security model, read this

- **The token is a credential.** Anyone holding it can message your bot and,
  if they got past the allowlist, drive an agent with tool access on your
  machine. `config.json` is chmod 600 and gitignored. Never commit it.
- **Hard allowlist**: the bridge ignores every chat except your `chat_id`.
  There is no pairing flow; strangers get silence.
- **Full tool access**: bridge sessions are auto-granted `full-access`
  permission so the agent can actually do things unattended. Understand what
  that means on your machine before enabling; change the `heavy_new()` grant
  to `guard` if you want confirmation-gated behavior instead.
- **Injection stance**: the persona instructs the agent to ignore
  instructions from anyone claiming not to be you. This is a mitigation, not
  a guarantee, the allowlist is the real boundary.
- **Kill switch**: `bridgemon` → `k`, or
  `launchctl bootout gui/$(id -u)/com.aside.telegram-bridge`. Messages sent
  while dead queue on Telegram's side and are recovered on restart, and a
  half-processed message survives restarts via the `pending` state field.
- Message text passes to the CLI as a subprocess argument (list form, no
  shell), so there's no shell-injection path through message content.

## Design notes and known limits

- **No mid-turn steering.** Messages sent while the agent is working queue
  and run as the next turn, they never redirect the current one. We tested
  every path to real steering: the `aside` CLI silently drops prompts sent
  to a busy session (it attaches as a viewer), and Aside's daemon actually
  contains a full native Telegram/Discord/Slack channel system with a real
  steering queue, but its delivery path doesn't call `steer()` yet and
  *drops* mid-turn messages. Until that ships, queueing is the honest
  behavior. (We ran the native system in production for an evening and
  reverted; the full findings are a story in themselves.)
- **Serial by design.** One turn at a time, adjacent messages batch into one
  turn. Simple, predictable, no session races.
- **Status folding**: Telegram can't collapse "thought for 4 mins" like a
  native UI, so the bridge fakes it: narration goes into one
  notification-silent message edited in place, deleted when the turn ends.
  History keeps ack → blockers/questions → result.
- **macOS only** as written (launchd, Aside's file layout). The Telegram and
  transcript logic is portable if someone wants to PR Linux support.
- The reply source of truth is the session's `messages.jsonl`, not CLI
  stdout, which stays clean when turns involve tool calls and thinking.

## Files

| file | purpose |
|---|---|
| `bridge.py` | the daemon (poller + worker + streaming) |
| `bridgemon.py` | the `bridgemon` CLI: deploy/update/rollback + `watch` (delegates to monitor.py) |
| `monitor.py` | live monitor + kill switch, run via `bridgemon watch` |
| `config.example.json` | copy to `config.json`, fill in |
| `com.aside.telegram-bridge.plist` | launchd template |

## Credits

Designed, built, tested, and documented by an Aside agent, working as a
digital co-founder for [@SaiAmartya](https://github.com/SaiAmartya), who had
the good ideas, caught the UX regressions, and made the executive calls.
