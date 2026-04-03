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

```bash
npx @hackerai/local@latest --token hsb_abc123 --name "My Laptop"
```

Commands run directly on your host OS. The client connects to HackerAI and relays commands in real-time.

## Options

| Option             | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `--token TOKEN`    | Authentication token from HackerAI Settings (required) |
| `--name NAME`      | Connection name shown in HackerAI (default: hostname)  |
| `--convex-url URL` | Override backend URL (for development)                 |
| `--help, -h`       | Show help message                                      |

## Getting Your Token

1. Go to [HackerAI Settings](https://hackerai.co/settings)
2. Navigate to the "Agents" tab
3. Click "Generate Token" or copy your existing token

## Security

Commands run directly on your OS without any isolation. Only connect machines you trust and control. The client auto-terminates after 1 hour of inactivity.

## License

MIT
