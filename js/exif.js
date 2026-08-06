// exif.js — read the GPS fix a camera wrote into a JPEG.
// A photo of a place usually knows where it was taken; the field can file it.

export async function exifGPS(file) {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const view = new DataView(buf);
    if (view.getUint16(0) !== 0xFFD8) return null; // not a JPEG (HEIC etc. — no fix)

    // find the APP1/Exif segment
    let offset = 2;
    let tiff = -1;
    while (offset + 4 < view.byteLength) {
      const marker = view.getUint16(offset);
      const size = view.getUint16(offset + 2);
      if (marker === 0xFFE1 &&
          view.getUint32(offset + 4) === 0x45786966 /* "Exif" */) {
        tiff = offset + 10;
        break;
      }
      if ((marker & 0xFF00) !== 0xFF00) return null;
      offset += 2 + size;
    }
    if (tiff < 0) return null;

    const little = view.getUint16(tiff) === 0x4949;
    const u16 = o => view.getUint16(o, little);
    const u32 = o => view.getUint32(o, little);

    // IFD0 → GPS IFD pointer (tag 0x8825)
    const ifd0 = tiff + u32(tiff + 4);
    const n = u16(ifd0);
    let gps = -1;
    for (let i = 0; i < n; i++) {
      const e = ifd0 + 2 + i * 12;
      if (u16(e) === 0x8825) { gps = tiff + u32(e + 8); break; }
    }
    if (gps < 0) return null;

    const rational = (o) => u32(o) / (u32(o + 4) || 1);
    const dms = (valOffset) => rational(valOffset) + rational(valOffset + 8) / 60 + rational(valOffset + 16) / 3600;

    let latRef = 'N', lngRef = 'E', lat = null, lng = null;
    const gn = u16(gps);
    for (let i = 0; i < gn; i++) {
      const e = gps + 2 + i * 12;
      const tag = u16(e);
      if (tag === 0x0001) latRef = String.fromCharCode(view.getUint8(e + 8));
      if (tag === 0x0003) lngRef = String.fromCharCode(view.getUint8(e + 8));
      if (tag === 0x0002) lat = dms(tiff + u32(e + 8));
      if (tag === 0x0004) lng = dms(tiff + u32(e + 8));
    }
    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (latRef === 'S') lat = -lat;
    if (lngRef === 'W') lng = -lng;
    if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}
