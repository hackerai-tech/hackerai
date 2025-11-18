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
      python3 \
      python3-venv \
      python3-pip \
      python-is-python3 \
      nmap \
      sqlmap \
      gobuster \
      curl \
      netcat-traditional \
      tcpdump \
      git \
      perl \
      gnupg2 \
      wget \
      libnet-ssleay-perl \
      libio-socket-ssl-perl \
      libcrypt-ssleay-perl \
      libssl-dev \
      ca-certificates \
      iputils-ping \
      dnsutils \
      iproute2 \
      net-tools \
      traceroute \
      jq \
      unzip \
      tree \
      sudo \
      nikto \
      whatweb \
      wafw00f \
      subfinder \
      dnsrecon \
      ffuf \
      arjun \
      wapiti \
      wpscan \
      naabu \
      smbclient \
      smbmap \
      nbtscan \
      python3-impacket \
      arp-scan \
      ike-scan \
      onesixtyone \
      snmpcheck \
      netdiscover \
      hping3 \
      socat \
      proxychains4 \
      commix \
      xsser \
      hashid \
      nuclei \
      hydra \
      libimage-exiftool-perl \
      cewl \
      cadaver \
      davtest \
      testssl.sh \
      gospider \
      subjack \
      dirsearch \
      golang \
      rustc \
      cargo \
      nodejs \
      npm \
      python3-dev \
      build-essential && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*",
    { user: "root" },
  )
  .runCmd(
    "if command -v whatweb >/dev/null 2>&1; then \
      mkdir -p /usr/bin/lib; \
      if ls /usr/lib/ruby/vendor_ruby/*.rb >/dev/null 2>&1; then \
        ln -sf /usr/lib/ruby/vendor_ruby/*.rb /usr/bin/lib/; \
      fi; \
    fi",
    { user: "root" },
  )
  .runCmd(
    'echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user && \
    chmod 0440 /etc/sudoers.d/user',
    { user: "root" },
  )
  .runCmd("nuclei -update-templates")
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
    'test -d /home/user/SecLists && \
    test -f /home/user/SecLists/README.md && \
    echo "SecLists OK" && \
    which nmap && echo "nmap OK" && \
    which sqlmap && echo "sqlmap OK" && \
    which gobuster && echo "gobuster OK" && \
    which nikto && echo "nikto OK" && \
    which whatweb && echo "whatweb OK" && \
    which wafw00f && echo "wafw00f OK" && \
    which subfinder && echo "subfinder OK" && \
    which ffuf && echo "ffuf OK" && \
    which arjun && echo "arjun OK" && \
    which wapiti && echo "wapiti OK" && \
    which wpscan && echo "wpscan OK" && \
    which naabu && echo "naabu OK" && \
    which nuclei && echo "nuclei OK" && \
    which hydra && echo "hydra OK" && \
    which dirsearch && echo "dirsearch OK" && \
    which testssl && echo "testssl OK" && \
    which xsser && echo "xsser OK" && \
    which commix && echo "commix OK" && \
    which jwt_tool && echo "jwt_tool OK" && \
    which httpx && echo "httpx OK" && \
    which go && echo "go OK" && \
    which python3 && echo "python3 OK" && \
    python3 -c "import reportlab; import docx; import openpyxl; import pptx; import pandas; import pypandoc; import odf" && echo "Python imports OK"',
    { user: "root" },
  )
  .setWorkdir("/home/user");
