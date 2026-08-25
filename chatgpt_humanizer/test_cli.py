"""Runnable self-check for chatgpt_humanizer.cli. No frameworks: `python -m chatgpt_humanizer.test_cli` (from repo root)."""
from chatgpt_humanizer.cli import build_prompt, fallback_humanize

prompt = build_prompt("We do not know.", tone="witty", length="same")
assert "Tone: witty" in prompt
assert "We do not know." in prompt

out = fallback_humanize("We do not know if I am ready.")
assert "don't" in out
assert "I'm" in out

print("ok")
