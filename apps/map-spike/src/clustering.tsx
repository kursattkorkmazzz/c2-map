// Spike'ın kümeleme ayarı (react.html ve cesium.html ortak): birlikler kimliğe göre (dost / düşman /
// tarafsız / bilinmeyen) ayrı kümelenir, rozet APP-6 kimlik rengini alır.

import { ClusterStage, MAP_EVENT, type ClusterInfo, type Feature } from '@c2/map-core';
import { useMapEvent } from '@c2/map-react';
import { useEffect, useState } from 'react';
import { IDENTITIES } from './sidc';

/** SIDC'nin 4. hanesi: kimlik (3 dost, 6 düşman, 4 tarafsız, 1 bilinmeyen). */
const identityOf = (feature: Feature) => (feature.props as { sidc?: string } | undefined)?.sidc?.[3] ?? '1';

const COLORS: Record<string, string> = { '3': '#2f8fe0', '6': '#e04848', '4': '#3aa35a', '1': '#d9a81f' };
/** Aynı hücrede dört kimlik üst üste binmesin: dost sol üst, düşman sağ üst, tarafsız sol alt, bilinmeyen sağ alt. */
const OFFSETS: Record<string, readonly [number, number]> = { '3': [-13, -13], '6': [13, -13], '4': [-13, 13], '1': [13, 13] };
export const clusterColor = (key: string) => COLORS[key] ?? '#808080';

/** Yalnız verilen katmandaki birlikler kümelenir (İHA'lar, kontrol tedbirleri, çizimler değil). */
export function unitClusterStage(layerId: string, cellPx = 64): ClusterStage {
  return new ClusterStage({
    filter: (f) => f.layerId === layerId && f.geometry.kind === 'point',
    clusterKey: identityOf,
    keyOffsetPx: (key) => OFFSETS[key],
    cellPx,
    // 2'li kümeler yakın zoom'da kalabalık gösteriyor; 3+ birlik kümelenir
    minPoints: 3,
  });
}

/** Panel satırları: aç / kapat, anlık sayılar, son tıklanan küme. */
export function ClusterControls({ stage, enabled, onToggle }: { stage: ClusterStage; enabled: boolean; onToggle: (on: boolean) => void }) {
  const [stats, setStats] = useState(stage.stats);
  const [last, setLast] = useState('—');
  useEffect(() => {
    const timer = setInterval(() => setStats(stage.stats), 1000);
    return () => clearInterval(timer);
  }, [stage]);
  useMapEvent(MAP_EVENT.CLUSTER_CLICK, (e) => {
    const info = e.data as ClusterInfo;
    const name = IDENTITIES.find((i) => i.code === info.key)?.name ?? info.key;
    setLast(`${info.count} ${name.toLowerCase()} birlik`);
  });
  return (
    <>
      <label>
        Kümeleme (kimliğe göre)
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
      </label>
      {enabled && (
        <p className="hint">
          {stats.zoom === null
            ? 'Bu yakınlıkta kümeleme yok'
            : `${stats.clusters.toLocaleString('tr-TR')} küme · ${stats.hidden.toLocaleString('tr-TR')} birlik kümede · son tıklanan: ${last}`}
        </p>
      )}
    </>
  );
}
