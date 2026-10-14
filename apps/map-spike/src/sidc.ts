// APP-6(D) SIDC parçaları (saf: DOM / canvas yok → Worker'da da kullanılır).

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
