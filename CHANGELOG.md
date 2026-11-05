# Changelog

## Unreleased

* **A stream no longer opens black when IINA has the video track disabled.** `vid` is a global
  mpv option, and IINA saves it (with `aid`) into the URL's watch-later file and applies it again
  before a file starts. IINA's yt-dlp plugin then resolves `bestaudio/best` (it checks
  `options/vid`), so the window plays audio only — a black picture with no explanation. Every
  load the plugin issues now carries the per-file options `vid=auto,aid=auto`; mpv applies those
  after the watch-later file, so the stream always starts with its tracks on (`mute` and
  `volume` are left alone). Loads the plugin does not issue — a new player window
  (`createPlayerInstance` takes no mpv options) or IINA's own *Open URL* — are repaired once per
  URL by reloading with the same options.
* **The chat overlay is only visible on a Twitch video.** The panel used to stay on screen after
  the playing media stopped being Twitch (and on a launch with nothing playing), showing an empty
  *Twitch* header over any file. Visibility now follows the connected chat: `overlay_visible` is
  the user's wish, but `show()` only runs while a channel is bound or a VOD replay is active, and
  losing that chat hides the panel at once. The preference is kept, so the overlay returns with
  the next Twitch stream; toggling it on non-Twitch media reports *Twitch Chat is only available
  on Twitch videos*.
* **Third-party emotes now render in a VOD replay whose title has no channel name.** The
  replay's GQL page carries `video.creator.id`, but the plugin only bound a channel from the
  URL/title and the sidebar only fetched BTTV/7TV/FFZ sets after a ROOMSTATE, so a VOD-only
  session showed `o7`, `ta` and every other channel emote as literal text (Twitch-native
  emotes still rendered from the GQL tags). The plugin now forwards the creator id in
  `twt:settings` (`vodOwnerId`) and the sidebar fetches the channel sets by it without an IRC
  join. The index keeps globals and the current channel apart: switching VOD/channel drops the
  previous channel's names and refetches its URL, while the global sets survive.
* **The overlay's resize zones no longer paint a coloured wash.** The invisible edge/corner hit
  areas kept an accent wash on hover and while a resize gesture ran; they are now fully inert
  visually in every state, so the directional resize cursor is the only affordance.

## 1.5.0

* **A VOD replay labels the VOD's channel, not the stream watched before it.** IINA reports the
  new media's URL before it parses the title, and a Twitch VOD URL carries only the video id.
  The channel decision therefore ran with the previous stream's title and kept the old channel
  on the overlay header (`#oldchannel (VOD chat replay)`); after that the title settled, but the
  decision ladder stopped as soon as the file token matched, so nothing re-evaluated it. The
  ladder now also compares what channel detection can see (the title and media title), so a
  title that arrives after the URL re-runs the decision while the replay is active.
* **The Videos tab search only considers followed channels.** Typing a channel name into the Videos filter no longer pulls that channel's videos through a global channel search — the filter matches only the recent videos of the channels you follow (by title, channel name or login).

## 1.4.0

* **The web views are loaded reliably even on a slow launch.** The plugin used to mark the
  views as loaded before a player window existed, so the sidebar's `loadFile` threw, the real
  `iina.window-loaded` then returned early, and the sidebar could stay dead until its tab was
  opened (the overlay only recovered through its retry ladder). It now distinguishes *attempted*
  from *loaded*, retries the load with 1/2/4/8 s backoff, and performs exactly one load per
  window, so the first load wins and the sidebar comes up on its own.
* **The settings switches really apply now.** `auto_join`, `history_remote` and
  `vod_chat_replay` rendered on the settings page but never wrote anything back — turning
  `auto_join` off silently did nothing. They are now read and written like every other
  preference, so toggling them takes effect.
* **New preference `auto_open_browser` (default off).** With it on, IINA opens the standalone
  Twitch browser once per launch when nothing is being played: the plugin waits ~2.5 s after the
  player starts, opens nothing if media appears during that window (opening a file or a restored
  session cancels it), leaves an already-open window alone, and **⌘⇧W** still opens it manually
  in any state. The switch is read at launch, so it takes effect on the next start.
* **The plugin is called *Twitch*.** The display name, the sidebar tab and every user-visible
  string (menu items, help page, error text) dropped the "Chat" suffix - the chat is what it
  shows, not what it is. The bundle identifier `com.kdressler.iina-twitch-chat` and the log
  prefix `[twitch-chat]` are unchanged: they key the stored preferences, the plugin's data folder
  and the documented log lines.
