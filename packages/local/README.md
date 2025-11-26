# @hackerai/local

HackerAI Local Sandbox Client - Execute commands on your local machine from HackerAI.

## Installation

```bash
npx @hackerai/local --token YOUR_TOKEN
```

Or install globally:

```bash
npm install -g @hackerai/local
hackerai-local --token YOUR_TOKEN
```

## Usage

### Basic Usage (Docker Mode)

```bash
npx @hackerai/local --token hsb_abc123 --name "My Laptop"
```

This pulls the pre-built HackerAI sandbox image (~2GB) with 30+ pentesting tools including:
nmap, sqlmap, ffuf, gobuster, nuclei, hydra, nikto, wpscan, subfinder, httpx, and more.

### Custom Docker Image

```bash
npx @hackerai/local --token hsb_abc123 --name "Kali" --image kalilinux/kali-rolling
```

### Dangerous Mode (No Docker)

```bash
npx @hackerai/local --token hsb_abc123 --name "Work PC" --dangerous
```

**Warning:** Dangerous mode runs commands directly on your host OS without isolation.

## Options

| Option | Description |
|--------|-------------|
| `--token TOKEN` | Authentication token from HackerAI Settings (required) |
| `--name NAME` | Connection name shown in HackerAI (default: hostname) |
| `--image IMAGE` | Docker image to use (default: hackeraidev/sandbox) |
| `--dangerous` | Run commands directly on host OS without Docker |
| `--convex-url URL` | Override backend URL (for development) |
| `--help, -h` | Show help message |

## Getting Your Token

1. Go to [HackerAI Settings](https://hackerai.com/settings)
2. Navigate to the "Local Sandbox" tab
3. Click "Generate Token" or copy your existing token

## Security

- **Docker Mode**: Commands run in an isolated container with `--network host` for network access
- **Dangerous Mode**: Commands run directly on your OS - use with caution

## License

MIT
