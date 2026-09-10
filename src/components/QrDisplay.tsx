import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { qrUrl } from '../lib/qr';

export default function QrDisplay({ data, size = 240, className }: { data: string; size?: number; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setSrc(null);
    setError(null);
    // Different data means the enlarged view would be showing the old code.
    setExpanded(false);
    qrUrl(data)
      .then((u) => {
        if (!alive) {
          if (u.startsWith('blob:')) URL.revokeObjectURL(u);
          return;
        }
        objectUrl = u;
        setSrc(u);
      })
      .catch((err) => {
        // Keep the reason rather than a bare failure. Every message qrUrl()
        // can raise names the layer that broke — a 403 from the proxy's origin
        // allowlist, an HTML shell answering /api/qr because no route proxies
        // it, a provider 500 — and that line is what fixes the deployment.
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
      // qrUrl() hands back a blob: URL for the provider's PNG bytes; release it
      // when this card is unmounted or the data changes, or every render leaks
      // one image.
      if (objectUrl?.startsWith('blob:')) URL.revokeObjectURL(objectUrl);
    };
  }, [data]);

  // Enlarged view behaviour: Escape closes, Tab stays inside, the page behind
  // cannot scroll, and focus returns to the thumbnail that opened it.
  useEffect(() => {
    if (!expanded) return;
    const trigger = triggerRef.current;
    closeRef.current?.focus();

    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') {
        setExpanded(false);
        return;
      }
      // One control in here, so Tab has nowhere legitimate to go: without this
      // it would reach the page behind an aria-modal overlay.
      if (ev.key === 'Tab') {
        ev.preventDefault();
        closeRef.current?.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [expanded]);

  if (error) {
    return (
      <div className={className}>
        <p className="text-sm text-danger">QR generation failed.</p>
        <p className="mt-1 break-words text-sm text-muted">{error}</p>
      </div>
    );
  }

  return (
    <div className={className}>
      {src ? (
        <button
          ref={triggerRef}
          type="button"
          aria-label={`Enlarge QR code for ${data}`}
          onClick={() => setExpanded(true)}
          className="block cursor-zoom-in rounded-lg focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
        >
          <img src={src} width={size} height={size} alt="" className="block rounded-lg border border-line bg-white p-2" />
        </button>
      ) : (
        <div style={{ width: size, height: size }} className="animate-pulse rounded-lg border border-line bg-surface" />
      )}

      {/*
        Fullscreen means "as large as the viewport allows", which is an overlay
        rather than the Fullscreen API: iOS Safari refuses requestFullscreen()
        on anything but a <video>, and an overlay also keeps the page, its
        history and its scroll position untouched.
      */}
      {expanded &&
        src &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`QR code for ${data}`}
            onClick={() => setExpanded(false)}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          >
            <div className="flex max-h-full flex-col items-center gap-4" onClick={(ev) => ev.stopPropagation()}>
              {/* Sized by the viewport, not by the thumbnail's `size` prop: the
                  provider returns a 1000 px PNG, so it stays sharp enlarged. */}
              <img src={src} alt="" className="max-h-[75vh] max-w-[88vw] rounded-xl border border-line bg-white p-3" />
              <p className="code max-w-[88vw] truncate text-white/90">{data}</p>
              <button ref={closeRef} type="button" className="btn btn-secondary" onClick={() => setExpanded(false)}>
                Close
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