* **Web-view messages can no longer break on backticks or `${`.** IINA injects plugin payloads
  into a web view as ``window.iina._emit(`name`, String.raw`<json>`)``; a forwarded string
  containing a backtick or `${` made that evaluation fail (WebKit: “Request to run JavaScript
  failed”) and the view silently missed the message — during a VOD replay with thousands of
  attacker-written chat lines (and untrusted media titles) this blanked the sidebar and left the
  overlay stale. `lib/webview.js` now base64-encodes any string containing either sequence and
  `ui/protocol.js` decodes it. Room ids are also tracked per channel (`state.roomIds[channel]`),
  so replayed comments carry their own channel's room id instead of a live one overwriting it.
* **The overlay is moved and resized directly.** The lock button, the edit-mode menu item and
  the `overlay_layout_locked` preference are gone. Move the panel by dragging its header (a
  grab/closed-hand cursor, nothing to reveal); resize it from any edge or corner, each with its
  directional cursor and a highlighted zone. The panel anchors to the nearest video corner and
  only switches corners once its centre passes the video centre by 10 % of the viewport on that
  axis, so resizing keeps the anchored edges still and a small drag cannot flip it; Escape
  cancels a gesture. The overlay reports the geometry continuously during a gesture and the
  plugin stores every report immediately, writing `overlay_layouts` once per gesture (250 ms
  debounce); the legacy `{x, y, w, h}` is read as `tl` - so a resized window keeps the panel's
  gap.
* **Chat lives only in the video overlay.** The sidebar no longer renders chat: no message list,
  no composer, no channel switcher and no settings popover. The IRC client still runs in the
  sidebar web view (which exists even when the overlay is hidden), but the overlay is the only
  chat display. Chat is display-only — there is no sending UI.
* **Chat is bound to the current stream only.** The plugin follows the channel detected in the
  playing media (Twitch URL/path/playlist entry, else the Twitch-sourced title heuristic), gated
  by `auto_join`. The `channel`, `favorite_channels_csv`, `last_channel` and
  `video_overrides_channel` preferences, the Join/Leave menu item, manual joining and the
  config-channel fallback are gone. With no Twitch channel in the video, chat releases and goes
  idle.
* **The sidebar is a six-tab Twitch browser plus settings.** *Following*
  (`/helix/channels/followed`, needs `user:read:follows`), *Top* (`/helix/streams`),
  *Categories* (`/helix/games/top`, plus `/helix/search/categories`), *Search*
  (`/helix/search/channels`), *Videos* and *Settings*. Each tab keeps its own history stack,
  cache and search text; switching tabs neither re-renders nor refetches, Back/Escape pop only
  the active tab, and refresh refetches only the active tab. The tab strip scrolls
  horizontally, and the connection indicator moved to a pinned footer while the panes became
  the only scrolling region. Following is sorted as an accumulated list: live channels by
  viewer count descending (ties by name), then offline channels by case-insensitive name;
  Categories intentionally shows no viewer counts (the API has none and no bounded call
  yields a total). Videos filters the videos of followed channels and explicitly is not a
  global VOD search — Helix has no VOD text search — though a channel-like query adds a
  bounded fan-out for that channel. A VOD row whose thumbnail is missing or still processing
  (`_404/404_processing_`, never requested) uses the live stream's thumbnail while the channel
  broadcasts, batched one request per page, and swaps once to the live preview when one is
  available if its own thumbnail fails to load.
* **Following avatars fixed.** The lookup used a malformed `/helix/users?login=login=…` query
  (HTTP 400), so no profile images arrived; it now sends `login=<name>` (batched per page).
* **Open a stream or VOD in a new window.** A VOD row, or the *Watch* button on a live row,
  opens it in the active player window; ⌘-click or middle-click opens a new one. This needs a
  `globalEntry` (`global.js`), because `iina.global.createPlayerInstance` is only available there.
* **Resizing the overlay works reliably again.** The edge/corner resize zones were unreachable —
  rules that could never match, and a stacking-context problem let the drag catcher cover them.
  The zones are now always present with their directional cursors, so resizing works as
  documented.
* **The menu shortcuts no longer depend on the Plugin menu having been opened.** IINA builds the
  Plugin menu from `PlayerCore.active.plugins` only when the menu opens or a plugin calls
  `forceUpdate()`; our one `forceUpdate()` ran from the plugin's boot code, i.e. while
  `PlayerCore.plugins` was still empty, so it could not publish the items - and it left the menu
  rebuilt without any plugin item, dropping the per-player shortcuts (⌘⇧B/⌘⇧T) until the menu
  was opened once. The refresh now happens on `iina.window-loaded`, when the instance is
  registered; the global entry's Open Twitch Window (⌘⇧W) is unaffected in every state.
