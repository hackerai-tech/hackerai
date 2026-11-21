# Isolated Linux fixture for pam_hackerai_egress and the collector: distro
# Dante and Linux-PAM, a loopback HTTP target and synthetic credentials only.
#
#   docker build --file scripts/egress/tests/Dockerfile --tag hackerai-egress-test scripts/egress
#   docker run --rm --network none hackerai-egress-test
#
# The build context is scripts/egress, which holds only public source and the
# synthetic fixture in tests/credentials.json. The run has no network.
FROM ubuntu:24.04

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates dante-server gcc libc6-dev libpam0g-dev libssl-dev python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/egress
COPY pam_hackerai_egress.c collector.py hackerai-egress.pam ./
COPY tests/ ./tests/

# The same flags the README documents for installing on a proxy host.
RUN install -d -m 0755 /usr/local/lib/hackerai-egress \
 && gcc -std=c11 -O2 -Wall -Wextra -Werror -Wformat=2 -fPIC -shared \
      -fstack-protector-strong -D_FORTIFY_SOURCE=2 -Wl,-z,relro,-z,now \
      -o /usr/local/lib/hackerai-egress/pam_hackerai_egress.so \
      pam_hackerai_egress.c -lpam -lcrypto \
 && chmod 0644 /usr/local/lib/hackerai-egress/pam_hackerai_egress.so

CMD ["sh", "-c", "python3 -I -B -m unittest discover -s /opt/egress/tests -p 'test_*.py' -v && python3 -I -B /opt/egress/tests/integration.py"]
