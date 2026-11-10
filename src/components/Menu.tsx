import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Icon from './Icon';
import type { IconName } from './Icon';

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

/**
 * An overflow menu ("⋯"): opens below its trigger, closes on Escape, an
 * outside click or a choice; arrow keys move between items and focus returns
 * to the trigger.
 */
export default function Menu({ label, items, trigger }: { label: string; items: (MenuItem | null | false)[]; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Right-aligned under the trigger, unless that would run off the left edge (narrow phones).
  const [alignLeft, setAlignLeft] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const shown = items.filter(Boolean) as MenuItem[];

  useEffect(() => {
    if (!open) return;
    const first = rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
    function onPointer(ev: PointerEvent) {
      if (!rootRef.current?.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const all = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
        const at = all.indexOf(document.activeElement as HTMLButtonElement);
        all[(at + (ev.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-secondary btn-sm px-2.5"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          const r = buttonRef.current?.getBoundingClientRect();
          setAlignLeft(Boolean(r && r.right < 232));
          setOpen((o) => !o);
        }}
      >
        {trigger ?? <Icon name="more" />}
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label={label} className={`menu-pop absolute ${alignLeft ? 'left-0 origin-top-left' : 'right-0'} z-30 mt-1.5 min-w-52 rounded-xl border border-line bg-surface p-1.5 shadow-card`}>
          {shown.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.hint}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none hover:bg-fg/6 focus-visible:bg-fg/6 disabled:opacity-50 ${item.danger ? 'text-danger' : 'text-fg'}`}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon && <Icon name={item.icon} size={16} className={item.danger ? '' : 'text-muted'} />}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
