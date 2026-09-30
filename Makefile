IMAGE ?= study-cards
TAG   ?= latest

.PHONY: help serve validate lint test build run smoke clean

help:
	@echo "targets: serve validate lint test build run smoke clean"

serve:
	python3 -m http.server 8000

validate:
	python3 scripts/validate_deck.py data/*.txt

lint:
	node --check js/app.js
	node --check js/scheduler.js

test:
	node scripts/test_scheduler.js

build:
	docker build -t $(IMAGE):$(TAG) .

run: build
	docker run --rm -p 8080:80 $(IMAGE):$(TAG)

smoke:
	bash scripts/smoke_test.sh $(IMAGE):test

clean:
	-docker rm -f $$(docker ps -aq --filter name=study-cards-smoke) 2>/dev/null
