# Hermit console
#
# The app binds to an OS-assigned free port, so nothing here is hard-coded.
# PIDs live in .run/, which is what lets `make down` work from a terminal that
# never ran `make up`.

SHELL := /bin/bash
NODE  := node
RUN   := .run
STAMP := node_modules/.install-stamp

.DEFAULT_GOAL := help
.PHONY: help up down restart status logs dev build install clean reset open

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
