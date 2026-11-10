"use client";
import { useEffect, useState, type FormEvent } from "react";
export default function LocalLogin() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/local-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: data.get("email"),
          password: data.get("password"),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Não foi possível entrar.");
      window.location.assign("/");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Falha de conexão.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-dvh flex items-center justify-center bg-background p-6">
      <form
        method="post"
        action="/api/local-auth/login"
        onSubmit={submit}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-card p-8 shadow-lg"
      >
        <div>
          <h1 className="text-2xl font-semibold">HackerAI Brasil</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Entre na sua instalação em tandi.tech
          </p>
        </div>
        <label className="block text-sm">
          E-mail
          <input
            required
            autoComplete="username"
            type="email"
            name="email"
            className="mt-2 block w-full rounded-lg border border-border bg-background p-3"
          />
        </label>
        <label className="block text-sm">
          Senha
          <input
            required
            autoComplete="current-password"
            type="password"
            name="password"
            maxLength={1024}
            className="mt-2 block w-full rounded-lg border border-border bg-background p-3"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
        )}
        <button
          disabled={busy || !ready}
          className="w-full rounded-lg bg-primary p-3 font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </main>
  );
}
