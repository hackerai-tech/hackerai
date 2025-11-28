FROM kalilinux/kali-rolling

LABEL org.opencontainers.image.title="HackerAI Agent Sandbox"
LABEL org.opencontainers.image.description="AI Agent Penetration Testing Environment with Comprehensive Automated Tools"
LABEL org.opencontainers.image.source="https://github.com/hackerai-tech/hackerai"
LABEL org.opencontainers.image.vendor="HackerAI"

# ============================================================================
# Environment Variables
# ============================================================================
ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/user
ENV GOPATH=/home/user/go
ENV GOCACHE=/home/user/go/.cache
ENV PATH=/home/user/.local/bin:/usr/local/go/bin:/home/user/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# ============================================================================
# Kali Mirrors & Base System Installation
# ============================================================================
RUN set -eux; \
    # Try multiple Kali mirrors for reliability
    mirrors="ftp.acc.umu.se/mirror/kali.org/kali mirror.math.princeton.edu/pub/kali kali.mirror.garr.it/mirrors/kali mirror.pit.teraswitch.com/kali"; \
    success=0; \
    for mirror in $mirrors; do \
        echo "deb http://$mirror kali-rolling main contrib non-free non-free-firmware" > /etc/apt/sources.list; \
        if apt-get update; then \
            echo "Using Kali mirror: $mirror"; \
            success=1; \
            break; \
        fi; \
    done; \
    if [ "$success" -ne 1 ]; then \
        echo "ERROR: apt-get update failed for all configured mirrors" >&2; \
        exit 1; \
    fi; \
    # Install all tools in one layer to minimize image size
    apt-get install -y --no-install-recommends \
    # Essential utilities
    curl \
    wget \
    git \
    ca-certificates \
    gnupg2 \
    unzip \
    jq \
    tree \
    perl \
    sudo \
    # Build tools
    build-essential \
    gcc \
    g++ \
    make \
    cmake \
    pkg-config \
    binutils \
    # Python stack
    python3 \
    python3-venv \
    python3-pip \
    python3-dev \
    python-is-python3 \
    libffi-dev \
    libxml2-dev \
    libxslt1-dev \
    zlib1g-dev \
    libglib2.0-dev \
    # Ruby stack
    ruby-full \
    ruby-dev \
    libnet-ssleay-perl \
    libio-socket-ssl-perl \
    libcrypt-ssleay-perl \
    libssl-dev \
    # Network utilities
    iputils-ping \
    dnsutils \
    iproute2 \
    net-tools \
    traceroute \
    netcat-traditional \
    tcpdump \
    # Text editors
    vim \
    nano \
    less \
    # Network scanning & enumeration (from Kali repos - pre-compiled!)
    nmap \
    masscan \
    naabu \
    nikto \
    whatweb \
    wafw00f \
    # Web vulnerability scanners
    sqlmap \
    wapiti \
    wpscan \
    # DNS/subdomain enumeration
    subfinder \
    dnsrecon \
    dnsenum \
    theharvester \
    # Web fuzzing & discovery
    ffuf \
    arjun \
    gobuster \
    dirsearch \
    # SMB/NetBIOS tools
    smbclient \
    smbmap \
    nbtscan \
    python3-impacket \
    enum4linux \
    # Network discovery
    arp-scan \
    ike-scan \
    onesixtyone \
    snmpcheck \
    netdiscover \
    hping3 \
    # Utilities
    socat \
    proxychains4 \
    seclists \
    hashid \
    hashcat \
    commix \
    libimage-exiftool-perl \
    cewl \
    # WebDAV tools
    cadaver \
    davtest \
    # SSL/TLS testing
    testssl.sh \
    # Web crawling & recon
    gospider \
    subjack \
    nuclei \
    # Authentication/bruteforce
    hydra \
    # Programming languages
    golang \
    nodejs \
    npm \
    # Debugging tools
    gdb \
    ltrace \
    strace \
    # Forensics
    steghide \
    binwalk \
    foremost \
    # Document conversion
    pandoc \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# ============================================================================
