# Twitch for IINA - build helpers.
#
#   make build   stage dist/Twitch.iinaplugin/ and pack it to dist/Twitch.iinaplgz
#   make verify  replay IINA 1.5.0's installer unpack + validation against the archive
#   make check   syntax-check main.js, global.js, lib/*.js, ui/*.js and Info.json (needs node)
#   make test    run the library test suite (npm test)
#   make link    symlink this folder into IINA's plugin folder as *.iinaplugin-dev
#   make unlink  remove that symlink
#   make clean   remove dist/
#
# Package layout (verified against IINA 1.5.0 source):
#   IINA/Plugin/JavascriptPlugin.swift, create(fromPackageURL:), runs
#       cp <pkg> <tmp>.zip && mkdir <tmp> <tmp>-1 && unzip <tmp>.zip -d <tmp>-1 &&
#       mv <tmp>-1/* <tmp>/
#   and then calls JavascriptPlugin(filename: <tmp>), whose init?(filename:) returns nil
#   unless <tmp>/Info.json exists and decodes with name, author.name, identifier,
#   version and entry (the entry file must exist too).  So the plugin contents MUST sit
#   at the archive root; wrapping them in Twitch.iinaplugin/ leaves Info.json one
#   level down and makes the installer report "IINA cannot load this plugin. It might
#   be in the wrong format." (the .cannotLoadPlugin error).
#
#   IINA's own `iina-plugin pack` runs `zip -ryq . -x 'node_modules/*' -x '.*'` inside the
#   plugin folder, i.e. it stores the contents at the root.  `make build` does the same with
#   Info-ZIP from inside the staged folder (`zip -r -X -q -y`), so it does not depend on
#   /Applications/IINA.app, and `make verify` checks the result has that structure and
#   survives IINA's unpack command verbatim.
#
# Installing:
#   * IINA > Settings > Plugins > Install Local Package... and pick
#     dist/Twitch.iinaplgz.
#   * or copy/symlink dist/Twitch.iinaplugin/ into
#     ~/Library/Application Support/com.colliderli.iina/plugins/
#   * the plugin is disabled until it is enabled once in IINA > Settings > Plugins.

PLUGIN_NAME  := Twitch
DIST_DIR     := dist
BUNDLE       := $(DIST_DIR)/$(PLUGIN_NAME).iinaplugin
ARCHIVE      := $(DIST_DIR)/$(PLUGIN_NAME).iinaplgz

PLUGIN_DIR   := $(HOME)/Library/Application Support/com.colliderli.iina/plugins
LINK_NAME    := iina-twitch-chat.iinaplugin-dev

# Everything the plugin needs at runtime, in archive order. `lib` belongs to the
# pure-logic modules; it is packaged when present.
PACKAGE_FILES := Info.json main.js global.js ui lib README.md CHANGELOG.md

.PHONY: all build verify pack-check check test link unlink clean

all: build

build:
	@rm -rf "$(BUNDLE)" "$(ARCHIVE)"
	@mkdir -p "$(BUNDLE)"
	@staged=""; \
	for entry in $(PACKAGE_FILES); do \
		if [ -e "$$entry" ]; then \
			cp -R "$$entry" "$(BUNDLE)/"; \
			staged="$$staged $$entry"; \
		else \
			echo "warning: $$entry is missing, skipping"; \
		fi; \
	done; \
	if [ -z "$$staged" ]; then echo "nothing to package" >&2; exit 1; fi; \
	find "$(BUNDLE)" \( -name '.DS_Store' -o -name '._*' \) -delete; \
	( cd "$(BUNDLE)" && zip -r -X -q -y "../$(PLUGIN_NAME).iinaplgz" $$staged ) || exit 1
	@echo "==> $(ARCHIVE)"
	@$(MAKE) --no-print-directory verify
	@unzip -l "$(ARCHIVE)"

