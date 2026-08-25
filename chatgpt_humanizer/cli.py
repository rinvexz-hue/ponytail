#!/usr/bin/env python3
"""
Simple CLI for the ChatGPT Humanizer.

Three modes:
- model=openai    : uses the OpenAI python client if OPENAI_API_KEY is provided.
- model=claude    : uses the Anthropic python client if ANTHROPIC_API_KEY is provided.
- model=fallback  : runs a tiny heuristic local "humanizer" (contractions, split sentences).

Usage:
  python -m chatgpt_humanizer.cli --model openai --tone friendly -f chatgpt_humanizer/examples/input.txt
  python -m chatgpt_humanizer.cli --model claude --tone friendly -f chatgpt_humanizer/examples/input.txt
  cat chatgpt_humanizer/examples/input.txt | python -m chatgpt_humanizer.cli --model fallback --tone casual
"""
import os
import sys
import argparse
import re

PROMPT_TEMPLATE = """You are a human-sounding copy editor. Rewrite the text below so it sounds natural, conversational, and distinctly human while keeping the original meaning and accuracy.

Rules:
- Use contractions and natural phrasing where appropriate.
- Vary sentence length and rhythm; avoid long monotone sentences.
- Prefer active voice and concrete details.
- Add small human touches: rhetorical questions or a brief relatable example when it fits.
- Preserve technical terms and legal text by default.

Tone: {tone}
Length change: {length}

--- Paste the text to humanize below this line ---
{text}
"""

DEFAULT_LLM_MODEL = {
    "openai": "gpt-4",
    "claude": "claude-sonnet-5",
}

CONTRACTIONS = {
    r"\bdo not\b": "don't",
    r"\bdoes not\b": "doesn't",
    r"\bwill not\b": "won't",
    r"\bis not\b": "isn't",
    r"\bare not\b": "aren't",
    r"\bcannot\b": "can't",
    r"\bwe are\b": "we're",
    r"\bI am\b": "I'm",
    r"\bI will\b": "I'll",
    r"\bI have\b": "I've",
}

def build_prompt(text: str, tone: str, length: str) -> str:
    return PROMPT_TEMPLATE.format(tone=tone, length=length, text=text.strip())

def fallback_humanize(text: str) -> str:
    # Very small local "humanizer": apply contractions, break very long sentences, and add a friendly opener
    out = text.strip()
    for pattern, repl in CONTRACTIONS.items():
        out = re.sub(pattern, repl, out, flags=re.IGNORECASE)
    # Break long sentences: insert newline for sentences > 120 chars at comma boundaries
    def split_long(s):
        if len(s) <= 120:
            return s
        parts = re.split(r"([,;:])", s)
        new = []
        curr = ""
        for p in parts:
            if len(curr) + len(p) > 100 and curr:
                new.append(curr.strip())
                curr = p
            else:
                curr += p
        if curr:
            new.append(curr.strip())
        return " ".join(new)
    out = ". ".join(split_long(s) for s in re.split(r"\.\s+", out))
    # Ensure short paragraphs
    out = "\n\n".join(p.strip() for p in out.split("\n\n"))
    return out

def call_openai_chat(prompt: str, model: str) -> str:
    try:
        from openai import OpenAI
    except Exception as e:
        raise RuntimeError("openai package is required for model=openai mode") from e
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set in environment")
    client = OpenAI(api_key=api_key)
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": "You are a helpful editor."}, {"role": "user", "content": prompt}],
        temperature=0.6,
        max_tokens=1024,
    )
    return resp.choices[0].message.content.strip()

def call_claude_chat(prompt: str, model: str) -> str:
    try:
        import anthropic
    except Exception as e:
        raise RuntimeError("anthropic package is required for model=claude mode") from e
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set in environment")
    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=model,
        max_tokens=1024,
        temperature=0.6,
        system="You are a helpful editor.",
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.content[0].text.strip()

def main(argv=None):
    p = argparse.ArgumentParser(description="ChatGPT Humanizer CLI")
    p.add_argument("--model", choices=["openai", "claude", "fallback"], default="fallback", help="LLM backend to use")
    p.add_argument("--tone", default="friendly", help="Tone preset (friendly, professional, casual, witty, empathetic, concise)")
    p.add_argument("--length", default="same", help="Length change (same / slightly shorter / slightly longer)")
    p.add_argument("--file", "-f", dest="file", help="Path to input file (or omit to read stdin)")
    p.add_argument("--llm-model", default=None, help="LLM model name (defaults to gpt-4 for openai, claude-sonnet-5 for claude)")
    args = p.parse_args(argv)

    if args.file:
        with open(args.file, "r", encoding="utf-8") as fh:
            text = fh.read()
    else:
        text = sys.stdin.read()

    if not text.strip():
        print("No input text provided", file=sys.stderr)
        sys.exit(2)

    prompt = build_prompt(text, args.tone, args.length)
    if args.model == "fallback":
        out = fallback_humanize(text)
        # Prepend one-line summary
        summary = f"Summary: applied contractions and sentence-splitting (tone={args.tone}, length={args.length})\n\n"
        print(summary + out)
        return

    llm_model = args.llm_model or DEFAULT_LLM_MODEL[args.model]
    caller = call_openai_chat if args.model == "openai" else call_claude_chat
    try:
        out = caller(prompt, model=llm_model)
        print(out)
    except Exception as e:
        print(f"Error calling remote model: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
