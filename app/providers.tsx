"use client";

import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

function useOperatorAuth() {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    fetch("/api/auth/token", { cache: "no-store" })
      .then((response) => setAuthenticated(response.ok))
      .catch(() => setAuthenticated(false))
      .finally(() => setReady(true));
  }, []);

  const fetchAccessToken = useCallback(async () => {
    const response = await fetch("/api/auth/token", { cache: "no-store" });
    if (!response.ok) {
      setAuthenticated(false);
      return null;
    }
    const body = await response.json() as { token?: string };
    return body.token ?? null;
  }, []);

  return { isLoading: !ready, isAuthenticated: authenticated, fetchAccessToken };
}

export function Providers({ children }: { children: ReactNode }) {
  // One client per browser session. useState initializer keeps it stable
  // across re-renders without re-instantiating the socket.
  const [client] = useState(
    () => new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!),
  );

  return <ConvexProviderWithAuth client={client} useAuth={useOperatorAuth}>{children}</ConvexProviderWithAuth>;
}
