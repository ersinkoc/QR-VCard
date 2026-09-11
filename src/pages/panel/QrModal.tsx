import CopyButton from '../../components/CopyButton';
import Modal from '../../components/Modal';
import QrDisplay from '../../components/QrDisplay';
import { useI18n } from '../../i18n';
import type { Card } from '../../lib/api';
import { shortUrl } from '../../lib/api';
import { qrDownloadUrl } from '../../lib/qr';

export default function QrModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const { t } = useI18n();
  const url = shortUrl(card.code);

  return (
    <Modal
      title={t('qr.title', { code: card.code })}
      onClose={onClose}
      footer={
        <>
          <CopyButton text={url} />
          <a className="btn btn-primary" href={qrDownloadUrl(card.code)} download={`qr-${card.code}.png`}>
            {t('qr.download')}
          </a>
        </>
      }
    >
      <div className="flex flex-col items-center">
        {card.status === 'draft' && <p className="mb-4 w-full rounded-lg bg-fg/5 p-3 text-sm">{t('qr.draftHint')}</p>}
        <QrDisplay code={card.code} label={url} size={260} />
        <p className="code mt-4 max-w-full truncate text-center text-muted">{url}</p>
      </div>
    </Modal>
  );
}
