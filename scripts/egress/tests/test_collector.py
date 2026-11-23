"""Unit tests for the egress collector. Standard library only; no network
beyond a loopback HTTP sink. Run with:

    python3 -I -B -m unittest discover -s scripts/egress/tests -p 'test_*.py'
"""

import hashlib
import hmac
import http.server
import json
import os
import signal
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import collector  # noqa: E402

FIXTURE = json.loads((HERE / "credentials.json").read_text())
US1, US2, EU1 = FIXTURE["vectors"]
TELEMETRY_KEY = bytes.fromhex(FIXTURE["telemetryKeys"]["us"])
UNIT = "danted.service"
MINUTE = 30_000_000
T0 = MINUTE * 60
GRACE = collector.SEAL_GRACE_S


def derive(key_hex, region, user_id, sandbox_id):
    """Independent statement of the documented credential derivation."""
    key = bytes.fromhex(key_hex)

    def mac(message):
        return hmac.new(key, message.encode(), hashlib.sha256).hexdigest()

    owner = mac(f"hackerai-egress/v1/owner\n{user_id}")[:32]
    workspace = mac(f"hackerai-egress/v1/workspace\n{user_id}\n{sandbox_id}")[:32]
    username = f"hae-v1-{owner}-{workspace}"
    password = mac(f"hackerai-egress/v1/password\n{region}\n{username}")
    return {"owner": owner, "workspace": workspace, "username": username, "password": password}


def entry(seq, seconds, message, unit=UNIT, facility="10"):
    return json.dumps(
        {
            "__CURSOR": f"s=test;i={seq:x}",
            "__REALTIME_TIMESTAMP": str(int(seconds * 1_000_000)),
            "MESSAGE": message,
            "SYSLOG_FACILITY": facility,
            "_SYSTEMD_UNIT": unit,
        }
    ).encode()


def event(vector, region=None):
    return (
        f"hackerai-egress-v1 accepted region={region or vector['region']} "
        f"owner={vector['owner']} workspace={vector['workspace']}"
    )


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "state.sqlite3")
        self.opened = []

    def tearDown(self):
        for each in self.opened:
            try:
                each.close()
            except Exception:
                pass
        self.tmp.cleanup()

    def open(self, region="us", now=T0 + 1):
        # The first start happens one second into MINUTE, which is partial.
        each = collector.Collector(self.path, region, UNIT, now=now)
        self.opened.append(each)
        return each

    @staticmethod
    def batches(each):
        rows = each.db.execute("SELECT minute, body FROM outbox ORDER BY minute").fetchall()
        return {minute: json.loads(body) for minute, body in rows}

    @staticmethod
    def counts(batch):
        return {(c["owner"], c["workspace"]): c["connections"] for c in batch["counts"]}


class SharedVectorTest(Case):
    def test_attribution_vectors_match_the_documented_derivation(self):
        for vector in FIXTURE["vectors"]:
            key = FIXTURE["attributionKeys"][vector["region"]]
            expected = {k: vector[k] for k in ("owner", "workspace", "username", "password")}
            self.assertEqual(
                derive(key, vector["region"], vector["userId"], vector["sandboxId"]), expected
            )

    def test_batch_body_and_signature_match_the_server_vector(self):
        vector = FIXTURE["telemetryVector"]
        body = collector.canonical_batch(
            "us",
            MINUTE,
            True,
            0,
            0,
            0,
            [(US1["owner"], US1["workspace"], 3), (US2["owner"], US2["workspace"], 2)],
        )
        self.assertEqual(body, vector["body"].encode())
        self.assertEqual(
            collector.sign(TELEMETRY_KEY, "us", vector["timestamp"], body), vector["signature"]
        )


