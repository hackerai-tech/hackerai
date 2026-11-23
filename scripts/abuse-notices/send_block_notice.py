#!/usr/bin/env python3
"""Send one fixed HackerAI abuse block notice through local Proton Mail Bridge.

Run only by scripts/abuse-block-notices.ts with ``python3 -I -B``:

    send_block_notice.py --bridge-dir <directory containing bridge.py>

stdin: one JSON object, at most 16 KiB:
    {"version": 1, "messageId": "<abuse-block.HEX@hackerai.co>",
     "from": "abuse@hackerai.co", "to": "<one address>",
     "subject": "...", "text": "..."}

stdout: one JSON object {"result": R} where R is
    "sent"      The exact message was verified in the Bridge Sent folder.
    "not_sent"  Nothing was submitted (input, connection or login failure,
                or a temporary rejection before the message was accepted).
    "rejected"  The server permanently refused the sender, recipient or data.
    "uncertain" Submission started and its outcome is unknown. The caller
                must never resend without reconciling the Sent folder by
                the stable Message-ID.

The address is read only from stdin and never printed. The pinned helper's
``smtp_session()`` owns the Keychain credential, loopback check and
certificate pin; this script never reads a credential itself.
"""

import argparse
from email import policy
from email.parser import BytesParser
import json
import re
import smtplib
import sys
import time
from email.message import EmailMessage
from email.utils import formatdate
from pathlib import Path

SENDER = "abuse@hackerai.co"
MAX_INPUT = 16 * 1024
MAX_SENT_BYTES = 65_536
MESSAGE_ID = re.compile(r"^<abuse-block\.[a-f0-9]{40}@hackerai\.co>$")
ADDRESS = re.compile(r"^[^\s@<>()\[\]\\,;:\"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$")
SUBJECT = re.compile(r"^[^\r\n]{1,200}$")


def emit(result):
    sys.stdout.write(json.dumps({"result": result}) + "\n")
    sys.stdout.flush()


def parse(raw):
    data = json.loads(raw)
    if not isinstance(data, dict) or set(data) != {
        "version", "messageId", "from", "to", "subject", "text"
    }:
        raise ValueError
    text = data["text"]
    if (
        data["version"] != 1
        or data["from"] != SENDER
        or not isinstance(data["messageId"], str)
        or not MESSAGE_ID.fullmatch(data["messageId"])
        or not isinstance(data["to"], str)
        or not ADDRESS.fullmatch(data["to"])
        or not isinstance(data["subject"], str)
        or not SUBJECT.fullmatch(data["subject"])
        or not isinstance(text, str)
        or not 0 < len(text) <= 8192
    ):
        raise ValueError
    message = EmailMessage()
    message["From"] = f"HackerAI Abuse <{SENDER}>"
    message["To"] = data["to"]
    message["Subject"] = data["subject"]
    message["Message-ID"] = data["messageId"]
    message["Date"] = formatdate(usegmt=True)
    message.set_content(text)
    return message


def load_sessions(bridge_dir):
    directory = Path(bridge_dir)
    if not directory.is_absolute() or not (directory / "bridge.py").is_file():
        raise RuntimeError
    sys.path.insert(0, str(directory))
    from bridge import imap_session, smtp_session  # pinned local helper

    return imap_session, smtp_session


