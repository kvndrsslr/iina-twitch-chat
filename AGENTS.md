# AGENTS.md

## What this is

IINA plugin (plain JavaScript, no build step) that shows Twitch chat over the video and in a
sidebar. `Info.json` is the manifest; `main.js` and `global.js` are the entries; `lib/` contains
the pure-logic modules; `ui/` contains the sidebar, overlay, browser and preferences pages;
`test/` holds the `node --test` suites.

## Build and test

- `make check` — `node --check` on the plugin and UI scripts, parse `Info.json`.
- `make test` — `npm test` (`node --test test/*.test.js`, 300+ tests, about 75 seconds).
- `make build` — stage `dist/Twitch.iinaplugin/`, pack `dist/Twitch.iinaplgz`, then run
  `scripts/verify-package.js` against the installer's unpacked layout.
- `gmake build` — run the same target with GNU make 4 when touching the Makefile; CI runs Ubuntu's
  GNU make 4, which handles recipe escaping differently from macOS's make 3.81. Keep helpers in
  `scripts/*.js`; do not embed multi-line `node -e` scripts in recipes.
- `make link` / `make unlink` — symlink/unlink this repo as an `.iinaplugin-dev` in
  `~/Library/Application Support/com.colliderli.iina/plugins` (restart IINA after).
- `dist/` is git-ignored; never commit it.

The `.iinaplgz` is a zip whose **contents sit at the archive root**: `Info.json` must be at the
root, not wrapped in a `Twitch.iinaplugin/` directory. IINA unpacks with
`unzip <pkg> <tmp>-1 && mv <tmp>-1/* <tmp>/` and then reads `<tmp>/Info.json`
(`JavascriptPlugin.create(fromPackageURL:)`).

## Installing

IINA → Settings → Plugins → *Install from GitHub…* → `kvndrsslr/iina-twitch-chat`. IINA uses the
latest release's `.iinaplgz`; the plugin stays disabled until enabled once in that pane.

## Releasing

`Info.json` drives both installation and auto-update:

- `ghRepo` must stay `kvndrsslr/iina-twitch-chat`.
- `ghVersion` is an integer. IINA fetches
  `https://raw.githubusercontent.com/<ghRepo>/main/Info.json` and prompts when the remote
  `ghVersion` is greater than the installed one.
- IINA installs a release asset whose name ends in `.iinaplgz` from the latest release.

Steps:

1. Update `CHANGELOG.md` (fold `Unreleased` into the new version).
2. Bump `version` (semver) and increment `ghVersion` in `Info.json`.
3. Commit and push `main`.
4. Tag `v<version>` — the tag must equal `Info.json`'s `version` — and push the tag.
5. The `Release` workflow (`.github/workflows/release.yml`) runs `make test` and `make build` on
   Ubuntu, then attaches `dist/Twitch.iinaplgz` to the GitHub release.
6. Verify with `gh release view v<version> -R kvndrsslr/iina-twitch-chat` and by downloading the
   asset without authentication.

A published tag is immutable. Ship fixes with a new `version` and a higher `ghVersion`; do not move
or reuse a released tag. Pushing only to `main` does not prompt installed users — that requires a
higher `ghVersion`, which is why it is bumped together with `version` at release time.
