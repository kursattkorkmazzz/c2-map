// ── Unsur (çizilebilir) ──────────────────────────────────────────

import type { Geometry } from "./geometry";

/*
style/props/geometry **görsel** alanlardır, değişince haritaya gider.
meta **görsel olmayan** domain verisidir, değişince yalnız React abonelerine (kart, tablo) gider; harita hiç dokunulmaz.  

Bu ayrım performansın temelindendir.
*/
export type Feature<K extends string = string, S = unknown, P = unknown> = {
  id: string;
  layerId: string; // ait olduğu katman
  kind: K; // 'vector' | 'marker' | 'milsym' | 'model3d' | 'composite' | custom
  geometry: Geometry;
  style?: S; // kind'e özel görsel stil       → motora gider
  props?: P; // kind'e özel görsel veri (SIDC, etiket, model url) → motora gider
  z?: number; // katman içi sıra
  hidden?: boolean;
  selectable?: boolean;
  meta?: Record<string, unknown>; // domain verisi (yakıt, durum…) → MOTORA GİTMEZ
  rev?: number; // backend sürüm/sequence; sıra dışı güncellemeyi düşürmek için
};