class CountingTest(Case):
    def test_counts_only_exact_events_from_danted_authpriv(self):
        each = self.open()
        at = T0 + 61
        lines = [
            entry(1, at, event(US1)),
            entry(2, at, event(US1)),
            entry(3, at, event(US2)),
            # Another region's event is never counted by this collector.
            entry(4, at, event(EU1)),
            entry(5, at, event(US1) + " target=example.test"),
            entry(6, at, "pam_unix(hackerai-egress:auth): authentication failure; user=legacy-egress"),
            entry(7, at, event(US1), facility="3"),
            entry(8, at, event(US1), unit="other.service"),
        ]
        counted = [each.process(line, now=at) for line in lines]
        self.assertEqual(counted, [True, True, True, False, False, False, False, False])
        self.assertEqual(each.cursor(), "s=test;i=8")
        each.seal(now=T0 + 120 + GRACE)

        batches = self.batches(each)
        self.assertEqual(sorted(batches), [MINUTE, MINUTE + 1])
        # Counting started mid-minute: reported as incomplete, not as zero.
        self.assertFalse(batches[MINUTE]["complete"])
        self.assertTrue(batches[MINUTE + 1]["complete"])
        self.assertEqual(batches[MINUTE + 1]["droppedEvents"], 0)
        self.assertEqual(
            self.counts(batches[MINUTE + 1]),
            {(US1["owner"], US1["workspace"]): 2, (US2["owner"], US2["workspace"]): 1},
        )

        # An unreadable line may have been an event: reported as a loss.
        later = T0 + 150
        self.assertFalse(each.process(b"{not json", now=later))
        self.assertFalse(each.process(collector.OVERSIZED, now=later))
        self.assertEqual(each.cursor(), "s=test;i=8")
        each.seal(now=T0 + 180 + GRACE)
        lossy = self.batches(each)[MINUTE + 2]
        self.assertEqual((lossy["complete"], lossy["droppedEvents"]), (False, 2))
        stored = json.dumps([list(row) for row in each.db.execute("SELECT * FROM meta")])
        self.assertNotIn("legacy-egress", stored)
        self.assertNotIn("example.test", stored)

    def test_crash_replays_uncommitted_entries_exactly_once(self):
        lines = [entry(i, T0 + 61 + i, event(US1)) for i in range(1, 9)]
        first = self.open()
        for line in lines[:5]:
            first.process(line, now=T0 + 70)
        first.commit()
        for line in lines[5:]:
            first.process(line, now=T0 + 70)
        first.close()  # Crash: the last three entries were never committed.

        second = self.open()
        self.assertEqual(second.cursor(), "s=test;i=5")
        # journalctl --after-cursor resumes with the entries after it.
        for line in lines[5:]:
            second.process(line, now=T0 + 80)
        second.seal(now=T0 + 120 + GRACE)
        sealed = self.batches(second)
        self.assertEqual(self.counts(sealed[MINUTE + 1]), {(US1["owner"], US1["workspace"]): 8})

        # A crash after sealing keeps the exact upload bytes.
        body = second.next_batch()
        second.close()
        self.assertEqual(self.open().next_batch(), body)

    def test_sealing_waits_for_a_replayed_backlog(self):
        each = self.open()
        each.process(entry(1, T0 + 61, event(US1)), now=T0 + 600)
        # Still replaying: only minutes before the latest entry are final.
        each.seal(now=T0 + 600, reader_idle=False)
        self.assertEqual(sorted(self.batches(each)), [MINUTE])
        each.process(entry(2, T0 + 130, event(US2)), now=T0 + 600)
        each.seal(now=T0 + 600, reader_idle=False)
        batches = self.batches(each)
        self.assertEqual(self.counts(batches[MINUTE + 1]), {(US1["owner"], US1["workspace"]): 1})
        # Caught up: every minute that ended SEAL_GRACE_S ago is sealed.
        each.seal(now=T0 + 600, reader_idle=True)
        self.assertEqual(max(self.batches(each)), MINUTE + 8)
        self.assertEqual(
            self.counts(self.batches(each)[MINUTE + 2]), {(US2["owner"], US2["workspace"]): 1}
        )

    def assert_discarded_as_loss(self, each, line, now, loss_minute):
        self.assertFalse(each.process(line, now=now))
        each.commit()
        # The cursor moves past it, so a restart does not replay it either.
        self.assertEqual(each.cursor(), json.loads(line)["__CURSOR"])
        each.seal(now=(loss_minute + 1) * 60 + GRACE)
        batch = self.batches(each)[loss_minute]
        self.assertEqual(batch["counts"], [])
        self.assertEqual((batch["complete"], batch["droppedEvents"]), (False, 1))

    def test_an_event_for_a_sealed_minute_is_reported_lost_not_moved(self):
        each = self.open()
        each.seal(now=T0 + 180 + GRACE)
        sealed = dict(self.batches(each))
        late = entry(1, T0 + 61, event(US1))
        self.assert_discarded_as_loss(each, late, T0 + 200, MINUTE + 3)
        batches = self.batches(each)
        for minute, body in sealed.items():
            self.assertEqual(batches[minute], body)

    def test_an_event_with_a_future_timestamp_is_reported_lost_not_moved(self):
        each = self.open()
        future = entry(1, T0 + 600, event(US1))
        self.assert_discarded_as_loss(each, future, T0 + 61, MINUTE + 1)
        # It neither counts later nor lets a replaying reader seal early.
        self.assertEqual(each.latest_entry_minute, MINUTE + 1)
        each.seal(now=T0 + 660 + GRACE)
        self.assertTrue(all(not b["counts"] for b in self.batches(each).values()))

    def test_identity_bound_reports_overflow(self):
        third = {"owner": US1["owner"], "workspace": "f" * 32}
        each = self.open()
        with mock.patch.object(collector, "MAX_IDENTITIES_PER_MINUTE", 2):
            for seq, vector in enumerate([US1, US2, third, third, US1], start=1):
                each.process(entry(seq, T0 + 61, event({**vector, "region": "us"})), now=T0 + 70)
        each.seal(now=T0 + 120 + GRACE)
        batch = self.batches(each)[MINUTE + 1]
        self.assertEqual(
            self.counts(batch),
            {(US1["owner"], US1["workspace"]): 2, (US2["owner"], US2["workspace"]): 1},
        )
        self.assertEqual(batch["overflowConnections"], 2)

    def test_outbox_bound_reports_dropped_batches(self):
        each = self.open()
        with mock.patch.object(collector, "MAX_OUTBOX_BATCHES", 3):
            # Uploads are failing: one minute is sealed per minute.
            for minute in range(5):
                each.seal(now=T0 + (minute + 1) * 60 + GRACE)
            batches = self.batches(each)
            self.assertEqual(sorted(batches), [MINUTE + 2, MINUTE + 3, MINUTE + 4])
            # MINUTE was evicted before MINUTE + 4 was sealed.
            self.assertEqual(batches[MINUTE + 4]["droppedBatches"], 1)
            # An outage longer than the outbox is a counted gap: 92 skipped,
            # plus each eviction, all reported in later batches.
            each.seal(now=T0 + 100 * 60 + GRACE)
            batches = self.batches(each)
            self.assertEqual(sorted(batches), [MINUTE + 97, MINUTE + 98, MINUTE + 99])
            self.assertEqual(
                [batch["droppedBatches"] for _, batch in sorted(batches.items())],
                [93, 1, 1],
            )

    def test_state_is_bound_to_its_region(self):
        self.open("us")
        with self.assertRaises(collector.ConfigError):
            collector.Collector(self.path, "eu", UNIT)


