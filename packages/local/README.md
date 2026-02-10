# @hackerai/local

HackerAI Local Sandbox Client - Execute commands on your local machine from HackerAI.

## Installation

```bash
npx @hackerai/local@latest --token YOUR_TOKEN
```

Or install globally:

```bash
npm install -g @hackerai/local
hackerai-local --token YOUR_TOKEN
```

## Usage

### Basic Usage (Docker Mode)

```bash
npx @hackerai/local@latest --token hsb_abc123 --name "My Laptop"
```

This pulls the pre-built HackerAI sandbox image (~3GB) - an AI Agent Penetration Testing Environment based on Kali Linux with comprehensive automated tools including:
nmap, masscan, sqlmap, ffuf, gobuster, nuclei, hydra, nikto, wpscan, subfinder, httpx, smbclient, impacket, and many more.

### Dangerous Mode (No Docker)

```bash
npx @hackerai/local@latest --token hsb_abc123 --name "Work PC" --dangerous
```

**Warning:** Dangerous mode runs commands directly on your host OS without isolation.

## Options

| Option             | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `--token TOKEN`    | Authentication token from HackerAI Settings (required) |
| `--name NAME`      | Connection name shown in HackerAI (default: hostname)  |
| `--dangerous`      | Run commands directly on host OS without Docker        |
| `--convex-url URL` | Override backend URL (for development)                 |
| `--help, -h`       | Show help message                                      |

## Getting Your Token

1. Go to [HackerAI Settings](https://hackerai.co/settings)
2. Navigate to the "Agents" tab
3. Click "Generate Token" or copy your existing token

## Security

- **Docker Mode**: Commands run in a container with process isolation, but with:
  - Host network access (`--network host`) for pentesting tools to scan network services
  - Linux capabilities for network tools:
    - `NET_RAW`: Required for ping, nmap, masscan, hping3, arp-scan, tcpdump, raw sockets
    - `NET_ADMIN`: Required for network interface manipulation, arp-scan, netdiscover
    - `SYS_PTRACE`: Required for debugging tools (gdb, strace, ltrace)
- **Dangerous Mode**: Commands run directly on your OS without any isolation - use with caution

## License

MIT
