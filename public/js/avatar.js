/*
 * PepeFrog procedural avatars — deterministic pixel-art frog creatures in Pepe's style.
 * One integer seed → one unique avatar (recolored frog + varied eyes / mouth / hat).
 * Used by the OBS heist overlay, the /sheet character page and PATV previews. Pure function, no deps.
 *
 *   pepeAvatarSVG(seed, size)        → an <svg> string (crisp pixels), size px square (11×11 grid).
 *   pepeAvatarSVG(seed, size, opts)  → same frog with cosmetic layers, opts = {hat, mask, outfit, prop, bg, frame}
 *                                      (each a layer id or absent; unknown ids ignored). With at least one valid
 *                                      layer the art is drawn on a 17×17 grid (frog centered, room for bg/frame/
 *                                      props/outfit). opts.hat replaces the seed's random hat.
 *   pepeAvatarLayers                 → {hat:[...], mask:[...], outfit:[...], prop:[...], bg:[...], frame:[...]}
 *
 * Layer order: bg, body (+ seed hat if no opts.hat), outfit, mask, hat, prop, frame.
 */
(function (global) {
  // mulberry32 — tiny deterministic PRNG
  function rng(seed) {
    let t = (seed >>> 0) || 1;
    return function () {
      t = (t + 0x6D2B79F5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hex(n) { return '#' + ((1 << 24) + n).toString(16).slice(1); }
  function mix(c, target, f) {                       // f in 0..1, blend c toward target
    const a = parseInt(c.slice(1), 16), b = parseInt(target.slice(1), 16);
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    const r = Math.round(ar + (br - ar) * f), g = Math.round(ag + (bg - ag) * f), bl = Math.round(ab + (bb - ab) * f);
    return hex((r << 16) | (g << 8) | bl);
  }
  const lighten = (c, f) => mix(c, '#ffffff', f);
  const darken = (c, f) => mix(c, '#000000', f);

  const BODY = ['#3AB54A', '#00AF3E', '#2F9E9E', '#3E7CFF', '#8E5BFF', '#FF6EC7',
                '#FF9F1C', '#E84855', '#F4B942', '#57CC99', '#7D8CC4', '#C77DFF',
                '#20A4F3', '#EF767A', '#6A994E', '#BC6C25'];
  const HAT = ['#E63946', '#1D3557', '#FFD700', '#2A9D8F', '#F4A261', '#457B9D', '#9B5DE5'];
  const MOUTH = '#8a0f1a';

  // 11×11 base frog silhouette (rows 2..10). '#' = body, '.' = empty.
  const SIL = [
    "...#####...",
    "..#######..",
    ".#########.",
    ".#########.",
    ".#########.",
    ".#########.",
    ".#########.",
    "..#######..",
    "...#...#..."
  ];
  const isBody = (y, x) => y >= 2 && y <= 10 && x >= 0 && x < 11 && SIL[y - 2][x] === '#';

  // The seed's random hat (rows 0-2, plus the shades variant over the eyes).
  function drawSeedHat(set, hatType, hatColor) {
    if (hatType === 1) {                              // cap
      for (let x = 2; x <= 8; x++) set(2, x, hatColor);
      for (let x = 3; x <= 7; x++) set(1, x, hatColor);
      set(2, 9, darken(hatColor, 0.2));
    } else if (hatType === 2) {                       // crown
      for (let x = 2; x <= 8; x++) set(2, x, '#FFD700');
      set(1, 2, '#FFD700'); set(1, 5, '#FFD700'); set(1, 8, '#FFD700');
      set(0, 5, '#FF3B6b');
    } else if (hatType === 3) {                       // top hat
      for (let x = 2; x <= 8; x++) set(2, x, '#111111');
      for (let x = 3; x <= 7; x++) for (let y = 0; y <= 1; y++) set(y, x, '#111111');
      for (let x = 3; x <= 7; x++) set(2, x, '#B01030');   // hatband
    } else if (hatType === 4) {                       // beanie
      for (let x = 2; x <= 8; x++) set(2, x, hatColor);
      for (let x = 2; x <= 8; x++) set(1, x, lighten(hatColor, 0.2));
      set(0, 5, lighten(hatColor, 0.4));
    } else if (hatType === 5) {                       // halo
      for (let x = 3; x <= 7; x++) set(0, x, '#FFE55C');
    } else if (hatType === 6) {                       // devil horns
      set(2, 1, '#C81D25'); set(1, 1, '#C81D25');
      set(2, 9, '#C81D25'); set(1, 9, '#C81D25');
    } else if (hatType === 7) {                       // shades (over the eyes)
      for (let x = 2; x <= 8; x++) set(4, x, '#111111');
      for (let x = 2; x <= 3; x++) set(5, x, '#111111');
      for (let x = 7; x <= 8; x++) set(5, x, '#111111');
    }
  }

  // Build the 11×11 frog grid for a seed. withHat=false leaves the seed hat off (caller draws it later).
  function buildFrog(seed, withHat) {
    const r = rng((seed | 0) || 1);
    const pick = a => a[Math.floor(r() * a.length)];
    const body = pick(BODY);
    const belly = lighten(body, 0.5);
    const outline = darken(body, 0.4);
    const eyeStyle = Math.floor(r() * 4);
    const mouthStyle = Math.floor(r() * 5);
    const hatType = Math.floor(r() * 8);            // 0 = no hat
    const pupilColor = pick(['#222222', '#222222', '#222222', '#2b7a2b', '#2b4a9a', '#7a2b2b']);
    const hatColor = pick(HAT);

    const N = 11;
    const G = Array.from({ length: N }, () => Array(N).fill(null));
    const set = (y, x, c) => { if (y >= 0 && y < N && x >= 0 && x < N) G[y][x] = c; };

    // body
    for (let y = 0; y < SIL.length; y++)
      for (let x = 0; x < N; x++)
        if (SIL[y][x] === '#') set(y + 2, x, body);
    // belly (lighter underside)
    for (let y = 8; y <= 9; y++) for (let x = 4; x <= 6; x++) if (G[y][x]) set(y, x, belly);

    // eyes — two 2×2 whites at rows 4-5, cols (2,3) and (7,8); pupil placed by style
    const eyes = [[4, 2], [4, 7]];
    const pupilOff = [[1, 0], [0, 0], [1, 1], [0, 1]][eyeStyle];   // down / up / down-right / up-right
    for (const [ey, ex] of eyes) {
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) set(ey + dy, ex + dx, '#ffffff');
      if (eyeStyle === 3) {                          // angry: brow shades top row
        set(ey, ex, outline); set(ey, ex + 1, outline);
      }
      set(ey + pupilOff[0], ex + pupilOff[1], pupilColor);
    }

    // mouth — row 8, cols 3..7
    const my = 8;
    const mouth = MOUTH;
    if (mouthStyle === 0) { for (let x = 3; x <= 7; x++) set(my, x, mouth); }         // flat
    else if (mouthStyle === 1) { for (let x = 3; x <= 7; x++) set(my, x, mouth); set(my + 1, 3, mouth); set(my + 1, 7, mouth); }  // frown-up smile
    else if (mouthStyle === 2) { for (let x = 3; x <= 7; x++) set(my, x, mouth); for (let x = 4; x <= 6; x++) set(my + 1, x, darken(mouth, 0.3)); } // open
    else if (mouthStyle === 3) { for (let x = 4; x <= 7; x++) set(my, x, mouth); }    // smirk (offset)
    else { for (let x = 3; x <= 7; x++) set(my, x, mouth); set(my - 1, 3, mouth); set(my - 1, 7, mouth); }  // grin corners up

    // hat / accessory (rows 0-2)
    if (withHat) drawSeedHat(set, hatType, hatColor);

    return { G, body, belly, outline, eyeStyle, mouthStyle, hatType, hatColor, pupilColor };
  }

  // ---------------------------------------------------------------------------------------------
  // Cosmetic layers. Frog-relative painters get P(y, x, c) in the 11×11 frog coords (may go
  // outside it: rows -1..13, cols -2..13); absolute painters get A(y, x, c) on the 17×17 canvas.
  // ---------------------------------------------------------------------------------------------
  const S = 17, OX = 3, OY = 2;        // canvas size; frog cell (0,0) sits at canvas (OY, OX)
  const isMouth = c => c === MOUTH || c === darken(MOUTH, 0.3);

  // Torso (shoulders) drawn under the frog's chin for outfits: rows 10..13 rel.
  function torso(P, fill) {
    for (let x = 2; x <= 8; x++) P(10, x, fill(10, x));
    for (let y = 11; y <= 13; y++) for (let x = 1; x <= 9; x++) P(y, x, fill(y, x));
  }

  const HATS = {
    crown(P) {
      const g = '#FFD700', d = '#C9A100';
      for (let x = 2; x <= 8; x++) { P(2, x, d); P(1, x, g); }
      for (const x of [2, 5, 8]) P(0, x, g);
      P(-1, 5, g);
      P(1, 3, '#E63946'); P(1, 5, '#3E7CFF'); P(1, 7, '#E63946');
      P(0, 5, '#FFF3A0');
    },
    tophat(P) {
      const k = '#111111', h = '#2b2b2b';
      for (let x = 1; x <= 9; x++) P(2, x, k);
      for (let y = -1; y <= 1; y++) for (let x = 3; x <= 7; x++) P(y, x, k);
      for (let y = -1; y <= 1; y++) P(y, 3, h);
      for (let x = 3; x <= 7; x++) P(1, x, '#B01030');
    },
    cowboy(P) {
      const b = '#8B5A2B', d = '#5E3A17', l = '#A9713A';
      for (let x = 0; x <= 10; x++) P(2, x, b);
      P(1, 0, b); P(1, 10, b);
      for (let x = 3; x <= 7; x++) { P(1, x, d); P(0, x, b); }
      P(-1, 3, b); P(-1, 4, l); P(-1, 6, l); P(-1, 7, b);
      P(0, 5, d);
      P(1, 1, b); P(1, 9, b);
    },
    beanie(P) {
      const c = '#E63946', s = '#F1FAEE', cuff = '#B5202C';
      for (let x = 2; x <= 8; x++) P(2, x, cuff);
      for (let x = 2; x <= 8; x++) P(1, x, x % 2 ? s : c);
      for (let x = 3; x <= 7; x++) P(0, x, c);
      P(-1, 5, s); P(-1, 4, '#dddddd'); P(-1, 6, '#dddddd');
    },
    halo(P) {
      const g = '#FFE55C', l = '#FFF7B8';
      for (let x = 4; x <= 6; x++) { P(-1, x, l); P(1, x, g); }
      P(0, 3, g); P(0, 7, g);
      P(-1, 3, g); P(1, 3, g); P(1, 7, g); P(-1, 7, g);
      P(0, 2, g); P(0, 8, g);
    },
    horns(P) {
      const r = '#C81D25', d = '#7A0E14', t = '#F2E8CF';
      P(2, 2, r); P(1, 2, r); P(1, 1, r); P(0, 1, d); P(-1, 1, t);
      P(2, 8, r); P(1, 8, r); P(1, 9, r); P(0, 9, d); P(-1, 9, t);
    },
    party(P) {
      const a = '#FF4FA3', b = '#2EC4F1', y = '#FFE14D';
      P(-1, 6, y);
      P(0, 5, a);
      P(1, 4, b); P(1, 5, b); P(1, 6, a);
      for (let x = 3; x <= 7; x++) P(2, x, x % 2 ? a : y);
    },
    chef(P) {
      const w = '#FFFFFF', s = '#DADDE2', band = '#C9CED6';
      for (const x of [3, 4, 6, 7]) P(-1, x, w);
      P(-1, 5, s);
      for (let x = 2; x <= 8; x++) { P(0, x, w); P(1, x, w); }
      P(0, 2, s); P(1, 2, s); P(1, 5, s);
      for (let x = 3; x <= 7; x++) P(2, x, band);
    },
    viking(P) {
      const m = '#9AA4B1', d = '#66707D', l = '#C8D0DA', ivory = '#F2E8CF', iv2 = '#CDBF9F';
      for (let x = 2; x <= 8; x++) P(2, x, d);
      for (let x = 2; x <= 8; x++) P(1, x, m);
      for (let x = 3; x <= 7; x++) P(0, x, m);
      P(0, 4, l); P(1, 3, l);
      for (const x of [3, 5, 7]) P(2, x, '#E0B84A');
      P(3, 5, d);                                     // nose guard
      P(2, 1, ivory); P(1, 0, ivory); P(0, 0, iv2); P(-1, 0, ivory);
      P(2, 9, ivory); P(1, 10, ivory); P(0, 10, iv2); P(-1, 10, ivory);
    },
    pirate(P) {
      const k = '#151515', h = '#2a2a2a', gold = '#E0B84A';
      for (let x = 1; x <= 9; x++) P(2, x, gold);
      P(1, 0, k); P(1, 10, k);
      for (let x = 1; x <= 9; x++) P(1, x, k);
      for (let x = 2; x <= 8; x++) P(0, x, k);
      for (let x = 3; x <= 7; x++) P(-1, x, h);
      P(0, 5, '#FFFFFF'); P(1, 4, '#FFFFFF'); P(1, 6, '#FFFFFF');   // skull + bones
    },
    // ── 1.99c: drag / camp / pride / cute / kink ──
    beehive(P) {
      const h = '#FF8FCB', l = '#FFC4E3', d = '#D9579E', band = '#B03A7E';
      for (let x = 4; x <= 6; x++) P(-2, x, h);
      for (let x = 3; x <= 7; x++) { P(-1, x, h); P(0, x, h); }
      for (let x = 2; x <= 8; x++) P(1, x, h);
      P(-2, 4, l); P(-1, 4, l); P(0, 3, l); P(1, 3, l);             // shine
      P(0, 7, d); P(1, 8, d); P(-1, 7, d);
      P(2, 1, d); P(2, 9, d); P(3, 1, h); P(3, 9, h); P(4, 0, d); P(4, 10, d);   // flipped ends
      for (let x = 2; x <= 8; x++) P(2, x, band);
      P(2, 3, '#9BE7FF'); P(2, 5, '#FFFFFF'); P(2, 7, '#9BE7FF');  // rhinestone band
    },
    tiara(P) {
      const s = '#E3E9F1', d = '#9AA4B1', p = '#FF4FA3', b = '#7FDBFF', w = '#FFFFFF';
      for (let x = 2; x <= 8; x++) P(2, x, d);
      for (const x of [2, 4, 5, 6, 8]) P(1, x, s);
      P(0, 4, s); P(0, 6, s); P(0, 5, p); P(-1, 5, w);
      P(2, 3, b); P(2, 5, p); P(2, 7, b);
      P(0, 1, w); P(-1, 9, w);                                      // twinkles
    },
    rainbowwig(P) {
      const R = ['#E40303', '#FF8C00', '#FFED00', '#008026', '#004DFF', '#750787'];
      for (let x = 3; x <= 7; x++) P(-2, x, R[0]);
      for (let x = 2; x <= 8; x++) P(-1, x, R[1]);
      for (let x = 1; x <= 9; x++) P(0, x, R[2]);
      for (let x = 0; x <= 10; x++) { P(1, x, R[3]); P(2, x, R[4]); }
      for (const x of [0, 1, 9, 10]) P(3, x, R[5]);
      P(4, 0, R[5]); P(4, 10, R[5]); P(5, 0, R[4]); P(5, 10, R[4]);
      P(-1, 4, '#FFB347'); P(0, 3, '#FFF59D');                      // shine
    },
    muir(P) {
      const k = '#151515', h = '#303030', c = '#C0C4CC', cd = '#7D838C';
      for (let x = 3; x <= 7; x++) P(-1, x, h);
      for (let x = 2; x <= 8; x++) { P(0, x, k); P(1, x, x % 2 ? c : cd); }
      P(0, 3, h); P(-1, 4, '#4A4A4A');
      P(0, 5, '#E0B84A');                                           // cap badge
      for (let x = 1; x <= 9; x++) P(2, x, '#0A0A0A');              // short visor
      P(2, 3, '#262626'); P(2, 4, '#262626');
    },
    bow(P) {
      const p = '#FF6EB4', l = '#FFB3D9', d = '#D81B78';
      for (const x of [1, 2, 8, 9]) P(-1, x, p);
      for (const x of [1, 2, 3, 7, 8, 9]) { P(0, x, p); P(2, x, p); }
      for (const x of [1, 2, 3, 4, 6, 7, 8, 9]) P(1, x, p);
      P(0, 2, l); P(0, 8, l); P(-1, 2, l); P(-1, 8, l);
      P(1, 5, d); P(0, 5, d); P(2, 5, d);                           // knot
      P(1, 4, d); P(1, 6, d);
    },
    catears(P) {
      const o = '#3A3A3A', i = '#FF9EC4';
      P(-1, 2, o); P(0, 2, o); P(0, 3, o); P(1, 2, o); P(1, 3, i); P(1, 4, o);
      P(-1, 8, o); P(0, 8, o); P(0, 7, o); P(1, 8, o); P(1, 7, i); P(1, 6, o);
      for (let x = 2; x <= 8; x++) P(2, x, o);
      P(2, 3, i); P(2, 7, i);
    },
    bunny(P) {
      const w = '#FAFAFA', s = '#DCDCE4', p = '#FFB3C6';
      for (const ex of [3, 7]) {
        P(-2, ex, w);
        for (let y = -1; y <= 1; y++) { P(y, ex - 1, y === 1 ? s : w); P(y, ex, p); P(y, ex + 1, s); }
      }
      for (let x = 2; x <= 8; x++) P(2, x, p);
      P(2, 5, '#FF6EB4');
    },
    flowercrown(P) {
      const leaf = '#4CAF50', dl = '#2E7D32', mid = '#FFE14D';
      const fl = { 2: '#FF8FB8', 5: '#B39DDB', 8: '#FFB38A' };
      for (let x = 1; x <= 9; x++) P(2, x, x % 2 ? leaf : dl);
      for (const x of [2, 5, 8]) {
        const c = fl[x];
        P(0, x, c); P(1, x - 1, c); P(1, x + 1, c); P(2, x, c); P(1, x, mid);
      }
      P(2, 0, leaf); P(2, 10, leaf);
    }
  };

  const MASKS = {
    balaclava(P, f) {
      const k1 = '#1E1E24', k2 = '#2C2C35';
      for (let y = 1; y <= 9; y++) for (let x = 0; x <= 10; x++) {
        const inHead = isBody(y, x) || (y === 1 && x >= 4 && x <= 6);
        if (!inHead) continue;
        if (y >= 4 && y <= 5 && x >= 2 && x <= 8) continue;        // eye slot
        if (isMouth(f.G[y][x])) continue;                           // mouth hole
        P(y, x, (x + y) % 2 ? k1 : k2);
      }
      for (let x = 2; x <= 8; x++) { if (!f.G[4][x] || f.G[4][x] === f.body || f.G[4][x] === f.outline) P(4, x, f.body); }
    },
    domino(P, f) {
      const k = '#141414';
      for (let y = 4; y <= 5; y++) for (let x = 1; x <= 9; x++) {
        const c = f.G[y][x];
        if (c === '#ffffff' || c === f.pupilColor) continue;
        P(y, x, k);
      }
      for (const x of [2, 3, 7, 8]) P(3, x, k);
      P(6, 1, k); P(6, 9, k);
    },
    sunglasses(P) {
      const k = '#0D0D0D', g = '#3A3F4B';
      for (let x = 1; x <= 9; x++) P(4, x, k);
      for (const ex of [2, 7]) {
        P(4, ex, k); P(4, ex + 1, k); P(5, ex, k); P(5, ex + 1, k);
        P(4, ex, '#5B6273'); P(5, ex + 1, g);
      }
      P(4, 0, k); P(4, 10, k);
    },
    monocle(P) {
      const g = '#E0B84A', d = '#9C7A1C';
      P(3, 7, g); P(3, 8, g);
      P(4, 6, g); P(5, 6, g); P(4, 9, g); P(5, 9, g);
      P(6, 7, g); P(6, 8, g);
      P(7, 9, d); P(8, 10, d); P(9, 10, d); P(10, 10, d);  // chain
      P(4, 4, '#3a3a3a'); P(4, 3, '#3a3a3a');             // stern brow over the other eye
    },
    eyepatch(P) {
      const k = '#111111';
      P(4, 2, k); P(4, 3, k); P(5, 2, k); P(5, 3, k); P(6, 2, k); P(6, 3, '#2a2a2a');
      P(3, 1, k); P(3, 4, k); P(2, 5, k); P(2, 6, k); P(2, 7, k); P(3, 8, k); P(3, 9, k);
      P(4, 1, k);
    },
    bandana(P, f) {
      const r = '#C1121F', d = '#8E0D17', w = '#FFF1F1';
      for (let y = 6; y <= 9; y++) for (let x = 0; x <= 10; x++) if (isBody(y, x)) P(y, x, r);
      for (let x = 1; x <= 9; x++) P(6, x, d);
      for (let x = 4; x <= 6; x++) P(10, x, r);
      P(11, 5, d);
      P(7, 3, w); P(8, 6, w); P(7, 8, w); P(9, 4, w); P(10, 5, w);
      P(6, 0, d); P(7, 0, r); P(6, 10, d);              // knot tails
    },
    lashes(P, f) {                                      // full beat: shadow, lashes, lips, blush
      const sh = '#B04CE0', sl = '#E0A3FF', k = '#111111';
      P(3, 2, sh); P(3, 3, sl); P(3, 7, sl); P(3, 8, sh);
      P(4, 1, k); P(3, 0, k); P(3, 1, k); P(4, 9, k); P(3, 10, k); P(3, 9, k);   // winged lashes
      for (let y = 6; y <= 10; y++) for (let x = 0; x <= 10; x++) {
        const c = f.G[y] && f.G[y][x];
        if (isMouth(c)) P(y, x, c === MOUTH ? '#E0115F' : '#A0003A');
      }
      P(6, 2, '#FF8FB8'); P(6, 8, '#FF8FB8');
      P(7, 9, '#3A1A1A');                               // beauty mark
    },
    puphood(P, f) {
      const k = '#1A1A1A', k2 = '#242424', a = '#1E88E5', m = '#3A3A3A';
      for (let y = 2; y <= 9; y++) for (let x = 0; x <= 10; x++) {
        if (!isBody(y, x)) continue;
        const c = f.G[y][x];
        if (y >= 4 && y <= 5 && (c === '#ffffff' || c === f.pupilColor)) continue;   // eyes show
        const edge = !isBody(y, x - 1) || !isBody(y, x + 1) || !isBody(y - 1, x);
        P(y, x, edge ? '#4A4F58' : (x + y) % 2 ? k : k2);
      }
      for (const ex of [2, 7]) { P(3, ex, a); P(3, ex + 1, a); }   // brow trim
      P(2, 5, a);
      for (let x = 4; x <= 6; x++) { P(7, x, m); P(9, x, m); }     // muzzle
      for (let x = 3; x <= 7; x++) P(8, x, m);
      P(7, 5, '#050505'); P(9, 5, '#050505');
      P(0, 2, k); P(1, 2, k); P(1, 3, a); P(2, 2, k);              // ears
      P(0, 8, k); P(1, 8, k); P(1, 7, a); P(2, 8, k);
    },
    heartshades(P) {
      const r = '#FF2D87', l = '#FF8AC4', g = '#FFE0EF';
      for (const bx of [0, 6]) {
        P(3, bx + 1, r); P(3, bx + 3, r);
        for (let x = bx; x <= bx + 4; x++) P(4, x, r);
        for (let x = bx + 1; x <= bx + 3; x++) P(5, x, r);
        P(6, bx + 2, r);
        P(4, bx + 1, g); P(4, bx + 2, l); P(4, bx + 3, l); P(5, bx + 2, l);
      }
      P(4, 5, '#C2185B');                               // bridge
    }
  };

  const OUTFITS = {
    suit(P) {
      const c = '#2B2D42', l = '#3B3E5A', w = '#F5F5F5', t = '#C1121F';
      torso(P, (y, x) => (x === 2 || x === 8) && y >= 11 ? l : c);
      P(10, 4, w); P(10, 6, w); P(11, 4, w); P(11, 6, w);
      for (let y = 10; y <= 13; y++) P(y, 5, t);
      P(10, 5, '#8E0D17');
      P(12, 3, '#555a78'); P(13, 3, '#555a78');
    },
    hoodie(P, f) {
      const c = '#5F6B7A', d = '#46505C', l = '#7D8998';
      for (let x = 3; x <= 7; x++) P(1, x, c);
      P(2, 2, c); P(2, 8, c); for (let x = 3; x <= 7; x++) P(2, x, l);
      P(3, 1, c); P(3, 9, c);
      for (let y = 4; y <= 9; y++) { P(y, 0, c); P(y, 10, c); }
      torso(P, (y, x) => (y === 13 && x >= 3 && x <= 7) ? d : c);
      P(10, 4, '#FFFFFF'); P(11, 4, '#FFFFFF'); P(10, 6, '#FFFFFF'); P(11, 6, '#FFFFFF');
    },
    prison(P) {
      const o = '#111111', w = '#F2F2F2';
      torso(P, (y) => (y % 2 === 0 ? o : w));
      P(12, 3, '#E85D04'); P(12, 4, '#E85D04');      // inmate number patch
    },
    tuxedo(P) {
      const k = '#0E0E12', w = '#FFFFFF';
      torso(P, () => k);
      for (let y = 11; y <= 13; y++) for (let x = 4; x <= 6; x++) P(y, x, w);
      P(10, 4, k); P(10, 6, k); P(10, 5, '#2a2a2a');                      // bow tie
      P(10, 3, w); P(10, 7, w);
      P(12, 5, '#222222'); P(13, 5, '#222222');                           // studs
    },
    goldchain(P, f) {
      const g = '#FFD23F', d = '#C9A100';
      torso(P, (y, x) => (x >= 4 && x <= 6 ? f.belly : f.body));
      P(9, 2, g); P(10, 3, d); P(11, 3, g); P(12, 4, d);
      P(9, 8, g); P(10, 7, d); P(11, 7, g); P(12, 6, d);
      P(12, 5, g); P(13, 5, g); P(13, 4, d); P(13, 6, d);                // medallion
    },
    bandolier(P, f) {
      const s = '#3B2414', b = '#F2C14E', shirt = '#5A6B2F';
      torso(P, (y, x) => (x >= 4 && x <= 6 ? lighten(shirt, 0.15) : shirt));
      const strap = [[10, 2], [10, 3], [11, 3], [11, 4], [12, 5], [12, 6], [13, 7], [13, 8]];
      strap.forEach(([y, x], i) => P(y, x, i % 2 ? b : s));
      P(9, 1, s); P(9, 2, s);
    },
    sequin(P, f) {                                      // strapless sequin gown
      const a = '#B0157A', b = '#D6249A', w = '#FFFFFF', l = '#FF9BE6';
      torso(P, (y, x) => {
        if (y === 10 && x >= 4 && x <= 6) return f.belly;
        if ((x * 3 + y * 5) % 7 === 0) return w;
        if ((x * 5 + y * 3) % 6 === 0) return l;
        return (x <= 2 || x >= 8) ? a : b;
      });
    },
    boa(P, f) {                                         // little black dress + feather boa
      const dress = '#1C1C24', d2 = '#2C2C3A';
      torso(P, (y, x) => (y === 10 && x >= 3 && x <= 7) ? f.belly : (x + y) % 5 === 0 ? d2 : dress);
      const fz = ['#FF6EC7', '#FF9ED8', '#E0479E'];
      const pts = [[8, 0], [9, 0], [9, 1], [10, 1], [10, 2], [11, 1], [11, 2], [12, 1], [12, 2], [13, 1], [13, 2],
                   [10, 3], [11, 3], [11, 4], [11, 5], [11, 6], [11, 7], [10, 7],
                   [8, 10], [9, 10], [9, 9], [10, 9], [10, 8], [11, 9], [11, 8], [12, 9], [12, 8], [13, 9], [13, 8]];
      pts.forEach(([y, x]) => P(y, x, fz[(x * 2 + y) % 3]));
    },
    harness(P, f) {
      const k = '#121212', s = '#C8CDD5';
      torso(P, (y, x) => (x >= 4 && x <= 6 ? f.belly : f.body));
      for (const [y, x] of [[10, 2], [10, 3], [11, 3], [11, 4], [12, 4], [12, 6], [11, 6], [11, 7], [10, 7], [10, 8]]) P(y, x, k);
      for (let x = 1; x <= 9; x++) P(13, x, k);
      P(12, 5, s); P(13, 5, s); P(13, 2, s); P(13, 8, s);         // O-ring, buckle, studs
    },
    collar(P, f) {
      const k = '#151515', s = '#D0D5DD';
      torso(P, (y, x) => (x >= 4 && x <= 6 ? f.belly : f.body));
      for (let x = 2; x <= 8; x++) P(10, x, k);
      for (const x of [3, 5, 7]) P(10, x, s);
      P(11, 4, s); P(11, 6, s); P(12, 5, s);                       // D-ring
    },
    latex(P) {                                          // glossy vinyl catsuit
      const k = '#0A0A0E', h = '#4A4D5C', w = '#C8CEDB', z = '#8A909C';
      torso(P, () => k);
      P(10, 3, h); P(11, 2, w); P(12, 2, h); P(13, 2, h);
      P(11, 8, h); P(12, 8, w); P(13, 8, h);
      for (let y = 10; y <= 13; y++) P(y, 5, z);
      P(10, 5, '#EDEDED');                              // zip pull
    },
    sundress(P, f) {
      const d = '#FFD1DC', hem = '#F7A8BE', st = '#FF8FB8', w = '#FFFFFF';
      torso(P, (y, x) => y === 10 ? (x >= 4 && x <= 6 ? f.belly : f.body) : y === 13 ? hem : ((x + y * 2) % 4 === 0 ? w : d));
      P(10, 3, st); P(10, 7, st);                       // straps
      P(11, 5, st);                                     // little bow
    },
    cardigan(P) {
      const c = '#B39DDB', c2 = '#C5B3E6', d = '#9575CD', t = '#FAFAFA';
      torso(P, (y, x) => (x >= 4 && x <= 6) ? t : (x === 3 || x === 7) ? d : (x + y) % 2 ? c : c2);
      P(11, 3, '#FFFFFF'); P(13, 3, '#FFFFFF');         // buttons
      P(12, 2, d);                                      // pocket
    },
    pridecape(P) {
      const R = ['#E40303', '#FF8C00', '#FFED00', '#008026', '#004DFF', '#750787'];
      const band = (y) => R[Math.min(5, Math.floor((y - 6) * 6 / 8))];
      for (let y = 6; y <= 13; y++) { P(y, 0, band(y)); P(y, 10, band(y)); }
      for (let y = 9; y <= 13; y++) { P(y, -1, band(y)); P(y, 11, band(y)); }
      torso(P, (y, x) => (x <= 1 || x >= 9) ? band(y) : '#F5F5F5');
      P(10, 2, '#FFD23F'); P(10, 8, '#FFD23F');         // clasps
      for (const [y, x] of [[11, 4], [11, 6], [12, 4], [12, 5], [12, 6], [13, 5]]) P(y, x, '#E8336B');   // heart on the tee
    }
  };

  // Props, absolute canvas coords (frog body spans cols 4..12, rows 4..12; right side free = cols 13..15).
  const PROPS = {
    cigar(A, P) {
      P(8, 8, '#8B5A2B'); P(8, 9, '#7A4A1E'); P(8, 10, '#8B5A2B'); P(8, 11, '#F2E8CF');
      P(8, 12, '#FF5A1F');
      P(7, 12, '#BFC3C9'); P(6, 11, '#9AA0A8'); P(5, 12, '#BFC3C9'); P(4, 11, '#9AA0A8');
    },
    moneybag(A, P, f) {
      const t = '#C8A96A', d = '#9C7F45', g = '#2E7D32';
      A(9, 12, d); A(9, 14, d); A(9, 13, t);                      // tufts
      A(10, 13, '#5E3A17');                                       // tie
      for (let x = 12; x <= 14; x++) A(11, x, t);
      for (let y = 12; y <= 15; y++) for (let x = 11; x <= 15; x++) A(y, x, t);
      A(12, 11, null); A(12, 15, d); A(15, 11, d); A(15, 15, d); A(13, 15, d); A(14, 15, d);
      A(12, 13, g); A(13, 12, g); A(13, 13, g); A(14, 13, g); A(14, 14, g); A(15, 13, g);   // $
    },
    crowbar(A, P, f) {
      const r = '#D62828', d = '#9D0208', m = '#C0C4CC';
      A(11, 13, f.body);                                         // hand
      A(3, 13, r); A(3, 14, r); A(4, 12, r); A(5, 12, d);        // hooked end
      for (let y = 4; y <= 14; y++) A(y, 14, y % 4 === 0 ? d : r);
      A(4, 15, '#FF6B6B');                                       // shine
      A(15, 14, m); A(15, 15, m);                                // flat claw
    },
    briefcase(A, P, f) {
      const b = '#6B3E1F', l = '#8B5A2B', g = '#E0B84A';
      A(10, 13, '#2a1a0e'); A(10, 14, '#2a1a0e');
      A(11, 12, '#2a1a0e'); A(11, 15, '#2a1a0e');
      for (let y = 12; y <= 15; y++) for (let x = 11; x <= 15; x++) A(y, x, y === 12 ? l : b);
      A(13, 13, g); A(13, 12, g); A(13, 14, g);
      A(9, 13, f.body); A(9, 14, f.body);                        // hand
    },
    rose(A, P, f) {
      const r = '#E5383B', d = '#A4161A', l = '#FF758F', g = '#2D6A4F', g2 = '#52B788';
      A(5, 13, r); A(5, 14, l); A(5, 15, r);
      A(6, 13, d); A(6, 14, r); A(6, 15, d);
      A(4, 14, r);
      for (let y = 7; y <= 14; y++) A(y, 14, g);
      A(11, 15, g2); A(12, 13, g2);
      A(10, 13, f.body);                                         // hand
    },
    dice(A) {
      const w = '#FAFAFA', e = '#BDBDBD', k = '#111111', r = '#D62828', rw = '#FFFFFF';
      for (let y = 13; y <= 15; y++) for (let x = 11; x <= 13; x++) A(y, x, w);
      A(13, 11, k); A(14, 12, k); A(15, 13, k); A(15, 11, e); A(13, 13, e);
      for (let y = 10; y <= 12; y++) for (let x = 13; x <= 15; x++) A(y, x, r);
      A(13, 14, '#8E0D17'); A(13, 15, '#8E0D17');                 // shadow
      A(10, 13, rw); A(10, 15, rw); A(11, 14, rw); A(12, 13, rw); A(12, 15, rw);
    },
    prideflag(A, P, f) {                                // rainbow flag on a pole, waving
      const R = ['#E40303', '#FF8C00', '#FFED00', '#008026', '#004DFF', '#750787'];
      for (let y = 2; y <= 15; y++) A(y, 13, '#D7CCC8');
      A(1, 13, '#FFD23F');
      for (let i = 0; i < 6; i++) { A(3 + i, 14, R[i]); A(3 + i, 15, R[i]); A(4 + i, 16, R[i]); }
      A(11, 13, f.body);                                // hand
    },
    discoball(A) {
      const c = ['#F5F5F5', '#A7AFBA', '#DCE3EA', '#7E8794', '#BFEFFF', '#FFFFFF'];
      for (let y = 0; y <= 2; y++) A(y, 14, '#8A8F98');  // string
      const rows = { 3: [13, 15], 4: [12, 16], 5: [12, 16], 6: [12, 16], 7: [13, 15] };
      for (const y in rows) for (let x = rows[y][0]; x <= rows[y][1]; x++) A(+y, x, c[(x * 3 + y * 2) % c.length]);
      A(4, 13, '#FFFFFF'); A(3, 13, '#FFFFFF');
      A(2, 11, '#FFF59D'); A(9, 16, '#FF8BF0'); A(9, 11, '#9BE7FF'); A(1, 16, '#FFFFFF');   // glints
    },
    flamingo(A) {
      const p = '#FF6FAE', d = '#D94C8A', l = '#FF9ECB', k = '#222222';
      A(5, 14, p); A(5, 15, p); A(5, 16, '#F5F5F5'); A(6, 16, k);  // head + beak
      A(4, 14, l); A(5, 15, k);                                    // eye
      A(6, 14, p); A(7, 13, p); A(8, 13, p); A(9, 14, p);         // S-neck
      for (let x = 14; x <= 16; x++) A(10, x, p);
      for (let x = 13; x <= 16; x++) A(11, x, p);
      A(10, 15, d); A(11, 15, d); A(11, 16, d); A(10, 14, l);
      for (let y = 12; y <= 15; y++) A(y, 15, '#E06A9A');          // leg
      A(13, 14, '#E06A9A'); A(15, 16, '#E06A9A');
    },
    fan(A, P, f) {                                      // folding fan, ready to clack
      const p = '#FF4FA3', l = '#FFB3D9', r = '#B0126A';
      for (let x = 12; x <= 16; x++) A(6, x, l);
      for (let x = 12; x <= 16; x++) A(7, x, p);
      for (let x = 13; x <= 15; x++) A(8, x, p);
      A(9, 14, p);
      A(7, 13, r); A(7, 15, r); A(8, 14, r);            // ribs
      A(6, 12, '#FFFFFF'); A(6, 16, '#FFFFFF');
      A(10, 14, '#6A0B3E');                             // pivot
      A(11, 14, f.body); A(11, 13, f.body);             // hand
    },
    cuffs(A) {                                          // fuzzy pink handcuffs
      const a = '#FF7AC0', b = '#FFB3DE', s = '#C0C4CC';
      const ring = (cy, cx) => { for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) if (y !== cy || x !== cx) A(y, x, (x + y) % 2 ? a : b); };
      ring(11, 13); ring(14, 15);
      A(12, 15, s); A(13, 14, s);                       // chain
    },
    crop(A, P, f) {                                     // riding crop
      const k = '#1A1A1A', h = '#5D2E1A', r = '#B71C1C', sh = '#8B5A3C', s = '#C0C4CC';
      A(2, 14, k); A(2, 15, k); A(3, 14, k); A(3, 15, '#4A4A4A'); A(1, 15, '#4A4A4A');  // keeper flap
      A(4, 14, s);                                      // ferrule
      for (let y = 5; y <= 11; y++) A(y, 14, sh);
      for (let y = 12; y <= 15; y++) A(y, 14, y % 2 ? r : h);      // wrapped grip
      A(15, 14, '#C0C4CC');
      A(12, 13, f.body);                                // hand
    },
    boba(A, P, f) {
      const lid = '#FFFFFF', tea = '#D7A86E', tl = '#E8C79A', pearl = '#3E2723';
      A(7, 15, '#FF6EB4'); A(8, 14, '#FF6EB4'); A(9, 14, '#FF6EB4');   // straw
      for (let x = 12; x <= 15; x++) A(10, x, lid);
      for (let y = 11; y <= 15; y++) for (let x = 12; x <= 15; x++) A(y, x, x === 12 && y <= 13 ? tl : tea);
      for (const [y, x] of [[14, 12], [14, 14], [15, 13], [15, 15], [13, 15], [15, 12]]) A(y, x, pearl);
      A(12, 11, f.body);                                // hand
    },
    strawberry(A) {
      const r = '#E53935', l = '#FF7961', g = '#43A047', dg = '#2E7D32', s = '#FFE082';
      A(9, 14, dg); A(10, 13, g); A(10, 14, dg); A(10, 15, g);
      for (let x = 12; x <= 16; x++) { A(11, x, r); A(12, x, r); }
      for (let x = 13; x <= 15; x++) A(13, x, r);
      A(14, 14, r);
      A(11, 12, l); A(12, 12, l);
      A(11, 14, s); A(12, 13, s); A(12, 15, s); A(13, 14, s); A(11, 16, s);
    },
    plushie(A) {                                        // bunny plushie
      const w = '#FFE4EE', s = '#F0AFC8', p = '#FF8FB8', k = '#222222';
      A(7, 13, w); A(8, 13, w); A(7, 15, w); A(8, 15, w); A(8, 14, null);
      A(9, 13, p); A(9, 15, p);                         // inner ears
      for (let x = 13; x <= 15; x++) A(10, x, w);
      for (let x = 12; x <= 16; x++) { A(11, x, w); A(12, x, w); }
      A(11, 13, k); A(11, 15, k); A(12, 14, p);         // face
      for (let y = 13; y <= 15; y++) for (let x = 13; x <= 15; x++) A(y, x, w);
      A(14, 14, '#FF6EB4');                             // heart patch
      A(15, 12, s); A(15, 16, s); A(13, 12, s); A(13, 16, s);   // paws
    }
  };

  // Pride flags as backgrounds: horizontal stripes with a gentle wave; progress / intersex-inclusive
  // add the chevron at the hoist (left edge, the part the frog doesn't cover).
  const RAINBOW = ['#E40303', '#FF8C00', '#FFED00', '#008026', '#004DFF', '#750787'];
  const FLAGS = {
    trans: ['#5BCEFA', '#F5A9B8', '#FFFFFF', '#F5A9B8', '#5BCEFA'],
    bi: ['#D60270', '#D60270', '#9B4F96', '#0038A8', '#0038A8'],
    lesbian: ['#D52D00', '#FF9A56', '#FFFFFF', '#D362A4', '#A30262'],
    pan: ['#FF218C', '#FFD800', '#21B1FF'],
    enby: ['#FCF434', '#FFFFFF', '#9C59D1', '#2C2C2C'],
    ace: ['#000000', '#A3A3A3', '#FFFFFF', '#800080'],
    aro: ['#3DA542', '#A7D379', '#FFFFFF', '#A9A9A9', '#000000'],
    genderfluid: ['#FF76A4', '#FFFFFF', '#C011D7', '#000000', '#2F3CBE'],
  };
  function flagBg(B, stripes) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const yy = Math.min(S - 1, Math.max(0, y + Math.round(Math.sin(x * 0.55) * 0.9)));
      let c = stripes[Math.min(stripes.length - 1, Math.floor(yy * stripes.length / S))];
      if (Math.cos(x * 0.55) < -0.6) c = darken(c, 0.12);         // fold shading
      B(y, x, c);
    }
  }
  function chevronBg(B, bands, w) {
    flagBg(B, RAINBOW);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const b = Math.floor((x + Math.abs(y - 8) * 0.9) / w);
      if (b < bands.length) B(y, x, bands[b]);
    }
  }

  const BGS = {
    vault(B) {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const d = Math.hypot(x - 8, y - 8.5);
        let c = (x + y) % 4 === 0 ? '#353C49' : '#2E3440';
        if (d <= 8.2 && d > 6.6) c = '#A3ADBD';
        else if (d <= 6.6) c = '#6B7385';
        if (d <= 7.9 && d > 7.0) c = '#C3CBD6';
        B(y, x, c);
      }
      for (let i = 0; i < 12; i++) {
        const a = i * Math.PI / 6;
        B(Math.round(8.5 + 7.4 * Math.sin(a)), Math.round(8 + 7.4 * Math.cos(a)), '#E0B84A');
      }
      for (let y = 6; y <= 11; y++) B(y, 0, '#4C566A');            // hinge
    },
    neon(B) {
      const sky = ['#0B0221', '#120330', '#19043D', '#22064A', '#2C0857', '#370A63', '#430D6E', '#4F1078', '#5C1381', '#6A1689'];
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) B(y, x, y < 10 ? sky[y] : '#14002B');
      for (const [y, x] of [[1, 2], [2, 13], [4, 15], [3, 6], [6, 1], [1, 10]]) B(y, x, '#FF8BF0');
      for (let x = 0; x < S; x++) B(10, x, '#FF2BD6');
      for (const y of [12, 14, 16]) for (let x = 0; x < S; x++) B(y, x, '#00C8E0');
      for (let k = -5; k <= 5; k++) for (let y = 11; y < S; y++) {
        const x = Math.round(8 + k * (y - 9) * 0.55);
        if (x >= 0 && x < S) B(y, x, '#00E5FF');
      }
    },
    city(B) {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) B(y, x, y < 6 ? '#0D1B2A' : '#16243A');
      for (const [y, x] of [[1, 3], [3, 8], [2, 11], [5, 1], [4, 15]]) B(y, x, '#E0E1DD');
      B(1, 13, '#F1FAEE'); B(1, 14, '#F1FAEE'); B(2, 13, '#F1FAEE'); B(2, 14, '#D8DCC8');   // moon
      const H = [7, 7, 11, 11, 11, 5, 5, 9, 9, 9, 9, 6, 6, 12, 12, 8, 8];
      for (let x = 0; x < S; x++) {
        const top = S - H[x], col = (Math.floor(x / 2) % 2) ? '#1B2433' : '#253047';
        for (let y = top; y < S; y++) {
          const lit = y > top && (x % 2 === 0) && ((x * 7 + y * 3) % 4 !== 0);
          B(y, x, lit && y % 2 === 0 ? '#FFD166' : col);
        }
      }
    },
    jail(B) {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        let c = '#5A5A63';
        if (y % 3 === 2) c = '#47474F';
        else if ((x + (Math.floor(y / 3) % 2) * 2) % 4 === 0) c = '#47474F';
        B(y, x, c);
      }
      for (let x = 1; x < S; x += 3) for (let y = 0; y < S; y++) B(y, x, y % 5 === 0 ? '#C0C6CF' : '#9AA0A8');
      for (const y of [1, 15]) for (let x = 0; x < S; x++) B(y, x, '#7D838C');
    },
    sunset(B) {
      const rows = ['#2D1B4E', '#3D1F59', '#552464', '#71296D', '#8E3072', '#AB3A70', '#C7486B', '#DD5A60', '#EE7052', '#F68845', '#FBA23C', '#FCBF49'];
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) B(y, x, y < 12 ? rows[y] : (y % 2 ? '#2B2150' : '#33285E'));
      for (let y = 6; y < 12; y++) for (let x = 0; x < S; x++) if (Math.hypot(x - 8, y - 11.5) <= 4.6) B(y, x, y < 9 ? '#FFE066' : '#FFD23F');
      const refl = [[12, 4, 12], [13, 5, 11], [14, 6, 10], [15, 7, 9], [16, 7, 9]];
      for (const [y, a, b] of refl) for (let x = a; x <= b; x += 2) B(y, x, '#F9A03F');
    },
    matrix(B) {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) B(y, x, (x * 13 + y * 7) % 5 === 0 ? '#0A2E0A' : '#020A02');
      const tail = ['#D8FFD8', '#00FF41', '#00D836', '#00A82A', '#008F11', '#005A0A', '#003B00'];
      for (let x = 0; x < S; x++) {
        const head = (x * 7 + 3) % S, len = 4 + (x * 5) % 4;
        for (let i = 0; i <= len && i < tail.length; i++) {
          const y = head - i;
          if (y >= 0) B(y, x, tail[i]);
        }
      }
    },
    progress(B) { chevronBg(B, ['#FFFFFF', '#F5A9B8', '#5BCEFA', '#613915', '#000000'], 1.7); },
    intersex(B) {
      chevronBg(B, ['#FFDA00', '#FFDA00', '#FFFFFF', '#F5A9B8', '#5BCEFA', '#613915', '#000000'], 1.35);
      for (const [y, x] of [[6, 1], [7, 0], [7, 2], [8, 0], [8, 2], [9, 1]]) B(y, x, '#7902AA');   // ring
    },
    trans(B) { flagBg(B, FLAGS.trans); },
    bi(B) { flagBg(B, FLAGS.bi); },
    lesbian(B) { flagBg(B, FLAGS.lesbian); },
    pan(B) { flagBg(B, FLAGS.pan); },
    enby(B) { flagBg(B, FLAGS.enby); },
    ace(B) { flagBg(B, FLAGS.ace); },
    aro(B) { flagBg(B, FLAGS.aro); },
    genderfluid(B) { flagBg(B, FLAGS.genderfluid); },
    lavalamp(B) {                                       // groovy 70s lava blobs
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) B(y, x, mix('#2A0845', '#C2157F', y / (S - 1)));
      const blobs = [[3, 2, 2.4, '#FF6D00'], [2, 14, 1.9, '#FF4081'], [9, 15, 2.3, '#FFAB00'], [14, 2, 2.5, '#FF4081'],
                     [15, 13, 1.7, '#FF6D00'], [8, 1, 1.3, '#FFAB00'], [0, 8, 1.4, '#FF6D00']];
      for (const [cy, cx, r, c] of blobs) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const d = Math.hypot(x - cx, (y - cy) * 0.8);
        if (d <= r) B(y, x, c);
      }
      for (const [cy, cx, r, c] of blobs) B(Math.round(cy - r / 2), Math.round(cx - r / 3), lighten(c, 0.45));   // highlights
    },
    leopard(B) {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) B(y, x, (x * 3 + y * 5) % 11 === 0 ? '#E8BC62' : '#D9A441');
      for (let cy = 1; cy < S + 2; cy += 5) for (let cx = (cy % 10 === 1 ? 1 : 4); cx < S + 2; cx += 6) {
        B(cy, cx, '#A0662A'); B(cy, cx + 1, '#A0662A');
        for (const [y, x] of [[cy - 1, cx], [cy - 1, cx + 1], [cy, cx - 1], [cy + 1, cx], [cy, cx + 2], [cy + 1, cx + 2]]) B(y, x, '#3E2A14');
      }
    },
    redroom(B) {                                        // velvet curtains, red glow
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        let c = x % 4 === 0 ? '#2A0508' : '#3E0A0F';
        const g = Math.max(0, 1 - Math.hypot(x - 8, y - 1) / 9);
        if (g > 0) c = mix(c, '#B3202A', g * 0.75);
        if (y >= 14) c = (x + y) % 2 ? '#140304' : '#260708';
        B(y, x, c);
      }
      const fold = ['#7A0F14', '#A3161D', '#5A0A0E'];
      for (let y = 0; y < 14; y++) for (const x of [0, 1, 2, 14, 15, 16]) {
        if ((x === 2 || x === 14) && y > 8) continue;    // tied back
        B(y, x, fold[x % 3]);
      }
      for (let x = 0; x < S; x++) B(0, x, '#A3161D');
      for (let x = 0; x < S; x++) if (x % 2) B(1, x, '#C9A227');   // gold fringe
      B(9, 2, '#C9A227'); B(9, 14, '#C9A227');           // tie-backs
    },
    sakura(B) {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) B(y, x, mix('#FFE4EE', '#CDE7FF', y / (S - 1)));
      for (let y = 15; y < S; y++) for (let x = 0; x < S; x++) B(y, x, (x + y) % 3 ? '#C5E1A5' : '#AED581');
      const br = '#5D4037';
      for (const [y, x] of [[3, 0], [3, 1], [2, 2], [2, 3], [1, 4], [1, 5], [0, 6], [2, 1], [4, 0],
                            [2, 16], [2, 15], [3, 14], [3, 13], [1, 13], [0, 12], [4, 16]]) B(y, x, br);
      const pk = '#FFB7C5', wt = '#FFF0F4', ct = '#FF8FAB';
      for (const [y, x] of [[1, 1], [1, 2], [2, 0], [0, 3], [1, 3], [0, 4], [2, 4], [4, 1], [5, 0], [0, 5], [3, 2],
                            [1, 14], [1, 15], [0, 13], [0, 14], [3, 15], [3, 16], [4, 13], [2, 12], [1, 12], [0, 11]]) B(y, x, (x + y) % 3 ? pk : wt);
      for (const [y, x] of [[1, 2], [0, 4], [1, 15], [3, 15]]) B(y, x, ct);
      for (const [y, x] of [[7, 1], [10, 2], [12, 0], [8, 15], [12, 14], [6, 13], [11, 16], [14, 3]]) B(y, x, pk);   // falling petals
    },
    clouds(B) {                                         // cotton-candy sky
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++)
        B(y, x, y < 8 ? mix('#FFC1E3', '#D9C6FF', y / 8) : mix('#D9C6FF', '#B8E2FF', (y - 8) / 8));
      const puffs = [[3, 2, 1.8], [2, 4, 1.5], [4, 0, 1.3], [2, 13, 1.7], [3, 15, 1.6], [13, 1, 1.6], [14, 3, 1.4], [12, 15, 1.8], [14, 14, 1.5]];
      for (const [cy, cx, r] of puffs) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r) B(y, x, y > cy + 0.4 ? '#F3E5F5' : '#FFFFFF');
      }
      B(0, 9, '#FFF59D'); B(7, 1, '#FFFFFF'); B(8, 15, '#FFF59D'); B(10, 13, '#FFFFFF');   // twinkles
    }
  };

  // Frames: F(y, x, c) writes on top of everything. isFg(y,x) tells whether art occupies a cell.
  const ring = (fn) => { for (let i = 0; i < S; i++) { fn(0, i, 'top'); fn(S - 1, i, 'bottom'); fn(i, 0, 'left'); fn(i, S - 1, 'right'); } };
  const FRAMES = {
    gold(F) {
      ring((y, x, side) => F(y, x, side === 'top' || side === 'left' ? '#F5D76E' : '#A67C00'));
      for (const [y, x] of [[0, 0], [0, 16], [16, 0], [16, 16]]) F(y, x, '#D4AF37');
      for (const [y, x] of [[1, 1], [1, 15], [15, 1], [15, 15]]) F(y, x, '#D4AF37');
      for (const [y, x] of [[0, 8], [16, 8], [8, 0], [8, 16]]) F(y, x, '#E63946');
    },
    diamond(F) {
      const c = ['#E0F7FF', '#9BE7FF', '#FFFFFF', '#5AD1FF'];
      ring((y, x) => F(y, x, c[(x + y) % 4]));
      for (const [y, x] of [[1, 1], [1, 15], [15, 1], [15, 15]]) F(y, x, '#FFFFFF');
      for (const [y, x] of [[0, 0], [0, 16], [16, 0], [16, 16]]) F(y, x, '#B9F2FF');
    },
    flame(F) {
      ring((y, x, side) => {
        let c = '#D00000';
        if (side === 'bottom') c = '#FF6D00';
        else if (side === 'left' || side === 'right') c = y > 10 ? '#FF6D00' : y > 5 ? '#E85D04' : '#D00000';
        else c = '#9D0208';
        F(y, x, c);
      });
      for (let x = 1; x < S - 1; x++) {
        const h = [2, 1, 3, 1, 2, 1, 3, 2, 1, 2, 3, 1, 2, 1, 3, 2, 1][x];
        for (let i = 1; i <= h; i++) F(S - 1 - i, x, i === h ? '#FFBA08' : '#FF8C00');
      }
      for (let y = 9; y < S - 1; y++) if (y % 2) { F(y, 1, '#FFBA08'); F(y, S - 2, '#FFBA08'); }
    },
    neon(F, isFg) {
      ring((y, x) => F(y, x, '#FF2BD6'));
      for (let i = 1; i < S - 1; i++) for (const [y, x] of [[1, i], [S - 2, i], [i, 1], [i, S - 2]]) if (!isFg(y, x)) F(y, x, '#6A1060');
      for (const [y, x] of [[0, 0], [0, 16], [16, 0], [16, 16], [0, 1], [1, 0], [0, 15], [1, 16], [16, 1], [15, 0], [16, 15], [15, 16]]) F(y, x, '#00F0FF');
    },
    pixel(F) {
      ring((y, x, side) => F(y, x, side === 'top' || side === 'left' ? '#FFFFFF' : '#9A9AA6'));
      for (const [y, x] of [[0, 0], [0, 16], [16, 0], [16, 16]]) F(y, x, null);
      F(1, 1, '#FFFFFF'); F(1, 15, '#C8C8D0'); F(15, 1, '#C8C8D0'); F(15, 15, '#9A9AA6');
    },
    glitter(F, isFg) {
      const c = ['#FFD6F5', '#FF8BF0', '#FFFFFF', '#E1BEE7', '#B388FF', '#FFF59D'];
      ring((y, x) => F(y, x, c[(x * 7 + y * 3) % c.length]));
      for (const [y, x] of [[1, 1], [1, 15], [15, 1], [15, 15], [1, 8], [15, 8], [8, 1], [8, 15]]) if (!isFg(y, x)) F(y, x, '#FFFFFF');
    },
    rainbow(F) {
      ring((y, x) => F(y, x, RAINBOW[Math.floor(((x + y) % 12) / 2)]));
    },
    chain(F, isFg) {                                    // chain links + studded leather
      ring((y, x, side) => F(y, x, ['#5F6670', '#C8CDD5', '#9AA0A8'][(side === 'top' || side === 'bottom' ? x : y) % 3]));
      for (let i = 1; i < S - 1; i++) for (const [y, x] of [[1, i], [S - 2, i], [i, 1], [i, S - 2]]) {
        if (isFg(y, x)) continue;
        F(y, x, i % 3 === 0 ? '#E0E4EA' : '#161616');
      }
    },
    hearts(F) {
      ring((y, x) => F(y, x, (x + y) % 2 ? '#FFB3D9' : '#FF8FC8'));
      const heart = (y, x) => {
        for (const [dy, dx] of [[0, 0], [0, 2], [1, 0], [1, 1], [1, 2], [2, 1]]) F(y + dy, x + dx, '#FF2D87');
        F(y, x, '#FF6FB0');
      };
      heart(0, 0); heart(0, 14); heart(14, 0); heart(14, 14);
      for (const [y, x] of [[0, 8], [16, 8], [8, 0], [8, 16]]) F(y, x, '#FFFFFF');
    }
  };

  const LAYERS = { hat: HATS, mask: MASKS, outfit: OUTFITS, prop: PROPS, bg: BGS, frame: FRAMES };
  const pepeAvatarLayers = {};
  for (const k in LAYERS) pepeAvatarLayers[k] = Object.keys(LAYERS[k]);

  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function validLayers(opts) {
    if (!opts || typeof opts !== 'object') return null;
    const L = {}; let any = false;
    for (const k in LAYERS) {
      const id = opts[k];
      if (typeof id === 'string' && own(LAYERS[k], id)) { L[k] = id; any = true; }
    }
    return any ? L : null;
  }

  function renderLayered(seed, size, L) {
    const f = buildFrog(seed, false);
    const bgG = Array.from({ length: S }, () => Array(S).fill(null));
    const fg = Array.from({ length: S }, () => Array(S).fill(null));
    const fr = Array.from({ length: S }, () => Array(S).fill(undefined));
    const inb = (y, x) => y >= 0 && y < S && x >= 0 && x < S;
    const A = (y, x, c) => { if (inb(y, x)) fg[y][x] = c; };
    const P = (y, x, c) => A(y + OY, x + OX, c);
    const B = (y, x, c) => { if (inb(y, x)) bgG[y][x] = c; };
    const F = (y, x, c) => { if (inb(y, x)) fr[y][x] = c; };

    if (L.bg) BGS[L.bg](B);
    for (let y = 0; y < 11; y++) for (let x = 0; x < 11; x++) if (f.G[y][x]) P(y, x, f.G[y][x]);
    if (L.outfit) OUTFITS[L.outfit](P, f);
    if (L.mask) MASKS[L.mask](P, f);
    // hat slot: a hat layer replaces the seed's own hat (whose shades variant also yields to a mask)
    if (L.hat) HATS[L.hat](P, f);
    else if (!(L.mask && f.hatType === 7)) drawSeedHat(P, f.hatType, f.hatColor);
    if (L.prop) PROPS[L.prop](A, P, f);
    if (L.frame) FRAMES[L.frame](F, (y, x) => !!fg[y][x]);

    // emit, merging horizontal runs of one color
    let rects = '';
    for (let y = 0; y < S; y++) {
      let x = 0;
      while (x < S) {
        const c = fr[y][x] !== undefined ? fr[y][x] : (fg[y][x] || bgG[y][x]);
        let e = x + 1;
        while (e < S && (fr[y][e] !== undefined ? fr[y][e] : (fg[y][e] || bgG[y][e])) === c) e++;
        if (c) rects += `<rect x="${x}" y="${y}" width="${e - x + 0.02}" height="1.02" fill="${c}"/>`;
        x = e;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${size}" height="${size}" ` +
      `shape-rendering="crispEdges" style="image-rendering:pixelated">${rects}</svg>`;
  }

  function pepeAvatarSVG(seed, size, opts) {
    size = size || 120;
    const L = validLayers(opts);
    if (L) return renderLayered(seed, size, L);
    const { G } = buildFrog(seed, true);
    const N = 11;

    // outline pass — draw a dark edge around body pixels for definition
    let rects = '';
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (!G[y][x]) continue;
      rects += `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${G[y][x]}"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 11 11" width="${size}" height="${size}" ` +
      `shape-rendering="crispEdges" style="image-rendering:pixelated">${rects}</svg>`;
  }

  global.pepeAvatarSVG = pepeAvatarSVG;
  global.pepeAvatarLayers = pepeAvatarLayers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
