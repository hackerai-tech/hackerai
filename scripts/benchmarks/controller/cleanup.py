"""Exact-job Docker cleanup with authoritative disappearance reconciliation.

Container and network inventories are snapshots shared by parallel jobs. A
failed inspect is harmless only when a fresh successful inventory proves the
exact immutable ID absent. No daemon/read failure becomes absence.
"""
import json
import hashlib
import hmac
import os
import re
import subprocess
import time
import tempfile
from pathlib import Path


class DockerObservationError(RuntimeError):
    def __init__(self, operation, result=None):
        self.record = {
            'operation': operation,
            'returnCode': getattr(result, 'returncode', None),
            'stdoutBytes': len(getattr(result, 'stdout', b'')),
            'stderrBytes': len(getattr(result, 'stderr', b'')),
        }
        super().__init__('exact_docker_observation_unconfirmed')


class Docker:
    def __init__(self, run=None):
        """Use bounded daemon calls, or inject the same result contract in tests."""
        self.run = run or (lambda args: subprocess.run(
            ['docker', *args], capture_output=True, timeout=30))

    def checked(self, args, operation):
        """Keep failed daemon reads distinct from empty successful inventories."""
        result = self.run(args)
        if result.returncode:
            raise DockerObservationError(operation, result)
        return result.stdout

    def ids(self, kind):
        """Reject partial IDs so later inspection cannot select another owner."""
        args = ['ps', '-aq', '--no-trunc'] if kind == 'container' else [
            'network', 'ls', '-q', '--no-trunc']
        identities = self.checked(args, kind + '_inventory').decode().split()
        if any(not re.fullmatch('[0-9a-f]{64}', value) for value in identities):
            raise DockerObservationError(kind + '_inventory_schema')
        return identities

    def inspect(self, kind, identity):
        """Reconcile disappearance only through a fresh successful inventory."""
        args = ['inspect', identity] if kind == 'container' else [
            'network', 'inspect', identity]
        result = self.run(args)
        if result.returncode:
            if identity not in self.ids(kind):
                return None
            raise DockerObservationError(kind + '_inspect', result)
        try:
            values = json.loads(result.stdout)
            if len(values) != 1 or values[0]['Id'] != identity:
                raise ValueError('Unexpected Docker identity')
            return values[0]
        except (ValueError, TypeError, KeyError):
            raise DockerObservationError(kind + '_inspect_schema', result)

    def remove(self, kind, identity):
        """Retain mutation uncertainty unless exact absence is independently read."""
        args = ['rm', '-f', identity] if kind == 'container' else [
            'network', 'rm', identity]
        result = self.run(args)
        if result.returncode and identity in self.ids(kind):
            raise DockerObservationError(kind + '_remove', result)


def owned_container(record, root):
    """Bind the job label to its trusted override, allowing stock base configs."""
    labels = record['Config'].get('Labels') or {}
    paths = labels.get('com.docker.compose.project.config_files', '').split(',')
    scoped_path = any(Path(p).is_absolute() and Path(p).resolve().is_relative_to(root.resolve())
                      for p in paths if p)
    scoped_label = labels.get('com.hackerai.benchmark.job') == root.name
    if scoped_path != scoped_label:
        raise DockerObservationError('container_ownership_mismatch')
    return scoped_path and scoped_label


def canonical(value):
    """Use sorted compact UTF-8 bytes shared by request and receipt signers."""
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def cleanup_job(root, docker=None):
    """Remove exact-owned resources before deleting the two task credentials."""
    root = Path(root)
    if not root.is_absolute() or root.is_symlink() or not re.fullmatch('[0-9a-f]{32}', root.name):
        raise DockerObservationError('invalid_job_scope')
    docker = docker or Docker()
    config = json.loads((root / 'control/config.json').read_text())
    if config['scope']['runId'] != 'local-' + root.name:
        raise DockerObservationError('config_job_scope_mismatch')
    removed = []
    for cid in docker.ids('container'):
        record = docker.inspect('container', cid)
        if record is not None and owned_container(record, root):
            docker.remove('container', cid)
            removed.append(cid)
    for nid in docker.ids('network'):
        record = docker.inspect('network', nid)
        if record is None:
            continue
        if (record.get('Labels') or {}).get('com.hackerai.benchmark.job') == root.name:
            if record.get('Containers'):
                raise DockerObservationError('owned_network_still_attached')
            docker.remove('network', nid)
    remaining_containers = []
    for cid in docker.ids('container'):
        record = docker.inspect('container', cid)
        if record is not None and owned_container(record, root):
            remaining_containers.append(cid)
    remaining_networks = []
    for nid in docker.ids('network'):
        record = docker.inspect('network', nid)
        if record is not None and (record.get('Labels') or {}).get(
                'com.hackerai.benchmark.job') == root.name:
            remaining_networks.append(nid)
    if remaining_containers or remaining_networks:
        raise DockerObservationError('owned_resources_remain')
    for name in ['remote-token', 'signing-key']:
        (root / 'control' / name).unlink(missing_ok=True)
    return {'cleanupVerified': True, 'remainingContainers': [],
            'remainingNetworks': [], 'hostTaskSecretsRemoved': True,
            'cleanupOwnedContainerIds': removed, 'cleanupFinishedAt': time.time()}


