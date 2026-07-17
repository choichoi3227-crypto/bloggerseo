/**
 * BloggerSEO v7 — 100% 자체 제작 서버리스 Redis 엔진 (Durable Objects 기반)
 * ─────────────────────────────────────────────────────────────────────
 * 설계 목표 (요청사항 13번):
 *   - Redis 호환 명령어 셋을 Durable Object 위에 처음부터 직접 구현
 *   - Cloudflare KV·D1·Upstash 등 외부 스토리지에 의존하지 않음
 *   - Workers Free 플랜에서 동작 (SQLite-backed DO만 사용 — KV-backed DO는 유료 전용)
 *   - 샤딩(64-way)으로 단일 DO storage 한도를 우회해 사실상 무제한에 수렴하는 용량 확보
 *
 * 왜 "무한 용량"이 정확히는 불가능한지:
 *   Durable Object 1개당 SQLite storage는 자체 한도가 있다(계정/플랜에 따라 변동).
 *   이 구현은 키를 해시로 SHARD_COUNT개의 독립 DO 인스턴스에 분산시켜,
 *   각 DO가 자기 한도를 갖는 대신 "전체 용량 = 샤드 수 × 1개 한도"로 선형 확장한다.
 *   SHARD_COUNT를 늘리면 늘릴수록 실질 한도는 사실상 닿기 어려운 수준까지
 *   커지지만, 수학적으로 완전한 무한은 아니다. 필요시 SHARD_COUNT만 올리면
 *   코드 변경 없이 용량이 그만큼 더 늘어나는 구조로 만들어 두었다.
 *
 * 지원 명령어 (Redis 서브셋):
 *   GET / SET (EX 지원) / DEL / EXISTS / EXPIRE / TTL / INCR / INCRBY
 *   LPUSH / RPUSH / LRANGE / LTRIM / LLEN
 *   HSET / HGET / HGETALL / HDEL
 *   SCAN(prefix 기반, Redis 진짜 SCAN과 100% 동일하진 않음 — 단순화된 자체 버전)
 *   MGET / FLUSHALL(샤드 단위)
 *
 * 데이터 모델:
 *   각 샤드 DO는 SQLite 테이블 하나(`kv`)에 모든 키를 저장.
 *   value는 JSON 직렬화된 { type, data, expAt } 레코드이며, [v14]부터는
 *   압축 이득이 있는 경우 gzip 압축 후 저장된다(kv-compress.js, 'z:' 접두사
 *   포맷 — 기존 비압축 데이터와 100% 하위 호환, 자동 판별). 압축/해제는
 *   조회·저장 경로에서 투명하게 처리되므로 이 파일의 나머지 명령어 구현은
 *   압축 여부를 신경 쓸 필요가 없다.
 *   만료는 lazy eviction(조회 시 검사) + 주기적 alarm GC로 처리한다.
 * 참고: checkRateLimit/recordMetric(store.js)은 매 요청마다 호출되는 핫패스라서
 * 의도적으로 DO Redis(doRedisIncrBy 등)를 쓰지 않고 인스턴스 메모리로 처리한다.
 * 요청마다 DO RPC를 추가하면 레이턴시와 서브리퀘스트 비용이 커지기 때문이며,
 * 카운터 정밀도보다 응답 속도가 더 중요한 경로이므로 이 트레이드오프를 의도했다.
 * 아래의 doRedisIncrBy/doRedisHSet/doRedisExpire 등은 그 외 용도(분석, 캐시
 * 메타데이터 등)로 store.js나 향후 기능에서 가져다 쓸 수 있도록 노출된 범용 API다.
 */

import { DurableObject } from 'cloudflare:workers';
import { encodeForStorage, decodeFromStorage } from './kv-compress.js';

const SHARD_COUNT_DEFAULT = 64; // wrangler.toml의 REDIS_SHARD_COUNT로 조절 가능
const GC_INTERVAL_MS = 5 * 60 * 1000; // 5분마다 만료 항목 정리

