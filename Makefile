PYTHON := .venv/bin/python

.PHONY: data serve format

data:
	$(PYTHON) bin/build.py

serve:
	$(PYTHON) bin/server.py

format:
	.venv/bin/black bin/*.py