* **A window opened from the browser could not play its stream.** `createPlayerInstance` loads
  *only the calling plugin* unless it is passed `enablePlugins: true` (the default branch calls
  `reloadPlugin(pluginInstance.plugin)`), so the new window had no Online Media (yt-dlp) plugin:
  nothing rewrote the twitch.tv page URL, mpv got it with `ytdl=no` and answered
  `error: Failed to recognize file format.` - IINA's "cannot open file or stream". The same URL
  then worked from IINA's Open URL window, whose players load every plugin
  (`PlayerCore.createPlayerCore`: `startMPV()` then `loadPlugins()`). `global.js` now creates the
  instance with `enablePlugins: true`.
* **Switching streams no longer shows IINA's loading window.** A `twt:open` for the current
  window now goes to `mpv loadfile <url> replace` instead of `iina.core.open`, so IINA never
  enters `PlayerCore.openMainWindow` and never shows its "Loading media" overlay - and its own
  title, history and "now playing" bookkeeping no longer update for that load. The new-window
  path (⌘/middle-click) still goes through `iina.global.createPlayerInstance`, because a new
  window has to load. Since IINA is no longer the loader, the plugin watches `mpv.end-file`
  itself: a load that leaves nothing playing logs, says *the URL could not be opened* on the
  OSD and releases the channel, so chat never stays bound to a stream that did not load, while
  a natural end of playback is left alone. `mpv.path.changed` stays the primary rung of the
  decision ladder (it fires for every load, including the ones where `iina.file-loaded` never
  arrives), and a ladder that finds nothing playing releases the channel too.
* **Twitch API access goes through the plugin.** The sidebar uses `twt:twitch-get` with an
  allow-listed Helix path and gets `twt:twitch-result`; the token never reaches the web views'
  Twitch calls. The plugin derives the Client-Id and user id from
  `id.twitch.tv/oauth2/validate` and caches them, and `/identity` exposes the user id and scopes
  to the browser UI. `twt:open` accepts only `https://twitch.tv` / `https://www.twitch.tv` URLs
  and opens them through IINA (yt-dlp/streamlink are needed for playback).
* **VOD chat replay.** A VOD's chat is fetched from Twitch's undocumented GQL endpoint
  (`VideoCommentsByOffsetOrCursor`, public web client id, no `Authorization` header), paged
  forward from the playhead by offset stepping (the next request starts one second past the
  newest comment of the last page; pages overlap and are deduped by id), bounded to one request at a time (≥250 ms
  apart, 20 s / 180-comment prefetch window, 2/4/8 s backoff on 429), re-synced on a backwards
  seek or a forward jump over 15 s, and emitted on a 1 s tick as ordinary messages marked
  `replay:true`. Live chat is suppressed while a VOD plays, and the overlay is cleared at
  start and end. `vod_chat_replay` (default on) disables it. There is no supported Twitch API
  for VOD chat, so a rejected query hash or endpoint change ends the replay (one warning, the
  OSD `VOD chat replay unavailable`, no chat, still in VOD mode).
* Menu reduced to four first-level player items: Connect / Disconnect, Toggle Twitch Overlay
  (⌘⇧T), Show Twitch Sidebar (⌘⇧B) and **Config** ▸ Reload Config / Open Config Folder /
  Open Help / README. *Join / Leave Channel…*, *Detect Channel from Video*, *Clear Chat* and
  *Edit Overlay Layout* are gone (detection runs on every file load, and the overlay is moved
  and resized directly). The global entry separately registers **Open Twitch Window** (⌘⇧W).
* **Standalone Twitch browser window.** **Plugin ▸ Open Twitch Window** (⌘⇧W, global entry
  `global.js`) opens `ui/standalone.html` via `iina.standaloneWindow`, so browsing works with
  no media and no player window (a sidebar cannot exist without a player). It has the five
  browse tabs, no chat and no Settings pane; Watch/VOD rows open a new player window because
  there is no current player.
* Documentation and help page updated for the overlay-only, stream-bound design.

## 1.0.3

* **The overlay panel is draggable and resizable.** *Chat ▸ Edit Overlay Layout* makes the overlay
  interactive so the panel can be moved and resized over the video; the panel always keeps at least
  80 × 40 px (and its 220 × 120 px minimum size) on screen. Escape or the menu item leaves edit mode.
