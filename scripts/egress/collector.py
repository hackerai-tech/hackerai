#!/usr/bin/env python3
"""HackerAI egress attribution collector for one regional Dante proxy.

Reads only the fixed authentication events that pam_hackerai_egress logs from
danted's journal, counts accepted attributed SOCKS connections per workspace
per minute, and uploads one signed batch per minute to the internal telemetry
endpoint. It never reads request data, destinations or passwords; exact HTTP
request counts are not available at this layer.

Durability: the journal cursor and counts advance in the same SQLite
transaction, so a crash replays uncommitted entries exactly once. A minute is
sealed into an immutable outbox body, so a retry after an uncertain HTTP
acknowledgement resends identical bytes that the server deduplicates. Memory,
line size, identities per minute and the outbox are bounded; anything that
exceeds a bound is counted and reported rather than reported as zero.

Standard library only; run with ``python3 -I``.
"""

import argparse
import hashlib
import hmac
import json
import os
import re
import select
import signal
import sqlite3
import ssl
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

EVENT = re.compile(
    r"hackerai-egress-v1 accepted region=(us|eu) "
    r"owner=([0-9a-f]{32}) workspace=([0-9a-f]{32})"
)
AUTHPRIV_FACILITY = "10"
REGIONS = ("us", "eu")
ENDPOINT_PATH = "/api/internal/egress-telemetry"
SIGNATURE_DOMAIN = "hackerai-egress-telemetry/v1"
UNIT = re.compile(r"[A-Za-z0-9@._-]{1,64}\.service")
KEY_HEX = re.compile(r"[0-9a-f]{64}")

MAX_LINE_BYTES = 16 * 1024
READ_CHUNK_BYTES = 64 * 1024
MAX_CURSOR_CHARS = 512
MAX_IDENTITIES_PER_MINUTE = 1000
MAX_OUTBOX_BATCHES = 24 * 60
SEAL_GRACE_S = 15
COMMIT_INTERVAL_S = 1.0
COMMIT_EVERY_ENTRIES = 500
UPLOADS_PER_ROUND = 30
UPLOAD_TIMEOUT_S = 10
MAX_BACKOFF_S = 300
# Statuses that can never succeed for this exact body: drop it and report it.
PERMANENT_REJECTIONS = (400, 409, 413)


class ConfigError(Exception):
    """Fixed-text configuration failure; never includes file contents."""


def log(message):
    print(f"hackerai-egress-collector: {message}", file=sys.stderr, flush=True)


def validate_endpoint(url, allow_loopback_http=False):
    parts = urllib.parse.urlsplit(url)
    if (
        parts.username
        or parts.password
        or parts.query
        or parts.fragment
        or not parts.hostname
        or parts.path != ENDPOINT_PATH
    ):
        raise ConfigError("invalid endpoint")
    if parts.scheme == "https":
        return url
    # Tests only: plain HTTP to the container's own loopback address.
    if allow_loopback_http and parts.scheme == "http" and parts.hostname == "127.0.0.1":
        return url
    raise ConfigError("invalid endpoint")


def load_config(path):
    try:
        with open(path, "rb") as handle:
            raw = handle.read(4097)
        data = json.loads(raw) if len(raw) <= 4096 else None
    except (OSError, ValueError):
        raise ConfigError("unreadable configuration") from None
    if not isinstance(data, dict) or set(data) != {"version", "region", "endpoint", "unit"}:
        raise ConfigError("invalid configuration")
    if data["version"] != 1 or data["region"] not in REGIONS:
        raise ConfigError("invalid configuration")
    if not isinstance(data["unit"], str) or not UNIT.fullmatch(data["unit"]):
        raise ConfigError("invalid configuration")
    if not isinstance(data["endpoint"], str):
        raise ConfigError("invalid configuration")
    validate_endpoint(data["endpoint"])
    return data


