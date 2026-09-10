import { useEffect, useState } from 'react';
import { qrUrl } from '../lib/qr';

export default function QrDisplay({ data, size = 240, className }: { data: string; size?: number; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setFailed(false);
    qrUrl(data)
      .then((u) => {
        if (alive) setSrc(u);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [data]);

  if (failed) return <p className="text-sm text-muted">QR generation failed.</p>;

  return (
    <div className={className}>
      {src ? (
        <img src={src} width={size} height={size} alt={`QR code for ${data}`} className="rounded-lg border border-line bg-white p-2" />
      ) : (
        <div style={{ width: size, height: size }} className="animate-pulse rounded-lg border border-line bg-surface" />
      )}
    </div>
  );
}
