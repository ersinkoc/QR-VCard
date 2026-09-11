/**
 * Photo when there is one, otherwise initials on a tint of the card's accent.
 * `logo`: a square, uncropped frame on white — a round crop cuts logo corners.
 */
export default function Avatar({
  name,
  photoUrl,
  accent,
  logo = false,
  size = 40,
}: {
  name: string;
  photoUrl?: string | null;
  accent?: string | null;
  logo?: boolean;
  size?: number;
}) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toLocaleUpperCase();
  const color = accent ?? 'var(--color-accent)';

  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt=""
        width={size}
        height={size}
        className={logo ? 'shrink-0 rounded-xl border border-line bg-white object-contain p-[6%]' : 'shrink-0 rounded-full border border-line object-cover'}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={`flex shrink-0 items-center justify-center font-medium ${logo ? 'rounded-xl' : 'rounded-full'}`}
      style={{ width: size, height: size, fontSize: size * 0.36, color, backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)` }}
    >
      {initials}
    </div>
  );
}