class Sink:
    """Loopback telemetry endpoint that verifies each signature and replies
    with scripted statuses; "drop" closes without a response."""

    def __init__(self, script):
        self.script = list(script)
        self.received = []
        sink = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                timestamp = self.headers["X-HackerAI-Egress-Timestamp"]
                expected = "v1=" + collector.sign(TELEMETRY_KEY, "us", timestamp, body)
                sink.received.append(
                    {
                        "path": self.path,
                        "body": body,
                        "valid": hmac.compare_digest(
                            expected, self.headers["X-HackerAI-Egress-Signature"]
                        )
                        and abs(time.time() - int(timestamp)) <= 300
                        and self.headers["X-HackerAI-Egress-Region"] == "us",
                    }
                )
                status = sink.script.pop(0)
                if status == "drop":
                    self.close_connection = True
                    return
                self.send_response(status)
                if status == 307:
                    self.send_header("Location", "http://127.0.0.1:9/elsewhere")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}{collector.ENDPOINT_PATH}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class UploadTest(Case):
    def sink(self, script):
        sink = Sink(script)
        self.addCleanup(sink.close)
        return sink, collector.Uploader(sink.url, "us", TELEMETRY_KEY, allow_loopback_http=True)

    def test_retries_identical_bytes_and_reports_permanent_rejections(self):
        each = self.open()
        each.process(entry(1, T0 + 61, event(US1)), now=T0 + 70)
        each.seal(now=T0 + 120 + GRACE)
        first_minute, first_body = each.next_batch()
        sink, uploader = self.sink([503, "drop", 307, 200, 409, 200])

        self.assertFalse(uploader.drain(each))  # 503: retry later
        self.assertFalse(uploader.drain(each))  # unknown outcome after the request
        self.assertFalse(uploader.drain(each))  # a redirect is not followed
        self.assertTrue(uploader.drain(each))  # 200, then 409 for the second batch
        self.assertIsNone(each.next_batch())
        bodies = [request["body"] for request in sink.received]
        self.assertEqual(bodies[:4], [first_body] * 4)
        self.assertTrue(all(request["valid"] for request in sink.received))
        self.assertEqual({request["path"] for request in sink.received}, {collector.ENDPOINT_PATH})

        # The rejected batch is reported in the next one rather than lost silently.
        each.seal(now=T0 + 180 + GRACE)
        self.assertEqual(json.loads(each.next_batch()[1])["droppedBatches"], 1)
        self.assertTrue(uploader.drain(each))
        self.assertEqual(first_minute, MINUTE)

    def test_unreachable_endpoint_keeps_the_batch(self):
        each = self.open()
        each.seal(now=T0 + 60 + GRACE)
        uploader = collector.Uploader(
            f"http://127.0.0.1:9{collector.ENDPOINT_PATH}", "us", TELEMETRY_KEY, True
        )
        before = each.next_batch()
        with mock.patch.object(collector, "log") as log:
            self.assertFalse(uploader.drain(each))
        self.assertEqual(each.next_batch(), before)
        # A coarse category, never the error text with the endpoint address.
        (line,), _ = log.call_args
        self.assertIn("status=unknown transport=refused attempt=1", line)
        self.assertNotIn("127.0.0.1", line)

    def test_logs_trouble_and_recovery_with_the_backlog_age(self):
        each = self.open()
        each.process(entry(1, T0 + 61, event(US1)), now=T0 + 70)
        each.seal(now=T0 + 120 + GRACE)
        now = [T0 + 200]
        sink = Sink([503, "drop", 200, 200, 503])
        self.addCleanup(sink.close)
        uploader = collector.Uploader(
            sink.url, "us", TELEMETRY_KEY, allow_loopback_http=True, clock=lambda: now[0]
        )

        with mock.patch.object(collector, "log") as log:
            self.assertFalse(uploader.drain(each))
            now[0] += 5
            self.assertFalse(uploader.drain(each))
            now[0] += 10
            self.assertTrue(uploader.drain(each))
            each.seal(now=T0 + 180 + GRACE)
            self.assertFalse(uploader.drain(each))
        lines = [call.args[0] for call in log.call_args_list]

        backlog = "pending=2 oldest_minute=2027-01-15T08:00:00Z"
        self.assertEqual(
            lines[:3],
            [
                f"upload deferred status=503 attempt=1 {backlog} oldest_age_s=140 "
                "last_success=unavailable",
                f"upload deferred status=unknown transport=connection attempt=2 {backlog} "
                "oldest_age_s=145 last_success=unavailable",
                f"upload recovered deferred=2 outage_s=15 {backlog} oldest_age_s=155 "
                "last_success=unavailable",
            ],
        )
        # A later outage starts a new count and names the last success.
        self.assertTrue(lines[3].startswith("upload deferred status=503 attempt=1 pending=1"))
        self.assertTrue(lines[3].endswith("last_success=2027-01-15T08:03:35Z"))
        self.assertEqual(len(lines), 4)
        # Retry is unchanged: the deferred batch was resent until acknowledged.
        self.assertEqual(len(sink.received), 5)
        logged = "\n".join(lines)
        for secret in (TELEMETRY_KEY.hex(), US1["owner"], US1["workspace"], "127.0.0.1"):
            self.assertNotIn(secret, logged)


