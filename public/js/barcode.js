/**
 * Code 128 (Set B) barcode generator. Draws an SVG string. No external library.
 * Supports ASCII 32–126 (letters, digits, common punctuation).
 */
(function (global) {
  const PATTERNS = [
    "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
    "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
    "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
    "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
    "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
    "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
    "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
    "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
    "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
    "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
    "114131","311141","411131","211412","211214","211232"
  ];
  const STOP = "2331112";
  const START_B = 104;

  function encode(text) {
    const s = String(text == null ? "" : text);
    if (!s) throw new Error("空内容无法生成条码");
    const codes = [START_B];
    for (let i = 0; i < s.length; i++) {
      const cp = s.charCodeAt(i);
      if (cp < 32 || cp > 126) throw new Error("条码仅支持英文、数字和常见符号");
      codes.push(cp - 32);
    }
    let sum = START_B;
    for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
    codes.push(sum % 103);
    return codes;
  }

  function modules(codes) {
    let bits = "";
    for (const c of codes) bits += PATTERNS[c];
    bits += STOP;
    return bits;
  }

  function svg(text, opts) {
    opts = opts || {};
    const h = opts.height || 56;
    const scale = opts.scale || 2;
    const quiet = opts.quiet == null ? 10 : opts.quiet;
    const codes = encode(text);
    const widths = modules(codes);
    let total = 0;
    for (const ch of widths) total += Number(ch);
    const w = (total + quiet * 2) * scale;
    let x = quiet * scale;
    let bars = "";
    let bar = true; // patterns start with a bar
    for (const ch of widths) {
      const n = Number(ch) * scale;
      if (bar) bars += `<rect x="${x}" y="0" width="${n}" height="${h}" fill="#111"/>`;
      x += n;
      bar = !bar;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeAttr(text)}">${bars}</svg>`;
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  global.Code128 = { encode, svg };
})(typeof window !== "undefined" ? window : globalThis);
