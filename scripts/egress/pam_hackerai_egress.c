/*
 * pam_hackerai_egress: per-workspace SOCKS5 credentials for Dante.
 *
 * Dante's pam.username method passes the SOCKS5 username and password to
 * this PAM service. A username in the reserved "hae-" namespace is handled
 * only here: it must be exactly
 *
 *   hae-v1-<32 lowercase hex owner>-<32 lowercase hex workspace>
 *
 * with password = lowercase hex HMAC-SHA256(region key,
 *   "hackerai-egress/v1/password\n" <region> "\n" <username>).
 *
 * Anything else in that namespace fails, so it can never fall through to a
 * later module. Exactly the configured legacy username returns PAM_IGNORE so
 * the following pam_unix line can check the region's existing shared login;
 * every other name fails here, so no other host account can authenticate.
 * No account database is read or provisioned.
 *
 * On success the module logs exactly one fixed AUTHPRIV event naming the
 * region and the opaque owner and workspace references. It logs nothing
 * else: no password, key, client address or destination.
 *
 * Module arguments, each exactly once: region=us|eu, key=/absolute/path and
 * legacy=<shared username>, a lowercase system name outside the reserved
 * namespace. Invalid or missing arguments fail every login, including the
 * legacy one. The key file must be a regular, root-owned, mode 0600 file
 * (not a symlink) holding exactly 64 lowercase hex characters and an
 * optional newline. It is read on each authentication so a replaced key
 * applies without restarting Dante.
 *
 * The derivation is shared with lib/cloud-network/egress-attribution.ts and
 * checked against scripts/egress/tests/credentials.json.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <syslog.h>
#include <unistd.h>

#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>

#define PAM_SM_AUTH
#define PAM_SM_ACCOUNT
#include <security/pam_ext.h>
#include <security/pam_modules.h>

#define RESERVED_PREFIX "hae-"
#define USERNAME_PREFIX "hae-v1-"
#define PREFIX_LEN (sizeof(USERNAME_PREFIX) - 1)
#define REF_LEN 32
#define USERNAME_LEN (PREFIX_LEN + REF_LEN + 1 + REF_LEN)
#define PASSWORD_LEN 64
#define KEY_LEN 32
#define KEY_HEX_LEN (2 * KEY_LEN)
#define REGION_LEN 2
#define PASSWORD_DOMAIN "hackerai-egress/v1/password\n"
#define LEGACY_MAX_LEN 32

struct options {
  const char *region;
  const char *key_path;
  const char *legacy;
};

static int is_reserved(const char *user) {
  return strncmp(user, RESERVED_PREFIX, sizeof(RESERVED_PREFIX) - 1) == 0;
}

/* A canonical lowercase system name, never in the reserved namespace. */
static int valid_legacy(const char *name) {
  size_t length = strnlen(name, LEGACY_MAX_LEN + 1);
  if (length == 0 || length > LEGACY_MAX_LEN || is_reserved(name)) return 0;
  if (!((name[0] >= 'a' && name[0] <= 'z') || name[0] == '_')) return 0;
  for (size_t i = 1; i < length; i++) {
    char c = name[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' ||
          c == '-'))
      return 0;
  }
  return 1;
}

/* Exactly one of each argument; anything else is invalid. */
static int parse_options(int argc, const char **argv, struct options *opts) {
  opts->region = NULL;
  opts->key_path = NULL;
  opts->legacy = NULL;
  for (int i = 0; i < argc; i++) {
    if (strncmp(argv[i], "region=", 7) == 0 && opts->region == NULL) {
      const char *region = argv[i] + 7;
      if (strcmp(region, "us") != 0 && strcmp(region, "eu") != 0) return -1;
      opts->region = region;
    } else if (strncmp(argv[i], "key=", 4) == 0 && opts->key_path == NULL) {
      const char *path = argv[i] + 4;
      if (path[0] != '/') return -1;
      opts->key_path = path;
    } else if (strncmp(argv[i], "legacy=", 7) == 0 && opts->legacy == NULL) {
      const char *legacy = argv[i] + 7;
      if (!valid_legacy(legacy)) return -1;
      opts->legacy = legacy;
    } else {
      return -1;
    }
  }
  return opts->region != NULL && opts->key_path != NULL && opts->legacy != NULL
             ? 0
             : -1;
}

/* Only the configured shared login may continue to pam_unix. */
static int is_legacy(const char *user, const struct options *opts) {
  return strcmp(user, opts->legacy) == 0;
}

