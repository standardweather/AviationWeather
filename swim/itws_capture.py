"""Capture sample ITWS messages from your SCDS queue so the decoders can be built.

Run this in your own terminal. It asks for anything not set in the environment, and
reads the password with a hidden prompt, so it never appears on screen or in a file:

    python3 -m pip install -r swim/requirements.txt
    python3 swim/itws_capture.py --seconds 180

Samples are written to swim/samples/ (git-ignored, never committed or published).
At the end it prints a summary of message types — that summary is what to share.
Note: captured messages are acknowledged, so they leave your queue.
"""

import argparse
import collections
import getpass
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import scds  # noqa: E402

OUT = Path(__file__).parent / "samples"


def ask(name, secret=False):
    if os.environ.get(name):
        return os.environ[name]
    label = {"SCDS_HOST": "Connection URL (e.g. tcps://…:55443)", "SCDS_VPN": "Message VPN",
             "SCDS_USERNAME": "Username", "SCDS_PASSWORD": "Password", "SCDS_QUEUE": "Queue name"}[name]
    return (getpass.getpass if secret else input)(f"{label}: ").strip()


def describe(m):
    """A short label for a message: its XML root element plus any product-type property."""
    text = m.text()
    root = re.search(r"<(?:\w+:)?([A-Za-z_][\w.-]*)[\s>]", re.sub(r"<\?xml[^>]*\?>", "", text, count=1)[:2000])
    prop = next((f"{k}={v}" for k, v in m.properties.items() if re.search(r"type|product", str(k), re.I)), "")
    return f"{root.group(1) if root else 'non-XML'}{f' [{prop}]' if prop else ''}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seconds", type=int, default=180, help="how long to listen (default 180)")
    ap.add_argument("--max", type=int, default=2000, help="stop after this many messages")
    ap.add_argument("--keep", type=int, default=5, help="samples to keep per message type")
    ap.add_argument("--insecure", action="store_true", help="skip TLS certificate checks (only if the default fails)")
    args = ap.parse_args()

    config = {k: ask(k, secret=(k == "SCDS_PASSWORD")) for k in scds.FIELDS}
    OUT.mkdir(exist_ok=True)
    counts = collections.Counter()
    sizes = collections.defaultdict(list)
    index = (OUT / "index.jsonl").open("a")

    def on_message(m):
        kind = describe(m)
        counts[kind] += 1
        sizes[kind].append(len(m.payload))
        n = counts[kind]
        if n <= args.keep:
            safe = re.sub(r"[^\w.-]+", "_", kind)[:80]
            path = OUT / f"{safe}_{n}.xml"
            path.write_bytes(m.payload)
            index.write(json.dumps({"file": path.name, "kind": kind, "destination": m.destination,
                                    "properties": {k: str(v) for k, v in m.properties.items()}, "bytes": len(m.payload)}) + "\n")
        total = sum(counts.values())
        if total % 25 == 0:
            print(f"  {total} messages, {len(counts)} types…", flush=True)

    print(f"Listening for {args.seconds} s…", flush=True)
    t0 = time.time()
    try:
        scds.drain(config, seconds=args.seconds, max_messages=args.max, insecure=args.insecure, on_message=on_message)
    except Exception as e:
        print(f"\nConnection failed: {e}", file=sys.stderr)
        if not args.insecure and "certificate" in str(e).lower():
            print("If this is a certificate error, try again with --insecure.", file=sys.stderr)
        sys.exit(1)
    index.close()

    total = sum(counts.values())
    print(f"\nReceived {total} messages in {time.time() - t0:.0f} s. Samples are in {OUT}\n")
    print(f"{'count':>6}  {'avg KB':>7}  type")
    for kind, n in counts.most_common():
        print(f"{n:>6}  {sum(sizes[kind]) / n / 1024:>7.1f}  {kind}")
    if not total:
        print("No messages arrived. Check that your SCDS subscription includes ITWS and that the queue is active.")


if __name__ == "__main__":
    main()
