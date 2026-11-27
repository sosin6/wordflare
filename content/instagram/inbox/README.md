# Instagram inbox

Finished videos made by the local "Editor IA" (Claude Code on the owner's computer) land here:

- `AAAA-MM-DD-<topic>.mp4` (1080x1920, 30 fps, H.264 + AAC, no music: Instagram adds trending music at publish time)
- `AAAA-MM-DD-<topic>.json` with `type`, `caption`, `music`, `video_volume`, `music_volume`, `notes`
- optional `AAAA-MM-DD-<topic>-story.mp4|jpg` (1080x1920)

Every Monday the weekly run moves them to `public/social/ig/<week>/`, adds them to
`content/instagram/queue.json` with `approved: false`, shows them to the owner and, after the OK,
sets `approved: true`. Nothing in this folder is published directly.
