"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const params = useSearchParams();
  const [operatorToken, setOperatorToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operatorToken }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Sign-in failed");
      const requested = params.get("next");
      window.location.assign(requested?.startsWith("/") ? requested : "/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-void p-6 text-ink">
      <form onSubmit={submit} className="panel w-full max-w-sm rounded-2xl p-7">
        <p className="label-eyebrow text-signal">Dropship AI</p>
        <h1 className="mt-3 font-display text-3xl">Operator access</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-dim">Enter the operator credential to open this control plane.</p>
        <label className="mt-6 block text-sm text-ink-dim" htmlFor="operatorToken">Operator credential</label>
        <input id="operatorToken" type="password" autoComplete="current-password" required value={operatorToken} onChange={(event) => setOperatorToken(event.target.value)} className="mt-2 w-full rounded-lg border border-line bg-void px-3 py-2.5 outline-none focus:border-signal" />
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <button type="submit" disabled={busy} className="mt-6 w-full rounded-lg bg-signal px-4 py-2.5 font-semibold text-void disabled:opacity-50">{busy ? "Checking…" : "Sign in"}</button>
      </form>
    </main>
  );
}
