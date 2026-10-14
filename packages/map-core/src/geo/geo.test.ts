import mgrsOracle from "mgrs";
import { describe, expect, it } from "vitest";
import type { LngLat } from "../model/geometry";
import { formatAngle, formatCoordinate, parseCoordinate } from "./dms";
import { bearing, destination, distance, formatArea, formatDistance, geodesicCircle, lineLength, polygonArea } from "./geodesic";
import { parseMgrs, toMgrs } from "./mgrs";
import { formatUtm, fromUtm, parseUtm, toUtm, utmZone } from "./utm";

/** Tekrarlanabilir rastgele (testler her koşuda aynı noktaları dener). */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}
const randomPoints = (count: number, seed = 42): LngLat[] => {
  const rnd = random(seed);
  return Array.from({ length: count }, () => [rnd() * 359.8 - 179.9, rnd() * 163.8 - 79.9] as LngLat);
};

const ANKARA: LngLat = [32.854, 39.92];

describe("UTM", () => {
  it("bilinen değerler: merkez meridyen ve ekvator", () => {
    const cm = toUtm([3, 0]);
    expect(cm.zone).toBe(31);
    expect(cm.easting).toBeCloseTo(500_000, 6);
    expect(cm.northing).toBeCloseTo(0, 6);
    // (0°, 0°): zone 31'de E = 166 021,4431 m (GeographicLib / NGA referansı)
    expect(toUtm([0, 0]).easting).toBeCloseTo(166_021.4431, 3);
  });

  it("gidiş-dönüş: zone içinde < 1 µm", () => {
    for (const p of randomPoints(2000)) {
      const back = fromUtm(toUtm(p));
      expect(distance(p, back)).toBeLessThan(1e-6); // ölçülen en büyük: ~5 nm
    }
  });

  it("güney yarımküre: yanlış kuzey ve bant", () => {
    const u = toUtm([-58.38, -34.6]); // Buenos Aires
    expect(u).toMatchObject({ zone: 21, band: "H" });
    expect(u.northing).toBeGreaterThan(6_000_000);
    expect(distance(fromUtm(u), [-58.38, -34.6])).toBeLessThan(1e-4);
  });

  it("zone istisnaları: Norveç 32V, Svalbard 31/33/35/37; boylam 180 → zone 60", () => {
    expect(utmZone(5, 60)).toBe(32);
    expect(utmZone(2, 60)).toBe(31);
    expect(utmZone(8, 78)).toBe(31);
    expect(utmZone(10, 78)).toBe(33);
    expect(utmZone(25, 78)).toBe(35);
    expect(utmZone(40, 78)).toBe(37);
    expect(utmZone(180, 0)).toBe(60);
    expect(toUtm([10, 78]).zone).toBe(33);
  });

  it("kapsam dışı enlem → RangeError", () => {
    expect(() => toUtm([0, 85])).toThrow(RangeError);
    expect(() => toUtm([0, -80.5])).toThrow(RangeError);
  });

  it("metin: bant harfiyle yaz / oku (Türkiye S bandı = kuzey)", () => {
    const u = toUtm(ANKARA);
    const text = formatUtm(u);
    expect(text).toMatch(/^36S \d{6} \d{7}$/);
    const parsed = parseUtm(text)!;
    expect(distance(fromUtm(parsed), ANKARA)).toBeLessThan(1);
    expect(parseUtm("36 s 684296mE 4420004mN")).toEqual({ zone: 36, band: "S", easting: 684296, northing: 4420004 });
    expect(parseUtm("61S 1 2")).toBeNull();
    expect(parseUtm("36I 1 2")).toBeNull(); // I bant harfi değil
  });
});

