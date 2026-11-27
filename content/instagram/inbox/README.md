# Instagram inbox

Finished videos made by the local "Editor IA" (Claude Code on the owner's computer) land here:

- `AAAA-MM-DD-<topic>.mp4` (1080x1920, 30 fps, H.264 + AAC). Since 27/11 the editor mixes royalty-free music into the file itself.
- `AAAA-MM-DD-<topic>.json` with `type`, `caption`, `music`, `video_volume`, `music_volume`, `notes`
- optional `AAAA-MM-DD-<topic>-story.mp4|jpg` (1080x1920)

If the .json says `"music": "none"` (or has no music field) the queue item gets NO `music` field, so Instagram adds nothing on top.
Only a .json with `"music": "trending"` keeps Instagram library music.

Every Monday the weekly run moves them to `public/social/ig/<week>/`, adds them to
`content/instagram/queue.json` with `approved: false`, shows them to the owner and, after the OK,
sets `approved: true`. Nothing in this folder is published directly.