# WhatWeb Ruby Library Symlink Fix
# ============================================================================
RUN set -eux; \
    if command -v whatweb >/dev/null 2>&1; then \
      mkdir -p /usr/bin/lib; \
      if ls /usr/lib/ruby/vendor_ruby/*.rb >/dev/null 2>&1; then \
        ln -sf /usr/lib/ruby/vendor_ruby/*.rb /usr/bin/lib/; \
      fi; \
    fi

# ============================================================================
# User Setup
# ============================================================================
RUN useradd --create-home --shell /bin/bash user && \
    usermod -aG sudo user && \
    echo 'user ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers && \
    mkdir -p /home/user/upload /home/user/go && \
    chown -R user:user /home/user

WORKDIR /home/user

# ============================================================================
# Python Packages for Document Generation & Security Tools
# ============================================================================
RUN pip3 install --break-system-packages \
    reportlab \
    python-docx \
    openpyxl \
    python-pptx \
    pandas \
    pypandoc \
    odfpy

# Additional security-focused Python packages
RUN pip3 install --break-system-packages requests aiohttp jinja2 'httpx[cli]' ratelimit pycryptodomex ropgadget ropper

# Active Directory security tools
RUN pip3 install --break-system-packages --ignore-installed bloodhound
RUN pip3 install --break-system-packages --ignore-installed certipy-ad
RUN pip3 install --break-system-packages --ignore-installed coercer

# Ruby forensics tool
RUN gem install zsteg

# ============================================================================
# Git-based Security Tools
# ============================================================================
RUN set -eux; \
    # GraphQL schema inference
    git clone https://github.com/nikitastupin/clairvoyance.git /opt/clairvoyance || true && \
    if [ -d /opt/clairvoyance ]; then \
      cd /opt/clairvoyance && \
      python3 -m venv venv && \
      . venv/bin/activate && \
      pip install . || true; \
    fi && \
    # JWT analysis tool
    git clone https://github.com/ticarpi/jwt_tool.git /opt/jwt_tool || true && \
    if [ -f /opt/jwt_tool/jwt_tool.py ]; then chmod +x /opt/jwt_tool/jwt_tool.py; fi && \
    # Template injection testing
    git clone https://github.com/epinna/tplmap.git /opt/tplmap || true && \
    if [ -f /opt/tplmap/tplmap.py ]; then chmod +x /opt/tplmap/tplmap.py; fi && \
    # Gopher protocol exploitation
    git clone https://github.com/tarunkant/Gopherus.git /opt/gopherus || true && \
    if [ -f /opt/gopherus/gopherus.py ]; then chmod +x /opt/gopherus/gopherus.py; fi && \
    # PHP object injection
    git clone https://github.com/ambionics/phpggc.git /opt/phpggc || true && \
    if [ -f /opt/phpggc/phpggc ]; then chmod +x /opt/phpggc/phpggc; fi && \
    # Network poisoning
    git clone https://github.com/lgandx/Responder.git /opt/responder && \
    ln -sf /opt/responder/Responder.py /usr/local/bin/responder && \
    # Git repository dumper
    git clone https://github.com/internetwache/GitTools.git /opt/gittools && \
    chmod +x /opt/gittools/Dumper/gitdumper.sh /opt/gittools/Extractor/extractor.sh && \
    ln -sf /opt/gittools/Dumper/gitdumper.sh /usr/local/bin/gitdumper && \
    ln -sf /opt/gittools/Extractor/extractor.sh /usr/local/bin/gitextractor && \
    # RSA CTF tool - install dependencies
    apt-get update && apt-get install -y --no-install-recommends libgmp-dev libmpfr-dev libmpc-dev && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    git clone https://github.com/RsaCtfTool/RsaCtfTool.git /opt/rsactftool && \
    cd /opt/rsactftool && \
    pip3 install --break-system-packages -r requirements.txt && \
    ln -sf /opt/rsactftool/RsaCtfTool.py /usr/local/bin/rsactftool || true

# ============================================================================
# Binary Downloads (Platform-aware)
# ============================================================================
RUN set -eux; \
    # Java deserialization exploits
    mkdir -p /opt/ysoserial && \
    wget -qO /opt/ysoserial/ysoserial.jar https://github.com/frohoff/ysoserial/releases/latest/download/ysoserial-all.jar || true && \
    # Linux privilege escalation scripts
    mkdir -p /opt/peass && \
    wget -qO /opt/peass/linpeas.sh https://github.com/peass-ng/PEASS-ng/releases/latest/download/linpeas.sh && \
    chmod +x /opt/peass/linpeas.sh && \
    ln -sf /opt/peass/linpeas.sh /usr/local/bin/linpeas && \
    # Secret scanning tool
    curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh | sh -s -- -b /usr/local/bin && \
    # httpx with proper architecture detection
    arch=$(uname -m); \
    if [ "$arch" = "x86_64" ]; then platform="linux_amd64"; \
    elif [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; then platform="linux_arm64"; \
    else platform="linux_amd64"; fi; \
    HTTPX_URL=$(curl -s https://api.github.com/repos/projectdiscovery/httpx/releases/latest \
      | grep -Eo '"browser_download_url"\s*:\s*"[^"]*' | cut -d '"' -f4 \
      | grep -E "${platform}\\.zip$" | head -n1); \
    echo "Fetching httpx: $HTTPX_URL"; \
    wget -qO /tmp/httpx.zip "$HTTPX_URL" && \
    mkdir -p /tmp/httpx_extracted && \
    unzip -q /tmp/httpx.zip -d /tmp/httpx_extracted || true && \
    find /tmp/httpx_extracted -type f -name httpx -exec mv {} /usr/local/bin/httpx \; || true && \
    chmod +x /usr/local/bin/httpx || true && \
    rm -rf /tmp/httpx_extracted /tmp/httpx.zip

# ============================================================================
# Create Wrapper Scripts for Python Tools
# ============================================================================
RUN set -eux; \
    # Clairvoyance wrapper
    ([ -d /opt/clairvoyance ] && echo '#!/bin/bash\ncd /opt/clairvoyance && source venv/bin/activate && python -m clairvoyance "$@"' > /usr/local/bin/clairvoyance && chmod +x /usr/local/bin/clairvoyance) || true && \
    # JWT Tool wrapper
    ([ -f /opt/jwt_tool/jwt_tool.py ] && echo '#!/bin/bash\npython3 /opt/jwt_tool/jwt_tool.py "$@"' > /usr/local/bin/jwt-tool && chmod +x /usr/local/bin/jwt-tool) || true && \
    # Tplmap wrapper
    ([ -f /opt/tplmap/tplmap.py ] && echo '#!/bin/bash\npython3 /opt/tplmap/tplmap.py "$@"' > /usr/local/bin/tplmap && chmod +x /usr/local/bin/tplmap) || true && \
    # Gopherus wrapper
    ([ -f /opt/gopherus/gopherus.py ] && echo '#!/bin/bash\npython3 /opt/gopherus/gopherus.py "$@"' > /usr/local/bin/gopherus && chmod +x /usr/local/bin/gopherus) || true && \
    # PHPGGC symlink
    ([ -f /opt/phpggc/phpggc ] && ln -sf /opt/phpggc/phpggc /usr/local/bin/phpggc) || true && \
    # YsoSerial wrapper
    (echo '#!/bin/bash\njava -jar /opt/ysoserial/ysoserial.jar "$@"' > /usr/local/bin/ysoserial && chmod +x /usr/local/bin/ysoserial) || true

# ============================================================================
# Go-based Security Tools
# ============================================================================
RUN set -eux; \
    go install github.com/projectdiscovery/interactsh/cmd/interactsh-client@latest && \
    go install github.com/nicocha30/ligolo-ng/cmd/agent@latest && \
    go install github.com/nicocha30/ligolo-ng/cmd/proxy@latest && \
    go install github.com/hahwul/dalfox/v2@latest && \
    go install github.com/jpillora/chisel@latest && \
    go install github.com/ropnop/kerbrute@latest

# ============================================================================
# Tool Validation
# ============================================================================
RUN set -eux; \
    echo "=== Starting tool validation ===" && \
    test -d /usr/share/seclists && \
    echo "✓ SecLists installed" && \
    which nmap && echo "✓ nmap" && \
    which masscan && echo "✓ masscan" && \
    which naabu && echo "✓ naabu" && \
    which nikto && echo "✓ nikto" && \
    which whatweb && echo "✓ whatweb" && \
    which wafw00f && echo "✓ wafw00f" && \
    which sqlmap && echo "✓ sqlmap" && \
    which wapiti && echo "✓ wapiti" && \
    which wpscan && echo "✓ wpscan" && \
    which subfinder && echo "✓ subfinder" && \
    which dnsrecon && echo "✓ dnsrecon" && \
    which dnsenum && echo "✓ dnsenum" && \
    which theharvester && echo "✓ theharvester" && \
    which ffuf && echo "✓ ffuf" && \
    which arjun && echo "✓ arjun" && \
    which gobuster && echo "✓ gobuster" && \
    which dirsearch && echo "✓ dirsearch" && \
    which testssl && echo "✓ testssl" && \
    which nuclei && echo "✓ nuclei" && \
    which hydra && echo "✓ hydra" && \
    which smbclient && echo "✓ smbclient" && \
    which smbmap && echo "✓ smbmap" && \
    which nbtscan && echo "✓ nbtscan" && \
    which enum4linux && echo "✓ enum4linux" && \
    which commix && echo "✓ commix" && \
    which gospider && echo "✓ gospider" && \
    which subjack && echo "✓ subjack" && \
    which hashcat && echo "✓ hashcat" && \
    which dalfox && echo "✓ dalfox" && \
    which chisel && echo "✓ chisel" && \
    which kerbrute && echo "✓ kerbrute" && \
    which interactsh-client && echo "✓ interactsh-client" && \
    which jwt-tool && echo "✓ jwt_tool" && \
    which tplmap && echo "✓ tplmap" && \
    which gopherus && echo "✓ gopherus" && \
    which phpggc && echo "✓ phpggc" && \
    which responder && echo "✓ responder" && \
    which gitdumper && echo "✓ gitdumper" && \
    which linpeas && echo "✓ linpeas" && \
    which trufflehog && echo "✓ trufflehog" && \
    which httpx && echo "✓ httpx" && \
    which go && echo "✓ go" && \
    which python3 && echo "✓ python3" && \
    which node && echo "✓ node" && \
    which ruby && echo "✓ ruby" && \
    python3 -c "import reportlab; print('✓ reportlab')" && \
    python3 -c "import docx; print('✓ python-docx')" && \
    python3 -c "import openpyxl; print('✓ openpyxl')" && \
    python3 -c "import pptx; print('✓ python-pptx')" && \
    python3 -c "import pandas; print('✓ pandas')" && \
    python3 -c "import odf; print('✓ odfpy')" && \
    python3 -c "import requests; print('✓ requests')" && \
    echo "=== Version Information ===" && \
    nmap --version | head -n1 && \
    python3 --version && \
    go version && \
    node --version && \
    ruby --version && \
    echo "=== All critical tools validated successfully ==="

# ============================================================================
# Final Cleanup & Permissions
# ============================================================================
RUN apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /var/cache/apt/archives/* && \
    chown -R user:user /home/user

# Default shell
SHELL ["/bin/bash", "-c"]

# ============================================================================
# IMPORTANT: Runtime Capabilities Required
# ============================================================================
# Docker drops Linux capabilities by default for security. This image requires
# additional capabilities for penetration testing tools to work properly.
#
# Run with: ./docker/run.sh
# Or manually: docker run --cap-add=NET_RAW --cap-add=NET_ADMIN --cap-add=SYS_PTRACE ...
#
# Required capabilities:
#   - NET_RAW:    ping, nmap, masscan, hping3, arp-scan, tcpdump, raw sockets
#   - NET_ADMIN:  network interface manipulation, arp-scan, netdiscover
#   - SYS_PTRACE: gdb, strace, ltrace (debugging tools)
#
# NOTE: These capabilities CANNOT be set in Dockerfile - they are runtime flags
# controlled by Docker's security model. Even root inside container doesn't
# have these capabilities unless explicitly granted at container start.
# ============================================================================

# Keep container running
CMD ["tail", "-f", "/dev/null"]
