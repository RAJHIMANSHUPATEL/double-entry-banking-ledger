.PHONY: run test seed migrate demo lint

run:
	docker compose up --build

test:
	npm test

seed:
	npm run seed

migrate:
	npm run migrate

demo: migrate seed

lint:
	npm run lint