class StartupTest(Case):
    def test_startup_reports_the_backlog_and_no_prior_success(self):
        state = collector.Collector(
            os.path.join(self.tmp.name, "collector.sqlite3"), "us", UNIT, now=T0 + 1
        )
        state.seal(now=T0 + 60 + GRACE)
        state.close()
        config = {
            "version": 1,
            "region": "us",
            "endpoint": f"https://app.example.test{collector.ENDPOINT_PATH}",
            "unit": UNIT,
        }
        for signum in (signal.SIGTERM, signal.SIGINT):
            self.addCleanup(signal.signal, signum, signal.getsignal(signum))

        class Stop(Exception):
            pass

        # Stops before the journal is opened or anything is uploaded.
        with mock.patch.object(collector, "log") as log, mock.patch.object(
            collector.subprocess, "Popen", side_effect=Stop
        ), mock.patch.object(collector.time, "time", return_value=T0 + 90):
            with self.assertRaises(Stop):
                collector.run(config, TELEMETRY_KEY, self.tmp.name)
        log.assert_called_once_with(
            "started region=us journal_cursor=missing "
            "sealed_through_minute=2027-01-15T08:00:00Z pending=1 "
            "oldest_minute=2027-01-15T08:00:00Z oldest_age_s=30 last_success=unavailable"
        )


