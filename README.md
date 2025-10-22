<p align="center">
  <h1 align="center">HackerAI</h1>
</p>

<p align="center">
  Your AI-Powered Penetration Testing Assistant
</p>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0%20with%20Commercial%20Restrictions-red.svg" alt="License: Apache 2.0 with Commercial Restrictions"/>
  </a>
  <a href="https://hackerai.co/">
    <img src="https://img.shields.io/badge/Demo-Website-blue" alt="Demo: Website"/>
  </a>
</p>

<p align="center">
  Demo: <a href="https://hackerai.co/">https://hackerai.co/</a>
</p>

## Getting started

### Prerequisites

You'll need the following accounts:

**Required:**

- [OpenRouter](https://openrouter.ai/) - AI model provider
- [AI Gateway](https://vercel.com/docs/ai-gateway) - AI model provider
- [OpenAI](https://platform.openai.com/) - AI model provider
- [XAI](https://x.ai/) - AI model provider for agent mode
- [E2B](https://e2b.dev/) - Sandbox environment for secure code execution in agent mode
- [Convex](https://www.convex.dev/) - Database and backend
- [WorkOS](https://workos.com/) - Authentication and user management

**Optional:**

- [Exa](https://exa.ai/) - Web search functionality
- [Jina AI](https://jina.ai/reader) - Web URL content retrieval
- [Upstash Redis](https://upstash.com/) - Rate limiting
- [PostHog](https://posthog.com/) - Analytics
- [Stripe](https://stripe.com/) - Payment processing

### Clone the repo

```bash
git clone https://github.com/hackerai-tech/hackerai.git
```

### Navigate to the project directory

```bash
cd hackerai
```

### Install dependencies

```bash
pnpm install
```

### Run the setup script

```bash
pnpm run setup
```

### Start the development server

```bash
pnpm run dev
```
