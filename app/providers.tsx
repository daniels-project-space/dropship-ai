"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useState, type ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  // One client per browser session. useState initializer keeps it stable
  // across re-renders without re-instantiating the socket.
  const [client] = useState(
    () => new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!),
  );

  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
