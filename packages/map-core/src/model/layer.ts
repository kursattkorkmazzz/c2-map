// ── Katman (grup) ────────────────────────────────────────────────
export type Layer = {
  id: string;
  name: string;
  parentId: string | null; // null = kök
  visible: boolean; // kendi bayrağı; efektif görünürlük MapSync'te hesaplanır
  opacity: number; // 0..1; efektif = atalarla çarpım
  selectable?: boolean;
  interactive?: boolean; // false → hit-test'e hiç girmez (perf)
  minZoom?: number;
  maxZoom?: number;
  renderGroup?: boolean; // true → motor bu alt ağaç için ayrı kaynak açar (plan/design/04-sync-and-rendering.md#maplibre-render-group)
  meta?: Record<string, unknown>;
};
