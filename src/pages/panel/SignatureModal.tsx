import { useState } from 'react';
import Avatar from '../../components/Avatar';
import BrandMark from '../../components/BrandMark';
import Modal from '../../components/Modal';
import { useI18n } from '../../i18n';
import type { Card } from '../../lib/api';
import { cardLogoUrl, cardPhotoUrl, displayName, publicLogoUrl, shortUrl } from '../../lib/api';

const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

export default function SignatureModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<'idle' | 'working' | 'done' | 'failed'>('idle');
  const name = displayName(card) || card.organization || card.code;
  const accent = card.accent_color ?? '#2457f5';
  const photo = cardPhotoUrl(card);
  const logo = cardLogoUrl(card);
  const cardUrl = shortUrl(card.code);

  async function downloadPng() {
    setStatus('working');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, 18, canvas.height);
      ctx.fillStyle = '#e8ebf2';
      ctx.fillRect(310, 68, 2, 224);

      const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
      ctx.save();
      if (card.photo_style !== 'logo') {
        ctx.beginPath();
        ctx.arc(164, 180, 94, 0, Math.PI * 2);
        ctx.clip();
      }
      if (photo) {
        const img = await loadImage(photo);
        const scale = card.photo_style === 'logo' ? Math.min(188 / img.width, 188 / img.height) : Math.max(188 / img.width, 188 / img.height);
        const width = img.width * scale;
        const height = img.height * scale;
        ctx.drawImage(img, 164 - width / 2, 180 - height / 2, width, height);
      } else {
        ctx.fillStyle = accent;
        ctx.fillRect(70, 86, 188, 188);
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 64px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initials || 'QR', 164, 180);
      }
      ctx.restore();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#10131a';
      ctx.font = '700 48px Arial, sans-serif';
      ctx.fillText(name, 360, 112);
      ctx.fillStyle = accent;
      ctx.font = '700 22px Arial, sans-serif';
      ctx.fillText([card.job_title, card.organization].filter(Boolean).join('  /  '), 360, 152);
      ctx.fillStyle = '#555d6d';
      ctx.font = '400 22px Arial, sans-serif';
      const lines = [card.phone, card.email, card.website?.replace(/^https?:\/\//, ''), cardUrl.replace(/^https?:\/\//, '')].filter(Boolean) as string[];
      lines.slice(0, 4).forEach((line, index) => ctx.fillText(line, 360, 201 + index * 34));
      if (logo) {
        const img = await loadImage(logo);
        const scale = Math.min(150 / img.width, 82 / img.height);
        const width = img.width * scale;
        const height = img.height * scale;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(1000, 58, 160, 102);
        ctx.drawImage(img, 1080 - width / 2, 109 - height / 2, width, height);
      }

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('png');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `email-signature-${card.code}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('done');
    } catch {
      setStatus('failed');
    }
  }

  async function copyHtml() {
    try {
      const details = [card.job_title, card.organization].filter(Boolean).map((value) => escapeHtml(String(value))).join(' · ');
      const publicLogo = publicLogoUrl(card);
      const logoCell = publicLogo ? `<td style="padding-left:18px"><img src="${escapeHtml(new URL(publicLogo, window.location.origin).href)}" alt="${escapeHtml(card.organization || '')}" width="96" style="display:block;max-width:96px;max-height:56px;object-fit:contain"></td>` : '';
      const html = `<table cellpadding="0" cellspacing="0" role="presentation" style="font-family:Arial,sans-serif;color:#10131a"><tr><td style="border-left:5px solid ${accent};padding:8px 18px"><strong style="font-size:18px">${escapeHtml(name)}</strong><br><span style="font-size:13px;color:${accent}">${details}</span><br><span style="font-size:12px;color:#555d6d">${[card.phone, card.email, card.website].filter(Boolean).map((v) => escapeHtml(String(v))).join(' · ')}</span><br><a href="${escapeHtml(cardUrl)}" style="font-size:12px;color:${accent}">${escapeHtml(cardUrl)}</a></td>${logoCell}</tr></table>`;
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([`${name}\n${details}\n${cardUrl}`], { type: 'text/plain' }) })]);
      } else {
        await navigator.clipboard.writeText(html);
      }
      setStatus('done');
    } catch {
      setStatus('failed');
    }
  }

  return (
    <Modal
      title={t('signature.title')}
      onClose={onClose}
      footer={<button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.close')}</button>}
    >
      <p className="mb-4 text-sm text-muted">{t('signature.subtitle')}</p>
      <div className="signature-preview">
        <div className="signature-avatar"><Avatar name={name} photoUrl={photo} accent={accent} logo={card.photo_style === 'logo'} size={76} /></div>
        <div className="signature-rule" style={{ background: accent }} />
        <div className="min-w-0">
          <p className="text-lg font-bold tracking-tight text-[#10131a]">{name}</p>
          <p className="text-sm font-semibold" style={{ color: accent }}>{[card.job_title, card.organization].filter(Boolean).join(' · ')}</p>
          <p className="mt-2 text-xs leading-5 text-[#555d6d]">{[card.phone, card.email, card.website?.replace(/^https?:\/\//, '')].filter(Boolean).join('  ·  ')}</p>
          <p className="text-xs font-medium" style={{ color: accent }}>{cardUrl.replace(/^https?:\/\//, '')}</p>
        </div>
        {logo ? <img src={logo} alt="" className="ml-auto hidden h-12 w-24 shrink-0 rounded-md border border-[#e5e7eb] bg-white object-contain p-1.5 sm:block" /> : <BrandMark className="ml-auto hidden h-9 w-9 shrink-0 text-[#10131a] sm:block" />}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={status === 'working'} onClick={() => void downloadPng()}>{status === 'working' ? t('signature.generating') : t('signature.download')}</button>
        <button type="button" className="btn btn-secondary" onClick={() => void copyHtml()}>{t('signature.copyHtml')}</button>
      </div>
      {status === 'done' && <p role="status" className="mt-3 text-sm text-success">{t('signature.ready')}</p>}
      {status === 'failed' && <p role="alert" className="mt-3 text-sm text-danger">{t('signature.failed')}</p>}
    </Modal>
  );
}
