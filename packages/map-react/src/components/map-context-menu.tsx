import { MAP_EVENT, type LngLat, type ScreenPoint } from '@c2/map-core';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useMapContext } from '../context';

export type ContextMenuState = {
  /** Sağ tıklanan unsur (boşluğa tıklandıysa yok). */
  readonly featureId?: string;
  readonly coord?: LngLat;
  /** Harita kabına göre piksel. */
  readonly screen: ScreenPoint;
  close(): void;
};

export type MapContextMenuProps = {
  /** Menü içeriği (başsız: görünüm uygulamanın, ör. UI kütüphanesinin DropdownMenu'sü). `null` → açılmaz. */
  children: (menu: ContextMenuState) => ReactNode;
  className?: string;
  style?: CSSProperties;
};

/**
 * Sağ tık menüsü. `CONTEXT_MENU` global dinleyicisidir: unsur/katman dinleyicisi
 * `stopPropagation()` ile engelleyebilir. Kapanma: Esc, menü dışına basma, haritada tıklama
 * veya harita hareket edince (menü koordinattan kopmasın).
 */
export function MapContextMenu({ children, className, style }: MapContextMenuProps) {
  const { router } = useMapContext('<MapContextMenu>');
  const [open, setOpen] = useState<Omit<ContextMenuState, 'close'> | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    const offs = [
      router.on(MAP_EVENT.CONTEXT_MENU, (e) => {
        if (!e.screen) return;
        setOpen({ featureId: e.featureId, coord: e.coord, screen: e.screen });
      }),
      router.on(MAP_EVENT.CLICK, close),
      router.on(MAP_EVENT.VIEW_CHANGE, close),
    ];
    return () => offs.forEach((off) => off());
  }, [router, close]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onPointer = (e: PointerEvent) => {
      if (!element.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open, close]);

  if (!open) return null;
  const content = children({ ...open, close });
  if (content == null) return null;
  return (
    <div
      ref={element}
      className={className}
      role="menu"
      style={{ position: 'absolute', left: open.screen.x, top: open.screen.y, zIndex: 10, ...style }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {content}
    </div>
  );
}
