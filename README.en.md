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
   `C` (comment pin) fixes the position when you press it, so it does not drift while you type.
   Later, press 💬 or "No comment" on a row in "Nearby markers" (under "This moment") to write a comment on a liked or bookmarked marker (the playhead does not move)
3. Quick comments (tags such as "Review" or "Great scene") are added with one key press: `4` to `9`.
   Edit them with the pencil button and switch between sets (e.g. for study and for watching)
4. Click a segment in the "Segments" row of the timeline to open a menu: "Make a cell", "Play from here", "Make a cell and repeat" and more (drag to select several segments).
   Clicking a marker on the timeline ("Full" and "Zoom" rows) or a cell ("Cells" row) also opens a menu. The playhead doesn't move, so while watching you can like, bookmark, comment on, nudge (±1 s, ±0.1 s) or delete other markers, make the segment to their left or right a cell, and like or repeat cells.
   Choose what a click does for each kind with "On click" at the bottom of the menu (for example "Make a cell right away" for segments or "Go to that marker" for markers, as before). Right-click always opens the menu.
   "Make cell" (Enter) makes the current segment a cell, and "Make left cell" (Shift+Enter) makes the segment to the left of the marker you just added (previous marker to that marker) a cell.
   Turn on "When you add a marker, make the segment to its left a cell" in Settings to do this automatically each time you add a marker.
   "Even cells" in the right sidebar splits the whole video into cells of the same length, such as every 30 seconds or every minute (the short leftover at the end can join the previous cell; Ctrl+Z undoes them all at once).
   After a big jump from a card or the timeline, press "Back to 0:12" next to the play buttons or Backspace to return to where you were (Shift+Backspace to go forward again).
   Press S inside a cell (or "Split" on the card of the cell being played) to split it in two at the playhead. The note, likes, bookmark and comments stay with the earlier cell, and the later part becomes a new cell
   - You can also split at a clicked point with "Split here" in a cell's timeline menu, or Shift+click on the Cells, Full or Zoom row (holding Shift shows ✂ and the time where it will split)
   - With subtitles loaded, the split snaps to the break between subtitle lines within 1 second (can be turned off in Settings)
   - Where two cells touch, a handle appears at the top of the Zoom row. Drag it to move the end of the earlier cell and the start of the later cell together; click it to nudge by ±0.1 s or ±1 s, snap to a subtitle break, or join the cells
   The "current cell" bar right under the timeline lets you split, set the start or end at the playhead (the boundary with a neighboring cell moves too), repeat, like, bookmark and comment on the cell at the playhead. When cells overlap, "1/2 ⇄" switches which one you work on, and S splits that one
   Press Ctrl+K (or 🔍 at the top right) to open the action list, find an action by typing and run it right away
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

## Now card (top of the right sidebar)

The actions for the scene you are watching are gathered in the "now card" at the top of the right sidebar, so the mouse can stay on the right.

- Top row: play, −5 s, +5 s, back to where you were, time, fold
- Current cell: its range and note (click to edit in place), the latest comment, a strip inside the cell (click to go there, Shift+click to split), start/end at the playhead, repeat, like, bookmark, and "Split" at the right end
- This moment: marker, marker a bit earlier, likes, bookmark, quick comments
- Comment: write it, then press "To this moment" (a marker) or "To this cell". Enter sends it to this cell and Shift+Enter to this moment. It is pinned to the time you started writing
  - Playback pauses while you write only if you turn on the ⏸ button next to the box (or the setting); normally it keeps playing
- Turn on "Fold the now card automatically when you scroll the list" in Settings to fold it while you browse the list; it unfolds when you scroll back to the top
- The moment comment and transcript list moves to the left column (under the video)
- "Where the actions go" in Settings switches back to "This moment" on the left (the previous layout)

## Two subtitles (Japanese and English side by side)

After loading subtitles, load another set (a translation, for example) to show two lines together.

- When subtitles are already loaded and you load, drop or paste another file, choose "Show side by side as the second subtitles" or "Replace the current subtitles". You can also load them from "Second subtitles" in Settings
- Next to the "Captions" button, choose "Both (Japanese on top)", "Both (English on top)", "Japanese only" or "English only" (the language is guessed from the subtitle text)
- The second subtitles are a little smaller and in a different color. They also appear under each line in a cell's "Transcript" and in the "Transcript" list at the bottom right
- Practice (shadowing and dictation), cell transcripts and subtitle editing use the first subtitles. To use the other one, press "Swap with the first" in Settings

