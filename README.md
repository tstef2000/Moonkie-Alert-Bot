# Moonkie-Alert-Bot

Consent-based Discord alert bot using slash commands.

## Features

- Admin-only `/alert <role> <message> [show_sender]` command
- Sends DMs only to members who have the selected role
- Supports sender visibility toggle (initiating admin or generic server attribution)
- Per-guild cooldown timer for `/alert`
- Per-DM delay to reduce rate-limit pressure
- Automatic 429 retry/backoff using Discord `retry_after`
- Posts channel start/completion messages tagging the admin who executed the command (including ETA and total duration)

## Requirements

- Node.js 18+
- A Discord Bot application with:
  - **Bot** permissions in your server
  - **Server Members Intent** enabled in the Developer Portal

## Setup

1. Install dependencies:

	```bash
	npm install
	```

2. Copy env template and fill values:

	```bash
	cp .env.example .env
	```

3. Run the bot:

	```bash
	npm start
	```

## Quick Start (End-to-End)

1. Go to Discord Developer Portal and create/select your application.
2. Under **Bot**:
	- Reset/copy token to `DISCORD_TOKEN`
	- Enable **Server Members Intent**
3. Under **OAuth2 > URL Generator**:
	- Scopes: `bot`, `applications.commands`
	- Bot permissions: `Administrator` (or at minimum `Send Messages`, `Use Application Commands`, `Read Message History`, `View Channels`)
4. Invite bot to your test server using generated URL.
5. Fill `.env` values and run:

	```bash
	npm start
	```

6. In Discord, run:

	```text
	/alert role:@YourRole message:Your message show_sender:true
	```

## Environment Variables

- `DISCORD_TOKEN` - Bot token
- `CLIENT_ID` - Application (bot) client ID
- `ALERT_COOLDOWN_SECONDS` - Cooldown between `/alert` runs in the same guild (default: `300`)
- `DM_DELAY_MS` - Delay between each DM (default: `1200`)
- `RATE_LIMIT_MAX_RETRIES` - Max retries when Discord returns HTTP 429 (default: `5`)
- `RATE_LIMIT_BUFFER_MS` - Extra wait added to `retry_after` (default: `250`)

## Notes

- This bot is intended for consent-based messaging/testing.
- Self-bot (user-account automation) usage is not supported.
- Discord API rate limits are still enforced platform-wide; this bot uses pacing and a cooldown to help avoid spikes.
