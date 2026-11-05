# Twitch for IINA

Shows Twitch chat over the video in [IINA](https://iina.io), always bound to the stream
that is playing, and browses Twitch from a sidebar tab. It reads the same configuration
as [twitch-tui](https://github.com/xithrius/twitch-tui) (`~/.config/twt/`), works
anonymously and read-only with no token, and works with no configuration file at all.

* Plugin folder: `Info.json`, `main.js`, `global.js`, `ui/**`
* Pure-logic modules (shared with the web views, both plugin entries and testable in Node):
  `lib/irc.js`, `lib/config.js`, `lib/emotes.js`, `lib/strftime.js`, plus `lib/helix.js`
  (the single Helix allowlist + proxy engine used by the player and global entries),
  `lib/webview.js` (the bridge codec: base64-encodes payload strings containing a backtick or
  `${`) and `lib/hostenv.js` (config-file/HOME plumbing shared by both entries)
* Tests: `test/**` (`npm test`)

---

## Install

```sh
make build          # -> dist/Twitch.iinaplgz (and dist/Twitch.iinaplugin/)
```

Then either

* **IINA → Settings → Plugins → *Install Local Package…*** and pick
  `dist/Twitch.iinaplgz`, or
* copy/symlink `dist/Twitch.iinaplugin/` into
  `~/Library/Application Support/com.colliderli.iina/plugins/`.

Or install from GitHub: **IINA → Settings → Plugins → *Install from GitHub…*** and enter
`kvndrsslr/iina-twitch-chat`. IINA downloads `Twitch.iinaplgz` from the latest release and prompts
for an update when `ghVersion` in `Info.json` increases.

Two things bite here, both verified against IINA 1.5.0:

* **The package must hold the plugin's contents at its archive root.** IINA unpacks a package with
  `unzip <pkg> <tmp>-1 && mv <tmp>-1/* <tmp>/` and then reads `Info.json` from `<tmp>`
  (`JavascriptPlugin.create(fromPackageURL:)`), so an archive that wraps everything in a
  `Twitch.iinaplugin/` folder fails with *“IINA cannot load this plugin. It might be in the
  wrong format.”* `make build` zips the staged folder's *contents* (that is what IINA's own
  `iina-plugin pack` does) and `make pack-check` guards the layout.
* **A plugin is disabled until it is enabled once.** IINA stores this per identifier
  (`PluginEnabled.<identifier>` in IINA's defaults, `JavascriptPlugin.enabled`), so after the first
  install (or after the first `make link`) open **IINA → Settings → Plugins**, select *Twitch*
  and enable it. Without that, IINA logs `Loaded JS plugin: Twitch <version> (disabled)` and
  nothing else happens.

`dist/` is a build artifact produced by `make build` (and removed by `make clean`): it is
git-ignored and not part of the repository, so build it locally before installing that way. The
GitHub install path uses the package attached to the latest release instead.

Or copy/symlink the plugin folder by hand:

```sh
make link           # symlink this repo as iina-twitch-chat.iinaplugin-dev
make unlink
```

`make link` creates

```
~/Library/Application Support/com.colliderli.iina/plugins/iina-twitch-chat.iinaplugin-dev
```

The `.iinaplugin-dev` suffix is required for IINA to treat the folder as a development
plugin; restart IINA after changing plugin script code (a plugin script is only read at
launch, and a plugin that has never been enabled in IINA → Settings → Plugins stays
`(disabled)` in the log). Web-view files can be reloaded without restarting IINA with the
sidebar's/overlay's context menu → *Reload* — that also re-runs `ui/transport.js`.

### Development loop

| What | Where |
| --- | --- |
| Plugin script logs (`[twitch-chat] …`) | **Window → Log Viewer**, subsystems `global - Twitch` and `player<n> - Twitch` |
| JS console in the plugin context | **Plugin → Developer Tool** (IINA 1.4+) |
| Web view debugging | Safari → *Develop* → *<computer>* → the sidebar/overlay context |
| Syntax check | `make check` (runs `node --check` on `main.js`, `global.js` and `ui/*.js`, parses `Info.json`) |
| Library tests | `make test` (delegates to `npm test`) |

### Make targets

| Target | Effect |
| --- | --- |
| `make build` | stages `dist/Twitch.iinaplugin/` from `Info.json`, `main.js`, `global.js`, `ui/`, `lib/`, `README.md`, `CHANGELOG.md`, then zips its *contents* to `dist/Twitch.iinaplgz` (a git-ignored build artifact), runs `pack-check` and lists the archive |
| `make pack-check` | asserts the archive layout IINA's installer requires (`Info.json` at the root, no wrapping `*.iinaplugin` folder, `ui/sidebar.html` present, the `globalEntry` file present) |
| `make check` | `node --check` on the plugin scripts and web view scripts + `Info.json` JSON parse |
| `make test` | `npm test` (the `lib/` unit tests) |
| `make link` | symlink the repo into IINA's plugin folder as `iina-twitch-chat.iinaplugin-dev` |
| `make unlink` | remove that symlink |
| `make clean` | remove `dist/` |

### Releasing

Bump `version` and `ghVersion` in `Info.json`, commit, then push a `v<version>` tag. The release
workflow runs the tests, builds the package and attaches it to the GitHub release; IINA compares
`ghVersion` against `main` and prompts installed users when it increases.

---

## Features

* **Chat lives only in the video overlay.** The overlay is a one-line channel/connection
  header plus the message list, with no buttons, inputs or other clickable elements, so the
  video keeps every mouse event outside the panel. Toggle it from the Plugin menu or with
  **⌘⇧T**. The panel is only shown while chat is connected to a Twitch video (a bound channel or
  a VOD replay): with any other media it stays hidden (and the shortcut reports *Twitch Chat is
  only available on Twitch videos*), while the visibility preference is kept for the next Twitch
  stream. Move the panel by dragging
  its header, resize it from any edge or corner, and the arrangement is remembered per channel —
  see [Overlay layout](#overlay-layout).
* **Chat is bound to the playing stream and to nothing else.** The plugin joins the channel
  it detects in the current media, gated by the `auto_join` preference: a
  `twitch.tv/<login>` URL in the media URL/path/playlist entry, else the title heuristic
  (only for media that is demonstrably Twitch-sourced). There is no config channel, no
  manual join and no remembered channel; a video without a Twitch channel releases the
  previous one and chat goes idle.
* **Sidebar = Twitch browser + settings (six tabs).** *Following*, *Top*,
  *Categories*, *Search*, *Videos* and *Settings*. Each tab keeps its own history stack (Back and
  Escape), its own response cache and its own query, so switching tabs neither re-renders nor
  refetches; the refresh button only refetches the active tab. The tab strip scrolls
  horizontally. The connection indicator is a pinned footer (the panes are the only scrolling
  region). *Settings* holds the palette, theme, message, emote, buffering and filter overrides
  that used to live in a popover. The sidebar renders no chat, has no composer, no message
  list and no channel switcher.
* **Open a stream or VOD in this window or a new one.** A VOD row (or the *Watch* affordance on
  a live row) opens it in the active player window; ⌘-click or middle-click opens it in a
  **new** player window. Opening a channel page or category stays inside the sidebar. The
  plugin ships a `globalEntry` (`global.js`) for new windows: `iina.global.createPlayerInstance`
  is only available to the global entry. Playback itself is resolved by IINA/yt-dlp/
  streamlink; the plugin only asks IINA to open the URL.
* **Fast stream switching.** Opening a stream/VOD from the browser into the current window
  uses `mpv loadfile <url> replace -1 vid=auto,aid=auto`, so IINA's *Loading Media…* window no
  longer appears and a stale watch-later entry (or a disabled video track) cannot turn the
  stream into audio-only. IINA's own title, history and “now playing” bookkeeping does not
  update for that load; if the load
  fails, the plugin logs it, shows an OSD and releases the channel after a short grace period
  so chat goes idle instead of showing the previous stream. The new-window path still uses
  IINA's loader.
* **Standalone Twitch window.** **Plugin ▸ Open Twitch Window** (⌘⇧W) opens the browser in
  IINA's own standalone window via the global entry, so it works with no media and no player
  window; it has the five browse tabs but no chat and no Settings pane, and stream/VOD rows
  open in a new player window.
* **Anonymous read-only chat** — no token required: the sidebar web view connects to
  `wss://irc-ws.chat.twitch.tv:443`, requests `twitch.tv/tags` + `twitch.tv/commands`,
  logs in as `justinfanNNNNN` and joins the channel. There is no message composer: chat
  is display-only.
* **Twitch API through a plugin proxy** — the sidebar never makes Twitch API calls directly and
  never handles the OAuth token for HTTP. Every request goes through the plugin
  (`twt:twitch-get` → `twt:twitch-result`), restricted to an allow-list of Helix paths and
  the `/identity` endpoint. See [Architecture](#architecture).
* **twitch-tui config parity** — the exact field mapping is below.
* **Filters** — `[filters]` (including the nested `[filters.message]` / `[filters.username]`
  form) plus `filters.txt`, applied with twitch-tui's semantics.
* **Automatic channel detection** — a `twitch.tv/<login>` URL found in `core.status.url`, the
  mpv `path`/`filename`/`media-title`, or a playlist entry wins (the `m.`, `go.` and
  `player.` forms and `player.twitch.tv/?channel=<login>` included; reserved paths such as
  `videos`, `clips`, `directory` and `settings` are skipped). Only if no URL matches is the
  *title* used, and only when the same media is demonstrably Twitch-sourced (`twitch.tv`,
  `ttvnw.net` or `twitch.com` in the URL, path, file name or media title) — so
  `ohnePixel — VITY vs LOUD [GRAND FINAL]` becomes `#ohnepixel`, while a YouTube video
  called `Bob - highlights` never joins `#bob` and titles that reduce to a stopword (`vod`,
  `live`, `highlights`, …) are rejected. `auto_join` (default **on**) is the only switch:
  with it off the plugin never joins automatically. Detection itself is always automatic: it
  runs on every file load. The plugin announces a join with the OSD text
  `Twitch: joined #<login> (from the playing video)` and logs one decision line per choice.
* **OSD feedback** — connect, disconnect, reconnect, channel changes and errors are
  reported with a short `core.osd()` message.
* **VOD chat replay** — a VOD's chat is replayed from Twitch's undocumented GQL endpoint,
  paged forward from the playhead; controlled by `vod_chat_replay` (default **on**). See
  [VOD chat replay](#vod-chat-replay).

---

## Menu commands and shortcuts

Everything lives under IINA's **Plugin** menu. The per-player items belong to the window that
has focus; the standalone item is registered once per app by the global entry and works with no
player window at all.

IINA only displays the **first five first-level items** of a plugin menu (`Please avoid adding
too much first-level menu items`), so the player entry uses four first-level items and keeps the
Config entries in one submenu:

| Menu item | Shortcut | Action |
| --- | --- | --- |
| Connect / Disconnect | – | open or close the IRC connection |
| Toggle Twitch Overlay | ⌘⇧T | show/hide the overlay on the video (only shown while chat is bound to a Twitch video) |
| Show Twitch Sidebar | ⌘⇧B | open the sidebar on the Twitch tab |
| **Config ▸** Reload Config | – | re-read `config.toml` + `filters.txt` |
| **Config ▸** Open Config Folder | – | reveal the folder of the config file that was found in the Finder |
| **Config ▸** Open Help / README | – | open `ui/help.html` (the same page is IINA's Settings → Twitch → Help tab) |
| Open Twitch Window | ⌘⇧W | open the standalone Twitch browser window (global entry; available without media) |

The shortcuts are registered in mpv's key-name format (`Meta+Shift+t` → ⌘⇧T, `Meta+Shift+b` → ⌘⇧B,
`Meta+Shift+w` → ⌘⇧W). Channel detection is automatic: it runs on every file load and needs no
menu item.

**Known IINA behaviour.** IINA rebuilds a plugin's menu — including the items that carry the key
equivalents — only when the Plugin menu is opened, when a plugin explicitly asks for a rebuild, or
once at the end of app launch. It does not rebuild the menu when a window becomes key or closes.
While a **non-player window is key** (which includes this plugin's standalone Twitch window),
IINA's notion of the active player falls back to the first player window: *Toggle Twitch Overlay*
and *Show Twitch Sidebar* then act on that window, and do nothing if it is gone. **Open Twitch
Window (⌘⇧W)** is registered by the global entry and keeps working in every state. If the
per-player shortcuts seem to target the wrong window, open the Plugin menu once: that re-binds
them to the window actually in front.

### Standalone Twitch window

**Plugin ▸ Open Twitch Window** (⌘⇧W) opens `ui/standalone.html` in an IINA standalone window
through the global entry (`global.js`, `iina.standaloneWindow`). A sidebar cannot exist without a
player window, so this is the way to browse Twitch with no media loaded. It is browse-only: the
five browse tabs (Following, Top, Categories, Search, Videos), no chat (the IRC client needs a
player channel) and no Settings pane. Clicking a channel or category row navigates inside the
window; the *Watch* button on a live row and a VOD row open the stream/video in a **new player
window**, because there is no current player to load into. The window's footer reads
`browsing · token available` / `browsing · no token`.

With the **Startup** preference `auto_open_browser` on (default **off**), the window opens itself
once per launch when IINA starts with nothing playing: it waits about 2.5 s, does not open if media
arrives during that window (opening a file or a restored session cancels it), and leaves an
already-open window alone. **⌘⇧W** opens it manually in any state.

### Overlay layout

The overlay panel is moved and resized directly, with nothing to reveal and nothing that
appears or disappears:

* **Move** — drag the panel by its **header**. There is no handle: the cursor becomes a grab
  hand over the header and a closed hand while you drag.
* **Resize** — drag **any edge or any corner**. Each one shows its directional cursor (the
  zones themselves are invisible; the cursor is the only affordance). Interacting with the
  controls never changes the overlay's size.
* **Anchoring** — the panel remembers which corner of the video it is nearest to, so a resized
  video window keeps the panel's distances. It only switches corners once the panel's centre
  passes the video centre by a margin (10 % of the viewport on that axis), so it does not flip
  while you nudge it across the middle. Resizing keeps the anchored edges still and moves only
  the edge(s) you drag, with a 220 × 120 minimum and the panel always inside the video.
* **Escape** cancels a drag or resize; the layout is saved per channel.

The overlay reports the geometry continuously while a drag or resize is in flight (at most one
report per 100 ms) plus a final one on release. The plugin stores every report immediately and
writes the `overlay_layouts` preference after the gesture pauses (250 ms debounce), and never
echoes the layout back. A layout is anchored - `{anchor, dx, dy, w, h}`
with `anchor` one of `tl`/`tr`/`bl`/`br` and `dx`/`dy` the pixel gaps to the anchored viewport
edges - so a resized video window keeps the panel's gap.

The plugin is the side that owns the bounds: a reported layout is clamped to `w >= 220`,
`h >= 120` and non-negative gaps, and the overlay applies the remaining clamp so the panel always
stays inside the video. The plugin stores the layout itself and does not echo it back.

**Per stream means per channel:** each arrangement is stored for the channel that is
bound — `default` while no channel is bound — in the `overlay_layouts` preference and restored
whenever the overlay reports ready and on every channel switch (including a channel detected from
the playing video). The preference holds at most 50 channels and prunes the least recently used one
first; writes are debounced by 250 ms. A missing or corrupt value is ignored (logged once)
and the panel falls back to its CSS default.

**Upgrading from 1.0.x.** An older `{x, y, w, h}` entry in `overlay_layouts` is still read: its
position becomes anchor `tl` (`dx = x`, `dy = y`) and it is rewritten in the anchored shape on the
next save. A stored `overlay_layout_locked` key is simply ignored — the plugin no longer reads it.
The bundle identifier is unchanged (`com.kdressler.iina-twitch-chat`), so IINA keeps the plugin's
preferences and its data folder (`@data/history.json` and the cached chat history) across the
rename.

---

## Configuration

The plugin reads the twitch-tui configuration. `config.toml` is searched in this order and the
**first file that exists wins**:

1. the *Config file* preference (IINA → Settings → Twitch),
2. the `TWT_CONFIG` environment variable,
3. `~/.config/twt/config.toml` — the XDG location twitch-tui uses and the one documented here,
4. `~/Library/Application Support/com.twitch-tui.twt/config.toml`, then
5. `~/Library/Preferences/com.twitch-tui.twt/config.toml` — what twitch-tui's `directories`-crate
   lookup resolves to on macOS: `ProjectDirs::from("com", "twitch-tui", "twt")`
   (twitch-tui `src/config/persistence.rs`) becomes
   `<qualifier>.<organization>.<application>` under those two roots.

The search itself lives in `lib/config.js`, which reports every candidate it probed through
`source.tried = [{path, found, error?}]`; `main.js` renders that verbatim instead of keeping its own
copy of the list. `main.js readEnvironment()` runs `utils.exec("/usr/bin/env")`, so `TWT_CONFIG` is
honoured only when the variable is present in **IINA's own environment** — for example when IINA was
launched from a shell (or another launcher) that exported it. Setting it in a shell profile after
IINA has started does not affect the running app; use the *Config file* preference in that case.

`filters.txt` is read from the folder of the config file that was found. Nothing is required: with
no config file the plugin uses twitch-tui's defaults and connects anonymously, and it never writes
to any config file.

The *Status* line in IINA's Twitch settings and the sidebar's Settings tab always name the
file that was read (or every path that was tried), and state whether an OAuth token was found,
missing or empty — so "no token" never appears without saying where the plugin looked.

`[twitch] channel` and `[frontend] favorite_channels` are still parsed by `lib/config.js` but are
no longer used by any view: chat is bound to the playing video, not to configuration.

### Field mapping (twt config → plugin)

| twitch-tui (`config.toml`) | Plugin setting | Consumed by (file / function) |
| --- | --- | --- |
| `[twitch] username` | `settings.twitch.username` | `ui/transport.js` `credentialsFor()`/`connect()` (IRC `NICK` + `PASS` pair) and `ui/chat-view.js` `mention()` (mention highlighting in the overlay) |
| `[twitch] token` | `settings.twitch.token` | `main.js` `reloadConfig()` → `state.token` (Keychain is the fallback); the IRC value goes to the sidebar-only `token` field → `ui/transport.js` `credentialsFor()` → `PASS oauth:…`; the Twitch API proxy uses it inside the plugin. The overlay never receives it |
| `[twitch] server` | `settings.twitch.server` | `ui/transport.js` `ensureClient()` → `irc.createClient({url})`. Anything that does not match `wss://irc-ws…` — including twitch-tui's EventSub default `wss://eventsub.wss.twitch.tv/ws` — is replaced by `wss://irc-ws.chat.twitch.tv:443` in `lib/config.js normalize()` **with a warning** |
| `[twitch] keepalive_timeout_seconds` | `settings.twitch.keepaliveTimeoutSeconds` | `ui/transport.js` `ensureClient()` (`keepaliveMs`) → `lib/irc.js` keepalive `PING`/`PONG` |
| `[frontend] palette` | `settings.chat.palette` | `ui/chat-view.js` `buildMessage()` (`emotes.userColor()` for usernames) and `applyAppearance()` → `data-palette` → `--twt-accent` in `ui/chat.css`. Also the sidebar chrome. `pastel` \| `vibrant` \| `warm` \| `cool` |
| `[frontend] theme` | `settings.chat.theme` | `ui/chat-view.js` `applyAppearance()` → `data-theme` on `<body>` (`ui/chat.css`) and the same attribute in the sidebar. twitch-tui accepts only `dark` (its default) and `light`; any other value logs a warning and falls back to `dark`. The plugin's own override additionally accepts `system` to follow the macOS appearance |
| `[frontend] show_datetimes` | `settings.chat.showDatetimes` | `ui/chat-view.js` `buildMessage()` (timestamp span) |
| `[frontend] datetime_format` | `settings.chat.datetimeFormat` | `ui/chat-view.js` `formatTime()` → `lib/strftime.js formatTimestamp()` |
| `[frontend] username_shown` | `settings.chat.usernameShown` | `ui/chat-view.js` `buildMessage()` |
| `[frontend] title_shown` | `settings.chat.titleShown` | `ui/overlay-view.js` `renderHeader()` — hides the `#header-channel` label in the overlay |
| `[frontend] badges` | `settings.chat.badges` | `ui/chat-view.js` `appendBadges()` → `emotes.badgeURL()` (`static-cdn.jtvnw.net/badges/v1/…`) |
| `[frontend] username_highlight` | `settings.chat.usernameHighlight` | `ui/chat-view.js` `mention()` (highlighted against `[twitch] username`) |
| `[frontend] twitch_emotes` | `settings.chat.twitchEmotes` | `ui/chat-view.js` `appendSegments()` (passes the IRC `emotes` tag to `emotes.segment()`) |
| `[frontend] betterttv_emotes` | `settings.chat.betterttvEmotes` | `ui/transport.js` `thirdPartyURLs()` + `fetchEmoteSet()` + `mergeEmotes()` → `emotes.parseThirdParty("bttv", …)` → `view.setEmoteIndex()` and `twt:emotes` for the overlay |
| `[frontend] seventv_emotes` | `settings.chat.seventvEmotes` | same path with kind `seventv` (`7tv.io`) |
| `[frontend] frankerfacez_emotes` | `settings.chat.frankerfacezEmotes` | same path with kind `ffz` |
| `[terminal] maximum_messages` | `settings.chat.maxMessages` | `ui/chat-view.js` `applyLimit()` (rows are dropped from the top after every flush) |
| `[terminal] delay` | `settings.chat.delay` | `ui/chat-view.js` `schedule()`/`flush()`: incoming events are queued and painted as one DOM write per `delay` ms (twitch-tui's redraw delay) |
| `[filters]`, `[filters.message]`, `[filters.username]`, `filters.txt` | `settings.filters.message` / `.username` (`{enabled, reversed, patterns}`) | `ui/chat-view.js` `passesFilters()` (message text against the message filter, login against the username filter) → `lib/config.js matchesFilters()` |
| *plugin feature, no twt field* — video → channel detection | `main.js detectChannel()` (shown as `detection`) | `main.js chooseChannel()`/`maybeAutoJoin()`: candidates are `core.status.url`/`.title`, mpv `path`/`filename`/`media-title` and playlist entries. A `twitch.tv/<login>` URL anywhere is trusted; the title heuristic (`ohnePixel — VITY vs LOUD` → `#ohnepixel`) only runs when the same media is demonstrably Twitch-sourced, so a YouTube video titled `Bob - highlights` never joins `#bob`. There is no fallback channel: no detection means no binding |
| *plugin preference* `auto_join` (default `true`) | `auto_join` | `main.js chooseChannel()`/`maybeAutoJoin()`: when off, the plugin never binds automatically and a playing video without a detected Twitch channel releases the connection's channel |

Every `settings.chat.*` value above can be overridden from IINA without touching the config
file (`ui_overrides`, see below); the override is applied in `main.js applyOverrides()`.

Errors in the config are not fatal: the lib collects them in `warnings`, the plugin logs them
(`Window → Log Viewer`) and shows their count in IINA's Twitch settings.

### Plugin preferences (IINA → Settings → Twitch)

| Preference | Meaning |
| --- | --- |
| `config_file` | explicit `config.toml` path (empty ⇒ the normal search) |
| `auto_join` | whether the plugin may bind chat to a channel detected in the playing video automatically (default **on**); with it off the plugin never joins automatically (detection itself runs on every file load) |
| `auto_open_browser` | open the standalone Twitch browser window on startup (default **off**): when on and IINA launches with nothing playing, the window opens itself about 2.5 s later, once per launch — media appearing in that window cancels it, an already-open window is left alone, and **⌘⇧W** still opens it manually. The switch is read at launch, so changing it takes effect on the next start |
| `ui_overrides` | JSON object of appearance overrides (see below), shared by the settings tab and the settings page |
| `overlay_visible` | whether the overlay was left visible; the panel itself is only shown while chat is bound to a Twitch video |
| `overlay_layouts` | JSON `{"version":1,"channels":{…}}`: the overlay panel's position and size per channel (`default` when no channel is bound), written automatically while arranging it — see [Overlay layout](#overlay-layout) |
| `token_input` | transient: a token typed in the settings page; the plugin moves it to the Keychain and clears it |
| `command_request` + `command_seq` | one-shot command channel for the settings page (`reload-config`, `forget-token`, `open-config-folder`) |
| `history_remote` | pre-fill a channel's first visit with the last 50 messages from `recent-messages.robotty.de` (default **off**; the request sends only the channel name, never the token) |
| `vod_chat_replay` | replay a VOD's chat from the playhead forward (default **on**) — see [VOD chat replay](#vod-chat-replay) |
| `status_line`, `token_status`, `filters_status` | read-only status text maintained by the plugin for the settings page |

The `channel`, `favorite_channels_csv`, `last_channel` and `video_overrides_channel`
preferences no longer exist; the plugin does not read them.

`ui_overrides` accepts: `palette`, `theme`, `showDatetimes`, `datetimeFormat`,
`usernameShown`, `titleShown`, `badges`, `usernameHighlight`, `twitchEmotes`,
`betterttvEmotes`, `seventvEmotes`, `frankerfacezEmotes`, `maxMessages`, `delay` and
`filtersEnabled: {message, username}`. `theme` additionally accepts `system`, which removes
the forced colour scheme and follows the macOS appearance (`prefers-color-scheme`); the
twitch-tui value itself only ever yields `dark` or `light`. A key that is absent means “use the config value”,
which is exactly what the “Use config” option of every control means. Because IINA's
settings page can only read and write preferences (it has no `postMessage` bridge), the
plugin polls these keys every 700 ms and re-applies them live.

### Tokens

A token is optional. When present (from `[twitch] token` in `config.toml`, a leading
`oauth:` is stripped, else the token saved from IINA → Settings → Twitch in the macOS
Keychain) it authenticates the IRC connection and lets the plugin call Twitch's Helix API
for the sidebar. Without one, chat still connects anonymously and the sidebar shows an
actionable “No token” state.

The token is resolved and validated **inside the plugin**: the plugin calls
`id.twitch.tv/oauth2/validate`, caches the resulting `client_id`, user id, login and scopes,
and adds the `Client-Id`/`Authorization` headers to every proxy request itself. The sidebar
web view receives the token value only because it hosts the IRC client (it needs it for
`PASS oauth:…`); the browser code never reads it and never makes Twitch API calls directly.
The overlay never receives the token, and it is never logged or written back to the twt config.

---

## Architecture

```
                    ┌──────────────────────── main.js (JavaScriptCore, one per player) ───────────────┐
                    │ config (lib/config.js) · preferences · menus/shortcuts · OSD · detection       │
                    │ Twitch API proxy (validate → Client-Id/Bearer → allow-listed Helix paths)      │
                    │ relay: twt:settings / twt:state / twt:event / twt:command / twt:clear /        │
                    │        twt:emotes / twt:overrides / twt:http-get / twt:http-result /            │
                    │        twt:twitch-get / twt:twitch-result / twt:open / twt:history-request /    │
                    │        twt:history-result / twt:overlay-layout / twt:overlay-moved /            │
                    │        twt:log                                                                  │
                    └─────────▲──────────────────────────────────────────────▲───────────────────────┘
                              │ iina.postMessage / iina.onMessage             │
       ┌──────────────────────┴────────────────────┐        ┌───────────────┴────────────────────┐
       │ ui/sidebar.html + browser.js + transport  │        │ ui/overlay.html + overlay-view.js  │
       │ - six tabs: Following/Top/Categories/     │        │ THE ONLY CHAT DISPLAY:             │
       │   Search/Videos/Settings, own stack+cache │        │ header + message list,             │
       │ - OWNS the IRC client (hidden WebSocket)  │        │ no buttons or inputs;              │
       │ - forwards events; renders NO chat        │        │ interactive per element, outside   │
       │ - connection state in a pinned footer     │        │ the panel click-through            │
       └───────────────────────────────────────────┘        └────────────────────────────────────┘
                              │                                         ▲
                              │ twt:open {url,target:"new"}             │ twt:event (chat stream)
                              ▼                                         │
                    ┌─────────────────────────────┐                     │
                    │ global.js (global entry)    │                     │
                    │ createPlayerInstance(url)   │                     │
                    └─────────────────────────────┘                     │
                                                                        │
                              iina.global.postMessage("twt:open-new-player") ┘
```

* IINA's plugin script has **no** WebSocket or `fetch`, and `iina.ws` is a local server only
  (`wss://` unsupported). The sidebar web view therefore hosts the only IRC client and is the
  single source of truth for the chat stream; the overlay is the only view that renders chat,
  and the plugin forwards every event to it.
* **Chat is stream-bound.** `main.js` detects a channel in the playing media (URL/path/playlist
  entry, else the guarded title heuristic), gated by `auto_join`. `maybeAutoJoin()` runs at
  startup, on `iina.file-loaded`/`mpv.path.changed` (on a bounded retry ladder, because IINA
  reports the event before the media fields change) and when `auto_join` is toggled. It posts
  `twt:join`/`twt:part` to the views; with no detected channel it releases the channel. There is
  no config channel, no manual join, no remembered channel and nothing to re-run by hand.
* **The sidebar never renders chat.** `ui/sidebar.html` has six tabs — *Following*, *Top*,
  *Categories*, *Search*, *Videos* and *Settings* — each with its own stack, cache and query;
  `ui/transport.js` keeps the IRC client but forwards every event to the plugin
  (`twt:event`) instead of painting it. The plugin records history and posts the event to the
  overlay only (`replayRecent()` likewise only replays to the overlay).
* **The IRC client runs even when the overlay is hidden.** In IINA the sidebar view is a lazy
  property of the plugin instance (`iina/JavascriptPluginInstance.swift`:
  `lazy var sidebarTabView`) that is only added to the window when a tab is selected
  (`iina/PluginViewController.swift`: `installView()`, called from `switchToTab()`), while
  `sidebar.loadFile()` (`iina/JavascriptAPISidebarView.swift`) instantiates it and calls
  `load(URLRequest:)` right away. The plugin therefore loads `ui/sidebar.html` on
  `iina.window-loaded` **without** calling `sidebar.show()`, so the IRC client runs with the
  sidebar closed. If the view does not report `twt:ready` within 6 s,
  `watchSidebarReadiness()` reloads it once and logs a warning.
* **That web view is throttled, so the plugin pokes it.** WebKit throttles timers in a view
  that was never attached, and a suspended view also holds back socket callbacks. `main.js
  startSidebarWatchdog()` posts `twt:command {command:"poke"}` to a sidebar that has been
  quiet: every 3 s it checks, and pokes after 3 s of silence while the overlay is on screen
  (so chat under the video arrives within a few seconds) or after 45 s when no chat view is
  visible (there the poke only has to keep the connection alive). `ui/transport.js` answers
  with a state report and, only when the IRC connection itself has been idle, an explicit
  `client.ping()`; only three *unanswered* pokes log `the sidebar web view is not answering
  pokes`.
* **Consequence worth knowing:** while the overlay is hidden, chat arrives in bursts (one
  burst per poke) instead of instantly, because WebKit suspends the transport's web view and
  holds back the socket callbacks with it. Showing the overlay removes the delay entirely.
* **Twitch API proxy.** A `file://` web view cannot send the OAuth token safely to Twitch
  (and its cross-origin `fetch` is blocked), so the sidebar asks the plugin instead:
  `twt:twitch-get {id, path}` → `twt:twitch-result {id, ok, status, data, error}`. `path`
  must be a plain path (no host) on this allow-list: `/identity`, `/helix/users`,
  `/helix/streams`, `/helix/videos`, `/helix/games/top`, `/helix/channels/followed`,
  `/helix/search/channels`, `/helix/search/categories`. Anything else is answered
  `error: "blocked"` without a request.
  The plugin validates the token once (`https://id.twitch.tv/oauth2/validate`,
  `Authorization: OAuth <token>`) and caches `{client_id, user_id, login, scopes}` per token;
  Helix requests then use `Client-Id` + `Authorization: Bearer …`. A 401 drops the cache.
  `/helix/channels/followed` defaults `user_id` to the validated user. The plugin's `/identity`
  route answers user id, login, client id and scopes from the cached validate call, with no
  Helix round trip. Requests time out after 10 s and bodies are capped at 4 MiB; only the
  host/path and status are logged, never headers. The allowlist and transport discipline live
  in `lib/helix.js`, shared by the player entry and the standalone global entry.
* **Opening a stream or VOD.** The browser posts `twt:open {url, target}`. Only
  `https://twitch.tv/…` and `https://www.twitch.tv/…` URLs are accepted (no other host, no
  credentials, no non-443 port). `target:"current"` calls
  `iina.mpv.command("loadfile", [url, "replace", "-1", "vid=auto,aid=auto"])`, so the stream
  replaces the current media without IINA's *Loading Media…* window. The per-file options come
  after the watch-later file in mpv, so a saved `vid=no` (which makes IINA's yt-dlp plugin
  resolve `bestaudio/best`, i.e. a black window) cannot stick; `mute` and `volume` are not
  touched. Consequences: IINA's own title, history and “now
  playing” bookkeeping is not updated for that load; `mpv.path.changed` is the primary signal
  that the new media started; and if `mpv.end-file` arrives and the player is idle after a
  short grace period, the plugin logs the failure, shows `the URL could not be opened` and
  releases the channel so chat goes idle. A natural end of playback keeps the media loaded and
  is left alone. `target:"new"` goes through IINA instead: it is forwarded to `global.js` over
  `iina.global.postMessage` (`twt:open-new-player {url}`) because only the global entry exposes
  `iina.global.createPlayerInstance`, and a new window has to load through IINA. The plugin does
  not resolve stream URLs: actual playback needs yt-dlp/streamlink configured in IINA, and a
  refusal is reported on the OSD.
* **HTTP bridge for emote lists.** A web view's `fetch` from a `file://` origin is frequently
  blocked cross-origin, which is exactly what the third-party emote lists need. The sidebar
  sends `twt:http-get {id, url}` and the plugin answers with
  `twt:http-result {id, ok, status, text, error}`. Only `https://` URLs whose host matches
  `allowedDomains` (mirrored in `main.js ALLOWED_HOSTS`) are served — it is a bridge for
  those lists, not an open proxy — `http.get(url, {})` is wrapped in a 10 s timeout driven by
  the plugin's `setTimeout`, response bodies are truncated at 8 MiB (7TV's per-channel emote
  set alone measured 2,321,907 B) and never logged (only host, status and byte count).
* **Overlay load ordering.** IINA flips `pluginInstance.overlayViewLoaded` inside
  `DispatchQueue.main.async` *after* `overlay.loadFile`, and `postMessage()`/`show()` are no-ops
  until it is true. `main.js` therefore only calls `loadFile` in the plugin script and then runs
  a bounded retry ladder (0 → 250 → 1000 → 2500 ms) that re-registers the message handlers and
  re-posts settings + emote index on each rung, stopping as soon as the view reports
  `twt:ready`. Re-registering is safe because IINA's `addListener` replaces the callback per
  name.
* **Emote index for the overlay.** The sidebar fetches the emote lists; the resulting
  name→URL map is cached in `state.emoteIndex` and re-sent as `twt:emotes` on every overlay
  `twt:ready`, next to the message backlog replay, and whenever `broadcastSettings()` runs.
* **Switching channel clears the overlay.** `announceChannelChange()` empties `state.recent`
  and posts `twt:clear {channel}` to the sidebar *and* the overlay before anything about the
  new channel is sent. `requestLeave()` does the same and posts `twt:part` before the chat
  goes idle.
* **Module loading is once, at load.** IINA's `require()` force-unwraps
  `pluginInstance.currentFile`, which is `nil` in any timer or promise callback, so requiring
  a module lazily from an async callback traps (`EXC_BREAKPOINT`). `lib/config.js` and
  `lib/irc.js` are therefore required at module load.
* **Chat history is local, with an opt-in remote pre-fill.** The last **50 messages per
  channel**, at most **20 channels**, are serialised to `@data/history.json` (≤ 512 KB,
  debounced writes after 2 s of quiet, on channel change and on window close). The transport
  asks once per room id: `twt:history-request {id, channel, roomId, count}` →
  `twt:history-result {id, channel, ok, source, messages, error}`, with `source: "cache" |
  "remote"`. With `history_remote` on (default **off**) an empty cache is pre-filled from
  `recent-messages.robotty.de`; the request carries only the public channel login, never the
  OAuth token. Every callback is generation- and teardown-guarded.
* **Crash-avoidance rules.** IINA keeps plugin menu items as `unowned` `NSMenuItem`s, so writing
  `.title`, `.selected` or `.enabled` on a live item traps in Swift (observed SIGABRT). The plugin
  therefore builds its four-item player menu once at boot and never mutates an item in place
  (the global entry builds its own one-item menu the same way). The chat
  renderer appends each event to the DOM in the same task — no queue, coalescing timer or delayed
  flush — so no render timer can fire against a torn-down window. Showing or hiding the overlay
  only calls `show()`/`hide()` and `setClickable()`; `ensureOverlayLoaded()` loads the web view
  once, so a toggle never reloads a live view.
* **VOD chat replay** (below) is a separate, lazy source that uses Twitch's undocumented GQL
  endpoint and never touches the live IRC stream.
* Text safety: IINA forwards a plugin → web view payload by evaluating
  ``window.iina._emit(`name`, String.raw`<json>`)``, so a backtick or `${` in the JSON breaks
  the evaluation and the view silently never receives the message. `lib/webview.js` therefore
  base64-encodes any string containing either sequence (`{__b64: …}`), and `ui/protocol.js`
  decodes it in the web view; everything else travels as plain JSON. Web view → plugin traffic
  goes through `JSON.stringify` and needs no escaping.
* XSS: every node is created with `createElement`/`textContent`; chat text, display names,
  badge names, channel names and every browser-provided title/description are never written
  to `innerHTML`.
* The plugin script is ES2017 (JavaScriptCore): no `window`, `fetch`, `localStorage`,
  optional chaining or top-level `await`.

### Twitch browser

The sidebar has six tabs. Each browse tab owns its response cache, its view stack and its search
query; switching tabs only hides/shows panes, so it does not re-render or refetch. Back and Escape
pop only the active tab's stack, and the refresh button drops only the active tab's cache. The tab
strip scrolls horizontally. Every API call goes through the proxy above and therefore needs a
token; without one the affected pane shows the *No token* card with *Retry*. Chat in the overlay
does not need a token.

The connection indicator (`connected as …` / read-only, plus the dot) is a **pinned footer**, the
last child of the sidebar shell; only the active pane scrolls.

| Tab / view | Requests | Notes |
| --- | --- | --- |
| Following | `/helix/channels/followed?user_id=<id>&first=100`, one batched `/helix/users?login=…` for avatars, one batched `/helix/streams?first=<page>&user_login=…` for live state; `after=<cursor>` for Load more | needs `user:read:follows`. Sorted as one accumulated list: live channels by `viewer_count` descending (ties by name), then offline channels by name A→Z; the name comparison is case-insensitive (login as tie-break), so paging never leaves an unsorted tail |
| Top | `/helix/streams?first=30` | thumbnail + name/title/category/viewers/uptime; row opens the channel page, the *Watch* affordance opens the stream |
| Categories | `/helix/games/top?first=30`; with a query `/helix/search/categories?query=…&first=20` | the search field filters categories. Rows show **no viewer count**: `/helix/games/top` has none, and there is no bounded Helix call that yields a category total. The list keeps Twitch's own popularity order |
| Category streams | `/helix/streams?first=30&game_id=<id>` (opened from a category row) | |
| Search | `/helix/search/channels?query=…&first=20` | channel search only; a result opens the channel page |
| Videos | `/helix/channels/followed?user_id=<id>` then one archive page per channel: `/helix/videos?user_id=<id>&type=archive&first=10` | bounded fan-out: at most 12 channels, 4 requests in flight, 10 videos per channel, merged/deduped and capped at 60, newest first. The field filters those videos by title, channel display name or login (case-insensitive) and never searches beyond the followed channels. **Helix has no VOD text search**, so this is not a search of all of Twitch |
| Channel page | `/helix/users?login=…`, `/helix/streams?user_login=…`, `/helix/videos?user_id=<id>&type=<archive|highlight|upload>&first=20` (+ `after=<cursor>`) | avatar, display name, `#login`, description; live block with thumbnail/viewers/uptime, or “Offline right now”; a paged VOD list with a type selector |
| Settings | none | palette, theme, message/emote/buffering overrides, filter switches, config summary |
| Identity | `/identity` | cached validate result: login, user id, client id, scopes |

Following and Videos wait for `/identity`; a missing/invalid token or a missing user id renders
the corresponding error card and *Retry*.

Clicking a channel row (avatar/name) opens that channel's page inside the sidebar; the *Watch*
affordance on a live row opens the stream. A VOD row opens
`https://www.twitch.tv/videos/<id>`. A plain click opens in the active player window;
⌘-click or middle-click sends `target:"new"`. Category and followed-channel rows navigate instead
of opening a player. Responses are cached per tab until refresh; a request that gets no reply
within 12 s is reported as a timeout.

**VOD thumbnails.** A VOD row uses `thumbnail_url` unless it is empty or carries Twitch's
processing marker (`_404/404_processing_`, case-insensitive in template or resolved form); that
URL is never requested. In both cases the row uses the live channel's `/helix/streams` thumbnail
while the channel is broadcasting, and a placeholder when it is not; the live lookups are
batched once per page. Every image goes through the host guard
(`static-cdn.jtvnw.net`, `vod-secure.twitch.tv`, `*.jtvnw.net`); anything else renders as a
placeholder. If a Twitch-hosted VOD thumbnail still fails to load, the box swaps **once** to the
live preview when one is available, then falls back to the placeholder.

### VOD chat replay

**There is no supported Twitch API for VOD chat.** Helix has no endpoint that returns the
comments of a past broadcast, and EventSub/IRC only carry the live stream. The plugin
therefore reads a VOD's comments from Twitch's **undocumented GQL endpoint**: a `POST` to
`https://gql.twitch.tv/gql` with the public web client id
(`kimne78kx3ncx6brgo4mv6wki5h1ko`), operation `VideoCommentsByOffsetOrCursor` and a
persisted-query hash. **No `Authorization` header is ever sent.** That is not part of
Twitch's public API and may break if Twitch rotates the endpoint or hash.

The VOD id is detected from `core.status.url`, the mpv path/file name/media title or a
playlist entry via `videos/<digits>` or `player.twitch.tv/?video=v<id>`. The match must be
Twitch-sourced: a bare title is only trusted when another candidate of the same media
carries a Twitch marker. Channel detection still runs normally; a detected channel labels
the replay (the plugin reports VOD mode as `vodReplay`, replaces `channelNote` with
`VOD chat replay` and counts pages/comments in `vodStats`). IINA can report the new media's
URL before it parses its title, and a VOD URL carries only the video id, so while a replay is
active the decision ladder keeps watching the detection inputs and re-runs when the title
settles — the label follows the VOD's channel instead of the stream watched before it. The
overlay header shows the observed channel with the note — `#channel (VOD chat replay)` — or the
note alone when the channel title is hidden.

Replay is tied to the playhead and paged **forward** from it:

* the first page is requested at `floor(position)` seconds, later pages by **offset
  stepping** - the next request asks for one second past the newest comment the last page
  held (cursor paging is rejected by Twitch, and pages start a few seconds before the
  requested offset, so they overlap and the comment ids are deduped);
  one request is in flight at a time and requests are at least 250 ms apart;
* the next page is prefetched only when less than 20 s of buffered comments remain and
  fewer than 180 comments are buffered;
* a backwards seek or a forward jump of more than 15 s discards the buffer, bumps a
  generation (dropping in-flight answers) and refetches from the new offset;
* the replay ends when `pageInfo.hasNextPage` is false, when a page brings no new comment
  id, when the offset passes the media duration, or when Twitch answers the past-the-end
  `service error` envelope;
* HTTP 429 retries after 2 / 4 / 8 s (three attempts); any other failure gives up once
  (`vodError` in the state payload, the OSD `VOD chat replay unavailable`, no chat at all);
* a 1 s tick emits every buffered comment the playhead has reached, and a page that lands
  triggers an immediate pass. Each comment is sent once as an ordinary `kind:"message"`
  event with `replay:true`, `offsetSeconds`, code-point-mapped emotes, badges and colour;
  ids are deduped.

While a VOD is replaying, live `twt:event` traffic is not relayed and a live
`twt:history-result` **for the replayed channel** is refused with `vod chat replay active`;
the IRC socket stays connected so room-id and emote sets still arrive. If the title carries no
channel name (a VOD URL has no login), the replay's `video.creator.id` travels to the sidebar as
`vodOwnerId` and the channel emote sets are fetched by id without an IRC join; Twitch-native
emotes keep rendering from the GQL emote tags. The overlay is cleared once when replay
starts and once when it stops. The replay starts and stops automatically with the playing
media; `vod_chat_replay` (default **on**) disables it entirely.

If a page fails, the plugin logs one warning, shows the OSD `VOD chat replay unavailable`,
shows no chat, and **stays in VOD mode** so live chat cannot leak in; a seek retries.

For an in-flight VOD a replayed comment shows the offset into the VOD — e.g. `10:18`, the point in
the broadcast at which the comment was originally sent — and never a wall-clock time. The original
comment's wall clock is not recoverable from the data the plugin has (a replay event carries only
the offset; its `timestamp` is the replay moment), so the offset is the canonical “original time”.
Live rows keep their own single timestamp.

### Files

| Path | Purpose |
| --- | --- |
| `Info.json` | plugin manifest: main entry, `globalEntry`, sidebar tab, preferences page + defaults, help page, permissions (`show-osd`, `video-overlay`, `file-system`, `network-request`) and `allowedDomains` |
| `main.js` | plugin entry: config, preferences, menus, shortcuts, OSD, stream-bound channel detection, VOD chat replay (GQL), web view relay, Twitch API proxy, `twt:open` handling |
| `global.js` | global entry: new-player creation (`createPlayerInstance`) and the standalone Twitch window (`iina.standaloneWindow`, `Open Twitch Window` ⌘⇧W), plus the shared Helix proxy/token for that window |
| `ui/sidebar.html`, `ui/browser.js` | sidebar shell, six tabs (Following, Top, Categories, Search, Videos, Settings) with per-tab stacks/caches/queries, the Twitch browser and its sorting/search/fan-out rules, pinned status footer |
| `ui/standalone.html` | standalone browser window: the same `ui/browser.js` with the five browse tabs, no Settings pane and no IRC transport |
| `ui/transport.js` | sidebar's IRC transport: connects, joins/parts the bound channel, forwards state/events to the plugin; no chat rendering |
| `ui/browser.css` | sidebar chrome and browser rows |
| `ui/overlay.html`, `ui/overlay-view.js` | video overlay shell + passive chat rendering; the only chat display |
| `ui/chat-view.js` | shared renderer used by the overlay: badges, emotes, timestamps, colours, bits, `/me`, sub/raid notices, `clearchat`/`clearmsg`, filters, message cap, autoscroll with “jump to bottom” |
| `ui/chat.css` | shared styles: light/dark (system + forced theme), the four palettes, overlay panel |
| `ui/protocol.js` | web view side of the message protocol (base64 text decode) |
| `ui/preferences.html` | IINA settings page (config path, auto-join, remote history, Keychain token, appearance/filter overrides, status) |
| `ui/help.html` | in-app help page (`helpPage`) with the same content as this section's menu table |

### Permissions and domains

`permissions`: `show-osd` (OSD messages), `video-overlay` (drawing over the video),
`file-system` (reading the config, `utils.exec("/usr/bin/env")` for `TWT_CONFIG`/`HOME`),
`network-request` (required for `iina.http`: the Twitch API proxy, the emote lists and the
optional remote history).

`allowedDomains`: `irc-ws.chat.twitch.tv`, `twitch.tv`, `*.twitch.tv` (which covers
`api.twitch.tv` and `id.twitch.tv`), `*.jtvnw.net` (badges + Twitch emotes), `api.betterttv.net`,
`cdn.betterttv.net`, `7tv.io`, `api.7tv.app`, `cdn.7tv.app`, `api.frankerfacez.com`,
`cdn.frankerfacez.com`, and `recent-messages.robotty.de` (only for the opt-in
`history_remote` pre-fill).

---

## Diagnostics

Add `--enable-logging` to IINA's launch (or enable *Advanced settings* → *Enable logging* in IINA's
settings) and watch **Window → Log Viewer**, subsystem `player<n> - Twitch`. The plugin's own
lines are prefixed `[twitch-chat]` (the global entry logs `[twitch-chat/global]`); IINA's plugin
host adds `Loading JS plugin from …`, `Loaded JS plugin: Twitch <version>` and
`Plugin is running`.

| Line | Meaning |
| --- | --- |
| `[twitch-chat] Twitch v<version> loading` | the plugin script booted; missing ⇒ the plugin is disabled in IINA → Settings → Plugins, or `Info.json`/`main.js` failed to load |
| `[twitch-chat] config loaded <path> (+filters.txt)` | the twt config was found and parsed; `config missing <path>` means no config file was found |
| `[twitch-chat] sidebar ready` | the sidebar web view's JavaScript is running and reported in — **this is the line that proves the chat transport exists**; it appears even when the sidebar was never opened |
| `[twitch-chat] the sidebar web view has not reported ready - reloading it once` | the web view did not come up; the plugin reloads it once and then says `still not ready: chat cannot connect until the Twitch tab is opened` |
| `[twitch-chat] sidebar: irc: >> CAP REQ :twitch.tv/tags twitch.tv/commands` / `>> NICK justinfanNNNNN` / `>> JOIN #channel` | the web view's IRC client is connecting and joining (`PASS oauth:<redacted>` for an authenticated connection — the token itself is never logged) |
| `[twitch-chat] channel decision: detected #x from <source> (…, leaving #y)` / `channel decision: no channel (…)` | which rule bound the channel, or that the playing video released it |
| `[twitch-chat] channel switch: clearing the message lists and the backlog for #x` | the explicit `twt:clear` to both views before the new channel's traffic |
| `[twitch-chat] leaving #x (the playing video has no Twitch channel)` | chat released and the overlay went idle |
| `[twitch-chat] history: #x -> <n> message(s) from cache` / `from remote` / `no cached history` | the answer to a `twt:history-request` |
| `[twitch-chat] history cache: restored <n> channel(s) from @data/history.json` / `… is unreadable, starting empty` | the persisted per-channel history cache |
| `[twitch-chat] http bridge: <host> -> <status> (<n> bytes)` / `blocked <url>` | an emote-list fetch (bodies are never logged) |
| `[twitch-chat] twitch api: <host><path> -> <status>` | a sidebar API request served by the proxy; `blocked <path>` is an unlisted path |
| `[twitch-chat] vod replay: watching video <id> from <n>s (undocumented Twitch GQL endpoint)` | VOD replay started at the current playhead |
| `[twitch-chat] vod replay: gql -> <status>` / `rate limited, retrying in <n>ms` / `seek to <n>s, refetching` | a GQL page was fetched, a 429 backoff was scheduled, or a seek reset the window |
| `[twitch-chat] vod replay: stopped (<reason>) - video <id>` | the playing media is no longer that VOD (or replay was switched off) |
| `[twitch-chat] vod chat replay unavailable (<code>: <detail>) - no chat is shown for this VOD` | replay gave up (invalid query hash, rate limit, timeout, no comments, …); one warning, the OSD `VOD chat replay unavailable` and the same text in `vodError` |
| `[twitch-chat] open: rejected <url>` / `open: mpv refused the loadfile for <url>` | a `twt:open` request was not a twitch.tv URL, or mpv refused the fast-switch load |
| `[twitch-chat] open: <url> did not load (mpv ended the file and nothing is playing)` | the fast-switch load failed; the OSD says `the URL could not be opened` and the channel is released |
| `[twitch-chat/global] opened a player window for <url> (id <n>)` / `(id <n>, requested as "new")` | the global entry created a new player window (from the sidebar or the standalone browser) |
| `[twitch-chat] sidebar: chat is flowing: forwarded the first message in #<channel>` | a real chat message reached the relay — the end-to-end proof that the transport, the relay and the overlay are working |
| `[twitch-chat] sidebar: irc: >> PING` | the connection is alive: driven by `keepalive_timeout_seconds` while the sidebar is open, and by a poke of the hidden view when the connection has been idle |
| `[twitch-chat] sidebar quiet for <n>s; poking it (#<n>)` | normal while the overlay is hidden: the plugin poked the suspended web view and the view answered |
| `[twitch-chat] the sidebar web view is not answering pokes` | three pokes in a row went unanswered: chat has stopped updating — show the overlay or open the sidebar to wake the web view |
| `[twitch-chat] call failed: …` | an IINA API rejected a call (the message names the API) |
| `Twitch: joined #channel (from the playing video)` (OSD) | automatic detection bound a channel; the matching log line is `channel decision: detected #channel from …` |
| `Twitch: no Twitch channel detected in the playing video` (OSD) | Connect was pressed with no channel bound; load a Twitch stream |

## Limitations

* Read-only: there is no message composer anywhere, so a token cannot be used to send
  messages. Without a token chat is anonymous and read-only; with one only the Twitch browser
  and the IRC authentication gain from it.
* Whisper messages (IRC `WHISPER`, or a message tagged `whisper=1`) are rendered with a
  `whisper` chip, but there is no whisper UI.
* The filter *patterns* are read-only inside IINA: the plugin never writes to `config.toml` or
  `filters.txt`. Only the on/off switches can be overridden.
* The overlay has no chat controls: the panel is interactive for its header (move) and its edges
  and corners (resize) and for scrolling, and everything outside it is click-through — appearance,
  emote and filter settings live in the sidebar's Settings tab and in IINA's settings. The panel
  is moved/resized through those affordances and the arrangement is remembered per channel (see
  [Overlay layout](#overlay-layout)).
* Emote lists (BetterTTV/7TV/FFZ) are fetched by the sidebar and shared with the overlay; if
  a provider is unreachable the toggle simply has no effect (the failure is logged). Those
  toggles default to **off** (twitch-tui's defaults), so emote *images* only appear once they
  are switched on — badges, timestamps and colours work regardless.
* `twitch.tv/videos/<id>` VOD URLs contain no channel name, so for a VOD the title heuristic
  is the only signal for binding live chat; when it finds nothing, no live channel is bound.
  VOD chat itself comes from the replay source described above (it needs only the VOD id).
* **VOD chat replay has no supported API and may break.** It uses Twitch's undocumented GQL
  endpoint (`VideoCommentsByOffsetOrCursor` with the public web client id), which Twitch can
  change or restrict at any time; a rejected persisted-query hash ends the replay. Live chat
  is suppressed while a VOD plays. A failure shows no chat and stays in VOD mode.
* A chat web view that is never shown is throttled by WebKit (see the architecture section):
  the plugin works around it by poking the view, but a view that has been suspended for a very
  long time can still need the overlay or sidebar to be shown once. Chat is unaffected while
  the overlay is visible.
* IINA only shows the first five first-level plugin menu items, and `utils.resolvePath("~")`
  rejects a bare `~` (only `~/…` is expanded) — both are worked around in `main.js`.
* `MenuItem.addSubMenuItem` is the real method name
  (`iina/JavascriptPluginMenuItem.swift`; the plugin type definitions agree, while the *example*
  in IINA's API docs spells it `addSubmenuItem`). `main.js` accepts either and falls back to a
  top-level item, so a rename cannot silently swallow the Config menu.
* A caught IINA API error is not fully benign: JavaScriptCore keeps `JSContext.exception` set, and the
  next bridge call can fail too. That is why the plugin avoids generating them in the first place
  (arity-checked calls, feature detection) rather than relying on `try`/`catch` alone.
* The IRC client's outbound log lines are redacted (`PASS oauth:<redacted>`) before they reach IINA's
  log, and the token is never placed in the overlay's payload, the status strings or any log line.
