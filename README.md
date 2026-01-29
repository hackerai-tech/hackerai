<p align="center">
  <a href="https://hackerai.co/">
    <img src="public/icon-512x512.png" width="150" alt="HackerAI Logo">
  </a>
</p>

<h1 align="center">HackerAI</h1>

<h2 align="center">Your AI-Powered Penetration Testing Assistant</h2>

<div align="center">

[![License](https://img.shields.io/badge/License-Apache%202.0%20with%20Commercial%20Restrictions-red.svg)](LICENSE)
[![Website](https://img.shields.io/badge/Website-hackerai.co-2d3748.svg)](https://hackerai.co)

</div>

## Getting started

### Prerequisites

You'll need the following accounts:

**Required:**

- [OpenRouter](https://openrouter.ai/) - AI model provider
- [OpenAI](https://platform.openai.com/) - AI model provider
- [XAI](https://x.ai/) - AI model provider for agent mode
- [E2B](https://e2b.dev/) - Sandbox environment for secure code execution in agent mode
- [Convex](https://www.convex.dev/) - Database and backend
- [WorkOS](https://workos.com/) - Authentication and user management

**Optional:**

- [Amazon S3](https://aws.amazon.com/s3/) - File storage (alternative to Convex storage)
- [Perplexity](https://perplexity.ai/) - Web search functionality
- [Jina AI](https://jina.ai/reader) - Web URL content retrieval
- [Redis](https://redis.io/) - Stream resumption
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

This runs both Next.js and Convex dev servers:

```bash
pnpm run dev
```

Or run them separately in two terminals:

```bash
pnpm run dev:next
pnpm run dev:convex
```