# Replay exactly what JavascriptPlugin.create(fromPackageURL:) does, then apply the
# checks from JavascriptPlugin.init?(filename:).  Fails loudly on the old wrapped layout.
verify:
	@test -f "$(ARCHIVE)" || { echo "verify: $(ARCHIVE) not found - run 'make build' first" >&2; exit 1; }
	@set -eu; \
	tmp=$$(mktemp -d "$${TMPDIR:-/tmp}/iina-verify.XXXXXX"); \
	trap 'rm -rf "$$tmp"' EXIT INT TERM; \
	mkdir -p "$$tmp/plugins"; \
	cp "$(ARCHIVE)" "$$tmp/plugins/.temp.zip"; \
	( cd "$$tmp/plugins" && mkdir .temp .temp-1 && unzip -q .temp.zip -d .temp-1 && mv .temp-1/* .temp/ ); \
	if [ ! -f "$$tmp/plugins/.temp/Info.json" ]; then \
		echo "verify: FAIL - Info.json not at the installer's temp root (archive wraps the plugin?)" >&2; exit 1; \
	fi; \
	have=$$(unzip -Z1 "$(ARCHIVE)" | LC_ALL=C sort); \
	want=$$( cd "$(BUNDLE)" && { \
		for d in $$(find . -mindepth 1 -type d); do echo "$${d#./}/"; done; \
		for f in $$(find . -mindepth 1 -type f); do echo "$${f#./}"; done; \
	} | LC_ALL=C sort ); \
	if [ "$$have" != "$$want" ]; then \
		echo "verify: FAIL - archive entries differ from the staged bundle" >&2; \
		echo "--- expected ---"; echo "$$want"; echo "--- archive ---"; echo "$$have"; exit 1; \
	fi; \
	if printf '%s\n' "$$have" | grep -Eq '(^|/)(__MACOSX|\.DS_Store|\._[^/]*)'; then \
		echo "verify: FAIL - archive contains macOS junk entries" >&2; exit 1; \
	fi; \
	node -e ' \
	  const fs = require("fs"), path = require("path"); \
	  const [file, root] = process.argv.slice(1); \
	  const bad = (m) => { console.error("verify: FAIL - " + m); process.exit(1); }; \
	  const j = JSON.parse(fs.readFileSync(file, "utf8")); \
	  for (const k of ["name", "identifier", "version", "entry"]) { \
	    if (typeof j[k] !== "string" || j[k].length === 0) bad("Info.json has no string " + k); \
	  } \
	  if (!j.author || typeof j.author.name !== "string" || j.author.name.length === 0) bad("Info.json has no author.name"); \
	  if (!j.identifier.split(".").every((s) => s.length > 0 && [...s].every((c) => /[A-Za-z0-9_-]/.test(c)))) bad("identifier is not reverse-DNS"); \
	  if (!fs.existsSync(path.join(root, j.entry))) bad("entry file " + j.entry + " is missing"); \
	  if (typeof j.globalEntry === "string" && j.globalEntry.length > 0 && !fs.existsSync(path.join(root, j.globalEntry))) bad("globalEntry file " + j.globalEntry + " is missing"); \
	  console.log("verify: Info.json required fields decode"); \
	' "$$tmp/plugins/.temp/Info.json" "$$tmp/plugins/.temp"; \
	for f in Info.json main.js global.js README.md CHANGELOG.md; do \
		cmp "$(CURDIR)/$$f" "$$tmp/plugins/.temp/$$f" || { echo "verify: FAIL - $$f differs from the working tree" >&2; exit 1; }; \
	done; \
	diff -r "$(CURDIR)/lib" "$$tmp/plugins/.temp/lib" >/dev/null || { echo "verify: FAIL - lib/ differs from the working tree" >&2; exit 1; }; \
	diff -r "$(CURDIR)/ui" "$$tmp/plugins/.temp/ui" >/dev/null || { echo "verify: FAIL - ui/ differs from the working tree" >&2; exit 1; }; \
	echo "verify: installer layout, Info.json, entry and payload bytes OK"

# Historical name kept for scripts/docs.
pack-check: verify

check:
	node --check main.js
	node --check global.js
	@for file in lib/*.js; do node --check "$$file"; done
	@for file in ui/*.js; do node --check "$$file"; done
	node -e 'JSON.parse(require("fs").readFileSync("Info.json","utf8")); console.log("Info.json OK")'
	node -e 'const i=JSON.parse(require("fs").readFileSync("Info.json","utf8")); for (const k of ["name","version","identifier","author","entry"]) if (!i[k]) { console.error("Info.json: missing "+k); process.exit(1); } console.log("Info.json fields OK")'

test:
	npm test

link:
	mkdir -p "$(PLUGIN_DIR)"
	rm -rf "$(PLUGIN_DIR)/$(LINK_NAME)"
	ln -s "$(CURDIR)" "$(PLUGIN_DIR)/$(LINK_NAME)"
	@echo "==> linked $(CURDIR) as $(LINK_NAME); restart IINA to reload"

unlink:
	rm -f "$(PLUGIN_DIR)/$(LINK_NAME)"
	@echo "==> removed $(LINK_NAME)"

clean:
	rm -rf "$(DIST_DIR)"
