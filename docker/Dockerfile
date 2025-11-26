# HackerAI Pentesting Sandbox
# Pre-built image with 30+ security tools for local sandbox execution
# Based on Debian 12 (Bookworm) - matches E2B sandbox environment

FROM debian:bookworm-slim

LABEL org.opencontainers.image.title="HackerAI Sandbox"
LABEL org.opencontainers.image.description="Pre-configured pentesting sandbox with 30+ security tools"
LABEL org.opencontainers.image.source="https://github.com/hackerai-tech/hackerai"
LABEL org.opencontainers.image.vendor="HackerAI"

# Prevent interactive prompts during installation
ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/user
ENV PATH="/home/user/.local/bin:/usr/local/go/bin:${PATH}"

# Create user directory structure
RUN mkdir -p /home/user/upload && \
    chmod -R 777 /home/user

WORKDIR /home/user

# ============================================================================
# Base System & Build Dependencies
# ============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Essential utilities
    curl \
    wget \
    git \
    ca-certificates \
    gnupg \
    unzip \
    jq \
    # Build tools
    build-essential \
    gcc \
    g++ \
    make \
    cmake \
    # Network utilities
    dnsutils \
    netcat-openbsd \
    net-tools \
    iputils-ping \
    iproute2 \
    # Text processing
    vim \
    nano \
    less \
    # Misc
    procps \
    file \
    locales \
    && rm -rf /var/lib/apt/lists/*

# Set locale
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# ============================================================================
# Python 3.11 (Debian Bookworm default)
# ============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Python packages for document generation and data processing
RUN pip3 install --no-cache-dir --break-system-packages \
    reportlab \
    python-docx \
    openpyxl \
    python-pptx \
    pandas \
    pypandoc \
    requests \
    beautifulsoup4 \
    lxml \
    pyyaml \
    colorama

# ============================================================================
# Node.js 20.x
# ============================================================================
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# ============================================================================
# Golang 1.24
# ============================================================================
RUN curl -fsSL https://go.dev/dl/go1.24.2.linux-amd64.tar.gz | tar -C /usr/local -xzf - && \
    mkdir -p /home/user/go

ENV GOPATH=/home/user/go
ENV PATH="${GOPATH}/bin:${PATH}"

# ============================================================================
# Network Scanning Tools
# ============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    nmap \
    hping3 \
    libpcap-dev \
    && rm -rf /var/lib/apt/lists/*

# naabu - Fast port scanner (download pre-built binary)
RUN NAABU_VERSION=$(curl -s https://api.github.com/repos/projectdiscovery/naabu/releases/latest | grep '"tag_name"' | cut -d'"' -f4 | sed 's/v//') && \
    curl -fsSL "https://github.com/projectdiscovery/naabu/releases/download/v${NAABU_VERSION}/naabu_${NAABU_VERSION}_linux_amd64.zip" -o /tmp/naabu.zip && \
    unzip -o /tmp/naabu.zip -d /tmp && \
    mv /tmp/naabu /usr/local/bin/ && \
    chmod +x /usr/local/bin/naabu && \
    rm -rf /tmp/naabu* /tmp/LICENSE* /tmp/README*

# httpx - HTTP probe (download pre-built binary)
RUN HTTPX_VERSION=$(curl -s https://api.github.com/repos/projectdiscovery/httpx/releases/latest | grep '"tag_name"' | cut -d'"' -f4 | sed 's/v//') && \
    curl -fsSL "https://github.com/projectdiscovery/httpx/releases/download/v${HTTPX_VERSION}/httpx_${HTTPX_VERSION}_linux_amd64.zip" -o /tmp/httpx.zip && \
    unzip -o /tmp/httpx.zip -d /tmp && \
    mv /tmp/httpx /usr/local/bin/ && \
    chmod +x /usr/local/bin/httpx && \
    rm -rf /tmp/httpx* /tmp/LICENSE* /tmp/README*

# ============================================================================
# Subdomain/DNS Enumeration
# ============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    dnsrecon \
    && rm -rf /var/lib/apt/lists/*

# subfinder - Passive subdomain discovery (download pre-built binary)
RUN SUBFINDER_VERSION=$(curl -s https://api.github.com/repos/projectdiscovery/subfinder/releases/latest | grep '"tag_name"' | cut -d'"' -f4 | sed 's/v//') && \
    curl -fsSL "https://github.com/projectdiscovery/subfinder/releases/download/v${SUBFINDER_VERSION}/subfinder_${SUBFINDER_VERSION}_linux_amd64.zip" -o /tmp/subfinder.zip && \
    unzip -o /tmp/subfinder.zip -d /tmp && \
    mv /tmp/subfinder /usr/local/bin/ && \
    chmod +x /usr/local/bin/subfinder && \
    rm -rf /tmp/subfinder* /tmp/LICENSE* /tmp/README*

# ============================================================================
# Web Fuzzing and Discovery
# ============================================================================

# ffuf - Fast web fuzzer (download pre-built binary)
RUN FFUF_VERSION=$(curl -s https://api.github.com/repos/ffuf/ffuf/releases/latest | grep '"tag_name"' | cut -d'"' -f4 | sed 's/v//') && \
    curl -fsSL "https://github.com/ffuf/ffuf/releases/download/v${FFUF_VERSION}/ffuf_${FFUF_VERSION}_linux_amd64.tar.gz" -o /tmp/ffuf.tar.gz && \
    tar -xzf /tmp/ffuf.tar.gz -C /tmp && \
    mv /tmp/ffuf /usr/local/bin/ && \
    chmod +x /usr/local/bin/ffuf && \
    rm -rf /tmp/ffuf*

# gobuster - Directory/DNS brute-forcer (download pre-built binary)
RUN GOBUSTER_VERSION=$(curl -s https://api.github.com/repos/OJ/gobuster/releases/latest | grep '"tag_name"' | cut -d'"' -f4 | sed 's/v//') && \
    curl -fsSL "https://github.com/OJ/gobuster/releases/download/v${GOBUSTER_VERSION}/gobuster_Linux_x86_64.tar.gz" -o /tmp/gobuster.tar.gz && \
    tar -xzf /tmp/gobuster.tar.gz -C /tmp && \
    mv /tmp/gobuster /usr/local/bin/ && \
    chmod +x /usr/local/bin/gobuster && \
    rm -rf /tmp/gobuster*

# dirsearch
RUN pip3 install --no-cache-dir --break-system-packages dirsearch

# arjun - Parameter discovery
RUN pip3 install --no-cache-dir --break-system-packages arjun

# ============================================================================
# Web Scanners
# ============================================================================

# nikto - Web server scanner (install from git)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnet-ssleay-perl \
    && rm -rf /var/lib/apt/lists/* && \
    git clone --depth 1 https://github.com/sullo/nikto.git /opt/nikto && \
    ln -s /opt/nikto/program/nikto.pl /usr/local/bin/nikto && \
    chmod +x /opt/nikto/program/nikto.pl

# whatweb - Web technology identifier (install from git)
RUN git clone --depth 1 https://github.com/urbanadventurer/WhatWeb.git /opt/whatweb && \
    ln -s /opt/whatweb/whatweb /usr/local/bin/whatweb && \
    chmod +x /opt/whatweb/whatweb

# wapiti - Web vulnerability scanner
RUN pip3 install --no-cache-dir --break-system-packages wapiti3

# wpscan
RUN apt-get update && apt-get install -y --no-install-recommends \
    ruby \
    ruby-dev \
    libcurl4-openssl-dev \
    && gem install wpscan --no-document \
    && rm -rf /var/lib/apt/lists/*

# wafw00f - WAF detection
RUN pip3 install --no-cache-dir --break-system-packages wafw00f

# ============================================================================
# Injection and XSS Testing
# ============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlmap \
    && rm -rf /var/lib/apt/lists/*

# xsser - XSS detection tool (install from git)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pycurl \
    python3-bs4 \
    python3-geoip \
    && rm -rf /var/lib/apt/lists/* && \
    git clone --depth 1 https://github.com/epsylon/xsser.git /opt/xsser && \
    ln -s /opt/xsser/xsser /usr/local/bin/xsser && \
    chmod +x /opt/xsser/xsser

# commix
RUN pip3 install --no-cache-dir --break-system-packages commix

# ============================================================================
# SSL/TLS Analysis
# ============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    testssl.sh \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/testssl.sh /usr/bin/testssl

# ============================================================================
# Authentication and Bruteforce
# ============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    hydra \
    && rm -rf /var/lib/apt/lists/*

# ============================================================================
# SMB/NetBIOS and Network Discovery
# ============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    smbclient \
    nbtscan \
    python3-impacket \
    arp-scan \
    ike-scan \
    onesixtyone \
    snmp \
    netdiscover \
    && rm -rf /var/lib/apt/lists/*

# smbmap - SMB enumeration tool
RUN pip3 install --no-cache-dir --break-system-packages smbmap

# ============================================================================
# Web Recon and Crawling
# ============================================================================

# gospider - Web crawler (download pre-built binary)
RUN GOSPIDER_VERSION=$(curl -s https://api.github.com/repos/jaeles-project/gospider/releases/latest | grep '"tag_name"' | cut -d'"' -f4 | sed 's/v//') && \
    curl -fsSL "https://github.com/jaeles-project/gospider/releases/download/v${GOSPIDER_VERSION}/gospider_v${GOSPIDER_VERSION}_linux_x86_64.zip" -o /tmp/gospider.zip && \
    unzip -o /tmp/gospider.zip -d /tmp && \
    find /tmp -name 'gospider' -type f -executable -exec mv {} /usr/local/bin/ \; && \
    chmod +x /usr/local/bin/gospider && \
    rm -rf /tmp/gospider* /tmp/LICENSE* /tmp/README*

# subjack - Subdomain takeover checker (build with CGO disabled)
RUN CGO_ENABLED=0 go install github.com/haccer/subjack@latest || echo "subjack build skipped"

# ============================================================================
# WebDAV Tools
# ============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    cadaver \
    && rm -rf /var/lib/apt/lists/*

# ============================================================================
# Utilities and Specialized Tools
# ============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    socat \
    proxychains4 \
    hashid \
    libimage-exiftool-perl \
    cewl \
    && rm -rf /var/lib/apt/lists/*

# jwt_tool
RUN pip3 install --no-cache-dir --break-system-packages pyjwt && \
    git clone --depth 1 https://github.com/ticarpi/jwt_tool.git /opt/jwt_tool && \
    chmod +x /opt/jwt_tool/jwt_tool.py && \
    ln -s /opt/jwt_tool/jwt_tool.py /usr/local/bin/jwt_tool

# nuclei - Template-based vulnerability scanner (download pre-built binary)
RUN NUCLEI_VERSION=$(curl -s https://api.github.com/repos/projectdiscovery/nuclei/releases/latest | grep '"tag_name"' | cut -d'"' -f4 | sed 's/v//') && \
    curl -fsSL "https://github.com/projectdiscovery/nuclei/releases/download/v${NUCLEI_VERSION}/nuclei_${NUCLEI_VERSION}_linux_amd64.zip" -o /tmp/nuclei.zip && \
    unzip -o /tmp/nuclei.zip -d /tmp && \
    mv /tmp/nuclei /usr/local/bin/ && \
    chmod +x /usr/local/bin/nuclei && \
    rm -rf /tmp/nuclei* /tmp/LICENSE* /tmp/README*

# ============================================================================
# SecLists - Wordlists
# ============================================================================
RUN git clone --depth 1 https://github.com/danielmiessler/SecLists.git /home/user/SecLists

# ============================================================================
# Pandoc for document conversion
# ============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    pandoc \
    && rm -rf /var/lib/apt/lists/*

# ============================================================================
# Final Cleanup & Permissions
# ============================================================================
RUN apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* && \
    chmod -R 777 /home/user

# Default shell
SHELL ["/bin/bash", "-c"]

# Keep container running
CMD ["tail", "-f", "/dev/null"]