describe("MGRS", () => {
  it("bilinen değer: (0°, 0°) → 31N AA 66021 00000", () => {
    expect(toMgrs([0, 0])).toBe("31N AA 66021 00000");
    expect(toMgrs([0, 0], { spaced: false })).toBe("31NAA6602100000");
  });

  it("2000 rastgele noktada referans kütüphaneyle (mgrs) aynı kare (en fazla son hanede 1 m)", () => {
    let exact = 0;
    for (const p of randomPoints(2000)) {
      const ours = toMgrs(p, { spaced: false });
      const theirs = mgrsOracle.forward([p[0], p[1]], 5);
      if (ours === theirs) {
        exact++;
        continue;
      }
      // Fark yalnız 1 m kesme sınırında olabilir (referansın düşük dereceli UTM serisi).
      expect(ours.slice(0, -10)).toBe(theirs.slice(0, -10));
      expect(Math.abs(Number(ours.slice(-10, -5)) - Number(theirs.slice(-10, -5)))).toBeLessThanOrEqual(1);
      expect(Math.abs(Number(ours.slice(-5)) - Number(theirs.slice(-5)))).toBeLessThanOrEqual(1);
    }
    expect(exact).toBeGreaterThan(1900);
  });

  it("okuma: referansla aynı noktaya döner; gidiş-dönüş karenin içinde", () => {
    for (const p of randomPoints(500, 7)) {
      const text = toMgrs(p);
      const parsed = parseMgrs(text)!;
      expect(parsed).not.toBeNull();
      // Referansın UTM tersi cm düzeyinde (5000 noktada en fazla 2,75 cm); bizimki nm düzeyinde
      // (yukarıdaki gidiş-dönüş testi). Fark referansın hassasiyeti.
      expect(distance(parsed.coord, mgrsOracle.toPoint(text.replace(/ /g, "")) as unknown as LngLat)).toBeLessThan(0.05);
      // Kesme: nokta, güneybatı köşenin en fazla ~1,5 m kuzeydoğusunda
      expect(distance(parsed.southWest, p)).toBeLessThan(1.5);
      expect(parsed.sizeM).toBe(1);
    }
  });

  it("hassasiyet: 0–5; kare boyu", () => {
    expect(toMgrs(ANKARA, { precision: 2 })).toMatch(/^36S [A-Z]{2} \d{2} \d{2}$/);
    expect(toMgrs(ANKARA, { precision: 0 })).toMatch(/^36S [A-Z]{2}$/);
    expect(parseMgrs(toMgrs(ANKARA, { precision: 2 }))!.sizeM).toBe(1000);
    expect(parseMgrs(toMgrs(ANKARA, { precision: 0 }))!.sizeM).toBe(100_000);
    expect(() => toMgrs(ANKARA, { precision: 6 })).toThrow(RangeError);
  });

  it("okuma biçimleri: boşluk / küçük harf / tek blok; hatalı girişler null", () => {
    const text = toMgrs(ANKARA); // "36S VK 84296 20004" benzeri
    const compact = text.replace(/ /g, "").toLowerCase();
    expect(distance(parseMgrs(compact)!.coord, parseMgrs(text)!.coord)).toBeLessThan(1e-6);
    const [gzd, square, e, n] = text.split(" ");
    expect(parseMgrs(`${gzd} ${square} ${e} ${n!.slice(0, 4)}`)).toBeNull(); // bloklar eşit değil
    expect(parseMgrs(`${gzd} IO ${e} ${n}`)).toBeNull(); // I / O harf değil
    expect(parseMgrs("61S VK 1 1")).toBeNull();
    // Satır harfini 1000 km kaydır → S bandıyla tutarsız
    const rows = "ABCDEFGHJKLMNPQRSTUV";
    const shifted = rows[(rows.indexOf(square![1]!) + 10) % 20];
    expect(parseMgrs(`${gzd} ${square![0]}${shifted} ${e} ${n}`)).toBeNull();
  });

  it("güney yarımküre ve zone istisnası", () => {
    const ba: LngLat = [-58.38, -34.6];
    expect(toMgrs(ba)).toMatch(/^21H /);
    expect(distance(parseMgrs(toMgrs(ba))!.southWest, ba)).toBeLessThan(1.5);
    expect(toMgrs([5, 60])).toMatch(/^32V /);
  });
});