def sent_receipt(client, expected):
    status, folders = client.list()
    if status != "OK":
        return "unavailable"
    # Use only a unique Sent mailbox identified by its IMAP special-use flag.
    sent = []
    for folder in folders:
        if not isinstance(folder, bytes):
            continue
        match = re.fullmatch(rb'\(([^)]*)\)\s+(?:"[^"]*"|NIL)\s+(.+)', folder)
        if match and b"\\Sent" in match[1].split():
            sent.append(match[2].decode("ascii"))
    if len(sent) != 1 or client.select(sent[0], readonly=True)[0] != "OK":
        return "unavailable"

    message_id = str(expected["Message-ID"])
    status, matches = client.uid("SEARCH", None, "HEADER", "Message-ID", f'"{message_id}"')
    if status != "OK" or len(matches) != 1 or not isinstance(matches[0], bytes):
        return "unavailable"
    ids = matches[0].split()
    if not ids:
        return "missing"
    # A duplicate or mismatched copy needs review, even if there is a good copy.
    if len(ids) != 1 or not ids[0].isdigit():
        return "mismatch"
    status, parts = client.uid("FETCH", ids[0], f"(BODY.PEEK[]<0.{MAX_SENT_BYTES}>)")
    if status != "OK":
        return "unavailable"
    chunks = [part[1] for part in parts if isinstance(part, tuple)]
    if len(chunks) != 1 or len(chunks[0]) >= MAX_SENT_BYTES:
        return "mismatch"
    actual = BytesParser(policy=policy.default).parsebytes(chunks[0])
    for header in ("From", "To", "Message-ID", "Subject"):
        if len(actual.get_all(header, [])) != 1:
            return "mismatch"
    for header in ("Cc", "Bcc"):
        if actual.get_all(header):
            return "mismatch"
    for header in ("From", "To"):
        if [address.addr_spec for address in actual[header].addresses] != [
            address.addr_spec for address in expected[header].addresses
        ]:
            return "mismatch"
    if (
        str(actual["Message-ID"]) != message_id
        or str(actual["Subject"]) != str(expected["Subject"])
    ):
        return "mismatch"
    body = actual.get_body(preferencelist=("plain",))
    if body is None:
        return "mismatch"
    return (
        "verified"
        if body.get_content().splitlines() == expected.get_content().splitlines()
        else "mismatch"
    )


def verify_sent(message, imap_session):
    try:
        with imap_session() as client:
            return sent_receipt(client, message)
    except Exception:
        return "unavailable"


def send(message, smtp_session):
    """Returns the result enum; never raises."""
    state = "connecting"
    try:
        with smtp_session() as client:
            state = "submitting"
            client.send_message(message, from_addr=SENDER)
            state = "sent"
    except (
        smtplib.SMTPSenderRefused,
        smtplib.SMTPRecipientsRefused,
        smtplib.SMTPDataError,
    ) as error:
        codes = (
            [code for code, _ in error.recipients.values()]
            if isinstance(error, smtplib.SMTPRecipientsRefused)
            else [error.smtp_code]
        )
        # An explicit refusal is an answer before acceptance.
        if codes and all(500 <= code < 600 for code in codes):
            return "rejected"
        return "not_sent"
    except Exception:
        # Connection, TLS pin and login failures happen before submission; a
        # failure while closing after acceptance does not undo the send.
        return {"connecting": "not_sent", "submitting": "uncertain"}.get(state, "sent")
    return "sent"


def deliver(message, imap_session, smtp_session, *, reconcile=False):
    receipt = verify_sent(message, imap_session)
    if receipt == "verified":
        return "sent"
    if receipt == "mismatch" or reconcile:
        return "uncertain"
    if receipt == "unavailable":
        return "not_sent"

    result = send(message, smtp_session)
    if result != "sent":
        return result
    # Proton may materialize Sent shortly after SMTP accepts the message.
    for delay in (0, 1, 2):
        if delay:
            time.sleep(delay)
        receipt = verify_sent(message, imap_session)
        if receipt == "verified":
            return "sent"
        if receipt == "mismatch":
            break
    return "uncertain"


def main(argv=None):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--bridge-dir", required=True)
    parser.add_argument("--reconcile", action="store_true")
    try:
        args = parser.parse_args(argv)
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ValueError
        message = parse(raw.decode("utf-8"))
        imap_session, smtp_session = load_sessions(args.bridge_dir)
    except (SystemExit, Exception):
        emit("not_sent")
        return 2
    emit(deliver(message, imap_session, smtp_session, reconcile=args.reconcile))
    return 0


if __name__ == "__main__":
    sys.exit(main())
