import hashlib
import hmac
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

OWNED = 'a' * 64
FOREIGN = 'b' * 64
NETWORK = 'c' * 64
FOREIGN_NETWORK = 'd' * 64

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from controller.cleanup import Docker, DockerObservationError, cleanup_job, finalize_job, reconcile_dead_job, reconcile_dead_undispatched, persist_state, exact_process_alive
from controller.diagnostics import GuardFailure, check_health, check_deadline
from controller.cleanup import canonical


class FakeDocker:
    def __init__(self, root):
        self.root = root
        self.containers = {
            OWNED: self.container(OWNED, root.name, root / 'control/compose.json'),
            FOREIGN: self.container(FOREIGN, 'f' * 32, Path('/other/compose.json')),
        }
        self.networks = {NETWORK: {'Id': NETWORK, 'Containers': {},
            'Labels': {'com.hackerai.benchmark.job': root.name}}}
        self.inspect_fault = None
        self.inventory_fault = False
        self.removals = []

    @staticmethod
    def container(identity, job, source):
        return {'Id': identity, 'Config': {'Labels': {
            'com.hackerai.benchmark.job': job,
            'com.docker.compose.project.config_files': str(source),
            'com.docker.compose.project': 'deliberately-shared-project-name'}}}

    def run(self, args):
        def reply(code=0, value=b''):
            return subprocess.CompletedProcess(args, code, value, b'PRIVATE_DAEMON_DETAIL' if code else b'')
        if args[:2] == ['ps', '-aq']:
            return reply(1) if self.inventory_fault else reply(value='\n'.join(self.containers).encode())
        if args[:2] == ['network', 'ls']:
            return reply(value='\n'.join(self.networks).encode())
        if args[0] == 'inspect' or args[:2] == ['network', 'inspect']:
            kind = 'network' if args[0] == 'network' else 'container'
            identity = args[-1]
            values = self.networks if kind == 'network' else self.containers
            if self.inspect_fault and self.inspect_fault(kind, identity, values):
                return reply(1)
            return reply(value=json.dumps([values[identity]]).encode()) if identity in values else reply(1)
        if args[:2] == ['rm', '-f'] or args[:2] == ['network', 'rm']:
            kind = 'network' if args[0] == 'network' else 'container'
            self.removals.append((kind, args[-1]))
            (self.networks if kind == 'network' else self.containers).pop(args[-1], None)
            return reply()
        raise AssertionError('Unexpected Docker operation')


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / ('a' * 32)
        (self.root / 'control/mailbox').mkdir(parents=True)
        self.scope = {'runId': 'local-' + self.root.name, 'laneId': 'synthetic-only',
                      'caseId': 'synthetic', 'agentBudgetSeconds': 600}
        self.key = b'k' * 32
        self.config = {'scope': self.scope, 'composeProject': 'deliberately-shared-project-name',
                       'terminalKeyFingerprint': hashlib.sha256(self.key).hexdigest()}
        self.write('control/config.json', self.config)
        for name in ['remote-token', 'signing-key']:
            (self.root / 'control' / name).write_text('PRIVATE_FIXTURE')
        self.fake = FakeDocker(self.root)
        self.docker = Docker(self.fake.run)

    def write(self, name, value):
        (self.root / name).write_text(json.dumps(value))

    def test_other_job_disappearing_during_inspection_does_not_strand_cleanup(self):
        def disappear(kind, identity, values):
            if identity == FOREIGN:
                values.pop(identity, None)
                return True
            return False
        self.fake.inspect_fault = disappear
        result = cleanup_job(self.root, self.docker)
        self.assertTrue(result['cleanupVerified'])
        self.assertEqual(self.fake.removals, [('container', OWNED), ('network', NETWORK)])
        self.assertFalse((self.root / 'control/remote-token').exists())

    def test_foreign_resources_with_same_project_name_are_preserved(self):
        self.fake.networks[FOREIGN_NETWORK] = {'Id': FOREIGN_NETWORK, 'Containers': {},
            'Labels': {'com.hackerai.benchmark.job': 'f' * 32,
                       'com.docker.compose.project': 'deliberately-shared-project-name'}}
        cleanup_job(self.root, self.docker)
        self.assertIn(FOREIGN, self.fake.containers)
        self.assertIn(FOREIGN_NETWORK, self.fake.networks)

    def test_failed_inspect_is_not_ignored_when_id_still_exists(self):
        self.fake.inspect_fault = lambda kind, identity, values: identity == OWNED
        with self.assertRaises(DockerObservationError):
            cleanup_job(self.root, self.docker)
        self.assertEqual(self.fake.removals, [])
        self.assertTrue((self.root / 'control/signing-key').exists())

    def test_failed_fresh_inventory_is_not_proof_of_disappearance(self):
        def lose_daemon(kind, identity, values):
            self.fake.inventory_fault = True
            return True
        self.fake.inspect_fault = lose_daemon
        with self.assertRaises(DockerObservationError):
            cleanup_job(self.root, self.docker)
        self.assertTrue((self.root / 'control/signing-key').exists())

    def test_network_disappearance_uses_fresh_read_without_replaying_delete(self):
        def disappear(kind, identity, values):
            if kind == 'network':
                values.pop(identity, None)
                return True
            return False
        self.fake.inspect_fault = disappear
        self.assertTrue(cleanup_job(self.root, self.docker)['cleanupVerified'])
        self.assertNotIn(('network', NETWORK), self.fake.removals)

    def test_attached_owned_network_remains_unconfirmed_and_keeps_credentials(self):
        self.fake.networks[NETWORK]['Containers'] = {'still-attached': {}}
        with self.assertRaises(DockerObservationError):
            cleanup_job(self.root, self.docker)
        self.assertTrue((self.root / 'control/signing-key').exists())

    def test_ownership_mismatch_never_deletes_the_container(self):
        self.fake.containers[OWNED]['Config']['Labels']['com.hackerai.benchmark.job'] = 'f' * 32
        with self.assertRaises(DockerObservationError):
            cleanup_job(self.root, self.docker)
        self.assertEqual(self.fake.removals, [])

    def test_finally_error_is_durably_terminal_and_keeps_original_guard(self):
        state = {'status': 'native_failure', 'errorClass': 'GuardFailure',
                 'failure': {'guard': {'metrics': {'zombies': 10}}}}
        def fail(root):
            raise DockerObservationError('container_inspect')
        result = finalize_job(self.root, state, cleanup=fail)
        saved = json.loads((self.root / 'native-state.json').read_text())
        self.assertEqual(saved, result)
        self.assertFalse(saved['cleanupVerified'])
        self.assertEqual(saved['errorClass'], 'GuardFailure')
        self.assertEqual(saved['failure']['guard']['metrics']['zombies'], 10)
        self.assertEqual(saved['cleanupFailure']['guard']['operation'], 'container_inspect')
        self.assertIn('finishedAt', saved)
        self.assertNotIn('PRIVATE', json.dumps(saved))

    def test_resource_guard_records_the_exact_boundary_sample_before_cleanup(self):
        healthy = {'freeBytes': 40 * 2**30, 'memoryPercent': 35, 'processes': 1999, 'zombies': 9}
        path = self.root / 'first-guard-failure.json'
        check_health(healthy, path)
        for key, value in [('freeBytes', 40 * 2**30 - 1), ('memoryPercent', 34.9),
                           ('processes', 2000), ('zombies', 10)]:
            with self.subTest(key=key), self.assertRaises(GuardFailure) as caught:
                check_health({**healthy, key: value}, path)
            self.assertEqual(caught.exception.record['failedMetrics'], [key])
            self.assertEqual(caught.exception.record['metrics'][key], value)
        first = json.loads(path.read_text())
        self.assertEqual(first['failedMetrics'], ['freeBytes'])
        self.assertEqual(first['metrics']['freeBytes'], 40 * 2**30 - 1)

    def receipt_fixture(self):
        request = {**self.scope, 'requestId': 'b' * 32}
        seal = lambda payload: {'payload': payload, 'signature': hmac.new(
            self.key, canonical(payload), hashlib.sha256).hexdigest()}
        self.write('control/mailbox/req-' + request['requestId'] + '.json', seal(request))
        payload = {'protocol': 'native-goal-terminal-v4', 'requestId': request['requestId'],
                   'laneId': request['laneId'], 'caseId': request['caseId'],
                   'agentBudgetSeconds': request['agentBudgetSeconds'],
                   'requestSha256': hashlib.sha256(canonical(request)).hexdigest(),
                   'goalCleanupConfirmed': True, 'outcome': 'achieved'}
        self.write('native-state.json', {'status': 'native_cleanup_unconfirmed',
            'childPid': 102, 'childStartTicks': '222', 'errorClass': 'DockerObservationError'})
        self.write('process.json', {'job': self.root.name, 'pid': 101, 'startTicks': '111'})
        proc = self.root / 'fake-proc'
        proc.mkdir()
        (proc / 'self').mkdir()
        (proc / 'self/stat').write_text('900 (observer) ' + ' '.join(['S', *(['0'] * 18), '123']))
        return seal(payload), proc

    def test_unavailable_procfs_cannot_prove_process_exit(self):
        receipt, proc = self.receipt_fixture()
        (proc / 'self/stat').unlink()
        with self.assertRaises(DockerObservationError):
            reconcile_dead_job(self.root, receipt, self.key, proc=proc)
        self.assertFalse((self.root / 'independent-cleanup-intent.json').exists())
        self.assertEqual(self.fake.removals, [])

    def test_no_dispatch_cleanup_requires_authenticated_empty_mailbox_and_dead_owners(self):
        receipt, proc = self.receipt_fixture()
        self.config['mode']='synthetic_canary';self.write('control/config.json',self.config)
        (self.root/'control/mailbox'/('req-'+'b'*32+'.json')).unlink()
        payload={'protocol':'benchmark-no-dispatch-cleanup-v1','job':self.root.name,
                 'scope':self.scope,'noProductDispatchConfirmed':True}
        auth={'payload':payload,'signature':hmac.new(self.key,canonical(payload),hashlib.sha256).hexdigest()}
        intent=self.root/'control/mailbox/request-intent.json';intent.write_text('{}')
        with self.assertRaises(DockerObservationError):reconcile_dead_undispatched(self.root,auth,self.key,proc=proc)
        self.assertEqual(self.fake.removals,[]);intent.unlink()
        result=reconcile_dead_undispatched(self.root,auth,self.key,proc=proc,
            cleanup=lambda root:cleanup_job(root,self.docker))
        self.assertTrue(result['cleanupVerified']);self.assertTrue(result['noProductDispatchConfirmed'])
        self.assertEqual(result['statusBeforeIndependentCleanup'],'native_cleanup_unconfirmed')

    def test_dead_owner_cleanup_is_receipt_bound_and_preserves_reused_pid(self):
        receipt, proc = self.receipt_fixture()
        (proc / '101').mkdir()
        fields = ['S', *(['0'] * 18), '999']
        (proc / '101/stat').write_text('101 (unrelated) ' + ' '.join(fields))
        result = reconcile_dead_job(self.root, receipt, self.key, proc=proc,
                                   cleanup=lambda root: cleanup_job(root, self.docker))
        self.assertTrue(result['cleanupVerified'])
        self.assertTrue((proc / '101/stat').exists())
        self.assertEqual(result['errorClass'], 'DockerObservationError')
        with self.assertRaises(FileExistsError):
            reconcile_dead_job(self.root, receipt, self.key, proc=proc)

    def test_alive_exact_owner_blocks_independent_cleanup(self):
        receipt, proc = self.receipt_fixture()
        (proc / '101').mkdir()
        fields = ['S', *(['0'] * 18), '111']
        (proc / '101/stat').write_text('101 (owner) ' + ' '.join(fields))
        with self.assertRaises(DockerObservationError):
            reconcile_dead_job(self.root, receipt, self.key, proc=proc)
        self.assertFalse((self.root / 'independent-cleanup-intent.json').exists())
        self.assertTrue((self.root / 'control/signing-key').exists())

    def test_invalid_product_receipt_cannot_authorize_native_cleanup(self):
        receipt, proc = self.receipt_fixture()
        receipt['payload']['goalCleanupConfirmed'] = False
        with self.assertRaises(DockerObservationError):
            reconcile_dead_job(self.root, receipt, self.key, proc=proc)
        self.assertTrue((self.root / 'control/signing-key').exists())

    def test_malformed_inventory_cannot_be_used_as_proof_of_absence(self):
        docker = Docker(lambda args: subprocess.CompletedProcess(args, 0, b'partial-id', b''))
        with self.assertRaises(DockerObservationError):
            cleanup_job(self.root, docker)
        self.assertTrue((self.root / 'control/signing-key').exists())

    def test_compose_path_cannot_escape_the_owned_root(self):
        self.fake.containers[OWNED]['Config']['Labels']['com.docker.compose.project.config_files'] = str(self.root / '..' / 'foreign' / 'compose.yaml')
        with self.assertRaises(DockerObservationError):
            cleanup_job(self.root, self.docker)
        self.assertEqual(self.fake.removals, [])

    def test_remove_failure_requires_fresh_absence_not_just_a_failed_mutation(self):
        original = self.fake.run
        def failed_delete(args):
            if args[:2] == ['rm', '-f']:
                return subprocess.CompletedProcess(args, 1, b'', b'PRIVATE_ERROR')
            return original(args)
        with self.assertRaises(DockerObservationError):
            cleanup_job(self.root, Docker(failed_delete))
        self.assertTrue((self.root / 'control/signing-key').exists())
        def removed_concurrently(args):
            if args[:2] == ['rm', '-f']:
                self.fake.containers.pop(args[-1])
                return subprocess.CompletedProcess(args, 1, b'', b'PRIVATE_ERROR')
            return original(args)
        self.assertTrue(cleanup_job(self.root, Docker(removed_concurrently))['cleanupVerified'])

    def test_successfully_signed_receipt_still_requires_exact_request_binding(self):
        receipt, proc = self.receipt_fixture()
        receipt['payload']['requestSha256'] = '0' * 64
        receipt['signature'] = hmac.new(self.key, canonical(receipt['payload']), hashlib.sha256).hexdigest()
        with self.assertRaises(DockerObservationError):
            reconcile_dead_job(self.root, receipt, self.key, proc=proc)
        self.assertFalse((self.root / 'independent-cleanup-intent.json').exists())

    def test_unknown_exception_text_and_attached_record_are_not_persisted(self):
        class UnexpectedFailure(RuntimeError):
            record = {'secret': 'PRIVATE_ERROR'}
        def fail(root):
            raise UnexpectedFailure('PRIVATE_COMMAND_OR_TOKEN')
        result = finalize_job(self.root, {'status': 'native_failure'}, cleanup=fail)
        self.assertFalse(result['cleanupVerified'])
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertIsNone(result['cleanupFailure']['guard'])

    def test_failed_state_serialization_preserves_previous_state_and_cleans_temp(self):
        path = self.root / 'native-state.json'
        persist_state(path, {'status': 'previous'})
        with self.assertRaises(ValueError):
            persist_state(path, {'invalid': float('nan')})
        self.assertEqual(json.loads(path.read_text()), {'status': 'previous'})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(list(self.root.glob('*.tmp')))

    def test_concurrent_guards_publish_one_complete_sample_without_private_fields(self):
        path = self.root / 'first-guard-failure.json'
        def sample(free):
            with self.assertRaises(GuardFailure):
                check_health({'freeBytes': free, 'memoryPercent': 99,
                    'processes': 100, 'zombies': 0, 'command': 'PRIVATE_ERROR'}, path)
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(sample, [1, 2]))
        first = path.read_bytes()
        sample(3)
        self.assertEqual(first, path.read_bytes())
        self.assertIn(json.loads(first)['metrics']['freeBytes'], [1, 2])
        self.assertNotIn(b'PRIVATE', first)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(list(self.root.glob('*.tmp')))

    def test_invalid_process_identity_does_not_become_absence(self):
        for pid, ticks in [(0, '1'), (1, '1'), (-1, '1'), (101, '0'), (101, 'unknown')]:
            with self.subTest(pid=pid, ticks=ticks), self.assertRaises(DockerObservationError):
                exact_process_alive(pid, ticks, proc=self.root / 'missing-proc')

    def test_wire_signature_encoding_retains_unescaped_utf8(self):
        self.assertEqual(canonical({'name': '\u00e9'}), b'{"name":"\xc3\xa9"}')

    def test_failed_independent_cleanup_remains_unconfirmed_and_cannot_replay(self):
        receipt, proc = self.receipt_fixture()
        def fail(root):
            raise DockerObservationError('container_inspect')
        result = reconcile_dead_job(self.root, receipt, self.key, proc=proc, cleanup=fail)
        self.assertFalse(result['cleanupVerified'])
        self.assertTrue(result['independentCleanupAttempted'])
        self.assertFalse(result['independentCleanupReconciled'])
        self.assertTrue((self.root / 'control/signing-key').exists())
        with self.assertRaises(FileExistsError):
            reconcile_dead_job(self.root, receipt, self.key, proc=proc)

    def test_deadline_retains_exact_boundary_and_invalid_limit_fails_closed(self):
        for elapsed, limit in [(600, 600), (1, float('nan')), (float('inf'), 600), (1, 0)]:
            with self.subTest(elapsed=elapsed, limit=limit), tempfile.TemporaryDirectory() as tmp:
                path=Path(tmp)/'failure.json'
                with self.assertRaises(GuardFailure):
                    check_deadline(elapsed, limit, path)
                result=json.loads(path.read_text())
                self.assertEqual(result['guard'], 'supervisor_envelope')
                if elapsed==600:self.assertEqual(result['elapsedSeconds'],600)
                self.assertNotIn('NaN',path.read_text())

    def test_claim_fsync_failure_is_durable_unconfirmed_and_never_mutates_resources(self):
        receipt, proc = self.receipt_fixture()
        original=os.fsync
        count=0
        def fail_first(fd):
            nonlocal count
            count+=1
            if count==1:raise OSError(28,'PRIVATE_CLAIM_ERROR')
            return original(fd)
        with patch('controller.cleanup.os.fsync',side_effect=fail_first), self.assertRaises(OSError):
            reconcile_dead_job(self.root,receipt,self.key,proc=proc,
                cleanup=lambda root:cleanup_job(root,self.docker))
        saved=json.loads((self.root/'native-state.json').read_text())
        self.assertEqual(saved['status'],'native_cleanup_unconfirmed')
        self.assertFalse(saved['cleanupClaimConfirmed'])
        self.assertFalse(saved['cleanupVerified'])
        self.assertEqual(saved['firstCleanupClaimFailure']['filesystemErrno'],28)
        self.assertNotIn('PRIVATE',json.dumps(saved))
        self.assertEqual(self.fake.removals,[])
        with self.assertRaises(FileExistsError):
            reconcile_dead_job(self.root,receipt,self.key,proc=proc)

    def test_missing_native_status_cannot_consume_a_cleanup_claim(self):
        receipt,proc=self.receipt_fixture()
        state=json.loads((self.root/'native-state.json').read_text());state.pop('status')
        self.write('native-state.json',state)
        with self.assertRaises(DockerObservationError):
            reconcile_dead_job(self.root,receipt,self.key,proc=proc)
        self.assertFalse((self.root/'independent-cleanup-intent.json').exists())
        self.assertEqual(json.loads((self.root/'native-state.json').read_text())['status'], 'native_cleanup_unconfirmed')


if __name__ == '__main__':
    unittest.main()
