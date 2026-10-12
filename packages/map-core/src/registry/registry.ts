// ── Ortak kayıt defteri ──────────────────────────────────────────
// Kind tanımları, altlık sağlayıcıları ve semboloji sağlayıcıları aynı temel davranışı paylaşır:
// anahtar → değer; aynı anahtarı ikinci kez kaydetmek hata (bilinçli değiştirme `replace` ile).

export type RegisterOptions = {
  /** Var olan kaydı bilerek değiştir. Verilmezse aynı anahtar ikinci kez kaydedilemez. */
  replace?: boolean;
};

export class Registry<T> {
  private readonly items = new Map<string, T>();

  constructor(
    /** Hata mesajlarında görünen ad (ör. "kind", "altlık sağlayıcısı"). */
    private readonly label: string,
    private readonly keyOf: (item: T) => string,
  ) {}

  /** Kaydeder; kaydı geri alan fonksiyon döner (yalnız hâlâ aynı nesne kayıtlıysa siler). */
  register(item: T, options: RegisterOptions = {}): () => void {
    const key = this.keyOf(item);
    if (this.items.has(key) && !options.replace) {
      throw new Error(`Bu ${this.label} zaten kayıtlı: "${key}". Değiştirmek için { replace: true } verin.`);
    }
    this.items.set(key, item);
    return () => {
      if (this.items.get(key) === item) this.items.delete(key);
    };
  }

  get(key: string): T | undefined {
    return this.items.get(key);
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  keys(): string[] {
    return [...this.items.keys()];
  }

  values(): T[] {
    return [...this.items.values()];
  }
}
