ARG BASE_IMAGE=debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates openvpn openssl iproute2 iptables dante-server \
    openssh-server openssh-client python3 curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --no-create-home proxyuser \
    && useradd --create-home labuser \
    && rm -f /etc/ssh/ssh_host_*
COPY fixture.py verify.py /fixture/
ENTRYPOINT ["python3", "/fixture/fixture.py"]