static int hex_value(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

static int is_lower_hex(const char *value, size_t length) {
  for (size_t i = 0; i < length; i++)
    if (hex_value(value[i]) < 0) return 0;
  return 1;
}

static int valid_username(const char *user) {
  if (strnlen(user, USERNAME_LEN + 1) != USERNAME_LEN ||
      memcmp(user, USERNAME_PREFIX, PREFIX_LEN) != 0)
    return 0;
  const char *owner = user + PREFIX_LEN;
  return is_lower_hex(owner, REF_LEN) && owner[REF_LEN] == '-' &&
         is_lower_hex(owner + REF_LEN + 1, REF_LEN);
}

static int load_key(const char *path, unsigned char key[KEY_LEN]) {
  char buffer[KEY_HEX_LEN + 2];
  size_t total = 0;
  struct stat st;
  int result = -1;
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NOCTTY | O_NONBLOCK);
  if (fd < 0) return -1;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != 0 ||
      (st.st_mode & 07777) != 0600)
    goto done;
  while (total < sizeof(buffer)) {
    ssize_t count = read(fd, buffer + total, sizeof(buffer) - total);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) goto done;
    if (count == 0) break;
    total += (size_t)count;
  }
  if (!(total == KEY_HEX_LEN ||
        (total == KEY_HEX_LEN + 1 && buffer[KEY_HEX_LEN] == '\n')))
    goto done;
  for (size_t i = 0; i < KEY_LEN; i++) {
    int high = hex_value(buffer[2 * i]);
    int low = hex_value(buffer[2 * i + 1]);
    if (high < 0 || low < 0) goto done;
    key[i] = (unsigned char)((high << 4) | low);
  }
  result = 0;
done:
  OPENSSL_cleanse(buffer, sizeof(buffer));
  close(fd);
  return result;
}

static int expected_password(const unsigned char key[KEY_LEN],
                             const char *region, const char *user,
                             char out[PASSWORD_LEN + 1]) {
  static const char digits[] = "0123456789abcdef";
  unsigned char message[sizeof(PASSWORD_DOMAIN) - 1 + REGION_LEN + 1 +
                        USERNAME_LEN];
  unsigned char mac[EVP_MAX_MD_SIZE];
  unsigned int mac_length = 0;
  size_t length = 0;
  int result = -1;

  memcpy(message, PASSWORD_DOMAIN, sizeof(PASSWORD_DOMAIN) - 1);
  length += sizeof(PASSWORD_DOMAIN) - 1;
  memcpy(message + length, region, REGION_LEN);
  length += REGION_LEN;
  message[length++] = '\n';
  memcpy(message + length, user, USERNAME_LEN);
  length += USERNAME_LEN;

  if (HMAC(EVP_sha256(), key, KEY_LEN, message, length, mac, &mac_length) !=
          NULL &&
      mac_length == PASSWORD_LEN / 2) {
    for (size_t i = 0; i < PASSWORD_LEN / 2; i++) {
      out[2 * i] = digits[mac[i] >> 4];
      out[2 * i + 1] = digits[mac[i] & 0x0f];
    }
    out[PASSWORD_LEN] = '\0';
    result = 0;
  }
  OPENSSL_cleanse(mac, sizeof(mac));
  return result;
}

PAM_EXTERN int pam_sm_authenticate(pam_handle_t *pamh, int flags, int argc,
                                   const char **argv) {
  const char *user = NULL;
  const char *password = NULL;
  struct options opts;
  unsigned char key[KEY_LEN];
  char expected[PASSWORD_LEN + 1];
  int result = PAM_AUTH_ERR;
  (void)flags;

  if (pam_get_user(pamh, &user, NULL) != PAM_SUCCESS || user == NULL)
    return PAM_AUTH_ERR;
  /* Every path is decisive except the configured legacy login. */
  if (parse_options(argc, argv, &opts) != 0) return PAM_SERVICE_ERR;
  if (!is_reserved(user))
    return is_legacy(user, &opts) ? PAM_IGNORE : PAM_AUTH_ERR;
  if (!valid_username(user)) return PAM_AUTH_ERR;
  if (pam_get_authtok(pamh, PAM_AUTHTOK, &password, NULL) != PAM_SUCCESS ||
      password == NULL ||
      strnlen(password, PASSWORD_LEN + 1) != PASSWORD_LEN)
    return PAM_AUTH_ERR;

  if (load_key(opts.key_path, key) == 0 &&
      expected_password(key, opts.region, user, expected) == 0 &&
      CRYPTO_memcmp(expected, password, PASSWORD_LEN) == 0)
    result = PAM_SUCCESS;
  OPENSSL_cleanse(key, sizeof(key));
  OPENSSL_cleanse(expected, sizeof(expected));

  if (result == PAM_SUCCESS)
    syslog(LOG_AUTHPRIV | LOG_INFO,
           "hackerai-egress-v1 accepted region=%s owner=%.32s workspace=%.32s",
           opts.region, user + PREFIX_LEN, user + PREFIX_LEN + REF_LEN + 1);
  return result;
}

PAM_EXTERN int pam_sm_setcred(pam_handle_t *pamh, int flags, int argc,
                              const char **argv) {
  (void)pamh;
  (void)flags;
  (void)argc;
  (void)argv;
  return PAM_IGNORE;
}

/* Reached only after authentication; there is no account to look up. */
PAM_EXTERN int pam_sm_acct_mgmt(pam_handle_t *pamh, int flags, int argc,
                                const char **argv) {
  const char *user = NULL;
  struct options opts;
  (void)flags;
  if (pam_get_user(pamh, &user, NULL) != PAM_SUCCESS || user == NULL)
    return PAM_PERM_DENIED;
  if (parse_options(argc, argv, &opts) != 0) return PAM_SERVICE_ERR;
  if (!is_reserved(user))
    return is_legacy(user, &opts) ? PAM_IGNORE : PAM_PERM_DENIED;
  return valid_username(user) ? PAM_SUCCESS : PAM_PERM_DENIED;
}
