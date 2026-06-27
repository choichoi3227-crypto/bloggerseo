/**
 * BloggerSEO v6 — WASM 로더 (v5 호환)
 * wasmCore.generateSlug(title) → 한글 제목에서 SEO 슬러그 생성
 * wasmCore.warmup()            → WASM 사전 초기화
 */

// WASM 바이너리를 base64로 임베드 (빌드 시 자동 생성)
// 빌드가 없을 경우 JS 폴백 사용
let _wasmInstance = null;
let _initPromise  = null;
let _lastBackend  = 'js';

async function initWasm() {
  // WASM 바이너리가 있으면 로드, 없으면 JS 폴백
  try {
    const { wasmBlob } = await import('../wasm-src/wasm-blob.js');
    const bytes = Uint8Array.from(atob(wasmBlob), c => c.charCodeAt(0));
    const mod   = await WebAssembly.instantiate(bytes, { env: {
      abort: () => {},
      'Math.random': Math.random,
    }});
    _wasmInstance = mod.instance;
    _lastBackend  = 'wasm';
  } catch (_) {
    _wasmInstance = null;
    _lastBackend  = 'js';
  }
}

// ── JS 폴백 슬러그 생성 (WASM 없을 때) ──────────────────────────────
function jsGenerateSlug(title) {
  if (!title || typeof title !== 'string') return 'post';
  let s = title.trim().toLowerCase();

  // 한글 → 영문 음독 (간단 매핑)
  const KO_MAP = {
    '가':'ga','나':'na','다':'da','라':'ra','마':'ma','바':'ba','사':'sa',
    '아':'a','자':'ja','차':'cha','카':'ka','타':'ta','파':'pa','하':'ha',
    '개':'gae','내':'nae','대':'dae','래':'rae','매':'mae','배':'bae','새':'sae',
    '에':'e','제':'je','체':'che','케':'ke','테':'te','페':'pe','헤':'he',
    '기':'gi','니':'ni','디':'di','리':'ri','미':'mi','비':'bi','시':'si',
    '이':'i','지':'ji','치':'chi','키':'ki','티':'ti','피':'pi','히':'hi',
    '고':'go','노':'no','도':'do','로':'ro','모':'mo','보':'bo','소':'so',
    '오':'o','조':'jo','초':'cho','코':'ko','토':'to','포':'po','호':'ho',
    '구':'gu','누':'nu','두':'du','루':'ru','무':'mu','부':'bu','수':'su',
    '우':'u','주':'ju','추':'chu','쿠':'ku','투':'tu','푸':'pu','후':'hu',
    '그':'geu','는':'neun','를':'reul','이':'i','가':'ga','와':'wa','에':'e',
    '의':'ui','도':'do','한':'han','을':'eul','은':'eun',
  };

  // 한글 문자를 음독으로 변환
  s = s.split('').map(c => {
    if (c >= '가' && c <= '힣') return KO_MAP[c] || 'x';
    return c;
  }).join('');

  s = s
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!s || s.length < 2) return 'post-' + Date.now().toString(36);
  return s.slice(0, 80);
}

export const wasmCore = {
  _lastBackend: 'js',

  async warmup() {
    if (!_initPromise) _initPromise = initWasm();
    await _initPromise;
    this._lastBackend = _lastBackend;
  },

  async generateSlug(title) {
    try {
      await this.warmup();
      if (_wasmInstance?.exports?.generateSlug) {
        // WASM 슬러그 생성 (메모리 관리 포함)
        const encoder = new TextEncoder();
        const bytes   = encoder.encode(title);
        const ptr     = _wasmInstance.exports.__alloc?.(bytes.length + 1, 0) ?? 0;
        if (ptr) {
          const mem = new Uint8Array(_wasmInstance.exports.memory.buffer);
          mem.set(bytes, ptr);
          mem[ptr + bytes.length] = 0;
          const resultPtr = _wasmInstance.exports.generateSlug(ptr);
          if (resultPtr) {
            let result = '';
            let i = resultPtr;
            while (mem[i] !== 0) result += String.fromCharCode(mem[i++]);
            return result || jsGenerateSlug(title);
          }
        }
      }
    } catch (_) {}
    return jsGenerateSlug(title);
  },
};
