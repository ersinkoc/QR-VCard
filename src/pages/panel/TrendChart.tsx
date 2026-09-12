import { useMemo } from 'react';
import { useI18n } from '../../i18n';
import type { ViewDayPoint } from '../../lib/api';

/**
 * A 30-day scan trend as a pure-SVG area chart: no chart library, no HTTP
 * requests beyond the trend endpoint, dark-mode safe (currentColor). The peak
 * is labelled with its day; hover targets carry per-day titles.
 *
 * `points` is a contiguous daily window ending today (holes already filled
 * with 0 by the server) — render exactly what arrives.
 */
export default function TrendChart({ points, total }: { points: ViewDayPoint[]; total: number }) {
  const { t } = useI18n();
  const W = 600;
  const H = 120;
  const PAD = 2;

  const { area, line, peak, last } = useMemo(() => {
    const max = Math.max(1, ...points.map((p) => p.views));
    const x = (i: number) => (points.length <= 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (points.length - 1));
    const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
    const coords = points.map((p, i) => `${x(i).toFixed(1)},${y(p.views).toFixed(1)}`);
    const peakIndex = points.reduce((best, p, i) => (p.views > points[best].views ? i : best), 0);
    return {
      area: `M0,${H} L${coords.join(' L')} L${W},${H} Z`,
      line: `M${coords.join(' L')}`,
      peak: points[peakIndex] ? { ...points[peakIndex], index: peakIndex } : null,
      last: points[points.length - 1] ?? null,
    };
  }, [points]);

  if (points.length === 0) return null;
  const fmtDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div className="card px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs text-muted">{t('cards.trendLabel', { days: points.length })}</p>
        <p className="text-xl font-semibold tracking-tight tabular-nums">{total}</p>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 h-20 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={t('cards.trendAria', { total })}
      >
        {/* Baseline: makes a zero-traffic month read as an empty chart, not a missing one. */}
        <line x1="0" y1={H - 1} x2={W} y2={H - 1} stroke="currentColor" strokeOpacity="0.15" strokeWidth="1" />
        <path d={area} fill="currentColor" fillOpacity="0.12" />
        <path d={line} fill="none" stroke="currentColor" strokeOpacity="0.7" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {peak && peak.views > 0 && (
          <g>
            <circle cx={((peak.index * (W - 2 * PAD)) / (points.length - 1)).toFixed(1)} cy={H - PAD - (peak.views / Math.max(1, ...points.map((p) => p.views))) * (H - 2 * PAD)} r="3" fill="currentColor" />
            <title>{t('cards.trendPeak', { count: peak.views, day: fmtDay(peak.day) })}</title>
          </g>
        )}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted">
        <span>{fmtDay(points[0].day)}</span>
        <span>{t('cards.trendToday', { count: last?.views ?? 0 })}</span>
        <span>{fmtDay(last.day)}</span>
      </div>
    </div>
  );
}