* **The overlay layout is remembered per channel** (the no-channel case is stored as `default`) in
  the new `overlay_layouts` preference, capped at 50 channels and pruned least-recently-used first;
  the panel is restored on the overlay loading and on every channel switch.
* **The overlay stays click-through by default.** It only captures mouse events while edit mode is
  on; every path that hides or disables it ends click-through.
* **Edit-mode menu item** with a checkmark while it is active (`Chat ▸ Edit Overlay Layout`).

## 1.0.2

* **The playing video's channel now wins over `[twitch] channel`.** A channel detected in the
  video replaces the configured one (new `video_overrides_channel` preference, on by default);
  the config channel is still used when detection finds no Twitch channel.
* **Channel switches clear both views.** A switch empties the sidebar and overlay message lists
  and the plugin's replay backlog before anything about the new channel is posted.
* **Per-channel history.** The last 50 messages per channel are kept in a local ring buffer and
  persisted in the plugin's data directory (`@data/history.json`). Opt-in `history_remote`
  (off by default) pre-fills a channel from `recent-messages.robotty.de`.
* **FrankerFaceZ endpoints corrected:** `/v1/set/global` for the global set and
  `/v1/room/id/<id>` for a channel's set (the previous paths answered with different data).
* **HTTP bridge body cap raised to 8 MiB**, because 7TV per-channel emote sets exceed the old
  2 MiB limit.
* **Overlay delivery ladder.** IINA flips `overlayViewLoaded` asynchronously after
  `overlay.loadFile`, so settings and the emote index are re-posted on a bounded retry ladder
  until the overlay reports ready.
* **Window-teardown guard:** a closed window stops the timers and ignores later events, fixing
  a SIGABRT in IINA's menu code.
* **`require()` moved to module load.** IINA's `require` traps outside module evaluation
  (`pluginInstance.currentFile` is nil), which broke the remote-history path with a SIGTRAP;
  the libs are now required once at load and only the loaded objects are used in callbacks.
* **Detection re-evaluated after `file-loaded`.** IINA reports the event before `core.status.url`
  and mpv `path` change, so the decision is retried on a short bounded ladder instead of acting
  on the previous file.

## 1.0.1

Fixes after the first install/run on a real machine (IINA 1.5.0):

* **Packaging**: `make build` now writes the plugin's *contents* at the archive root. IINA's
  installer unpacks a package with `unzip <pkg> <tmp>-1 && mv <tmp>-1/* <tmp>/` and requires
  `Info.json` in `<tmp>`, so the previous archive (which wrapped everything in a folder of its
  own) was rejected with *“IINA cannot load this plugin. It might be in the
  wrong format.”* `make pack-check` asserts the layout.
* **Configuration really loads now**: IINA evaluates a required module as
  `(function () { const module = {}; …; return module.exports; })()`, so the UMD wrappers'
  `typeof module === "object" && module.exports` test failed and `require("./lib/config.js")`
  returned nothing — the plugin ran with no settings at all ("no OAuth token configured" even
  though the twt config has one). `main.js` now falls back to the `TwitchPlugin.*` global the same
  wrapper already filled in, so the token, channel, palette, filters and emote toggles are read.
* `utils.resolvePath("~")` throws (`The path should be an absolute path: ~`); the home directory now
  comes from `/usr/bin/env` with a `~/.config/twt`-derived fallback.
* Config lookup mirrors twitch-tui: *Config file* preference → `TWT_CONFIG` →
  `~/.config/twt/config.toml` → `~/Library/Application Support/com.twitch-tui.twt/config.toml`
  (`ProjectDirs::from("com", "twitch-tui", "twt")`), first existing file wins, `filters.txt` from the
  same folder.
* Status is never silent: the sidebar and overlay always show the connection state, the channel and
  an actionable empty state; the sidebar's status line names the config file that was read (or every
  path tried) and whether an OAuth token was found, and `token_status` in IINA's settings says the
  same.
* Menu restructured to five first-level items (IINA only displays five) with **Chat** and **Config**
  submenus.
* New: channel detection from the playing video (`Detect Channel from Video` menu item, `auto_join`
  preference, OSD announcement, detection result in the sidebar), with a Twitch-source guard so
  titles of non-Twitch videos are never guessed.
* Security: `PASS oauth:…` is redacted before IRC log lines reach IINA's log.
* Menu setup uses the real `MenuItem.addSubMenuItem` name (IINA's API-doc *example* spells it
  `addSubmenuItem`) with feature detection. On IINA 1.5.0 the typo raised a caught exception that
  still stopped the rest of the plugin's initialisation, so the menu also never loses items now.
