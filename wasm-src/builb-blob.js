#!/usr/bin/env node
// wasm-src/bloggerseo.wasm → wasm-src/wasm-blob.js (base64 export)로 변환.
// worker.js는 이 파일을 import해서 WASM 바이너리를 얻는다.
// AssemblyScript 소스(assembly/index.ts)를 수정한 뒤에는:
//   1) npx asc assembly/index.ts -o bloggerseo.wasm --target release -O3 --runtime stub --exportRuntime
//   2) node build-blob.js
// 순서로 다시 실행해 wasm-blob.js를 갱신해야 한다.
const fs = require('fs');
const path = require('path');

const wasmPath = path.join(__dirname, 'bloggerseo.wasm');
const outPath = path.join(__dirname, 'wasm-blob.js');

const buf = fs.readFileSync(wasmPath);
const b64 = buf.toString('base64');

const content = `// 자동 생성 파일 — 직접 수정하지 말 것.
// 생성 방법: wasm-src/build-blob.js 참고 (소스: assembly/index.ts)
// WASM 바이너리(${buf.length} bytes)를 base64로 인코딩해 보관.
export const WASM_BASE64 = "${b64}";
`;

fs.writeFileSync(outPath, content, 'utf8');
console.log(`wrote ${outPath} (${content.length} bytes, wasm=${buf.length} bytes)`);
