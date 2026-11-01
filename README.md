# FigBridge server

Small relay between the FigBridge Figma plugin and the FigBridge Roblox Studio plugin.
Figma uploads a design and gets a 6-character code; Studio downloads it with that code.

- No dependencies. Needs Node.js 18 or newer. Start with `npm start`.
- Runs in hosted mode automatically on Render (or set `HOSTED=1`).

## Privacy
- No accounts, no database. Designs are kept in memory only and deleted after 6 hours or when the server restarts.
- Nothing is written to disk and design names are not logged.
- Uploads are limited per IP address, and wrong codes are rate limited.

## Settings (optional environment variables)
`PORT`, `MAX_BODY_MB` (default 30), `MAX_TOTAL_MB` (default 300), `HOSTED`.