def load_key(path, owner_uid=0):
    """A regular, non-symlink file owned by ``owner_uid`` with no group or
    other access, holding 64 lowercase hex characters and an optional newline."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError:
        raise ConfigError("unreadable telemetry key") from None
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != owner_uid
            or info.st_mode & 0o077
        ):
            raise ConfigError("telemetry key must be a private regular file")
        raw = os.read(fd, 67)
    finally:
        os.close(fd)
    text = raw[:-1] if raw.endswith(b"\n") else raw
    if not KEY_HEX.fullmatch(text.decode("ascii", "replace")):
        raise ConfigError("invalid telemetry key")
    return bytes.fromhex(text.decode("ascii"))


def canonical_batch(region, minute, complete, dropped_events, dropped_batches, overflow, counts):
    """The stable upload body. ``counts`` is sorted (owner, workspace, n)."""
    return json.dumps(
        {
            "version": 1,
            "region": region,
            "minute": minute,
            "complete": bool(complete),
            "droppedEvents": dropped_events,
            "droppedBatches": dropped_batches,
            "overflowConnections": overflow,
            "counts": [
                {"owner": owner, "workspace": workspace, "connections": connections}
                for owner, workspace, connections in counts
            ],
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


def sign(key, region, timestamp, body):
    prefix = f"{SIGNATURE_DOMAIN}\n{region}\n{timestamp}\n".encode("ascii")
    return hmac.new(key, prefix + body, hashlib.sha256).hexdigest()


def journal_command(unit, cursor):
    """Only AUTHPRIV entries from danted's own unit, with only the fields read."""
    command = [
        "journalctl",
        "--output=json",
        "--follow",
        "--no-pager",
        "--quiet",
        "--output-fields=MESSAGE,SYSLOG_FACILITY,_SYSTEMD_UNIT",
        f"_SYSTEMD_UNIT={unit}",
        f"SYSLOG_FACILITY={AUTHPRIV_FACILITY}",
    ]
    command.append(f"--after-cursor={cursor}" if cursor else "--lines=0")
    return command


OVERSIZED = object()


class LineReader:
    """Splits a byte stream into lines of at most ``max_bytes``; longer lines
    are discarded up to their newline and reported as OVERSIZED."""

    def __init__(self, max_bytes=MAX_LINE_BYTES):
        self.max_bytes = max_bytes
        self.buffer = b""
        self.discarding = False

    def feed(self, chunk):
        lines = []
        self.buffer += chunk
        while True:
            newline = self.buffer.find(b"\n")
            if newline < 0:
                if len(self.buffer) > self.max_bytes:
                    if not self.discarding:
                        lines.append(OVERSIZED)
                    self.discarding = True
                    self.buffer = b""
                return lines
            line, self.buffer = self.buffer[:newline], self.buffer[newline + 1 :]
            if self.discarding:
                self.discarding = False
            elif len(line) > self.max_bytes:
                lines.append(OVERSIZED)
            else:
                lines.append(line)


