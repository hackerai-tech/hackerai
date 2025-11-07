import { Template } from "e2b";

export const template = Template()
  .fromImage("e2bdev/code-interpreter:latest")
  .runCmd(
    "apt-get update && \
    apt-get install -y \
      apt-utils \
      sudo \
      git \
      ca-certificates \
      gnupg \
      nmap \
      iputils-ping \
      whois \
      traceroute \
      dnsutils \
      whatweb \
      wafw00f \
      net-tools \
      gobuster \
      pandoc && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /var/lib/dpkg/status.d",
    { user: "root" },
  )
  .runCmd(
    'echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user && \
    chmod 0440 /etc/sudoers.d/user',
    { user: "root" },
  )
  .runCmd(
    "pip install --no-cache-dir \
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
  .setEnvs({
    GO_VERSION: "1.24.2",
    GOROOT: "/usr/local/go",
    GOPATH: "/go",
    PATH: "/usr/local/go/bin:/go/bin:/home/user/go/bin:$PATH",
  })
  .runCmd("mkdir -p /home/user", { user: "root" })
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
    "go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest && \
    ln -s /go/bin/subfinder /usr/local/bin/subfinder",
    { user: "root" },
  )
  .runCmd(
    'test -d /home/user/SecLists && \
    test -f /home/user/SecLists/README.md && \
    nmap --version && \
    whois --version && \
    traceroute --version && \
    dig -v && \
    go version && \
    whatweb --version && \
    wafw00f --version && \
    ping -V && \
    ifconfig -v && \
    gobuster -v && \
    subfinder --version && \
    pandoc --version && \
    python -c "import reportlab; import docx; import openpyxl; import pptx; import pandas; import pypandoc; import odf"',
    { user: "root" },
  )
  .setWorkdir("/home/user");