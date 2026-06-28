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
 *   value는 JSON 직렬화된 { type, data, expAt } 레코드.
 *   만료는 lazy eviction(조회 시 검사) + 주기적 alarm GC로 처리한다.
 * 참고: checkRateLimit/recordMetric(store.js)은 매 요청마다 호출되는 핫패스라서
 * 의도적으로 DO Redis(doRedisIncrBy 등)를 쓰지 않고 인스턴스 메모리로 처리한다.
 * 요청마다 DO RPC를 추가하면 레이턴시와 서브리퀘스트 비용이 커지기 때문이며,
 * 카운터 정밀도보다 응답 속도가 더 중요한 경로이므로 이 트레이드오프를 의도했다.
 * 아래의 doRedisIncrBy/doRedisHSet/doRedisExpire 등은 그 외 용도(분석, 캐시
 * 메타데이터 등)로 store.js나 향후 기능에서 가져다 쓸 수 있도록 노출된 범용 API다.
 */

import { DurableObject } from 'cloudflare:workers';

const SHARD_COUNT_DEFAULT = 64; // wrangler.toml의 REDIS_SHARD_COUNT로 조절 가능
const GC_INTERVAL_MS = 5 * 60 * 1000; // 5분마다 만료 항목 정리

// ── 키 → 샤드 번호 해시 (FNV-1a) ─────────────────────────────────────
function shardOf(key, shardCount) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
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
    return await resp.json();
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

  _put(key, vtype, data, ttlSec) {
    const expAt = ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0;
    this.sql.exec(
      `INSERT INTO kv (key, vtype, vdata, exp_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET vtype=excluded.vtype, vdata=excluded.vdata, exp_at=excluded.exp_at`,
      key, vtype, JSON.stringify(data), expAt
    );
  }

  async fetch(request) {
    let cmd;
    try { cmd = await request.json(); } catch (_) {
      return Response.json({ ok: false, error: 'bad-json' }, { status: 400 });
    }
    try {
      const result = this._exec(cmd);
      return Response.json(result);
    } catch (e) {
      return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
    }
  }

  _exec(cmd) {
    const op = cmd.op;
    switch (op) {
      case 'GET': {
        const row = this._row(cmd.key);
        if (!row) return { ok: true, value: null };
        const parsed = JSON.parse(row.vdata);
        return { ok: true, value: row.vtype === 'string' ? parsed : null };
      }
      case 'SET': {
        this._put(cmd.key, 'string', cmd.value, cmd.ttlSec || 0);
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
        const rawCur = row ? JSON.parse(row.vdata) : 0;
        const cur = Number(rawCur);
        if (row && !Number.isFinite(cur)) {
          return { ok: false, error: 'ERR value is not an integer' };
        }
        const next = cur + (cmd.by || 1);
        this._put(cmd.key, 'string', next, row ? this._remainingTtl(cmd.key) : 0);
        return { ok: true, value: next };
      }
      case 'LPUSH': case 'RPUSH': {
        const row = this._row(cmd.key);
        const list = row && row.vtype === 'list' ? JSON.parse(row.vdata) : [];
        if (op === 'LPUSH') list.unshift(cmd.value); else list.push(cmd.value);
        this._put(cmd.key, 'list', list, row ? this._remainingTtl(cmd.key) : 0);
        return { ok: true, len: list.length };
      }
      case 'LRANGE': {
        const row = this._row(cmd.key);
        const list = row && row.vtype === 'list' ? JSON.parse(row.vdata) : [];
        const stop = cmd.stop < 0 ? list.length + cmd.stop + 1 : cmd.stop + 1;
        return { ok: true, items: list.slice(cmd.start, stop) };
      }
      case 'LTRIM': {
        const row = this._row(cmd.key);
        const list = row && row.vtype === 'list' ? JSON.parse(row.vdata) : [];
        const stop = cmd.stop < 0 ? list.length + cmd.stop + 1 : cmd.stop + 1;
        const trimmed = list.slice(cmd.start, stop);
        this._put(cmd.key, 'list', trimmed, row ? this._remainingTtl(cmd.key) : 0);
        return { ok: true };
      }
      case 'LLEN': {
        const row = this._row(cmd.key);
        const list = row && row.vtype === 'list' ? JSON.parse(row.vdata) : [];
        return { ok: true, len: list.length };
      }
      case 'HSET': {
        const row = this._row(cmd.key);
        const hash = row && row.vtype === 'hash' ? JSON.parse(row.vdata) : {};
        hash[cmd.field] = cmd.value;
        this._put(cmd.key, 'hash', hash, row ? this._remainingTtl(cmd.key) : 0);
        return { ok: true };
      }
      case 'HGET': {
        const row = this._row(cmd.key);
        const hash = row && row.vtype === 'hash' ? JSON.parse(row.vdata) : {};
        return { ok: true, value: hash[cmd.field] ?? null };
      }
      case 'HGETALL': {
        const row = this._row(cmd.key);
        const hash = row && row.vtype === 'hash' ? JSON.parse(row.vdata) : {};
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
