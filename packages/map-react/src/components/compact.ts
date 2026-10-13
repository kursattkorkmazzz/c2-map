/** `undefined` değerli alanları atar: opsiyonel prop verilmediyse store'daki nesnede anahtar da olmasın. */
export function compact<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = v;
  return out as T;
}
