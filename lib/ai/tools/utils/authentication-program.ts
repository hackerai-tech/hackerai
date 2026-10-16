// Executed in the selected sandbox through run_terminal_cmd. Only file references
// and a credential-free endpoint enter argv. Secrets and response bodies stay in
// this process; even exception messages can contain credentials and must not escape.
export const AUTHENTICATION_PROGRAM = String.raw`
import contextlib, http.cookiejar, io, json, math, os, re, signal, stat, sys, urllib.request, warnings
from urllib.parse import urlsplit

MAX_FILE = 262144
MAX_BODY = 262144

class Diagnostic(Exception):
    def __init__(self, outcome, reason):
        self.outcome, self.reason = outcome, reason

def fail(outcome, reason):
    raise Diagnostic(outcome, reason)

def read_private(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as f:
            info = os.fstat(f.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                fail('input_unavailable', 'not_owned_regular_file')
            if info.st_mode & 0o077:
                fail('input_unavailable', 'private_file_required')
            raw = f.read(MAX_FILE + 1)
            if len(raw) > MAX_FILE:
                fail('input_unavailable', 'file_too_large')
            return raw.decode('utf-8')
    except Diagnostic:
        raise
    except Exception:
        fail('input_unavailable', 'file_unreadable')

def pair(name, value):
    if not isinstance(name, str) or not re.fullmatch(r"[!#$%&'*+.^_\x60|~0-9A-Za-z-]+", name):
        fail('invalid_cookie_format', 'invalid_cookie_name')
    if not isinstance(value, str) or not re.fullmatch(r'[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*', value):
        fail('invalid_cookie_format', 'invalid_cookie_value')

def cookie_header(raw):
    # A single Cookie field (optionally prefixed), or one name=value per line.
    # Never interpret Set-Cookie attributes or a jar as request header text.
    raw = raw.strip()
    if raw.lower().startswith('cookie:'):
        raw = raw[7:].strip()
    entries = []
    for line in raw.splitlines():
        for item in line.split(';'):
            item = item.strip()
            if not item or '=' not in item:
                fail('invalid_cookie_format', 'expected_cookie_pairs')
            name, value = item.split('=', 1)
            pair(name, value)
            if name.lower() in ('domain', 'path', 'expires', 'max-age', 'samesite'):
                fail('invalid_cookie_format', 'set_cookie_attributes_are_not_request_cookies')
            entries.append((name, value))
    if not entries:
        fail('invalid_cookie_format', 'empty_cookie_input')
    return '; '.join(name + '=' + value for name, value in entries), len(entries)

def scoped_header(raw, kind, url):
    jar = http.cookiejar.MozillaCookieJar()
    storage_present = False
    if kind == 'netscape':
        for line in raw.splitlines():
            if line.startswith('#HttpOnly_'):
                line = line[10:]
            elif not line or line.startswith('#'):
                continue
            fields = line.split('\t')
            if len(fields) != 7 or fields[1] not in ('TRUE', 'FALSE') or fields[3] not in ('TRUE', 'FALSE') or not fields[4].isdigit():
                fail('invalid_cookie_format', 'expected_netscape_cookie_jar')
        try:
            # The standard parser preserves tail-match, path, secure and expiry.
            # It requires the Netscape header, preventing curl's silent ignore.
            # stdlib malformed-jar warnings can include the offending secret line.
            with warnings.catch_warnings(), contextlib.redirect_stderr(io.StringIO()):
                warnings.simplefilter('ignore')
                jar._really_load(io.StringIO(raw), '<private>', True, True)
        except Exception:
            fail('invalid_cookie_format', 'expected_netscape_cookie_jar')
    else:
        try:
            state = json.loads(raw)
        except Exception:
            fail('invalid_cookie_format', 'expected_plain_browser_state_json')
        if not isinstance(state, dict) or not isinstance(state.get('cookies'), list) or not isinstance(state.get('origins'), list):
            fail('invalid_cookie_format', 'expected_browser_state')
        # Never export or translate browser storage into HTTP credentials.
        storage_present = bool(state['origins'])
        for c in state['cookies']:
            if not isinstance(c, dict):
                fail('invalid_cookie_format', 'invalid_browser_cookie')
            if c.get('partitionKey') is not None or c.get('partitioned'):
                fail('unsupported_cookie_semantics', 'partitioned_cookie_requires_browser')
            required = ('name', 'value', 'domain', 'path', 'secure', 'expires')
            if any(k not in c for k in required):
                fail('invalid_cookie_format', 'incomplete_browser_cookie')
            pair(c['name'], c['value'])
            domain, path, expires = c['domain'], c['path'], c['expires']
            if not isinstance(domain, str) or not domain or not isinstance(path, str) or not path.startswith('/') or type(c['secure']) is not bool:
                fail('invalid_cookie_format', 'invalid_browser_cookie_scope')
            if type(expires) not in (int, float) or not math.isfinite(expires) or expires < -1:
                fail('invalid_cookie_format', 'invalid_browser_cookie_expiry')
            if c.get('sameSite') not in (None, 'Strict', 'Lax', 'None'):
                fail('invalid_cookie_format', 'invalid_browser_cookie_same_site')
            jar.set_cookie(http.cookiejar.Cookie(
                0, c['name'], c['value'], None, False, domain,
                domain.startswith('.'), domain.startswith('.'), path, True,
                c['secure'], None if expires == -1 else expires,
                expires == -1, None, None, {'HttpOnly': c.get('httpOnly', False), 'SameSite': c.get('sameSite')}, False))
    for c in jar:
        pair(c.name, c.value)
        # curl's Netscape convention uses 0 for session cookies; Python's
        # Mozilla parser otherwise interprets it as an expired Unix timestamp.
        if kind == 'netscape' and c.expires == 0:
            c.expires, c.discard = None, True
        if not re.fullmatch(r'\.?[a-zA-Z0-9.-]+', c.domain) or not c.path.startswith('/') or any(ord(ch) < 32 for ch in c.path):
            fail('invalid_cookie_format', 'invalid_cookie_scope')
    if not len(jar):
        fail('credentials_not_sent', 'no_cookies_in_input')
    # Default CookieJar policy otherwise sends host-only cookies to subdomains.
    jar.set_policy(http.cookiejar.DefaultCookiePolicy(
        strict_ns_domain=http.cookiejar.DefaultCookiePolicy.DomainStrictNonDomain))
    request = urllib.request.Request(url)
    total = len(jar)
    jar.add_cookie_header(request)
    header = request.get_header('Cookie', '')
    return header, total, storage_present

def pointer(document, path):
    if not isinstance(path, str) or not path.startswith('/'):
        fail('invalid_expectation', 'json_pointer_required')
    value = document
    try:
        for key in path[1:].split('/'):
            key = key.replace('~1', '/').replace('~0', '~')
            value = value[int(key)] if isinstance(value, list) else value[key]
        return value
    except (KeyError, IndexError, TypeError, ValueError):
        return None

def main(config):
    try:
        with warnings.catch_warnings(record=True) as notices:
            warnings.simplefilter('always')
            import requests
    except ImportError:
        fail('unsupported_runtime', 'python_requests_unavailable')
    if any(type(item.message).__name__ == 'NotOpenSSLWarning' for item in notices):
        fail('unsupported_runtime', 'unsupported_python_tls')
    url = config['url']
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        fail('invalid_endpoint', 'credential_free_http_endpoint_required')
    try:
        expectation = json.loads(read_private(config['expectation_file']))
    except Diagnostic:
        raise
    except Exception:
        fail('invalid_expectation', 'expected_json_object')
    if not isinstance(expectation, dict) or set(expectation) != {'origin', 'identity_pointer', 'identity'}:
        fail('invalid_expectation', 'expected_origin_and_identity')
    origin = urlsplit(expectation['origin'])
    if origin.scheme not in ('http', 'https') or not origin.hostname or origin.username or origin.password or origin.path not in ('', '/') or origin.query or origin.fragment:
        fail('invalid_expectation', 'exact_origin_required')
    def origin_key(value):
        return (value.scheme, value.hostname, value.port or (443 if value.scheme == 'https' else 80))
    if origin_key(parsed) != origin_key(origin):
        fail('invalid_endpoint', 'expected_origin_mismatch')
    identity = expectation['identity']
    if type(identity) not in (str, int) or identity == '':
        fail('invalid_expectation', 'nonempty_identity_required')
    pointer({}, expectation['identity_pointer'])
    raw = read_private(config['credential_file'])
    kind = config['credential_format']
    storage_present = False
    if kind == 'cookie_header':
        header, total = cookie_header(raw)
    elif kind in ('netscape', 'browser_state'):
        header, total, storage_present = scoped_header(raw, kind, url)
    else:
        fail('invalid_cookie_format', 'unknown_format')
    result = {
        'outcome': 'authentication_unverified', 'reason': 'identity_not_verified',
        'credential_format': kind, 'cookies_in_input': total,
        'attachment': 'not_sent', 'http_status': None,
        'browser_storage_used': False, 'browser_storage_present': storage_present,
        'verification_scope': 'single_endpoint_cookie_http_request',
        'expiry_proven': False,
    }
    if not header:
        return dict(result, outcome='credentials_not_sent', reason='no_cookie_matches_endpoint_scope')
    with requests.Session() as session:
        # No ambient .netrc credentials, proxies, global cookies, retries or TLS bypass.
        session.trust_env = False
        prepared = session.prepare_request(requests.Request('GET', url, headers={'Cookie': header, 'Accept': 'application/json'}))
        if prepared.headers.get('Cookie') != header:
            return dict(result, outcome='credentials_not_sent', reason='prepared_request_missing_cookies')
        result['attachment'] = 'prepared_request_verified'
        try:
            # Session.send computes response.next even with allow_redirects=False,
            # eagerly consuming a redirect body. The installed Requests adapter
            # performs exactly one dispatch and leaves ALL bodies bounded here.
            response = session.get_adapter(prepared.url).send(
                prepared, timeout=(5, 10), stream=True, verify=True, cert=None, proxies={})
            with response:
                if response.request.headers.get('Cookie') != header:
                    return dict(result, outcome='credentials_not_sent', reason='dispatched_request_missing_cookies')
                result['attachment'] = 'client_request_verified'
                result['http_status'] = response.status_code
                if response.headers.get('cf-mitigated', '').lower() == 'challenge':
                    return dict(result, outcome='challenge_required', reason='response_challenge_header')
                if 300 <= response.status_code < 400:
                    # Even same-origin redirects require a separately authorized check.
                    return dict(result, reason='redirect_not_followed')
                body = bytearray()
                for chunk in response.iter_content(8192):
                    body.extend(chunk)
                    if len(body) > MAX_BODY:
                        return dict(result, reason='response_too_large')
                text = body.decode('utf-8', errors='replace')
                if re.search(r'cf-chl-|/cdn-cgi/challenge-platform/|g-recaptcha|h-captcha', text, re.I):
                    return dict(result, outcome='challenge_required', reason='response_challenge_marker')
                if response.status_code in (401, 403):
                    return dict(result, outcome='authentication_failed', reason='endpoint_rejected_request_cause_unknown')
                if not 200 <= response.status_code < 300:
                    return dict(result, reason='endpoint_error')
                if 'json' not in response.headers.get('content-type', '').lower():
                    return dict(result, reason='expected_json_identity_response')
                try:
                    document = json.loads(text)
                except Exception:
                    return dict(result, reason='invalid_json_response')
                if isinstance(document, dict) and (document.get('error') or document.get('errors') or document.get('success') is False or document.get('authenticated') is False):
                    return dict(result, reason='error_or_unauthenticated_response')
                observed = pointer(document, expectation['identity_pointer'])
                if observed is None:
                    return dict(result, reason='identity_missing')
                if type(observed) is not type(identity) or observed != identity:
                    return dict(result, outcome='identity_mismatch', reason='unexpected_identity')
                return dict(result, outcome='authenticated', reason='expected_identity_matched')
        except requests.RequestException:
            return dict(result, outcome='request_failed', reason='transport_error_cause_unknown')

def stopped(signum, frame):
    fail('cancelled' if signum != signal.SIGALRM else 'request_failed',
         'cancelled' if signum != signal.SIGALRM else 'deadline_exceeded')

if __name__ == '__main__':
    if not hasattr(signal, 'SIGALRM') or not hasattr(os, 'O_NOFOLLOW'):
        print(json.dumps({'outcome': 'unsupported_runtime', 'reason': 'posix_python_required', 'expiry_proven': False}))
        sys.exit(0)
    signal.signal(signal.SIGTERM, stopped)
    signal.signal(signal.SIGINT, stopped)
    signal.signal(signal.SIGALRM, stopped)
    signal.alarm(20)
    try:
        result = main(json.loads(sys.argv[1]))
    except Diagnostic as error:
        result = {'outcome': error.outcome, 'reason': error.reason, 'expiry_proven': False}
    except BaseException:
        result = {'outcome': 'diagnostic_unavailable', 'reason': 'internal_error', 'expiry_proven': False}
    signal.alarm(0)
    print(json.dumps(result, separators=(',', ':')))
`;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export type AuthenticationRequest = {
  url: string;
  credential_file: string;
  credential_format: "cookie_header" | "netscape" | "browser_state";
  expectation_file: string;
};

export function authenticationCommand(input: AuthenticationRequest): string {
  return `python3 -c ${quote(AUTHENTICATION_PROGRAM)} ${quote(JSON.stringify(input))}`;
}