* `iina.file.read` is called with the second argument its declared signature has
  (`read(_ path: String, _ options: [String: Any])`, identical in IINA 1.5.0 and develop), with a
  one-argument fallback; a failed read is recorded in the status line and in `token_status` instead of
  being indistinguishable from "no config file", and the detected `iina.file.read` arity is logged
  once per session.
* **Crash fix (remote history).** With `history_remote` on, the remote-history callback called
  `require("./lib/irc.js")` lazily; IINA's `require` force-unwraps `pluginInstance.currentFile`, which
  is `nil` outside `evaluateFile`, so the trap was an `EXC_BREAKPOINT`/SIGTRAP
  (`closure #5 in JavascriptPolyfill.register`). The libs are now required once at module load, and the
  remote path is generation- and teardown-guarded, bounded (1 MiB body, 200 lines, 2000 chars per
  message) and never sends the token; regression tests cover the load-time-only require, stale
  results, teardown results, oversized bodies and `history_remote = false`.
* The hidden sidebar web view is suspended by WebKit (measured on IINA 1.5.0: it connects and joins,
  then sends no keepalive and - in a busy channel - delivers no socket callbacks for 59 s), so
  `main.js` pokes the transport with `twt:command poke`: every 3 s of silence while the overlay is
  visible, every 45 s otherwise. The transport answers with a state report plus an idle-gated
  `client.ping()`, chat therefore arrives in bursts while the tab is closed, and only three
  *unanswered* pokes log a warning.
* `lib/` compatibility: `loadLib()` keeps the `TwitchPlugin.*` fallback as a silent net (logged only
  when it is actually needed) now that the lib's UMD wrappers detect IINA's `require` shim, and it
  reports a clear error if both paths fail. A new `chat is flowing: rendered the first message in
  #channel` line gives the end-to-end proof in the log.
* Config path probing is no longer duplicated in `main.js`: `lib/config.js` reports its search
  (`source.tried`, `source.tokenPresent`) and the plugin renders that. `TWT_CONFIG` is still honoured
  by the library but is unreachable inside IINA, whose `utils.exec` runs children with a sanitised
  environment - use the *Config file* preference instead (documented).

## 1.0.0

First release.

* Sidebar tab **Twitch**: connection status and channel header, message list, composer,
  channel switcher (config `channel` + `favorite_channels`) and a settings popover with
  palette, theme, timestamps, usernames, badges, mention highlighting, the four emote
  toggles, message cap, render delay and filter switches.
* Video overlay mirroring the same stream, with a compact composer and channel switcher;
  toggled from the Plugin menu or **⌘⇧T**, interactive only on its own `data-clickable`
  controls.
* Anonymous read-only chat with no token: `wss://irc-ws.chat.twitch.tv:443`,
  `CAP REQ :twitch.tv/tags twitch.tv/commands`, `NICK justinfanNNNNN`, `JOIN #channel`.
  Sending needs an OAuth token (twt `[twitch] token` or the macOS Keychain); the composer is
  disabled with an explanation when there is none.
* twitch-tui configuration parity (`~/.config/twt/config.toml` + `filters.txt`), including
  `[twitch]`, `[frontend]`, `[terminal]`, `[filters]` (flat and nested forms) — and working
  defaults when no config file exists. Exact field mapping documented in `README.md`.
* Plugin menu: Join/Leave channel…, Connect/Disconnect, Toggle Twitch overlay (⌘⇧T),
  Focus chat input, Show Twitch sidebar, Clear chat, Reload config, Open config folder and
  Help/README.
* Auto-join: a loaded video whose URL or title contains `twitch.tv/<channel>` is joined when
  no channel is configured; the last channel is persisted through `iina.preferences`.
* `core.osd()` messages on connect, disconnect, reconnect and errors.
* Chat rendering: badges, Twitch/BetterTTV/7TV/FrankerFaceZ emotes, username colours per
  palette, timestamps via `strftime`, bit messages, `/me` actions, sub/resub/raid notices,
  `CLEARCHAT`/`CLEARMSG` removal, twitch-tui filter semantics, message cap and autoscroll
  with a “jump to bottom” affordance.
* `title_shown` hides the channel label in both headers; the plugin-only `system` theme
  override follows the macOS appearance.
* The sidebar web view is loaded at `iina.window-loaded` even when its tab is closed (it hosts
  the IRC transport), with a reload-once watchdog and a log message if it never becomes ready.
* Build helpers: `make build` (`.iinaplgz`), `make check`, `make test`, `make link`,
  `make unlink`, `make clean`.
