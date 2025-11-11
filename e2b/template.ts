import { Template } from "e2b";

export const template = Template()
  .fromImage("kalilinux/kali-rolling:latest")
  .runCmd(
    "apt-get update && \
    apt-get install -y kali-archive-keyring sudo && \
    apt-get update && \
    apt-get upgrade -y",
    { user: "root" },
  )
  .runCmd(
    "apt-get update && \
    apt-get install -y --no-install-recommends \
      apt-utils \
      wget \
      curl \
      git \
      vim \
      nano \
      unzip \
      tar \
      apt-transport-https \
      ca-certificates \
      gnupg \
      lsb-release \
      build-essential \
      software-properties-common \
      gcc \
      libc6-dev \
      pkg-config \
      libpcap-dev \
      libssl-dev \
      python3 \
      python3-pip \
      python3-dev \
      python3-venv \
      python3-setuptools \
      golang-go \
      net-tools \
      dnsutils \
      whois \
      traceroute \
      iputils-ping \
      jq \
      parallel \
      ripgrep \
      grep \
      less \
      man-db \
      procps \
      htop \
      iproute2 \
      netcat-traditional \
      nmap \
      ncat \
      ndiff \
      sqlmap \
      nuclei \
      subfinder \
      naabu \
      ffuf \
      whatweb \
      nodejs \
      npm \
      pipx \
      libcap2-bin \
      gdb \
      tmux \
      pandoc && \
    apt-get autoremove -y && \
    apt-get autoclean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* && \
    mkdir -p /var/lib/dpkg/status.d",
    { user: "root" },
  )
  .runCmd(
    'echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user && \
    chmod 0440 /etc/sudoers.d/user',
    { user: "root" },
  )
  .runCmd(
    "pipx install arjun && \
    pipx install dirsearch && \
    pipx inject dirsearch setuptools && \
    pipx install wafw00f",
    { user: "root" },
  )
  .runCmd("nuclei -update-templates", { user: "root" })
  .runCmd(
    "pip3 install --break-system-packages --no-cache-dir \
      reportlab \
      python-docx \
      openpyxl \
      python-pptx \
      pandas \
      pypandoc \
      odfpy",
    { user: "root" },
  )
  .runCmd(
    "git clone --depth 1 https://github.com/danielmiessler/SecLists.git /home/user/SecLists",
    { user: "root" },
  )
  .runCmd(
    "git clone https://github.com/ticarpi/jwt_tool.git /opt/jwt_tool && \
    chmod +x /opt/jwt_tool/jwt_tool.py && \
    pip3 install --break-system-packages --no-cache-dir -r /opt/jwt_tool/requirements.txt && \
    ln -s /opt/jwt_tool/jwt_tool.py /usr/local/bin/jwt_tool",
    { user: "root" },
  )
  .runCmd("mkdir -p /home/user", { user: "root" })
  .setEnvs({
    GO_VERSION: "1.24.2",
    GOROOT: "/usr/local/go",
    GOPATH: "/go",
    PATH: "/usr/local/go/bin:/go/bin:/home/user/go/bin:/home/user/.local/bin:$PATH",
  })
  .runCmd(
    "wget -q https://golang.org/dl/go${GO_VERSION}.linux-amd64.tar.gz && \
    tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz && \
    rm go${GO_VERSION}.linux-amd64.tar.gz",
    { user: "root" },
  )
  .runCmd(
    'echo "export PATH=/usr/local/go/bin:/go/bin:/home/user/go/bin:$PATH" >> /etc/profile && \
    echo "export PATH=/usr/local/go/bin:/go/bin:/home/user/go/bin:$PATH" >> /root/.bashrc && \
    echo "export PATH=/usr/local/go/bin:/go/bin:/home/user/go/bin:$PATH" >> /home/user/.bashrc',
    { user: "root" },
  )
  .runCmd(
    "go install github.com/projectdiscovery/httpx/cmd/httpx@latest && \
    ln -s /go/bin/httpx /usr/local/bin/httpx",
    { user: "root" },
  )
  .runCmd(
    'export PATH="/root/.local/bin:$PATH" && \
    test -d /home/user/SecLists && \
    test -f /home/user/SecLists/README.md && \
    which nmap && \
    which httpx && \
    which nuclei && \
    which subfinder && \
    which naabu && \
    which ffuf && \
    which sqlmap && \
    which whatweb && \
    which wafw00f && \
    which arjun && \
    which dirsearch && \
    which jwt_tool && \
    which go && \
    which python3 && \
    python3 -c "import reportlab; import docx; import openpyxl; import pptx; import pandas; import pypandoc; import odf"',
    { user: "root" },
  )
  .setWorkdir("/home/user");
