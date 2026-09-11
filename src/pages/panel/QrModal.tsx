import { useState } from 'react';
import CopyButton from '../../components/CopyButton';
import Modal from '../../components/Modal';
import QrDisplay from '../../components/QrDisplay';
import { useI18n } from '../../i18n';
import type { Card } from '../../lib/api';
import { shortUrl } from '../../lib/api';
import type { QrStyle } from '../../lib/qr';
import { qrDownloadUrl } from '../../lib/qr';

export default function QrModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const { t } = useI18n();
  const url = shortUrl(card.code);
  const [style, setStyle] = useState<QrStyle>('standard');

  return (
    <Modal
      title={t('qr.title', { code: card.code })}
      onClose={onClose}
      footer={
        <>
          <CopyButton text={url} />
          <a className="btn btn-primary" href={qrDownloadUrl(card.code, { style })} download={`qr-${card.code}-${style}.png`}>
            {t('qr.download')}
          </a>
        </>
      }
    >
      <div className="flex flex-col items-center">
        {card.status === 'draft' && <p className="mb-4 w-full rounded-lg bg-fg/5 p-3 text-sm">{t('qr.draftHint')}</p>}
        <div className="mb-4 flex rounded-lg border border-line bg-surface p-1 text-xs">
          <button
            type="button"
            className={`rounded px-3 py-1 font-medium transition-colors ${style === 'standard' ? 'bg-primary text-white shadow-xs' : 'text-muted hover:text-fg'}`}
            onClick={() => setStyle('standard')}
          >
            {t('qr.styleStandard')}
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1 font-medium transition-colors ${style === 'art' ? 'bg-primary text-white shadow-xs' : 'text-muted hover:text-fg'}`}
            onClick={() => setStyle('art')}
          >
            {t('qr.styleArt')}
          </button>
        </div>
        <QrDisplay code={card.code} label={url} size={260} style={style} />
        <p className="code mt-4 max-w-full truncate text-center text-muted">{url}</p>
      </div>
    </Modal>
  );
}
