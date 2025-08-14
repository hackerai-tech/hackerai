# HackerAI - The AI Pentest Assistant

## Prerequisites

Before running the application, you need to obtain API keys for the following services:

### Required API Keys

1. **OpenRouter API Key** - For LLM (Large Language Model) usage
   - Sign up at [https://openrouter.ai/](https://openrouter.ai/)
   - Get your API key from the dashboard
   - This enables the AI to access various models including Claude, GPT, etc.

2. **E2B API Key** - For secure sandbox environments
   - Sign up at [https://e2b.dev/](https://e2b.dev/)
   - Get your API key from the dashboard
   - This allows the AI to execute terminal commands and Python code safely in isolated containers

## Getting Started

1. **Install dependencies:**

   ```bash
   pnpm i
   ```

2. **Set up environment variables:**
   - Copy `.env.local.example` to `.env.local`
   - Add your API keys to the `.env.local` file:
     ```
     OPENROUTER_API_KEY=your_openrouter_api_key_here
     E2B_API_KEY=your_e2b_api_key_here
     ```
   - Optionally customize the AI models:
     ```
     NEXT_PUBLIC_AGENT_MODEL=qwen/qwen3-coder
     NEXT_PUBLIC_TITLE_MODEL=qwen/qwen-turbo
     ```

3. **Run the development server:**

   ```bash
   pnpm dev
   ```

4. **Open the application:**
   - Navigate to [http://localhost:3000](http://localhost:3000) in your browser

The AI assistant is now ready to help with your penetration testing tasks!
