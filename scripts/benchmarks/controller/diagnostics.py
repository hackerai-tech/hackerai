"""Fail-closed numeric guard evidence; never persist commands, locals or output."""
import json
import math
import os
import time
import tempfile
from pathlib import Path

LIMITS = {'freeBytes': 40 * 2**30, 'memoryPercent': 35,
          'processes': 2000, 'zombies': 10}


class GuardFailure(RuntimeError):
    def __init__(self, record):
        self.record = record
        super().__init__('native_guard_failed_' + record['guard'])


def persist_first(path, record):
    """Publish a complete durable first failure without replacing prior evidence."""
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(record, out, allow_nan=False)
            out.flush()
            os.fsync(out.fileno())
        try:
            os.link(temp, path)
        except FileExistsError:
            pass
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temp.unlink(missing_ok=True)


def check_health(metrics, evidence):
    clean = {k: v for k, v in metrics.items() if k in LIMITS
             and type(v) in (int, float) and math.isfinite(v)}
    failed = [k for k, limit in LIMITS.items()
              if k not in clean or clean[k] < 0 or
              (clean[k] < limit if k in ('freeBytes', 'memoryPercent')
               else clean[k] >= limit)]
    if failed:
        record = {'guard': 'host_resources', 'failedMetrics': failed,
                  'metrics': clean, 'limits': LIMITS, 'at': time.time()}
        persist_first(evidence, record)
        raise GuardFailure(record)
    return metrics


def check_deadline(elapsed, limit, evidence):
    valid_elapsed = type(elapsed) in (int, float) and math.isfinite(elapsed) and elapsed >= 0
    valid_limit = type(limit) in (int, float) and math.isfinite(limit) and limit > 0
    if not valid_elapsed or not valid_limit or elapsed >= limit:
        record = {'guard': 'supervisor_envelope', 'elapsedSeconds': elapsed if valid_elapsed else None,
                  'limitSeconds': limit if valid_limit else None, 'at': time.time()}
        persist_first(evidence, record)
        raise GuardFailure(record)


def exception_record(error):
    # Traceback locations only: no exception text, source lines, locals or paths.
    frames = []
    tb = error.__traceback__
    while tb:
        frames.append({'module': Path(tb.tb_frame.f_code.co_filename).name,
                       'function': tb.tb_frame.f_code.co_name, 'line': tb.tb_lineno})
        tb = tb.tb_next
    return {'errorClass': type(error).__name__, 'frames': frames[-20:],
            'guard': error.record if isinstance(error, GuardFailure) else None, 'at': time.time()}
