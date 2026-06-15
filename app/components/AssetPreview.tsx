"use client";

import { useEffect, useRef, useState } from "react";

// Lazy R2 asset preview. Resolves a presigned URL via /api/asset only when scrolled near view,
// then renders a muted looping <video> (mp4) or <img>. Shows a shimmer while resolving and a
// framed placeholder when the asset is missing/unresolvable — never a broken-image icon.
export function AssetPreview({
  r2Key,
  className = "",
  kind = "auto",
}: {
  r2Key: string | null | undefined;
  className?: string;
  kind?: "auto" | "video" | "image";
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [near, setNear] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const isVideo = kind === "video" || (kind === "auto" && (r2Key?.endsWith(".mp4") ?? false));

  // only resolve once the card is near the viewport (cheap, avoids presign storms)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near || !r2Key) return;
    let live = true;
    fetch(`/api/asset?key=${encodeURIComponent(r2Key)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { url?: string }) => live && d.url && setUrl(d.url))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [near, r2Key]);

  return (
    <div
      ref={ref}
      className={`relative overflow-hidden bg-void ${className}`}
    >
      {/* atmospheric placeholder/frame always present behind the media */}
      <div className="absolute inset-0 grid place-items-center">
        {!url && !failed && r2Key ? (
          <div className="shimmer h-full w-full" />
        ) : (
          <div className="flex flex-col items-center gap-2 text-ink-faint">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <path d="m9 9 6 3-6 3z" />
            </svg>
            <span className="font-mono text-[10px] uppercase tracking-wider">
              {failed ? "asset unavailable" : "asset pending"}
            </span>
          </div>
        )}
      </div>

      {url &&
        (isVideo ? (
          <video
            src={url}
            muted
            loop
            playsInline
            autoPlay
            onError={() => setFailed(true)}
            className="relative h-full w-full object-cover"
          />
        ) : (
          <img
            src={url}
            alt=""
            onError={() => setFailed(true)}
            className="relative h-full w-full object-cover"
          />
        ))}
    </div>
  );
}
