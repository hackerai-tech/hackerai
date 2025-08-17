# HackerAI

_Your AI-Powered Penetration Testing Assistant_

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Configure Environment

Create `.env.local` from the example file:

```bash
cp .env.local.example .env.local
```

Add your OpenRouter API key:

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
```

### 3. Launch Application

```bash
pnpm dev
```

Visit **[http://localhost:3000](http://localhost:3000)** and start your penetration testing journey! 🎯

---

## 🔑 API Configuration

### Required

| Service        | Purpose                        | Get API Key                             |
| -------------- | ------------------------------ | --------------------------------------- |
| **OpenRouter** | LLM access (Claude, GPT, etc.) | [openrouter.ai](https://openrouter.ai/) |

### Optional - Sandbox Mode

| Service | Purpose                   | Get API Key                 |
| ------- | ------------------------- | --------------------------- |
| **E2B** | Secure isolated execution | [e2b.dev](https://e2b.dev/) |

> 💡 **Default Behavior**: Terminal commands execute locally on your machine  
> 🔒 **Sandbox Mode**: Add E2B key for isolated container execution

#### Enable Sandbox Mode

```env
TERMINAL_EXECUTION_MODE=sandbox
E2B_API_KEY=your_e2b_api_key_here
```