class Collector:
    """Durable per-minute counts, journal cursor and sealed outbox."""

    def __init__(self, path, region, unit, now=None):
        if region not in REGIONS or not UNIT.fullmatch(unit):
            raise ConfigError("invalid configuration")
        self.region = region
        self.unit = unit
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.in_transaction = False
        self.uncommitted = 0
        self.last_commit = time.monotonic()
        self.latest_entry_minute = None
        # executescript commits implicitly, so the schema is created before
        # any transaction; every statement is idempotent.
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS open_minutes(
              minute INTEGER PRIMARY KEY, complete INTEGER NOT NULL,
              dropped_events INTEGER NOT NULL, overflow INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS counts(
              minute INTEGER NOT NULL, owner TEXT NOT NULL, workspace TEXT NOT NULL,
              connections INTEGER NOT NULL, PRIMARY KEY(minute, owner, workspace));
            CREATE TABLE IF NOT EXISTS outbox(minute INTEGER PRIMARY KEY, body BLOB NOT NULL);
            """
        )
        with self._transaction():
            stored = self._meta("region")
            if stored is not None and stored != region:
                raise ConfigError("state belongs to another region")
            if stored is None:
                # First start: counting begins mid-minute, so that minute is partial.
                current = int((time.time() if now is None else now) // 60)
                self._set_meta("region", region)
                self._set_meta("sealed_through", str(current - 1))
                self._open(current)
                self.db.execute("UPDATE open_minutes SET complete = 0 WHERE minute = ?", (current,))

    # -- storage helpers -------------------------------------------------

    def _begin(self):
        if not self.in_transaction:
            self.db.execute("BEGIN IMMEDIATE")
            self.in_transaction = True

    def commit(self):
        if self.in_transaction:
            self.db.execute("COMMIT")
            self.in_transaction = False
        self.uncommitted = 0
        self.last_commit = time.monotonic()

    def close(self):
        """Discards any uncommitted entries, as a crash would."""
        if self.in_transaction:
            self.db.execute("ROLLBACK")
            self.in_transaction = False
        self.db.close()

    class _Tx:
        def __init__(self, collector):
            self.collector = collector

        def __enter__(self):
            self.collector._begin()

        def __exit__(self, kind, value, traceback):
            if kind is None:
                self.collector.commit()
            else:
                self.collector.db.execute("ROLLBACK")
                self.collector.in_transaction = False
            return False

    def _transaction(self):
        return Collector._Tx(self)

    def _meta(self, key):
        row = self.db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def _set_meta(self, key, value):
        self.db.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def _open(self, minute):
        self.db.execute(
            "INSERT OR IGNORE INTO open_minutes(minute, complete, dropped_events, overflow) "
            "VALUES(?, 1, 0, 0)",
            (minute,),
        )

    def sealed_through(self):
        return int(self._meta("sealed_through"))

    def cursor(self):
        return self._meta("cursor")

    # -- journal entries -------------------------------------------------

    def _current_open(self, now):
        """The open minute that records losses noticed at ``now``."""
        return max(self.sealed_through() + 1, int(now // 60))

    def process(self, line, now=None):
        """Handles one journal line. Returns True when it was a counted event."""
        now = time.time() if now is None else now
        self._begin()
        self.uncommitted += 1
        entry = None
        if line is not OVERSIZED:
            try:
                entry = json.loads(line)
            except ValueError:
                entry = None
        if not isinstance(entry, dict):
            self._lose(now)
            return False
        cursor = entry.get("__CURSOR")
        stamp = entry.get("__REALTIME_TIMESTAMP")
        if (
            not isinstance(cursor, str)
            or not 0 < len(cursor) <= MAX_CURSOR_CHARS
            or not isinstance(stamp, str)
            or not stamp.isdigit()
            or len(stamp) > 20
        ):
            self._lose(now)
            return False
        minute = int(stamp) // 60_000_000
        current = int(now // 60)
        # A future timestamp must not let a replaying reader seal early.
        seen = min(minute, current)
        self.latest_entry_minute = max(self.latest_entry_minute or seen, seen)
        # The cursor advances even for a discarded entry, so it is not replayed.
        self._set_meta("cursor", cursor)
        message = entry.get("MESSAGE")
        match = EVENT.fullmatch(message) if isinstance(message, str) else None
        if (
            match is None
            or entry.get("_SYSTEMD_UNIT") != self.unit
            or entry.get("SYSLOG_FACILITY") != AUTHPRIV_FACILITY
            or match.group(1) != self.region
        ):
            # Any other danted AUTHPRIV line (such as pam_unix) is skipped unread.
            return False
        if minute <= self.sealed_through() or minute > current:
            # Its minute was already uploaded, or the clock is ahead: counting
            # it in another minute would misplace a burst, so report a loss.
            self._lose(now)
            return False
        bucket = minute
        self._open(bucket)
        owner, workspace = match.group(2), match.group(3)
        updated = self.db.execute(
            "UPDATE counts SET connections = connections + 1 "
            "WHERE minute = ? AND owner = ? AND workspace = ?",
            (bucket, owner, workspace),
        ).rowcount
        if not updated:
            (identities,) = self.db.execute(
                "SELECT COUNT(*) FROM counts WHERE minute = ?", (bucket,)
            ).fetchone()
            if identities >= MAX_IDENTITIES_PER_MINUTE:
                self.db.execute(
                    "UPDATE open_minutes SET overflow = overflow + 1 WHERE minute = ?",
                    (bucket,),
                )
            else:
                self.db.execute(
                    "INSERT INTO counts(minute, owner, workspace, connections) VALUES(?, ?, ?, 1)",
                    (bucket, owner, workspace),
                )
        return True

    def _lose(self, now):
        """An entry that may have been an event was not counted."""
        bucket = self._current_open(now)
        self._open(bucket)
        self.db.execute(
            "UPDATE open_minutes SET dropped_events = dropped_events + 1, complete = 0 "
            "WHERE minute = ?",
            (bucket,),
        )

    def mark_incomplete(self, now=None):
        """The journal stream failed: the open minute may be missing entries."""
        now = time.time() if now is None else now
        with self._transaction():
            bucket = self._current_open(now)
            self._open(bucket)
            self.db.execute("UPDATE open_minutes SET complete = 0 WHERE minute = ?", (bucket,))

    def flush_if_due(self):
        if self.uncommitted and (
            self.uncommitted >= COMMIT_EVERY_ENTRIES
            or time.monotonic() - self.last_commit >= COMMIT_INTERVAL_S
        ):
            self.commit()

    # -- sealing and outbox ----------------------------------------------

    def seal(self, now=None, reader_idle=True):
        """Seals each minute that ended SEAL_GRACE_S ago. While a backlog is
        replaying, a minute is sealed only after a later entry has been read,
        since journal entries arrive in order."""
        now = time.time() if now is None else now
        with self._transaction():
            sealed = self.sealed_through()
            current = int(now // 60)
            through = current - 1 if now - current * 60 >= SEAL_GRACE_S else current - 2
            if not reader_idle:
                if self.latest_entry_minute is None:
                    return 0
                through = min(through, self.latest_entry_minute - 1)
            if through <= sealed:
                return 0
            skipped = max(0, through - sealed - MAX_OUTBOX_BATCHES)
            if skipped:
                # A longer outage than the outbox can hold is a reported gap.
                self._add_dropped_batches(skipped)
                self.db.execute("DELETE FROM counts WHERE minute <= ?", (sealed + skipped,))
                self.db.execute("DELETE FROM open_minutes WHERE minute <= ?", (sealed + skipped,))
            for minute in range(sealed + skipped + 1, through + 1):
                self._seal_minute(minute)
            self._set_meta("sealed_through", str(through))
            return through - sealed - skipped

    def _add_dropped_batches(self, count):
        current = int(self._meta("dropped_batches") or 0)
        self._set_meta("dropped_batches", str(current + count))

    def _seal_minute(self, minute):
        row = self.db.execute(
            "SELECT complete, dropped_events, overflow FROM open_minutes WHERE minute = ?",
            (minute,),
        ).fetchone()
        complete, dropped_events, overflow = row or (1, 0, 0)
        counts = self.db.execute(
            "SELECT owner, workspace, connections FROM counts WHERE minute = ? "
            "ORDER BY owner, workspace",
            (minute,),
        ).fetchall()
        dropped_batches = int(self._meta("dropped_batches") or 0)
        body = canonical_batch(
            self.region, minute, complete, dropped_events, dropped_batches, overflow, counts
        )
        self.db.execute("INSERT OR IGNORE INTO outbox(minute, body) VALUES(?, ?)", (minute, body))
        self._set_meta("dropped_batches", "0")
        self.db.execute("DELETE FROM counts WHERE minute = ?", (minute,))
        self.db.execute("DELETE FROM open_minutes WHERE minute = ?", (minute,))
        (pending,) = self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()
        if pending > MAX_OUTBOX_BATCHES:
            evicted = pending - MAX_OUTBOX_BATCHES
            self.db.execute(
                "DELETE FROM outbox WHERE minute IN "
                "(SELECT minute FROM outbox ORDER BY minute LIMIT ?)",
                (evicted,),
            )
            self._add_dropped_batches(evicted)

    def next_batch(self):
        return self.db.execute("SELECT minute, body FROM outbox ORDER BY minute LIMIT 1").fetchone()

    def acknowledge(self, minute, rejected=False):
        with self._transaction():
            self.db.execute("DELETE FROM outbox WHERE minute = ?", (minute,))
            if rejected:
                self._add_dropped_batches(1)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Uploader:
    def __init__(self, endpoint, region, key, allow_loopback_http=False, clock=time.time):
        self.endpoint = validate_endpoint(endpoint, allow_loopback_http)
        self.region = region
        self.key = key
        self.clock = clock
        # No environment proxies and no redirects: the signed body goes only here.
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            _NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        )

    def post(self, body):
        """Returns the HTTP status, or None when the outcome is unknown."""
        timestamp = str(int(self.clock()))
        request = urllib.request.Request(
            self.endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "User-Agent": "hackerai-egress-collector/1",
                "X-HackerAI-Egress-Region": self.region,
                "X-HackerAI-Egress-Timestamp": timestamp,
                "X-HackerAI-Egress-Signature": "v1=" + sign(self.key, self.region, timestamp, body),
            },
        )
        try:
            with self.opener.open(request, timeout=UPLOAD_TIMEOUT_S) as response:
                response.read(1024)
                return response.status
        except urllib.error.HTTPError as error:
            return error.code
        except (urllib.error.URLError, OSError, ValueError):
            return None

    def drain(self, collector, limit=UPLOADS_PER_ROUND):
        """Uploads sealed batches oldest first. Returns False when a retry is
        needed; the batch stays in the outbox with its exact bytes."""
        for _ in range(limit):
            batch = collector.next_batch()
            if batch is None:
                return True
            minute, body = batch
            status = self.post(body)
            if status is not None and 200 <= status < 300:
                collector.acknowledge(minute)
            elif status in PERMANENT_REJECTIONS:
                log(f"batch rejected status={status} minute={minute}")
                collector.acknowledge(minute, rejected=True)
            else:
                log(f"upload deferred status={status or 'unknown'}")
                return False
        return True


def run(config, key, state_dir):
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(True))
    signal.signal(signal.SIGINT, lambda *_: stopping.append(True))
    collector = Collector(os.path.join(state_dir, "collector.sqlite3"), config["region"], config["unit"])
    uploader = Uploader(config["endpoint"], config["region"], key)
    backoff = 0
    next_upload = 0.0
    while not stopping:
        # Without a cursor, entries logged while stopped cannot be replayed.
        if collector.cursor() is None:
            collector.mark_incomplete()
        process = subprocess.Popen(
            journal_command(config["unit"], collector.cursor()),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        reader = LineReader()
        stream_failed = False
        try:
            fd = process.stdout.fileno()
            while not stopping:
                ready, _, _ = select.select([fd], [], [], 1.0)
                if ready:
                    chunk = os.read(fd, READ_CHUNK_BYTES)
                    if not chunk:
                        stream_failed = True
                        break
                    for line in reader.feed(chunk):
                        collector.process(line)
                collector.flush_if_due()
                if not collector.uncommitted:
                    collector.seal(reader_idle=not ready)
                if time.monotonic() >= next_upload:
                    if uploader.drain(collector):
                        backoff = 0
                    else:
                        backoff = min(MAX_BACKOFF_S, max(5, backoff * 2))
                        next_upload = time.monotonic() + backoff
        except InterruptedError:
            pass
        finally:
            collector.commit()
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if stream_failed and not stopping:
            log("journal stream ended; resuming from the saved cursor")
            collector.mark_incomplete()
            time.sleep(1)
    collector.commit()
    collector.db.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", default="/etc/hackerai-egress/collector.json")
    parser.add_argument("--key", default="/etc/hackerai-egress/telemetry.key")
    parser.add_argument(
        "--state-dir",
        default=os.environ.get("STATE_DIRECTORY", "/var/lib/hackerai-egress-collector"),
    )
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        key = load_key(args.key)
    except ConfigError as error:
        log(str(error))
        return 78  # EX_CONFIG: systemd does not restart-loop on configuration.
    run(config, key, args.state_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