def persist_state(path, state):
    """Publish complete private state and retain the previous file on failure."""
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(state, out, allow_nan=False)
            out.flush()
            os.fsync(out.fileno())
        temporary.replace(path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def finalize_job(root, state, cleanup=None):
    """Always retain a terminal cleanup outcome, including observation failures."""
    from .diagnostics import exception_record
    root = Path(root)
    interrupt = None
    try:
        state.update((cleanup or cleanup_job)(root))
    except BaseException as error:
        if not isinstance(error, Exception):
            interrupt = error
        state.update(status='native_cleanup_unconfirmed', cleanupVerified=False,
                     cleanupFailure=exception_record(error))
        if isinstance(error, DockerObservationError):
            state['cleanupFailure']['guard'] = error.record
        # Keep the original guard/process failure and the distinct cleanup fault.
        state.setdefault('errorClass', type(error).__name__)
    finally:
        if state.get('independentCleanupAttempted'):
            state['independentCleanupReconciled'] = state.get('cleanupVerified') is True
        state['finishedAt'] = time.time()
        state['productRequestIntentAbsent'] = not (
            root / 'control/mailbox/request-intent.json').exists()
        persist_state(root / 'native-state.json', state)
    if interrupt is not None:
        raise interrupt
    return state


def claim_cleanup_intent(path, payload):
    """Make the one-use cleanup claim durable before the first mutation."""
    path = Path(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(payload, out, allow_nan=False)
        out.flush()
        os.fsync(out.fileno())
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def record_claim_failure(root, state, error):
    """A failed one-use claim cannot leave a healthy-looking running state."""
    from .diagnostics import exception_record
    failure = exception_record(error)
    if isinstance(error, DockerObservationError):
        failure['guard'] = error.record
    state.setdefault('firstCleanupClaimFailure', failure)
    state.update(status='native_cleanup_unconfirmed', cleanupVerified=False,
                 cleanupClaimConfirmed=False, cleanupFailure=failure,
                 finishedAt=time.time())
    state.setdefault('errorClass', type(error).__name__)
    # A storage failure here must propagate too; it is never a cleanup receipt.
    persist_state(root / 'native-state.json', state)


def claim_for_state(root, state, payload):
    """Persist claim failures without overwriting a prior replay outcome."""
    try:
        if not isinstance(state.get('status'), str):
            raise DockerObservationError('native_state_status_missing')
        claim_cleanup_intent(root / 'independent-cleanup-intent.json', payload)
    except FileExistsError:
        # Rejected replays cannot overwrite an earlier cleanup outcome.
        raise
    except BaseException as error:
        record_claim_failure(root, state, error)
        raise


def exact_process_alive(pid, start_ticks, proc=Path('/proc')):
    """Require readable procfs before PID absence can attest owner termination."""
    if type(pid) is not int or pid <= 1 or not re.fullmatch('[0-9]+', str(start_ticks)) or int(start_ticks) <= 0:
        raise DockerObservationError('process_identity_invalid')
    # ENOENT for a target PID is meaningful only inside a readable procfs.
    # Never interpret an unavailable mount as proof that every owner exited.
    try:
        probe = (proc / 'self/stat').read_text().rsplit(')', 1)[1].split()
        if len(probe) < 20 or not re.fullmatch('[0-9]+', probe[19]):
            raise ValueError('Invalid procfs')
    except (OSError, ValueError, IndexError):
        raise DockerObservationError('process_observation_unavailable')
    try:
        fields = (proc / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()
        if len(fields) < 20 or not re.fullmatch('[0-9]+', fields[19]):
            raise DockerObservationError('process_stat_invalid')
        return int(fields[19]) == int(start_ticks) and fields[0] not in {'Z', 'X'}
    except (FileNotFoundError, ProcessLookupError):
        return False


def reconcile_dead_undispatched(root, authorization, key, proc=Path('/proc'), cleanup=None):
    """Reconcile a synthetic setup failure that provably never sent a request."""
    root = Path(root)
    config = json.loads((root / 'control/config.json').read_text())
    payload = authorization['payload']
    expected = {'protocol': 'benchmark-no-dispatch-cleanup-v1',
                'job': root.name, 'scope': config['scope'],
                'noProductDispatchConfirmed': True}
    if (config.get('mode') != 'synthetic_canary' or payload != expected or
            len(key) != 32 or hashlib.sha256(key).hexdigest() != config.get('terminalKeyFingerprint') or
            not hmac.compare_digest(authorization['signature'], hmac.new(
                key, canonical(payload), hashlib.sha256).hexdigest())):
        raise DockerObservationError('undispatched_cleanup_authorization_invalid')
    mailbox = root / 'control/mailbox'
    if ((mailbox / 'request-intent.json').exists() or list(mailbox.glob('req-*.json')) or
            list(mailbox.glob('res-*.json'))):
        raise DockerObservationError('undispatched_cleanup_request_exists')
    owner = json.loads((root / 'process.json').read_text())
    state = json.loads((root / 'native-state.json').read_text())
    if (owner['job'] != root.name or not state.get('childPid') or not state.get('childStartTicks') or
            exact_process_alive(owner['pid'], owner['startTicks'], proc) or
            exact_process_alive(state['childPid'], state['childStartTicks'], proc)):
        raise DockerObservationError('undispatched_cleanup_native_owner_unconfirmed')
    claim_for_state(root, state,
        {'job': root.name, 'noProductDispatchConfirmed': True,
         'supervisorExited': True, 'harborExited': True, 'at': time.time()})
    state['statusBeforeIndependentCleanup'] = state['status']
    if 'cleanupFailure' in state:
        state['priorCleanupFailure'] = state.pop('cleanupFailure')
    state.update(status='native_setup_failure_cleaned_without_product_dispatch',
                 noProductDispatchConfirmed=True, independentCleanupAttempted=True)
    return finalize_job(root, state, cleanup=cleanup)


def reconcile_dead_job(root, envelope, key, proc=Path('/proc'), cleanup=None):
    """Crash-independent final cleanup, never a process or Goal restart."""
    root = Path(root)
    config = json.loads((root / 'control/config.json').read_text())
    if len(key) != 32 or hashlib.sha256(key).hexdigest() != config.get(
            'terminalKeyFingerprint'):
        raise DockerObservationError('cleanup_key_identity_mismatch')
    payload = envelope['payload']
    if not hmac.compare_digest(envelope['signature'], hmac.new(
            key, canonical(payload), hashlib.sha256).hexdigest()):
        raise DockerObservationError('cleanup_receipt_signature_mismatch')
    request_id = payload.get('requestId', '')
    if not re.fullmatch('[0-9a-f]{32}', request_id):
        raise DockerObservationError('cleanup_request_identity_missing')
    request_envelope = json.loads((root / 'control/mailbox' / (
        'req-' + request_id + '.json')).read_text())
    request = request_envelope['payload']
    if not hmac.compare_digest(request_envelope['signature'], hmac.new(
            key, canonical(request), hashlib.sha256).hexdigest()):
        raise DockerObservationError('cleanup_original_request_changed')
    if (any(request.get(k) != v for k, v in config['scope'].items()) or
            payload.get('requestSha256') != hashlib.sha256(canonical(request)).hexdigest() or
            payload.get('requestId') != request['requestId'] or
            payload.get('laneId') != request['laneId'] or
            payload.get('caseId') != request['caseId'] or
            payload.get('agentBudgetSeconds') != request['agentBudgetSeconds'] or
            payload.get('protocol') != 'native-goal-terminal-v4' or
            payload.get('goalCleanupConfirmed') is not True):
        raise DockerObservationError('cleanup_product_termination_unconfirmed')
    if payload.get('outcome') not in {
            'achieved', 'model_stopped', 'budget_exhausted', 'infrastructure_stopped'}:
        raise DockerObservationError('cleanup_unknown_product_outcome')
    state = json.loads((root / 'native-state.json').read_text())
    owner = json.loads((root / 'process.json').read_text())
    if owner['job'] != root.name:
        raise DockerObservationError('cleanup_supervisor_identity_mismatch')
    if exact_process_alive(owner['pid'], owner['startTicks'], proc):
        raise DockerObservationError('cleanup_supervisor_still_running')
    if not state.get('childPid') or not state.get('childStartTicks'):
        raise DockerObservationError('cleanup_harbor_identity_missing')
    if exact_process_alive(state['childPid'], state['childStartTicks'], proc):
        raise DockerObservationError('cleanup_harbor_still_running')
    claim_for_state(root, state,
        {'job': root.name, 'requestSha256': payload['requestSha256'],
         'supervisorExited': True, 'harborExited': True,
         'productCleanupConfirmed': True, 'at': time.time()})
    # Keep existing native/cleanup faults. Resource reconciliation cannot
    # upgrade a model result or grant permission to run a verifier.
    state['statusBeforeIndependentCleanup'] = state['status']
    if 'cleanupFailure' in state:
        state['priorCleanupFailure'] = state.pop('cleanupFailure')
    state['independentCleanupAttempted'] = True
    state['status'] = 'native_terminal_after_independent_cleanup'
    return finalize_job(root, state, cleanup=cleanup)
