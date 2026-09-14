# Hermit console
#
# The app binds to an OS-assigned free port, so nothing here is hard-coded.
# PIDs live in .run/, which is what lets `make down` work from a terminal that
# never ran `make up`.

SHELL := /bin/bash
NODE  := node
RUN   := .run
STAMP := node_modules/.install-stamp

# Where backup/restore read and write. Override on the command line, e.g.
# `make backup DATA_DIR=/some/data`.
DATA_DIR      ?= $(CURDIR)/data
BACKUP_DIR    ?= $(CURDIR)/backups
NEWEST_BACKUP  = $(shell ls -1t $(BACKUP_DIR)/hermit-backup-*.tar.gz 2>/dev/null | head -1)

# Recursive (=) so the version is read only when a recipe uses it, keeping
# make help working on a machine without Node installed.
VERSION = $(shell $(NODE) -p "require('./package.json').version")

.DEFAULT_GOAL := help
.PHONY: help up down restart status logs dev build install clean reset backup restore open secret publish release

help: ## Show this help
	@echo "Hermit console"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'
	@echo

$(STAMP): package.json package-lock.json
	@npm install
	@mkdir -p node_modules && touch $(STAMP)

install: $(STAMP) ## Install dependencies

build: install ## Build the web UI
	@npx vite build

up: build ## Start the app in the background on a free port
	@$(NODE) scripts/start.mjs

dev: install ## Start with hot reload (also backgrounded; stop with make down)
	@$(NODE) scripts/start.mjs --dev

down: ## Stop whatever is running
	@$(NODE) scripts/stop.mjs

restart: ## Stop then start
	@$(MAKE) --no-print-directory down
	@$(MAKE) --no-print-directory up

status: ## Show pids, the URL and a health check
	@$(NODE) scripts/status.mjs

logs: ## Follow the server log
	@tail -n 80 -f $(RUN)/*.log

open: ## Open the running app in a browser
	@url=$$(cat $(RUN)/url 2>/dev/null); \
	if [ -z "$$url" ]; then echo "Not running. Try 'make up'."; exit 1; fi; \
	echo "Opening $$url"; \
	( command -v open >/dev/null && open "$$url" ) || ( command -v xdg-open >/dev/null && xdg-open "$$url" )

clean: ## Remove build output and run state
	@rm -rf web/dist $(RUN)
	@echo "Removed web/dist and $(RUN)"

reset: clean ## Also drop the local database and cache
	@rm -f data/db.json data/cache.json
	@echo "Removed data/db.json and data/cache.json"

backup: ## Back up db.json and cache.json to backups/hermit-backup-<timestamp>.tar.gz
	@$(NODE) bin/hermit.mjs backup --data-dir "$(DATA_DIR)" --out "$(BACKUP_DIR)"

restore: ## Stop the app, then restore the newest backup (or FILE=<path>) into data/
	@file="$(if $(FILE),$(FILE),$(NEWEST_BACKUP))"; \
	if [ -z "$$file" ]; then \
		echo "No backup found in $(BACKUP_DIR). Run 'make backup' first, or pass FILE=<path>."; exit 1; \
	fi; \
	if [ ! -f "$$file" ]; then echo "Backup not found: $$file"; exit 1; fi; \
	$(MAKE) --no-print-directory down || exit 1; \
	$(NODE) bin/hermit.mjs restore "$$file" --data-dir "$(DATA_DIR)" --force || exit 1; \
	echo "Run 'make up' to start with the restored data."

secret: ## Set the NPM_TOKEN repo secret from the ~/.authinfo npm token
	@$(NODE) scripts/set-npm-secret.mjs

publish: ## Choose a version and publish to npm (token from ~/.authinfo)
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "Working tree is not clean - commit first so the tarball matches git."; exit 1; \
	fi
	@$(NODE) scripts/publish-npm.mjs
	@$(NODE) scripts/set-npm-secret.mjs --if-possible

release: ## Tag the current version and push the tag (runs the release workflow)
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "Working tree is not clean - commit first so the tag matches what you see."; exit 1; \
	fi
	@$(NODE) scripts/set-npm-secret.mjs --if-possible
	@tag="v$(VERSION)"; \
	if git rev-parse -q --verify "refs/tags/$$tag" >/dev/null; then \
		echo "Tag $$tag already exists."; exit 1; \
	fi; \
	git tag -a "$$tag" -m "Hermit $$tag"; \
	git push origin "$$tag"; \
	echo "Pushed $$tag - the release workflow builds hermit.tgz and publishes to npm if NPM_TOKEN is set."