describe("DD / DM / DMS", () => {
  it("biçimler; Türkçe yön harfleri", () => {
    expect(formatAngle(39.92, "lat")).toBe(`39°55'12.0"N`);
    expect(formatAngle(-32.85, "lon", { format: "dm" })).toBe(`32°51.000'W`);
    expect(formatAngle(39.92, "lat", { format: "dd", decimals: 3 })).toBe(`39.920°N`);
    expect(formatCoordinate(ANKARA, { hemispheres: "tr" })).toBe(`39°55'12.0"K 32°51'14.4"D`);
    expect(formatCoordinate([-58.38, -34.6], { hemispheres: "tr", format: "dd", decimals: 2 })).toBe(`34.60°G 58.38°B`);
    expect(formatCoordinate(ANKARA, { format: "mgrs" })).toBe(toMgrs(ANKARA));
    expect(formatCoordinate(ANKARA, { format: "utm" })).toBe(formatUtm(toUtm(ANKARA)));
  });

  it("yuvarlama taşması: 59,99…\" → bir üst dakika / derece", () => {
    expect(formatAngle(39.9999999, "lat")).toBe(`40°00'00.0"N`);
    expect(formatAngle(39.99999999, "lat", { format: "dm" })).toBe(`40°00.000'N`);
    expect(formatAngle(1.5 / 3600, "lat")).toBe(`0°00'01.5"N`);
  });

  it("serbest metin okuma: farklı yazımlar aynı noktaya", () => {
    const cases = [
      "39.92, 32.854",
      "39,92 32,854",
      "39.92 32.854",
      "39.92;32.854",
      "39.92N 32.854E",
      "32.854E 39.92N",
      "N39.92 E32.854",
      "K39.92 D32.854",
      `39°55'12"N 32°51'14.4"E`,
      `39°55′12″K, 32°51′14.4″D`,
      "39 55 12 N 32 51 14.4 E",
      "39 55 12 32 51 14.4",
      "39°55.2'N 32°51.24'E",
    ];
    for (const text of cases) {
      const p = parseCoordinate(text);
      expect(p, text).not.toBeNull();
      expect(distance(p!, ANKARA), text).toBeLessThan(0.5);
    }
  });

  it("işaret ve güney/batı", () => {
    expect(parseCoordinate("-34.6, -58.38")).toEqual([-58.38, -34.6]);
    expect(parseCoordinate("34.6S 58.38W")).toEqual([-58.38, -34.6]);
    expect(parseCoordinate("34.6G 58.38B")).toEqual([-58.38, -34.6]);
  });

  it("MGRS ve UTM metni de okunur", () => {
    expect(distance(parseCoordinate(toMgrs(ANKARA))!, ANKARA)).toBeLessThan(1.5);
    expect(distance(parseCoordinate(formatUtm(toUtm(ANKARA)))!, ANKARA)).toBeLessThan(1);
  });

  it("geçersiz girişler null", () => {
    for (const bad of ["", "merhaba", "95, 10", "10, 200", "39 61 0 N 32 0 0 E", "39N 40N", "39.92", "-39.92S 32E", "1 2 3"]) {
      expect(parseCoordinate(bad), bad).toBeNull();
    }
  });
});

describe("jeodezik", () => {
  it("bilinen yaylar: ekvatorda 1° boylam, meridyende 0–1° enlem", () => {
    expect(distance([0, 0], [1, 0])).toBeCloseTo(111_319.4908, 3);
    expect(distance([0, 0], [0, 1])).toBeCloseTo(110_574.3886, 3);
    expect(distance(ANKARA, [29.0, 41.0])).toBeCloseTo(distance([29.0, 41.0], ANKARA), 6);
  });

  it("yön ve hedef nokta tutarlı", () => {
    expect(bearing([0, 0], [0, 1])).toBeCloseTo(0, 9);
    expect(bearing([0, 0], [1, 0])).toBeCloseTo(90, 9);
    expect(bearing([0, 1], [0, 0])).toBeCloseTo(180, 9);
    const istanbul: LngLat = [29.0, 41.0];
    const there = destination(ANKARA, bearing(ANKARA, istanbul), distance(ANKARA, istanbul));
    expect(distance(there, istanbul)).toBeLessThan(1e-6);
    expect(destination([179.9, 0], 90, 50_000)[0]).toBeLessThan(-179); // tarih değiştirme çizgisi
  });

  it("çizgi uzunluğu = parçaların toplamı", () => {
    const line: LngLat[] = [[0, 0], [1, 0], [1, 1]];
    expect(lineLength(line)).toBeCloseTo(distance([0, 0], [1, 0]) + distance([1, 0], [1, 1]), 6);
  });

  it("alan: 1°×1° ekvator hücresi ≈ kenarların çarpımı; delik çıkarılır; kapalı/açık/yön önemsiz", () => {
    const cell: LngLat[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const area = polygonArea([cell]);
    expect(Math.abs(area / (111_319.49 * 110_574.39) - 1)).toBeLessThan(0.002);
    expect(polygonArea([[...cell, cell[0]!]])).toBeCloseTo(area, 0);
    expect(polygonArea([[...cell].reverse()])).toBeCloseTo(area, 0);
    const hole: LngLat[] = [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]];
    expect(polygonArea([cell, hole])).toBeCloseTo(area - polygonArea([hole]), 0);
    expect(polygonArea([[[0, 0], [1, 1]]])).toBe(0);
  });

  it("jeodezik daire: her köşe merkezden tam yarıçap uzaklıkta; kapalı halka", () => {
    const ring = geodesicCircle(ANKARA, 15_000, 32);
    expect(ring).toHaveLength(33);
    expect(ring[0]).toEqual(ring[32]);
    for (const p of ring) expect(distance(ANKARA, p)).toBeCloseTo(15_000, 6);
  });

  it("gösterim", () => {
    expect(formatDistance(850.4)).toBe("850 m");
    expect(formatDistance(12_400)).toBe("12,4 km");
    expect(formatArea(950)).toBe("950 m²");
    expect(formatArea(35_000)).toBe("3,5 ha");
    expect(formatArea(12_400_000)).toBe("12,4 km²");
  });
});