class ConfigurationTest(Case):
    def write(self, name, content, mode=0o600):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w") as handle:
            handle.write(content)
        os.chmod(path, mode)
        return path

    def test_key_file_must_be_private_regular_and_exact(self):
        uid = os.geteuid()
        good = self.write("key", FIXTURE["telemetryKeys"]["us"] + "\n")
        self.assertEqual(collector.load_key(good, owner_uid=uid), TELEMETRY_KEY)
        link = os.path.join(self.tmp.name, "link")
        os.symlink(good, link)
        fifo = os.path.join(self.tmp.name, "fifo")
        os.mkfifo(fifo, 0o600)
        bad = [
            self.write("shared", FIXTURE["telemetryKeys"]["us"], 0o640),
            link,
            fifo,
            self.write("upper", FIXTURE["telemetryKeys"]["us"].upper()),
            self.write("short", FIXTURE["telemetryKeys"]["us"][:-2]),
            self.write("lines", FIXTURE["telemetryKeys"]["us"] + "\n\n"),
            os.path.join(self.tmp.name, "missing"),
        ]
        for path in bad:
            with self.subTest(path=os.path.basename(path)):
                with self.assertRaises(collector.ConfigError):
                    collector.load_key(path, owner_uid=uid)
        with self.assertRaises(collector.ConfigError):
            collector.load_key(good, owner_uid=uid + 1)

    def test_configuration_is_a_fixed_schema(self):
        valid = {
            "version": 1,
            "region": "us",
            "endpoint": "https://app.example.test/api/internal/egress-telemetry",
            "unit": "danted.service",
        }
        self.assertEqual(collector.load_config(self.write("ok.json", json.dumps(valid))), valid)
        changes = [
            {"endpoint": "http://app.example.test/api/internal/egress-telemetry"},
            {"endpoint": "http://127.0.0.1/api/internal/egress-telemetry"},
            {"endpoint": "https://user:secret@app.example.test/api/internal/egress-telemetry"},
            {"endpoint": "https://app.example.test/api/internal/egress-telemetry?x=1"},
            {"endpoint": "https://app.example.test/api/other"},
            {"region": "ap"},
            {"unit": "danted"},
            {"unit": "danted.service --all"},
            {"version": 2},
            {"extra": True},
        ]
        for index, change in enumerate(changes):
            with self.subTest(change=change):
                path = self.write(f"bad{index}.json", json.dumps({**valid, **change}))
                with self.assertRaises(collector.ConfigError):
                    collector.load_config(path)

    def test_journal_command_reads_only_danted_authpriv_fields(self):
        fresh = collector.journal_command(UNIT, None)
        resumed = collector.journal_command(UNIT, "s=abc;i=1")
        for command in (fresh, resumed):
            self.assertIn("_SYSTEMD_UNIT=danted.service", command)
            self.assertIn("SYSLOG_FACILITY=10", command)
            self.assertIn("--output-fields=MESSAGE,SYSLOG_FACILITY,_SYSTEMD_UNIT", command)
        self.assertIn("--lines=0", fresh)
        self.assertEqual(resumed[-1], "--after-cursor=s=abc;i=1")

    def test_line_reader_bounds_lines(self):
        reader = collector.LineReader(max_bytes=8)
        self.assertEqual(reader.feed(b"abc\nde"), [b"abc"])
        self.assertEqual(reader.feed(b"f\n"), [b"def"])
        # An oversized line is reported once and skipped through its newline.
        self.assertEqual(reader.feed(b"0123456789"), [collector.OVERSIZED])
        self.assertEqual(reader.feed(b"abcdef\nok\n"), [b"ok"])
        self.assertEqual(reader.feed(b"123456789\n"), [collector.OVERSIZED])


if __name__ == "__main__":
    unittest.main()
