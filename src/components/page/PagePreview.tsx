import { memo } from 'react';
import type { PublicCard } from '../../lib/api';
import type { PageDesign, ThemeMode } from '../../lib/page-design';
import PageCard from './PageCard';
import type { PageAssets } from './PageCard';

/**
 * A page-designer card drawn at phone size and scaled down — template
 * thumbnails and the form's summary. The transformed screen is also the
 * containing block for the card's fixed parts (dock, top bar), so they stay
 * inside the miniature instead of escaping to the panel.
 */
function PagePreview({
  card,
  design,
  assets,
  scale,
  mode,
  width = 375,
  height = 720,
}: {
  card: PublicCard;
  design: PageDesign;
  assets: PageAssets;
  scale: number;
  mode?: ThemeMode;
  width?: number;
  height?: number;
}) {
  const forced = mode ?? (design.theme.mode === 'dark' ? 'dark' : 'light');
  return (
    <div className="pc-thumb" style={{ width: width * scale, height: height * scale }} aria-hidden="true" inert>
      <div className="pc-thumb-screen" style={{ width, height, transform: `scale(${scale})` }}>
        <PageCard card={card} design={design} assets={assets} preview forcedMode={forced} />
      </div>
    </div>
  );
}

export default memo(PagePreview);
