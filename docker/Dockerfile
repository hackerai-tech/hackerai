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
    hping3 \
    arp-scan \
    # Utilities
    socat \
    proxychains4 \
    seclists \
    hashid \
    libimage-exiftool-perl \
    cewl \
    # SSL/TLS testing
    testssl.sh \
    # Web crawling & recon
    gospider \
    nuclei \
    # Authentication/bruteforce
    hydra \
    # Programming languages
    golang \
    nodejs \
    npm \
    tmux \
    # Forensics
    binwalk \
    foremost \
    # Document conversion
    pandoc \
    # Web application security scanner
    zaproxy \
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
RUN pip3 install --break-system-packages requests aiohttp jinja2 'httpx[cli]' ratelimit pycryptodomex

# ============================================================================
# Git-based Security Tools
# ============================================================================
RUN set -eux; \
    # JWT analysis tool
    git clone https://github.com/ticarpi/jwt_tool.git /opt/jwt_tool || true && \
    if [ -f /opt/jwt_tool/jwt_tool.py ]; then chmod +x /opt/jwt_tool/jwt_tool.py; fi && \
    # Git repository dumper
    git clone https://github.com/internetwache/GitTools.git /opt/gittools && \
    chmod +x /opt/gittools/Dumper/gitdumper.sh /opt/gittools/Extractor/extractor.sh && \
    ln -sf /opt/gittools/Dumper/gitdumper.sh /usr/local/bin/gitdumper && \
    ln -sf /opt/gittools/Extractor/extractor.sh /usr/local/bin/gitextractor

# ============================================================================
# Binary Downloads (Platform-aware)
# ============================================================================
RUN set -eux; \
    # Secret scanning tool
    curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh | sh -s -- -b /usr/local/bin && \
    # Vulnerability scanner for containers and filesystems
    curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin && \
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
    # JWT Tool wrapper
    ([ -f /opt/jwt_tool/jwt_tool.py ] && echo '#!/bin/bash\npython3 /opt/jwt_tool/jwt_tool.py "$@"' > /usr/local/bin/jwt-tool && chmod +x /usr/local/bin/jwt-tool) || true

# ============================================================================
# Go-based Security Tools
# ============================================================================
RUN set -eux; \
    go install github.com/projectdiscovery/interactsh/cmd/interactsh-client@latest && \
    go install github.com/projectdiscovery/katana/cmd/katana@latest && \
    go install github.com/projectdiscovery/cvemap/cmd/cvemap@latest

# ============================================================================
# TestSSL Symlink - Allow access via both 'testssl' and 'testssl.sh'
# ============================================================================
RUN set -eux; \
    if command -v testssl >/dev/null 2>&1; then \
      ln -sf $(which testssl) /usr/local/bin/testssl.sh; \
    fi

# ============================================================================
# Update Nuclei Templates
# ============================================================================
RUN nuclei -update-templates

# ============================================================================
# Tool Validation
# ============================================================================
RUN set -eux; \
    echo "=== Starting tool validation ===" && \
    test -d /usr/share/seclists && \
    echo "✓ SecLists installed" && \
    which nmap && echo "✓ nmap" && \
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
    which ffuf && echo "✓ ffuf" && \
    which arjun && echo "✓ arjun" && \
    which gobuster && echo "✓ gobuster" && \
    which dirsearch && echo "✓ dirsearch" && \
    which testssl && echo "✓ testssl" && \
    which testssl.sh && echo "✓ testssl.sh" && \
    which nuclei && echo "✓ nuclei" && \
    which hydra && echo "✓ hydra" && \
    which smbclient && echo "✓ smbclient" && \
    which smbmap && echo "✓ smbmap" && \
    which nbtscan && echo "✓ nbtscan" && \
    which enum4linux && echo "✓ enum4linux" && \
    which arp-scan && echo "✓ arp-scan" && \
    which gospider && echo "✓ gospider" && \
    which interactsh-client && echo "✓ interactsh-client" && \
    which katana && echo "✓ katana" && \
    which cvemap && echo "✓ cvemap" && \
    which jwt-tool && echo "✓ jwt_tool" && \
    which gitdumper && echo "✓ gitdumper" && \
    which trufflehog && echo "✓ trufflehog" && \
    which trivy && echo "✓ trivy" && \
    which zaproxy && echo "✓ zaproxy" && \
    which httpx && echo "✓ httpx" && \
    which go && echo "✓ go" && \
    which python3 && echo "✓ python3" && \
    which node && echo "✓ node" && \
    which ruby && echo "✓ ruby" && \
    which tmux && echo "✓ tmux" && \
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


# Keep container running
CMD ["tail", "-f", "/dev/null"]
