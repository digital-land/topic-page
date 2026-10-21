PYTHON := .venv/bin/python

.PHONY: data serve format

data:
	$(PYTHON) build.py

serve:
	$(PYTHON) server.py

format:
	.venv/bin/black *.py