// ── [v14] DO SQLite 저장 압축 (gzip) ────────────────────────────────────
// 목표(요청사항 1번): "기존 크기의 최소 70%로 압축" — 저장 바이트 수를
// 원본의 70% 이하로 줄인다(=최소 30% 절감). 실제 압축/해제 로직은
// kv-compress.js에 분리되어 있다(Workers 런타임 밖에서도 단위 테스트가
// 가능하도록). 저장 포맷(vdata 컬럼 값 자체의 접두사가 포맷 태그):
//   'z:' + base64(gzip(JSON 문자열))  → 압축 저장
//   원본 JSON 문자열 그대로            → 비압축 저장(기존 v13 포맷과 100%
//                                       호환 — 기존에 저장된 행도 그대로
//                                       읽힌다, 마이그레이션 불필요)

// ── 키 → 샤드 번호 해시 (FNV-1a) ─────────────────────────────────────
function shardOf(key, shardCount) {
  // ✅ [에러 방지 장치] key가 문자열이 아니면(undefined, number, null 등)
  // key.charCodeAt이 존재하지 않아 TypeError로 즉시 죽는다. 호출부에서
  // 이미 검증하지만, 이 함수가 단독으로도 안전하도록 이중 방어한다.
  const k = typeof key === 'string' ? key : String(key ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < k.length; i++) {
    h ^= k.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = (h ^ (h >>> 16)) >>> 0;
  return h % shardCount;
}

function shardCountOf(env) {
  const n = parseInt(env?.REDIS_SHARD_COUNT || '', 10);
  return Number.isFinite(n) && n > 0 ? n : SHARD_COUNT_DEFAULT;
}

function hasDo(env) {
  return !!(env && env.REDIS_SHARD && typeof env.REDIS_SHARD.idFromName === 'function');
}

function getShardStub(env, shardIdx) {
  const id = env.REDIS_SHARD.idFromName('shard-' + shardIdx);
  return env.REDIS_SHARD.get(id);
}

// 샤드 DO에 명령 전송 (DO의 fetch 핸들러로 RPC 형태 요청)
async function sendToShard(env, key, cmd) {
  if (!hasDo(env)) return { ok: false, error: 'no-do-binding' };
  const shardCount = shardCountOf(env);
  const idx = shardOf(key, shardCount);
  const stub = getShardStub(env, idx);
  try {
    const resp = await stub.fetch('https://redis-shard.internal/cmd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    if (!resp.ok) return { ok: false, error: 'shard-http-' + resp.status };
    // ✅ [에러 방지 장치] resp.ok이어도 바디가 유효한 JSON이 아닐 가능성
    // (예: DO 내부에서 처리되지 않은 예외로 빈 바디/HTML 에러 페이지가
    // 반환되는 극단적 상황)을 대비해 별도로 감싼다. 이전에는 이 지점의
    // 예외가 바깥 catch까지 전파되긴 했지만, try 블록 경계를 명확히 해
    // 어느 단계에서 실패했는지 에러 메시지로 구분할 수 있게 한다.
    try {
      return await resp.json();
    } catch (parseErr) {
      return { ok: false, error: 'shard-bad-response-json: ' + String(parseErr?.message || parseErr) };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// SCAN처럼 모든 샤드를 순회해야 하는 명령 (관리 패널 통계용 — 비용이 크므로 남용 주의)
async function broadcastToShards(env, cmd) {
  if (!hasDo(env)) return [];
  const shardCount = shardCountOf(env);
  const calls = [];
  for (let i = 0; i < shardCount; i++) {
    const stub = getShardStub(env, i);
    calls.push(
      stub.fetch('https://redis-shard.internal/cmd', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cmd),
      }).then(r => r.ok ? r.json() : { ok: false, shard: i })
        .catch(() => ({ ok: false, shard: i }))
    );
  }
  return Promise.all(calls);
}

// ─────────────────────────────────────────────────────────────────────
// 퍼블릭 클라이언트 API (store.js에서 이 함수들만 호출)
// ─────────────────────────────────────────────────────────────────────

export function doRedisAvailable(env) {
  return hasDo(env);
}

export async function doRedisGet(env, key) {
  const r = await sendToShard(env, key, { op: 'GET', key });
  return r && r.ok ? r.value : null;
}

export async function doRedisSet(env, key, value, ttlSec = 0) {
  const r = await sendToShard(env, key, { op: 'SET', key, value, ttlSec });
  return !!(r && r.ok);
}

export async function doRedisDel(env, key) {
  const r = await sendToShard(env, key, { op: 'DEL', key });
  return !!(r && r.ok);
}

export async function doRedisExists(env, key) {
  const r = await sendToShard(env, key, { op: 'EXISTS', key });
  return !!(r && r.ok && r.exists);
}

export async function doRedisExpire(env, key, ttlSec) {
  const r = await sendToShard(env, key, { op: 'EXPIRE', key, ttlSec });
  return !!(r && r.ok);
}

export async function doRedisTtl(env, key) {
  const r = await sendToShard(env, key, { op: 'TTL', key });
  return r && r.ok ? r.ttl : -2;
}

export async function doRedisIncrBy(env, key, by = 1) {
  const r = await sendToShard(env, key, { op: 'INCRBY', key, by });
  if (!r || !r.ok) return null; // 실패(타입 불일치 등) — 호출 측에서 null 체크
  return r.value;
}

export async function doRedisLPush(env, key, value) {
  const r = await sendToShard(env, key, { op: 'LPUSH', key, value });
  return r && r.ok ? r.len : 0;
}

export async function doRedisRPush(env, key, value) {
  const r = await sendToShard(env, key, { op: 'RPUSH', key, value });
  return r && r.ok ? r.len : 0;
}

export async function doRedisLRange(env, key, start, stop) {
  const r = await sendToShard(env, key, { op: 'LRANGE', key, start, stop });
  return r && r.ok ? r.items : [];
}

export async function doRedisLTrim(env, key, start, stop) {
  const r = await sendToShard(env, key, { op: 'LTRIM', key, start, stop });
  return !!(r && r.ok);
}

export async function doRedisLLen(env, key) {
  const r = await sendToShard(env, key, { op: 'LLEN', key });
  return r && r.ok ? r.len : 0;
}

export async function doRedisHSet(env, key, field, value) {
  const r = await sendToShard(env, key, { op: 'HSET', key, field, value });
  return !!(r && r.ok);
}

export async function doRedisHGet(env, key, field) {
  const r = await sendToShard(env, key, { op: 'HGET', key, field });
  return r && r.ok ? r.value : null;
}

export async function doRedisHGetAll(env, key) {
  const r = await sendToShard(env, key, { op: 'HGETALL', key });
  return r && r.ok ? r.value : {};
}

// 모든 샤드를 순회하며 prefix로 키를 모음 — 관리 패널 통계 / 만료 정리용
export async function doRedisScanAll(env, prefix, limitPerShard = 200) {
  const results = await broadcastToShards(env, { op: 'SCAN', prefix, limit: limitPerShard });
  const keys = [];
  for (const r of results) {
    if (r && r.ok && Array.isArray(r.keys)) keys.push(...r.keys);
  }
  return keys;
}

// 샤드별 통계 (관리 패널 — Redis 관리 탭)
export async function doRedisClusterStats(env) {
  if (!hasDo(env)) return { available: false, shards: [] };
  const shardCount = shardCountOf(env);
  const results = await broadcastToShards(env, { op: 'STATS' });
  const shards = results.map((r, i) => ({
    shard: i,
    keys: r && r.ok ? r.keys : 0,
    bytesApprox: r && r.ok ? r.bytesApprox : 0,
    expired: r && r.ok ? r.expired : 0,
  }));
  const totalKeys  = shards.reduce((s, x) => s + (x.keys || 0), 0);
  const totalBytes = shards.reduce((s, x) => s + (x.bytesApprox || 0), 0);
  return { available: true, shardCount, totalKeys, totalBytesApprox: totalBytes, shards };
}

export async function doRedisFlushAll(env) {
  if (!hasDo(env)) return { ok: false };
  const results = await broadcastToShards(env, { op: 'FLUSHALL' });
  const ok = results.every(r => r && r.ok);
  return { ok };
}

// ─────────────────────────────────────────────────────────────────────
// Durable Object 클래스: MyDurableObject
// (Cloudflare 대시보드에서 먼저 생성한 네임스페이스의 class_name과 일치시킴.
//  역할은 RedisShard와 동일 — 100% 자체 제작 서버리스 Redis 샤드 1개.)
// wrangler.toml에 durable_objects.bindings + migrations(new_sqlite_classes)로 등록.
// ─────────────────────────────────────────────────────────────────────
export class MyDurableObject extends DurableObject {
  constructor(state, env) {
    super(state, env); // DurableObject 베이스 클래스 필수 호출
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql; // SQLite storage backend

    // Cloudflare 권장 패턴: blockConcurrencyWhile()로 스키마 초기화가 끝나기 전까지
    // 이 DO 인스턴스로 들어오는 모든 요청(fetch/alarm)을 큐에 대기시킨다.
    // 이렇게 하면 _ready를 매 메서드마다 수동으로 await할 필요가 없고,
    // 초기화 중간에 끼어드는 race condition을 원천적으로 막을 수 있다.
    this.state.blockConcurrencyWhile(async () => {
      await this._init();
    });
  }

  async _init() {
    // kv 테이블: key(PK) / vtype / vdata(JSON 문자열) / exp_at(ms epoch, 0=무만료)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key    TEXT PRIMARY KEY,
        vtype  TEXT NOT NULL,
        vdata  TEXT NOT NULL,
        exp_at INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_kv_exp ON kv(exp_at)`);

    // 주기적 GC 알람 예약 (없으면 최초 1회 설정)
    const alarm = await this.state.storage.getAlarm();
    if (!alarm) {
      await this.state.storage.setAlarm(Date.now() + GC_INTERVAL_MS);
    }
  }

  async alarm() {
    this._gc();
    await this.state.storage.setAlarm(Date.now() + GC_INTERVAL_MS);
  }

  _gc() {
    const now = Date.now();
    this.sql.exec(`DELETE FROM kv WHERE exp_at > 0 AND exp_at <= ?`, now);
  }

  _row(key) {
    const now = Date.now();
    const cursor = this.sql.exec(`SELECT vtype, vdata, exp_at FROM kv WHERE key = ?`, key);
    const rows = cursor.toArray ? cursor.toArray() : [...cursor];
    const row = rows[0];
    if (!row) return null;
    if (row.exp_at > 0 && row.exp_at <= now) {
      this.sql.exec(`DELETE FROM kv WHERE key = ?`, key);
      return null;
    }
    return row;
  }

  // ✅ [v14] gzip 압축(요청사항 1번: DO 저장 크기 최소 70%로 압축) —
  // encodeForStorage()가 압축 이득이 있을 때만 'z:' 접두사 포맷으로
  // 바꾸고, 이득이 없으면 원본 그대로 저장한다(항상 회귀 없음).
  async _put(key, vtype, data, ttlSec) {
    const expAt = ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0;
    const stored = await encodeForStorage(JSON.stringify(data));
    this.sql.exec(
      `INSERT INTO kv (key, vtype, vdata, exp_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET vtype=excluded.vtype, vdata=excluded.vdata, exp_at=excluded.exp_at`,
      key, vtype, stored, expAt
    );
  }

  // ✅ [에러 방지 장치] vdata는 항상 이 DO가 직접 (압축 후) 쓴 값이라
  // 정상 상황에서는 파싱이 실패할 수 없지만, 만에 하나 외부 요인(수동
  // SQLite 조작, 향후 스키마 변경, 저장소 손상 등)으로 손상된 값이
  // 들어있으면 이전 구현은 JSON.parse가 그대로 throw해서 그 요청 전체가
  // 500으로 실패하고 해당 키는 이후 모든 접근에서 영구히 500만 반환하는
  // "죽은 키"가 되어버렸다. 손상을 감지하면 해당 키를 자동 삭제해 다음
  // 접근부터는 "키 없음"으로 정상 복구되도록 한다 — 사용자가 수동으로
  // KV 관리 탭에서 삭제하지 않아도 스스로 치유된다.
  // [v14] 압축 여부('z:' 접두사)를 먼저 투명하게 해제한 뒤 JSON.parse한다.
  async _safeParse(row, key, fallback) {
    try {
      const raw = await decodeFromStorage(row.vdata);
      return JSON.parse(raw);
    } catch (_) {
      try { this.sql.exec(`DELETE FROM kv WHERE key = ?`, key); } catch (_) {}
      return fallback;
    }
  }

  async fetch(request) {
    let cmd;
    try { cmd = await request.json(); } catch (_) {
      return Response.json({ ok: false, error: 'bad-json' }, { status: 400 });
    }
    try {
      // [v14] 압축/해제(gzip)가 비동기이므로 _exec 자체도 비동기로 바뀌었다.
      const result = await this._exec(cmd);
      return Response.json(result);
    } catch (e) {
      return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
    }
  }

  async _exec(cmd) {
    // ✅ [에러 방지 장치] cmd/cmd.op/cmd.key가 없거나 잘못된 타입이면
    // SQL 바인딩에 undefined가 들어가 예측 불가능한 동작(SQLite가 NULL로
    // 취급하거나 예외 발생)으로 이어질 수 있었다. 진입점에서 미리 검증해
    // 명확한 에러 메시지로 즉시 실패시킨다.
    if (!cmd || typeof cmd !== 'object') return { ok: false, error: 'bad-command: not an object' };
    const op = cmd.op;
    if (typeof op !== 'string') return { ok: false, error: 'bad-command: missing op' };
    if (op !== 'FLUSHALL' && op !== 'SCAN' && op !== 'STATS' && typeof cmd.key !== 'string') {
      return { ok: false, error: 'bad-command: missing or invalid key' };
    }
    switch (op) {
      case 'GET': {
        const row = this._row(cmd.key);
        if (!row) return { ok: true, value: null };
        const parsed = await this._safeParse(row, cmd.key, null);
        return { ok: true, value: row.vtype === 'string' ? parsed : null };
      }
      case 'SET': {
        await this._put(cmd.key, 'string', cmd.value, cmd.ttlSec || 0);
        return { ok: true };
      }
      case 'DEL': {
        this.sql.exec(`DELETE FROM kv WHERE key = ?`, cmd.key);
        return { ok: true };
      }
      case 'EXISTS': {
        return { ok: true, exists: !!this._row(cmd.key) };
      }
      case 'EXPIRE': {
        const row = this._row(cmd.key);
        if (!row) return { ok: false, error: 'no-such-key' };
        const expAt = cmd.ttlSec > 0 ? Date.now() + cmd.ttlSec * 1000 : 0;
        this.sql.exec(`UPDATE kv SET exp_at = ? WHERE key = ?`, expAt, cmd.key);
        return { ok: true };
      }
      case 'TTL': {
        const row = this._row(cmd.key);
        if (!row) return { ok: true, ttl: -2 }; // 키 없음
        const cursor = this.sql.exec(`SELECT exp_at FROM kv WHERE key = ?`, cmd.key);
        const rows = cursor.toArray ? cursor.toArray() : [...cursor];
        const expAt = rows[0]?.exp_at || 0;
        if (expAt === 0) return { ok: true, ttl: -1 }; // 무만료
        return { ok: true, ttl: Math.max(0, Math.round((expAt - Date.now()) / 1000)) };
      }
      case 'INCRBY': {
        const row = this._row(cmd.key);
        if (row && row.vtype !== 'string') {
          return { ok: false, error: 'WRONGTYPE: value is not a string/integer' };
        }
        const rawCur = row ? await this._safeParse(row, cmd.key, 0) : 0;
        const cur = Number(rawCur);
        if (row && !Number.isFinite(cur)) {
          return { ok: false, error: 'ERR value is not an integer' };
        }
        const next = cur + (cmd.by || 1);
        await this._put(cmd.key, 'string', next, row ? this._remainingTtl(cmd.key) : 0);
        return { ok: true, value: next };
      }
      case 'LPUSH': case 'RPUSH': {
        const row = this._row(cmd.key);
        const list = row && row.vtype === 'list' ? await this._safeParse(row, cmd.key, []) : [];
        if (op === 'LPUSH') list.unshift(cmd.value); else list.push(cmd.value);
        await this._put(cmd.key, 'list', list, row ? this._remainingTtl(cmd.key) : 0);
        return { ok: true, len: list.length };
      }
      case 'LRANGE': {
        const row = this._row(cmd.key);
        const list = row && row.vtype === 'list' ? await this._safeParse(row, cmd.key, []) : [];
        const stop = cmd.stop < 0 ? list.length + cmd.stop + 1 : cmd.stop + 1;
        return { ok: true, items: list.slice(cmd.start, stop) };
      }
      case 'LTRIM': {
        const row = this._row(cmd.key);
        const list = row && row.vtype === 'list' ? await this._safeParse(row, cmd.key, []) : [];
        const stop = cmd.stop < 0 ? list.length + cmd.stop + 1 : cmd.stop + 1;
        const trimmed = list.slice(cmd.start, stop);
        await this._put(cmd.key, 'list', trimmed, row ? this._remainingTtl(cmd.key) : 0);
        return { ok: true };
      }
      case 'LLEN': {
        const row = this._row(cmd.key);
        const list = row && row.vtype === 'list' ? await this._safeParse(row, cmd.key, []) : [];
        return { ok: true, len: list.length };
      }
      case 'HSET': {
        const row = this._row(cmd.key);
        const hash = row && row.vtype === 'hash' ? await this._safeParse(row, cmd.key, {}) : {};
        hash[cmd.field] = cmd.value;
        await this._put(cmd.key, 'hash', hash, row ? this._remainingTtl(cmd.key) : 0);
        return { ok: true };
      }
      case 'HGET': {
        const row = this._row(cmd.key);
        const hash = row && row.vtype === 'hash' ? await this._safeParse(row, cmd.key, {}) : {};
        return { ok: true, value: hash[cmd.field] ?? null };
      }
      case 'HGETALL': {
        const row = this._row(cmd.key);
        const hash = row && row.vtype === 'hash' ? await this._safeParse(row, cmd.key, {}) : {};
        return { ok: true, value: hash };
      }
      case 'SCAN': {
        this._gc();
        const like = (cmd.prefix || '').replace(/[%_]/g, c => '\\' + c) + '%';
        const cursor = this.sql.exec(
          `SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' LIMIT ?`,
          like, cmd.limit || 200
        );
        const rows = cursor.toArray ? cursor.toArray() : [...cursor];
        return { ok: true, keys: rows.map(r => r.key) };
      }
      case 'STATS': {
        this._gc();
        // ✅ [v14] LENGTH(vdata)는 압축 적용 여부와 무관하게 "실제 SQLite에
        // 저장된 바이트 수"를 반환한다 — 압축된 행은 압축 후 크기가 그대로
        // 잡히므로, bytesApprox는 관리 패널에서 실질 저장 절감 효과를
        // 확인하는 데도 그대로 쓸 수 있다(별도 계측 불필요).
        const cursor = this.sql.exec(`SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(vdata)),0) AS b FROM kv`);
        const rows = cursor.toArray ? cursor.toArray() : [...cursor];
        const row = rows[0] || { c: 0, b: 0 };
        return { ok: true, keys: row.c, bytesApprox: row.b, expired: 0 };
      }
      case 'FLUSHALL': {
        this.sql.exec(`DELETE FROM kv`);
        return { ok: true };
      }
      default:
        return { ok: false, error: 'unknown-op:' + op };
    }
  }

  _remainingTtl(key) {
    const cursor = this.sql.exec(`SELECT exp_at FROM kv WHERE key = ?`, key);
    const rows = cursor.toArray ? cursor.toArray() : [...cursor];
    const expAt = rows[0]?.exp_at || 0;
    if (expAt === 0) return 0;
    return Math.max(0, Math.round((expAt - Date.now()) / 1000));
  }
}
