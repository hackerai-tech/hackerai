# HackerAI

_Your AI-Powered Penetration Testing Assistant_

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Set Up Authentication & Database

HackerAI uses **Convex** for real-time database and **WorkOS** for authentication to provide persistent conversations and user management.

#### Configure Convex (Required)

1. Create a Convex account at [convex.dev](https://convex.dev/)
2. Initialize Convex in your project:
   ```bash
   npx convex dev
   ```
3. Follow the prompts to create a new project

#### Configure WorkOS Authentication (Required)

1. Create a WorkOS account at [workos.com](https://workos.com/)
2. Create a new project and get your API credentials
3. Configure redirect URI: `http://localhost:3000/callback`

### 3. Configure Environment

Create `.env.local` from the example file:

```bash
cp .env.local.example .env.local
```

Then fill in your API keys and configuration values in the `.env.local` file.

### 4. Deploy Convex Functions

```bash
npx convex deploy
```

### 5. Launch Application

```bash
pnpm dev
```

Visit **[http://localhost:3000](http://localhost:3000)** and start your penetration testing journey! 🎯

---

## 🔑 Required Services

| Service        | Purpose                                   | Get Started                             |
| -------------- | ----------------------------------------- | --------------------------------------- |
| **Convex**     | Real-time database & conversation storage | [convex.dev](https://convex.dev/)       |
| **WorkOS**     | User authentication & session management  | [workos.com](https://workos.com/)       |
| **OpenRouter** | LLM access (Claude, GPT, etc.)            | [openrouter.ai](https://openrouter.ai/) |
| **OpenAI**     | Moderation API                            | [openai.com](https://openai.com/api/)   |

## 🔧 Optional Enhancements

### Sandbox Mode

Execute terminal commands in isolated containers instead of your local machine:

| Service | Purpose                   | Get API Key                 |
| ------- | ------------------------- | --------------------------- |
| **E2B** | Secure isolated execution | [e2b.dev](https://e2b.dev/) |

```env
TERMINAL_EXECUTION_MODE=sandbox
E2B_API_KEY=your_e2b_api_key_here
```

### Web Search

Enable AI to search the web for up-to-date information:

```env
EXA_API_KEY=your_exa_api_key_here
```