## Library (all your videos and search)

"Library" at the top (or the L key) lists every video and audio file you have notes for.

- Type in the search box to search the cell notes, comments, quick comments, captions (transcripts) and vocabulary of all videos at once (separate words with spaces to match all of them)
- Narrow down to "Cells", "Comments", "Captions" or "Words". "Liked or bookmarked only" lists your favorite scenes across all videos
- Click a result to open that video, jump to the scene and show its cell or marker card (for files on your computer, open the same file to jump there)

## Playlist (play across videos)

The right side of the Library is the playlist. Line up cells and markers from different videos in any order and play them one after another (a highlight reel, for example).

- Add: press + on a search result in the Library, or "Add all cells and markers in the results to the playlist". You can also use the "Add to playlist" button on a cell card (for markers, inside the opened details)
  - Turn on "Liked or bookmarked only" and press "Add all" to add your favorite scenes from every video at once
- Reorder: drag (or Alt+↑↓). "Group by video" puts items from the same video next to each other (fewer video switches)
- Play: "Play from the start", or click a row to start there. The sidebar bar shows "Playlist 3 / 12" with previous, next, repeat and stop
- YouTube and URL videos are opened automatically. The browser can't open files on your computer by itself, so playback stops there; open the same file with "Open file" to continue
- Videos that can't be opened (embedding not allowed, deleted, etc.) are skipped. If a video doesn't start, a hint appears: press ▶ to play it, or "Next" to skip it
- YouTube may show an ad when the video switches
- Save to file: give the playlist a name and press "Save to file" to save it as `name.playlist.json`. Load it with "Load from file" (or "Import" at the top, or by dropping the file) to use it again
  - If there is already a list, you can choose "Replace it" or "Add to the end". Keep several playlists as files and switch between them
  - The file also holds a copy of each item's range, note and video title, so the YouTube items play on another PC or browser too

## Share links (share on X and elsewhere)

For YouTube videos (and online videos), you can make a link that contains your cells and comments and share it.

- Press "Share" at the top, choose your display name, what to include (cells and notes, markers, comments, quick comments, likes), the range and where viewers start, then press "Copy link" or "Post on X" (X only opens the post screen; you do the posting)
- People who open the link play the same video from YouTube with your cells and comments, shown in color as your shared notes. They are kept separate from their own notes
- Shared notes can be viewed, jumped to and repeated, but not edited. Likes and comments go to the viewer's own marker at that time
- In "Shared notes" at the top of the sidebar, you can show or hide each person, "Add to mine" to make them your own, or "Remove" them (Ctrl+Z to undo)
- The notes are stored in the link itself (after the # in the address), so no server is used. A link is a snapshot — make a new one after adding notes
- Files on your computer can't be shared, because viewers don't have the same file

## YouTube live streams

Open the URL of a live stream (`…/watch?v=…` or `…/live/…`) to add markers, cells and comments while you watch.

- The "LIVE" button next to the time shows how far you are behind the latest part. Press it to jump back to the latest
- During a live stream, the YouTube live chat is shown on the left (YouTube's own chat embed). If you are signed in to YouTube in this browser, you can post with your own account. Turn it off with "Chat" or in Settings. If it doesn't show or you can't post, "Pop out" opens the chat on YouTube
- The strip under the chat lets you write for the chat and X. Save the stream's hashtags (per video); "View on X" opens the latest posts with those hashtags on X in a tall window at the left edge of the screen (X pages can't be embedded in the app). Write in the box and choose where to send it — your text is also saved as a moment comment marked with where it went (YT / X), and Enter uses the last destination
  - "Copy for chat" copies the text (it isn't sent automatically); click the chat input box on the left and press Ctrl+V, then Enter (the app can't type into the embedded YouTube chat directly, for browser security)
  - "To X" opens X's post screen with your text and hashtags in a small window (you do the posting)
  - "Both" does both at once. Turn on "Link" to add a link to the video at that time when sending to X
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
