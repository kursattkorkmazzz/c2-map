import ms from 'milsymbol';

// APP-6(D) sembol üretimi + önbellek.
// Kural: sembol görüntüsü BENZERSİZ KOD başına bir kez üretilir. 50k birlik birkaç yüz görüntüyü paylaşır.
// Bu yüzden birliğe özel metin (ör. "A/1-12") görüntüye gömülmez; o etiket ayrı çizilmelidir,
// yoksa her birlik benzersiz bir görüntü olur ve önbellek işe yaramaz.

ms.setStandard('APP6');

const SYMBOL_SIZE = 22; // milsymbol "size" (çerçeve boyu, CSS px)

/** Kimlik (standard identity) — renkler APP-6 standardından gelir. */
export const IDENTITIES = [
  { code: '3', name: 'Dost' },
  { code: '6', name: 'Düşman' },
  { code: '4', name: 'Tarafsız' },
  { code: '1', name: 'Bilinmeyen' },
] as const;

export const ENTITIES = [
  { code: '121100', name: 'Piyade' },
  { code: '121102', name: 'Mekanize piyade' },
  { code: '120500', name: 'Zırhlı' },
  { code: '121300', name: 'Keşif' },
  { code: '130300', name: 'Sahra topçusu' },
  { code: '130100', name: 'Hava savunma' },
  { code: '120400', name: 'Tanksavar' },
  { code: '140700', name: 'İstihkâm' },
  { code: '161300', name: 'Sağlık' },
  { code: '111000', name: 'Muhabere' },
  { code: '163600', name: 'İkmal' },
  { code: '120100', name: 'Havacılık' },
] as const;

export const ECHELONS = [
  { code: '14', name: 'Takım' },
  { code: '15', name: 'Bölük' },
  { code: '16', name: 'Tabur' },
  { code: '18', name: 'Tugay' },
  { code: '21', name: 'Tümen' },
] as const;

/** 20 haneli APP-6(D) SIDC: sürüm|bağlam|kimlik|sembol seti|durum|KH/GK|kademe|varlık|değiştiriciler */
export function buildSidc(identity: number, entity: number, echelon: number): string {
  const id = IDENTITIES[identity]?.code ?? '1';
  const ech = ECHELONS[echelon]?.code ?? '00';
  const ent = ENTITIES[entity]?.code ?? '000000';
  return `100${id}1000${ech}${ent}0000`;
}

export type SymbolImage = {
  key: string;
  canvas: HTMLCanvasElement;
  /** CSS piksel boyutu; görüntü, sembolün çapa noktası tam ortada olacak şekilde boşluklu. */
  width: number;
  height: number;
  pixelRatio: number;
};

export class SymbolCache {
  private readonly images = new Map<string, SymbolImage>();
  private readonly dataUrls = new Map<string, string>();
  private readonly pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  /** Toplam sembol üretim süresi (ms) — ölçüm için. */
  renderMs = 0;

  get size(): number {
    return this.images.size;
  }

  get(sidc: string): SymbolImage {
    let img = this.images.get(sidc);
    if (!img) {
      const t0 = performance.now();
      img = renderCentered(sidc, this.pixelRatio);
      this.renderMs += performance.now() - t0;
      this.images.set(sidc, img);
    }
    return img;
  }

  /** deck.gl görüntüyü URL olarak ister; data URL de kod başına bir kez üretilir. */
  dataUrl(sidc: string): string {
    let url = this.dataUrls.get(sidc);
    if (!url) {
      const t0 = performance.now();
      url = this.get(sidc).canvas.toDataURL();
      this.renderMs += performance.now() - t0;
      this.dataUrls.set(sidc, url);
    }
    return url;
  }
}

// milsymbol'ün çapası (çerçevenin merkezi) görüntünün ortasında değildir: kademe işareti üste,
// bazı değiştiriciler yanlara taşar. Harita motorları ikonu ortasından yerleştirdiği için
// sembolü, çapa tam ortaya gelecek şekilde daha büyük bir tuvale yerleştiriyoruz.
function renderCentered(sidc: string, pixelRatio: number): SymbolImage {
  const symbol = new ms.Symbol(sidc, { size: SYMBOL_SIZE });
  const src = symbol.asCanvas(pixelRatio);
  const anchor = symbol.getAnchor();
  const size = symbol.getSize();

  const halfW = Math.max(anchor.x, size.width - anchor.x);
  const halfH = Math.max(anchor.y, size.height - anchor.y);
  const width = Math.ceil(halfW * 2);
  const height = Math.ceil(halfH * 2);

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * pixelRatio);
  canvas.height = Math.ceil(height * pixelRatio);
  canvas
    .getContext('2d')!
    .drawImage(src, Math.round((width / 2 - anchor.x) * pixelRatio), Math.round((height / 2 - anchor.y) * pixelRatio));

  return { key: sidc, canvas, width, height, pixelRatio };
}
