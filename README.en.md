# Cells Player

[日本語](README.md)

A browser-based player for studying and enjoying video and audio.
Add **markers** (points) and **cells** (segments), then use 3-level likes, comments, bookmarks and repeat.
It also supports learning with captions and transcripts: shadowing, dictation and a vocabulary list.

- Files are played only inside your browser and are never uploaded. Your notes are also saved in the browser ([Privacy & data](privacy.html?lang=en))
- No server-side processing: just HTML, CSS and JavaScript (no build step)
- Made for Chrome (or Edge) on a PC. Speech recognition works in Chrome

## Getting started

Open **https://pe-kun333.github.io/cells-player/?lang=en** in Chrome.
The screen is shown in English when your browser language is not Japanese. You can switch the language in Settings, or with the "English / 日本語" link on the start screen.

Drop a video or audio file onto the page, or press "Open file". You can also enter a YouTube URL and press "Open".

To install it as an app, use the install icon at the right of the address bar (or "Install as app" in the "?" screen).
It then opens in its own window and also starts offline. After installing, you can open video and caption files directly with "Open with" in Explorer.

## Basic workflow

1. While watching, press `M` to add a marker (playback does not stop). Buttons such as "−3s" add a marker a bit earlier
2. Right after that, press `1` `2` `3` to like the moment, or `C` to write a comment.
   `C` (comment pin) fixes the position when you press it, so it does not drift while you type
3. Quick comments (tags such as "Review" or "Great scene") are added with one key press: `4` to `9`.
   Edit them with the pencil button and switch between sets (e.g. for study and for watching)
4. Click a segment in the "Segments" row of the timeline to make the part between markers a cell (drag to include several segments)
5. In the sidebar, rate, write notes, comment and repeat cells. "Play list" plays the listed cells and markers in order

Press "?" at the top right for the list of keyboard shortcuts.

## Learning with captions and transcripts

- Load captions (.srt / .vtt / transcript JSON) with "Load captions", by dropping the file, or paste the text of YouTube's "Show transcript" with "Paste" (or Ctrl+V)
- "Transcribe" transcribes the playing audio live with Chrome speech recognition (PC audio must be routed into the microphone input; audio is sent to Google)
- In the "Transcript" tab (bottom right): click a line to go there, comment, edit, add to the vocabulary or delete it. Shift-click to select a range and make it a cell
- **Shadowing**: plays one line at a time and pauses so you can say it aloud
- **Dictation**: hides the captions, plays one line at a time, and checks what you type (differences are highlighted with a match score)
- **Tools**: export as .srt / .vtt / text, fix caption timing, split into cells automatically by gaps and length
- **Vocabulary**: select words in a line and press "Vocab" (or `W`) to save them with the sentence and time. Export as CSV for Anki or Excel
- Repeat options: number of loops, a pause between loops, and "Speed up" (starts at 0.7× and speeds up each loop)

For YouTube videos, captions are shown in a strip just below the player instead of over it, following YouTube's terms.

## YouTube live streams

Open the URL of a live stream (`…/watch?v=…` or `…/live/…`) to add markers, cells and comments while you watch.

- The "LIVE" button next to the time shows how far you are behind the latest part. Press it to jump back to the latest
- Everything you add during the stream is still there when you open the same URL after the stream has been archived
- If the beginning or middle was cut from the archive, the times can be off. When you open the archive, use "Align live notes with the archive": click a marker you added during the stream, move the archive to that same scene, and press "Align all" (if the middle was cut, use a marker after the cut with "From here on")
- To fix it later, use "Align live notes" next to the playback buttons (Ctrl+Z to undo)
- A channel's "Live" page URL can't be opened — open the stream itself and paste its URL. Streams that don't allow embedding can't be played

## Your data

- Notes (markers, cells, transcripts) and the vocabulary are saved automatically in the browser's storage (IndexedDB). Opening the same file again restores them (even if the file was renamed)
- Data is stored per browser and per address. Use "Export" to save important notes as JSON, and "Import" to add them back
- The app talks to external services only when you open a YouTube video and while you use speech recognition. See [privacy.html](privacy.html?lang=en)

## Running it locally

Double-click `start.bat` (requires Python). Chrome opens `http://127.0.0.1:8765/`.
Opening `index.html` directly does not work.

## License

[MIT License](LICENSE). Some icons are based on Tabler Icons (MIT License), see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
