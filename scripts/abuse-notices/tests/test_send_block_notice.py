"""Run: python3 -B -m unittest discover -s scripts/abuse-notices/tests -v

Exercises the real helper as a subprocess against a synthetic bridge module,
so the stdio contract, phase mapping and output privacy are what is tested.
"""

import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / "send_block_notice.py"
ADDRESS = "synthetic.user@example.invalid"
MESSAGE = {
    "version": 1,
    "messageId": "<abuse-block." + "a" * 40 + "@hackerai.co>",
    "from": "abuse@hackerai.co",
    "to": ADDRESS,
    "subject": "Your HackerAI account access has been suspended (AB-x)",
    "text": "Synthetic fixed notice body.\n",
}

# Each scenario replaces the pinned helper with a synthetic session.
BRIDGE = """
import smtplib, json
from pathlib import Path
from contextlib import contextmanager
SCENARIO = {scenario!r}
LOG = {log!r}
SENT = Path(LOG + ".eml")

class Client:
    def send_message(self, message, from_addr=None):
        with open(LOG, "w") as handle:
            json.dump({{"to": message["To"], "id": message["Message-ID"],
                        "from": from_addr}}, handle)
        if SCENARIO == "recipient_refused":
            raise smtplib.SMTPRecipientsRefused({{message["To"]: (550, b"no")}})
        if SCENARIO == "temporary_refusal":
            raise smtplib.SMTPRecipientsRefused({{message["To"]: (451, b"later")}})
        if SCENARIO not in ("missing_sent", "lost_ack"):
            SENT.write_bytes(message.as_bytes())
        if SCENARIO == "lost_ack":
            raise smtplib.SMTPServerDisconnected("closed during DATA")

class SentFolder:
    def list(self):
        return "OK", [br'(\\HasNoChildren \\Sent) "/" "Sent"']

    def select(self, name, readonly=False):
        assert name == '"Sent"' and readonly
        return "OK", [b"1"]

    def uid(self, command, *args):
        if command == "SEARCH":
            return "OK", [b"1" if SENT.exists() else b""]
        return "OK", [(b"1", SENT.read_bytes())]

@contextmanager
def imap_session():
    if SCENARIO == "imap_failed":
        raise OSError("imap unavailable")
    yield SentFolder()

@contextmanager
def smtp_session():
    if SCENARIO == "login_failed":
        raise smtplib.SMTPAuthenticationError(535, b"bad")
    yield Client()
    if SCENARIO == "close_failed":
        raise OSError("close")
"""


class SendBlockNoticeTest(unittest.TestCase):
    def run_helper(self, scenario, message=MESSAGE):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "sent.json"
            (Path(directory) / "bridge.py").write_text(
                textwrap.dedent(BRIDGE.format(scenario=scenario, log=str(log)))
            )
            completed = subprocess.run(
                [sys.executable, "-I", "-B", str(HELPER), "--bridge-dir", directory],
                input=json.dumps(message).encode(),
                capture_output=True,
                timeout=30,
            )
            submitted = json.loads(log.read_text()) if log.exists() else None
        output = completed.stdout.decode() + completed.stderr.decode()
        self.assertNotIn(ADDRESS, output)
        return json.loads(completed.stdout), submitted

    def test_accepted_message_uses_fixed_sender_and_stable_message_id(self):
        result, submitted = self.run_helper("ok")
        self.assertEqual(result, {"result": "sent"})
        self.assertEqual(submitted["id"], MESSAGE["messageId"])
        self.assertEqual(submitted["from"], "abuse@hackerai.co")
        self.assertEqual(submitted["to"], ADDRESS)

    def test_failure_after_acceptance_is_still_sent(self):
        self.assertEqual(self.run_helper("close_failed")[0], {"result": "sent"})

    def test_lost_acknowledgement_during_submission_is_uncertain(self):
        self.assertEqual(self.run_helper("lost_ack")[0], {"result": "uncertain"})

    def test_smtp_acceptance_without_verified_sent_copy_is_uncertain(self):
        result, submitted = self.run_helper("missing_sent")
        self.assertIsNotNone(submitted)
        self.assertEqual(result, {"result": "uncertain"})

    def test_unavailable_sent_lookup_never_submits(self):
        result, submitted = self.run_helper("imap_failed")
        self.assertEqual(result, {"result": "not_sent"})
        self.assertIsNone(submitted)

    def test_login_failure_never_submits(self):
        result, submitted = self.run_helper("login_failed")
        self.assertEqual(result, {"result": "not_sent"})
        self.assertIsNone(submitted)

    def test_refusals_distinguish_permanent_and_temporary(self):
        self.assertEqual(self.run_helper("recipient_refused")[0], {"result": "rejected"})
        self.assertEqual(self.run_helper("temporary_refusal")[0], {"result": "not_sent"})

    def test_rejects_header_injection_and_foreign_sender_without_sending(self):
        for change in (
            {"to": ADDRESS + "\r\nBcc: other@example.invalid"},
            {"subject": "x\r\nBcc: other@example.invalid"},
            {"from": "someone@hackerai.co"},
            {"messageId": "<other@example.invalid>"},
            {"extra": True},
        ):
            result, submitted = self.run_helper("ok", {**MESSAGE, **change})
            self.assertEqual(result, {"result": "not_sent"})
            self.assertIsNone(submitted)


if __name__ == "__main__":
    unittest.main()
