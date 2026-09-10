import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

export default function HomePage() {
  const [code, setCode] = useState('');
  const navigate = useNavigate();

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="text-center">
          <img src="/favicon.svg" alt="" width="48" height="48" className="mx-auto" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">QR-VCard</h1>
          <p className="mt-2 text-sm text-muted">Digital business cards, one QR away.</p>
        </div>

        <div className="card mt-8 p-5">
          <Link to="/panel" className="btn btn-primary w-full">
            Open panel
          </Link>

          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              const c = code.trim();
              if (c) navigate(`/c/${encodeURIComponent(c)}`);
            }}
          >
            <label className="label" htmlFor="code">
              Have a card code?
            </label>
            <div className="flex gap-2">
              <input id="code" className="input font-mono" placeholder="code" value={code} onChange={(e) => setCode(e.target.value)} />
              <button type="submit" className="btn btn-secondary">
                Open
              </button>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
