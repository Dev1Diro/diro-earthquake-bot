/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  재난 알림 봇 v10.0.0  —  Ultimate All-in-One Edition            ║
 * ║  소스: KMA · JMA · NDMS · USGS                               ║
 * ║  AI : Gemini · Groq (Llama 3.3 70B) · Cerebras (Llama 3.1 70B) ║
 * ║                                                              ║
 * ║  [엔터프라이즈급 강화 스펙]                                      ║
 * ║  ├─ 본래 기능 100% 복원 (감사로그, JMA번역, USGS분류, 명령어)  ║
 * ║  ├─ AI 여진 예측 통합 (Gemini → Groq/Cerebras 협의 파이프라인)║
 * ║  ├─ AI 병렬 네트워크 최적화 (Promise.any + AbortController)  ║
 * ║  ├─ Discord 메모리 400MB 제한 엄수 (makeCache 극단적 최적화)   ║
 * ║  ├─ Helmet 8.x 보안 헤더 & Express Rate-Limit 15분 100회 제한 ║
 * ║  ├─ 모든 Map/Array의 Bounded LRU 캐시화 (메모리 누수 원천차단)║
 * ║  ├─ 모든 비동기 처리망에 Defensive Catch (무중단 안정성 확보) ║
 * ║  ├─ 화산 정보 일괄 삭제 및 관련 로직 제거                     ║
 * ║  ├─ USGS 탐지 범위: 대한민국 및 대만 ~ 캄차카반도 라인으로 확장 ║
 * ║  └─ 초정밀 로그 시스템, 강화된 오류 처리, 소스 제어 명령 추가 ║
 * ╚═══════════════════════════════════════════════════════════════╝
 */

import 'dotenv/config';
import express          from 'express';
import helmet           from 'helmet';
import rateLimit        from 'express-rate-limit';
import axios            from 'axios';
import fs               from 'fs/promises';
import path             from 'path';
import https            from 'https';
import http             from 'http';
import { XMLParser }    from 'fast-xml-parser';
import {
  Client, GatewayIntentBits, Partials, Options,
  EmbedBuilder, REST, Routes, Events, AuditLogEvent,
  ApplicationCommandOptionType,
} from 'discord.js';

/* ══════════════════════════════════════════════════════════════
   §0. 글로벌 로그 시스템
══════════════════════════════════════════════════════════════ */
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  CRITICAL: 4,
  FATAL: 5,
};

let CURRENT_LOG_LEVEL = LOG_LEVELS.INFO; // Default production level

if (process.env.NODE_ENV === 'development') {
  CURRENT_LOG_LEVEL = LOG_LEVELS.DEBUG; // Development logs all
}

class Logger {
  constructor(source) {
    this.source = String(source).padEnd(5);
  }

  _log(level, msg, extra = '') {
    if (LOG_LEVELS[level] < CURRENT_LOG_LEVEL) {
      return;
    }
    const ts = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const ex = extra ? ` | ${String(extra).slice(0, 200)}` : '';
    const output = `${ts} [${level.padEnd(8)}][${this.source}] ${msg}${ex}`;
    
    switch (level) {
      case 'DEBUG':
        console.debug(output);
        break;
      case 'INFO':
        console.info(output);
        break;
      case 'WARN':
        console.warn(output);
        break;
      case 'ERROR':
      case 'CRITICAL':
      case 'FATAL':
        console.error(output);
        break;
      default:
        console.log(output);
    }
  }

  debug(msg, extra) { this._log('DEBUG', msg, extra); }
  info(msg, extra) { this._log('INFO', msg, extra); }
  warn(msg, extra) { this._log('WARN', msg, extra); }
  error(msg, extra) { this._log('ERROR', msg, extra); }
  critical(msg, extra) { this._log('CRITICAL', msg, extra); }
  fatal(msg, extra) { this._log('FATAL', msg, extra); process.exit(1); } // Fatal errors exit the process
}

const mainLogger = new Logger('MAIN'); // Main logger for general system events

/* ══════════════════════════════════════════════════════════════
   §1. 환경 변수 검증 및 전역 설정
══════════════════════════════════════════════════════════════ */
const ENV = (() => {
  const envVars = {
    DISCORD_TOKEN:   process.env.DISCORD_TOKEN,
    APPLICATION_ID:  process.env.APPLICATION_ID  ?? '',
    OWNER_ID:        process.env.OWNER_ID         ?? '',
    PORT:            process.env.PORT             ?? '3000',
    CHANNEL_IDS:     process.env.CHANNEL_IDS      ?? '',
    KMA_KEY:         process.env.KMA_KEY          ?? '',
    SAFETY_KEY:      process.env.SAFETY_KEY       ?? '',
    GEMINI_API_KEY:  process.env.GEMINI_API_KEY   ?? '',
    GROQ_API_KEY:    process.env.GROQ_API_KEY     ?? '',
    CEREBRAS_API_KEY:process.env.CEREBRAS_API_KEY ?? '',
  };

  if (!envVars.DISCORD_TOKEN) {
    mainLogger.fatal('DISCORD_TOKEN 환경 변수가 설정되지 않았습니다. 봇을 시작할 수 없습니다.');
  }
  if (!envVars.KMA_KEY) {
    mainLogger.warn('KMA_KEY가 설정되지 않았습니다. KMA 데이터 소스가 비활성화됩니다.');
  }
  if (!envVars.SAFETY_KEY) {
    mainLogger.warn('SAFETY_KEY가 설정되지 않았습니다. NDMS 데이터 소스가 비활성화됩니다.');
  }
  
  // AI Keys: 적어도 하나는 있어야 AI 기능 활성화
  if (!envVars.GEMINI_API_KEY && !envVars.GROQ_API_KEY && !envVars.CEREBRAS_API_KEY) {
    mainLogger.warn('AI API 키(GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY) 중 하나도 설정되지 않았습니다. AI 예측 기능이 비활성화됩니다.');
  } else {
    if (!envVars.GEMINI_API_KEY) mainLogger.warn('GEMINI_API_KEY가 설정되지 않았습니다. Gemini AI Provider가 비활성화됩니다.');
    if (!envVars.GROQ_API_KEY) mainLogger.warn('GROQ_API_KEY가 설정되지 않았습니다. Groq AI Provider가 비활성화됩니다.');
    if (!envVars.CEREBRAS_API_KEY) mainLogger.warn('CEREBRAS_API_KEY가 설정되지 않았습니다. Cerebras AI Provider가 비활성화됩니다.');
  }

  return Object.freeze(envVars);
})();

const CFG = Object.freeze({
  PORT:          Number(ENV.PORT) || 3000,
  DATA_DIR:      path.resolve(process.cwd(), 'data'),
  GLOBAL_CH:     ENV.CHANNEL_IDS.split(',').map(s => s.trim()).filter(Boolean),

  MS_NDMS:       2  * 60_000,
  MS_EQ:         5  * 60_000,
  MS_ERR:        20 * 60_000,

  RETRY_BASE:    Object.freeze([3_000, 8_000, 20_000]),
  RETRY_JITTER:  0.3,

  CB_THRESH:     3,
  CB_HALF_MS:    5 * 60_000,
  ERR_CD_MS:     10 * 60_000,

  CACHE_TTL:     24 * 3_600_000,
  SENT_MAX:      2_000,  // 메모리 관리
  XL_MAX:        800,

  DEDUP_DIST_KM: 80,
  DEDUP_MAG_D:   0.5,
  DEDUP_TIME_MS: 5 * 60_000,
  DEDUP_MAX:     500,

  KMA_OK:        Object.freeze(new Set(['00', '03'])),
  USGS_URL:      'https://earthquake.usgs.gov/fdsnws/event/1/query',
  USGS_MIN_MAG:  4.5,
  USGS_LIMIT:    20,

  GEO: Object.freeze({
    KR: Object.freeze({ latMin:33.0, latMax:38.9, lonMin:124.5, lonMax:132.0 }),
    // 대만 남부(약 21N, 118E)부터 러시아 캄차카 북부(약 61N, 167E)까지를 아우르는 직사각형 영역
    TW_KAMCHATKA: Object.freeze({ latMin:21.0, latMax:61.0, lonMin:118.0, lonMax:167.0 }),
  }),

  RAID_MENTION_LIMIT:  5,
  RAID_MENTION_SEC:    3,
  RAID_CH_LIMIT:       5,
  RAID_CH_SEC:         10,
  BULK_DELETE_MS:      14 * 24 * 60 * 60 * 1000, // 14일 정확 계산

  AI_MIN_MAG:    5.0,
  BROADCAST_GAP: 350,
  EMBED_MAX:     4_000,
  SHUTDOWN_MS:   12_000,
});

/* ══════════════════════════════════════════════════════════════
   §2. 입력 무결성 (보안)
══════════════════════════════════════════════════════════════ */
const DANGER_RE = /[<>"'`\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const sane = (v, max = 1024) => v == null ? '없음' : String(v).replace(DANGER_RE, '').slice(0, max) || '없음';

/* ──────────────────────────────────────────────────────────────
   JSON 안전 파서 (코드 펜스 자동 제거)
────────────────────────────────────────────────────────────── */
function safeParseJSON(text) {
  const logger = new Logger('JSON');
  if (!text) {
    logger.debug('파싱할 텍스트 없음');
    return null;
  }
  try {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const clean = (fence ? fence[1] : text).trim();
    const parsed = JSON.parse(clean);
    logger.debug('JSON 파싱 성공');
    return parsed;
  } catch (e) {
    logger.debug('코드 펜스 JSON 파싱 실패, 일반 객체 시도', e.message);
    const block = text.match(/\{[\s\S]*\}/);
    if (block) { 
      try { 
        const parsed = JSON.parse(block[0]);
        logger.debug('블록 JSON 파싱 성공');
        return parsed;
      } catch (e2) {
        logger.debug('블록 JSON 파싱 실패', e2.message);
      }
    }
    logger.debug('JSON 파싱 최종 실패');
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   §3. AI 매니저 및 예측 모듈 (통합/네트워크 병렬 Abort 최적화)
────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────────────
   Provider 정의
────────────────────────────────────────────────────────────── */
const AI_PROVIDERS = Object.freeze([
  {
    id:   'gemini',
    name: 'Gemini 2.0 Flash',
    key:  () => ENV.GEMINI_API_KEY ?? '',
    call: async (prompt, system, key, signal) => {
      const body = {
        contents:          [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig:  { temperature: 0.25, maxOutputTokens: 600 },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
        body, { timeout: 20_000, signal }
      );
      return res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    },
  },
  {
    id:   'groq',
    name: 'Llama 3.3 70B (Groq)',
    key:  () => ENV.GROQ_API_KEY ?? '',
    call: async (prompt, system, key, signal) => {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama-3.3-70b-versatile', messages, temperature: 0.25, max_tokens: 600 },
        { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 20_000, signal }
      );
      return res.data?.choices?.[0]?.message?.content ?? null;
    },
  },
  {
    id:   'cerebras',
    name: 'Llama 3.1 70B (Cerebras)',
    key:  () => ENV.CEREBRAS_API_KEY ?? '',
    call: async (prompt, system, key, signal) => {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });
      const res = await axios.post(
        'https://api.cerebras.ai/v1/chat/completions',
        { model: 'llama3.1-70b', messages, temperature: 0.25, max_tokens: 600 },
        { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 20_000, signal }
      );
      return res.data?.choices?.[0]?.message?.content ?? null;
    },
  },
]);

/* ──────────────────────────────────────────────────────────────
   AIManager 싱글톤
────────────────────────────────────────────────────────────── */
class AIManager {
  #logger = new Logger('AI');
  #provider(id) { return AI_PROVIDERS.find(p => p.id === id && p.key().length > 0) ?? null; }

  get active()      { return AI_PROVIDERS.filter(p => p.key().length > 0); }
  get isAvailable() { return this.active.length > 0; }

  /**
   * 첫 번째 성공한 Provider 응답 반환 (병렬 호출 with AbortController)
   */
  async queryFirst(prompt, systemPrompt = '') {
    if (!this.isAvailable) {
      this.#logger.debug('활성 AI Provider 없음, queryFirst 건너뛰기');
      return null;
    }
    const ac = new AbortController();
    
    try {
      const promises = this.active.map(p => 
        p.call(prompt, systemPrompt, p.key(), ac.signal).then(text => {
          if (!text) throw new Error('Empty response');
          this.#logger.info(`응답 수신 (${p.name})`);
          return { text, provider: p.name };
        }).catch(e => {
          if (e.name === 'CanceledError' || ac.signal.aborted) { // AbortError or CanceledError
            this.#logger.debug(`${p.name} 요청 취소됨 (다른 Provider 성공)`);
          } else {
            this.#logger.warn(`${p.name} 실패`, e.message);
          }
          throw e; // Promise.any가 다음 Promise를 시도하도록 에러를 다시 던짐
        })
      );
      const result = await Promise.any(promises);
      ac.abort(); // 🚀 1등 응답을 받으면 나머지 네트워크 요청 즉시 강제 종료 (대역폭/메모리 절약)
      return result;
    } catch (err) {
      this.#logger.warn('모든 AI Provider 실패');
      return null;
    }
  }

  /**
   * AI 협의 파이프라인
   * ─ 1단계: Gemini가 초안을 생성
   * ─ 2단계: 초안을 Groq 또는 Cerebras 중 하나에 전달 → 최종 JSON 확정 (병렬 시도)
   * ─ 폴백 : 2단계 실패 시 Gemini 초안에서 JSON 파싱 시도
   */
  async deliberate(prompt, systemPrompt = '') {
    if (!this.isAvailable) {
      this.#logger.debug('활성 AI Provider 없음, deliberate 건너뛰기');
      return null;
    }

    const gemini = this.#provider('gemini');
    const groq   = this.#provider('groq');
    const cerebras = this.#provider('cerebras');

    // Gemini 사용 불가 → 단순 queryFirst (병렬)
    if (!gemini) {
      this.#logger.info('Gemini 비활성, queryFirst로 대체');
      return this.queryFirst(prompt, systemPrompt);
    }

    /* Step 1: Gemini 초안 생성 */
    let draft = null;
    try {
      this.#logger.info('Gemini 초안 생성 시작');
      draft = await gemini.call(prompt, systemPrompt, gemini.key(), new AbortController().signal);
      if (draft) this.#logger.info('Gemini 초안 완성');
      else throw new Error('Gemini returned empty draft');
    } catch (err) {
      this.#logger.warn('Gemini 초안 실패', err.message);
    }

    /* Step 2: Groq 또는 Cerebras 검토·확정 (병렬 시도) */
    if (draft) {
      const reviewPrompt =
        `다음은 지진 분석 초안입니다:\n\n${draft}\n\n` +
        `위 분석을 검토하고 최종 결론을 아래 JSON 형식으로만 출력하세요.\n` +
        `홍보 문구("봇 제공", "이 분석은" 등), 마크다운, 설명 문장 없이 JSON만 작성합니다.\n` +
        `{"predictedMagnitude":<숫자>,"aftershockProbability":"<퍼센트 문자열>","advice":"<대응 요령 1-2문장>"}`;
      
      const reviewProviders = [];
      if (groq) reviewProviders.push(groq);
      if (cerebras) reviewProviders.push(cerebras);

      if (reviewProviders.length > 0) {
        this.#logger.info(`Groq/Cerebras 검토 시작 (${reviewProviders.map(p => p.name).join('/')})`);
        const ac = new AbortController();
        try {
          const reviewPromises = reviewProviders.map(p => 
            p.call(reviewPrompt, '', p.key(), ac.signal).then(text => {
              if (!text) throw new Error('Empty review response');
              this.#logger.info(`${p.name} 검토 완성 → Gemini+${p.name} 협의 완료`);
              return { text, provider: `Gemini+${p.name}` };
            }).catch(e => {
              if (e.name === 'CanceledError' || ac.signal.aborted) {
                this.#logger.debug(`${p.name} 검토 요청 취소됨 (다른 Provider 성공)`);
              } else {
                this.#logger.warn(`${p.name} 검토 실패`, e.message);
              }
              throw e;
            })
          );
          const reviewedResult = await Promise.any(reviewPromises);
          ac.abort();
          if (reviewedResult) return reviewedResult;
        } catch (err) {
          this.#logger.warn('모든 검토 Provider 실패', err.message);
        }
      }
    }

    // Groq/Cerebras 없거나 실패 → Gemini 초안 사용
    if (draft) {
      this.#logger.info('Groq/Cerebras 검토 실패/비활성 → Gemini 초안 직접 사용');
      return { text: draft, provider: 'Gemini' };
    }

    // 모두 실패 → 남은 Provider (fallback to queryFirst for any other active provider)
    this.#logger.info('Gemini 초안 및 검토 모두 실패 → queryFirst 폴백');
    return this.queryFirst(prompt, systemPrompt);
  }

  /**
   * 전송 전 Gemini 검수 (Gatekeeper)
   * embedText: 임베드에서 추출한 평문
   * 반환: { ok:boolean, issues:string[] }
   */
  async gatekeeperCheck(embedText) {
    const gemini = this.#provider('gemini');
    if (!gemini) { this.#logger.debug('Gemini 비활성, Gatekeeper 건너뛰기'); return { ok: true, issues: [] }; }

    const prompt =
      `다음 재난 알림 메시지의 오류를 검사하세요.\n` +
      `검사 항목: NaN, 0{lat}/0{lon} 같은 미치환 템플릿, undefined, [object Object], 2600년 이후 날짜, 비정상 좌표.\n\n` +
      `메시지:\n${embedText.slice(0, 600)}\n\n` +
      `오류가 없으면 {"ok":true,"issues":[]} 을, ` +
      `있으면 {"ok":false,"issues":["오류 설명1",...]} 을 JSON으로만 출력하세요.`;

    try {
      this.#logger.info('Gatekeeper 검수 시작');
      const raw = await gemini.call(prompt, '', gemini.key(), new AbortController().signal);
      const parsed = safeParseJSON(raw);
      if (!parsed) throw new Error('Failed to parse Gatekeeper response JSON');
      
      const ok = parsed.ok !== false;
      const issues = Array.isArray(parsed.issues) ? parsed.issues : [];

      if (ok) this.#logger.info('Gatekeeper 검수 통과');
      else this.#logger.warn('Gatekeeper 검수 실패', issues.join(', '));

      return { ok, issues };
    } catch (err) {
      this.#logger.warn('Gatekeeper 검수 실패 (안전하게 통과 처리)', err.message);
      return { ok: true, issues: [] }; // 검수 실패 시 안전하게 통과
    }
  }

  /** 복구 쿼리 */
  async recoverFromError(errorContext, originalPrompt) {
    this.#logger.info('복구 쿼리 시작', errorContext);
    const p =
      `이전 요청에서 오류 발생: ${errorContext}\n\n원래 요청:\n${originalPrompt}\n\n` +
      `JSON 형식으로만 출력하세요. 설명, 홍보 문구, 마크다운 없이 JSON만 작성합니다.`;
    return this.queryFirst(p);
  }
}

const aiManager = new AIManager();

/* ──────────────────────────────────────────────────────────────
   시스템 프롬프트 — JSON만 출력, 홍보 문구 금지
────────────────────────────────────────────────────────────── */
const AI_SYSTEM_PROMPT = `
당신은 지진 전문가입니다.
반드시 아래 JSON 형식만 출력하세요.
마크다운, 코드 펜스, 설명문, "봇 제공", "이 분석은", "참고로" 같은 불필요한 문구 없이 JSON만 작성합니다.
{
  "predictedMagnitude": <소수 숫자, 예: 4.2>,
  "aftershockProbability": <퍼센트 문자열, 예: "약 65%">,
  "advice": <한국어 대응 요령 1~2문장>
}
`.trim();

/**
 * 여진 예측 모듈
 * @param {{ loc:string, time:string|number, mag:number,
 *           depth:number|null, lat:number|null, lon:number|null }} quake
 * @returns {Promise<{predictedMagnitude:number, aftershockProbability:string,
 *                   advice:string, provider:string}|null>}
 */
async function predictAftershock(quake) {
  const logger = new Logger('AI_PRED');
  if (!aiManager.isAvailable)        return null;
  if (!quake.mag || quake.mag < CFG.AI_MIN_MAG) return null; // M5.0 미만 스킵

  const prompt = `
아래 지진 정보를 분석하여 향후 24시간 이내 최대 여진 규모, 발생 확률, 시민 행동 요령을 분석하세요.

- 발생 위치: ${quake.loc ?? '알 수 없음'}
- 발생 시각: ${quake.time ?? '-'}
- 규모: M ${Number(quake.mag).toFixed(1)}
- 진원 깊이: ${quake.depth != null ? `${quake.depth} km` : '알 수 없음'}
- 좌표: ${quake.lat != null ? `위도 ${quake.lat}, 경도 ${quake.lon}` : '알 수 없음'}
`.trim();

  /* ── 협의 파이프라인 호출 ── */
  let result = await aiManager.deliberate(prompt, AI_SYSTEM_PROMPT)
    .catch(err => { logger.error('Deliberate pipeline failed', err.message); return null; });

  if (result) {
    const parsed = safeParseJSON(result.text);
    if (parsed && parsed.predictedMagnitude != null) {
      logger.info(`여진 예측 성공 (${result.provider})`);
      return _buildAftershockPrediction(parsed, result.provider);
    }
    // JSON 파싱 실패 → 복구 쿼리
    logger.warn('JSON 파싱 실패 (복구 시도)', result.text.slice(0, 100));
    const recovered = await aiManager.recoverFromError(
      'JSON 파싱 실패: ' + result.text.slice(0, 100), prompt
    ).catch(err => { logger.error('Recovery query failed', err.message); return null; });
    
    if (recovered) {
      const rp = safeParseJSON(recovered.text);
      if (rp && rp.predictedMagnitude != null) {
        logger.info(`여진 예측 복구 성공 (${recovered.provider})`);
        return _buildAftershockPrediction(rp, recovered.provider);
      }
    }
  }
  logger.warn('여진 예측 최종 실패');
  return null;
}

function _buildAftershockPrediction(parsed, provider) {
  return {
    predictedMagnitude:    Number(parsed.predictedMagnitude) || 0,
    aftershockProbability: String(parsed.aftershockProbability ?? '-'),
    // "봇 제공" 등 홍보 문구 후처리 제거
    advice: String(parsed.advice ?? '재난 당국의 지시에 따르세요.')
      .replace(/봇\s*제공|이\s*분석은|참고\s*로|제공\s*:\s*\S+/g, '')
      .trim(),
    provider: String(provider ?? 'AI'),
  };
}


/* ══════════════════════════════════════════════════════════════
   §4. Haversine & Cross-Source 전역 중복 방지 (Bounded Array)
══════════════════════════════════════════════════════════════ */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6_371, d2r = Math.PI / 180;
  const a = Math.sin((lat2-lat1)*d2r/2)**2 + Math.cos(lat1*d2r)*Math.cos(lat2*d2r)*Math.sin((lon2-lon1)*d2r/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const GEV =[]; // Global Event Viewer for deduplication
function isDuplicateEvent({ src, lat, lon, mag, timeMs }) {
  const now = Date.now(), cutoff = now - CFG.CACHE_TTL;
  while (GEV.length > 0 && GEV[GEV.length-1].sentAt < cutoff) GEV.pop();
  while (GEV.length >= CFG.DEDUP_MAX) GEV.pop();

  if (lat == null || lon == null) {
    GEV.unshift({ src, lat, lon, mag, timeMs, sentAt: now });
    return false;
  }
  for (const ev of GEV) {
    if (ev.lat == null || ev.lon == null) continue;
    if (haversineKm(lat,lon,ev.lat,ev.lon) <= CFG.DEDUP_DIST_KM &&
        mag != null && ev.mag != null && Math.abs(mag - ev.mag) <= CFG.DEDUP_MAG_D &&
        timeMs != null && ev.timeMs != null && Math.abs(timeMs - ev.timeMs) <= CFG.DEDUP_TIME_MS) {
      new Logger(src).info(`Cross-Dedup 스킵 (${ev.src} 기전송)`, `d=${haversineKm(lat,lon,ev.lat,ev.lon).toFixed(0)}km`);
      return true;
    }
  }
  GEV.unshift({ src, lat, lon, mag, timeMs, sentAt: now });
  return false;
}

/* ══════════════════════════════════════════════════════════════
   §5. Circuit Breaker & Tracking
══════════════════════════════════════════════════════════════ */
class CircuitBreaker {
  #name; #state='CLOSED'; #failures=0; #openedAt=0;
  #logger;
  constructor(name) { 
    this.#name = name; 
    this.#logger = new Logger(`CB-${name}`);
  }
  get state()  { return this.#state; }
  get isOpen() { return this.#state === 'OPEN'; }

  async exec(fn) {
    if (this.#state === 'OPEN') {
      const wait = CFG.CB_HALF_MS - (Date.now() - this.#openedAt);
      if (wait > 0) throw Object.assign(new Error(`CB_OPEN:${this.#name}`), { cbOpen:true });
      this.#state = 'HALF_OPEN';
      this.#logger.info('→ HALF_OPEN (복구 시도)');
    }
    try {
      const r = await fn();
      if (this.#failures > 0 || this.#state === 'HALF_OPEN') this.#logger.info('→ CLOSED (복구)');
      this.#state = 'CLOSED'; this.#failures = 0;
      return r;
    } catch(e) {
      if (!e.cbOpen) {
        this.#failures++;
        this.#logger.debug(`실패 카운트: ${this.#failures}/${CFG.CB_THRESH}`, e.message);
      }
      if (!e.cbOpen && this.#failures >= CFG.CB_THRESH) {
        this.#state = 'OPEN'; this.#openedAt = Date.now();
        this.#logger.warn(`→ OPEN (${this.#failures}회 실패)`);
      }
      throw e;
    }
  }

  // Owner command hook: Force close
  forceClose() {
    this.#state = 'CLOSED';
    this.#failures = 0;
    this.#openedAt = 0;
    this.#logger.info('강제로 CLOSED 상태로 변경');
  }

  badge() {
    if (this.#state === 'CLOSED') return '✅ 정상';
    if (this.#state === 'HALF_OPEN') return '🟡 복구 시험 중';
    const s = Math.ceil((CFG.CB_HALF_MS-(Date.now()-this.#openedAt))/1_000);
    return `❌ 차단됨 (${s}초 후)`;
  }
}
const CB = Object.fromEntries(['kma','jma','ndms','usgs'].map(k =>[k, new CircuitBreaker(k.toUpperCase())]));
const TRK = Object.fromEntries(['kma','jma','ndms','usgs'].map(k =>[k, { streak:0, lastOk:null }]));

const onOk  = src => { const t=TRK[src]; const w=t.streak; t.streak=0; t.lastOk=new Date(); return w>0?w+1:null; };
const onErr = src => TRK[src].streak++;

/* ══════════════════════════════════════════════════════════════
   §6. 영속화 (Storage) & Bounded Map (캐시 메모리 제한)
══════════════════════════════════════════════════════════════ */
const SENT = Object.fromEntries(['kma','jma','ndms','usgs'].map(k=>[k,new Map()]));
function pruneSent() {
  const cut = Date.now()-CFG.CACHE_TTL;
  for (const m of Object.values(SENT)) for (const[id,ts]of m) if(ts<cut) m.delete(id);
}
function markSent(src, id) {
  const m = SENT[src]; m.set(id, Date.now());
  if (m.size > CFG.SENT_MAX) m.delete(m.keys().next().value);
}

const FILE = Object.fromEntries(['kma','jma','ndms','usgs','config'].map(k=>[k, path.join(CFG.DATA_DIR,`${k}.json`)]));
const GUILD_CFG = new Map();

async function initStorage() {
  const logger = new Logger('STORAGE');
  await fs.mkdir(CFG.DATA_DIR, { recursive:true });
  for (const[k, p] of Object.entries(FILE)) {
    try {
      const rows = JSON.parse(await fs.readFile(p,'utf8'));
      if (k === 'config') Object.entries(rows).forEach(([id, cfg]) => GUILD_CFG.set(id, cfg));
      else if (Array.isArray(rows)) rows.forEach(([id,ts])=>SENT[k].set(id,ts||Date.now()));
      logger.info(`로드 완료 (${k})`);
    } catch(err) {
      logger.warn(`로드 실패 (${k}), 초기화합니다`, err.message);
      await fs.writeFile(p, k === 'config'?'{}':'[]', 'utf8').catch(e => logger.error(`초기 파일 쓰기 실패 (${k})`, e.message));
    }
  }
}
async function persist(key) {
  const logger = new Logger('STORAGE');
  try {
    const data = key === 'config' ? JSON.stringify(Object.fromEntries(GUILD_CFG)) : JSON.stringify([...SENT[key].entries()]);
    await fs.writeFile(`${FILE[key]}.tmp`, data, 'utf8');
    await fs.rename(`${FILE[key]}.tmp`, FILE[key]);
    logger.debug(`저장 완료 (${key})`);
  } catch(e) { logger.error(`파일 쓰기 실패 (${key})`, e.message); }
}
function getAlertChannels() {
  const ids = new Set(CFG.GLOBAL_CH);
  for (const [, cfg] of GUILD_CFG) if (cfg.alertChannel) ids.add(cfg.alertChannel);
  return [...ids];
}
function getLogChannel(guildId) { return GUILD_CFG.get(guildId)?.logChannel ?? null; }

/* ══════════════════════════════════════════════════════════════
   §7. 유틸리티 & HTTP Client (Axios)
══════════════════════════════════════════════════════════════ */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => Math.floor(ms * (1 + (Math.random()*2-1)*CFG.RETRY_JITTER));
const fmtDate = v => {
  if (!v) return '-'; const d = new Date(typeof v==='string' && !/^\d{10,}$/.test(v) ? v : Number(v));
  return isNaN(d) ? sane(v,30) : d.toLocaleString('ko-KR', { timeZone:'Asia/Seoul' });
};
const gmap = (lat, lon, q) => lat!=null&&lon!=null ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}` : q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : 'https://www.google.com/maps';
const magStyle = m => {
  if (m>=7) return { color:0x7B0000, em:'🆘' }; if (m>=6) return { color:0xFF0000, em:'🔴' };
  if (m>=5) return { color:0xFF6600, em:'🟠' }; if (m>=4) return { color:0xFFAA00, em:'🟡' };
  if (m>=3) return { color:0x00AAFF, em:'🔵' }; return { color:0x888888, em:'⚪' };
};
const pagerMeta = lv => ({
  green: {em:'🟢',color:0x00CC00,label:'낮음'}, yellow:{em:'🟡',color:0xFFCC00,label:'보통'},
  orange:{em:'🟠',color:0xFF8800,label:'높음'}, red: {em:'🔴',color:0xFF0000,label:'심각'},
}[lv] ?? {em:'⚫',color:0x888888,label:'-'});
const geoRegion = (lat, lon) => {
  if (lat==null||lon==null) return 'INT';
  const {KR, TW_KAMCHATKA} = CFG.GEO;
  if (lat>=KR.latMin&&lat<=KR.latMax&&lon>=KR.lonMin&&lon<=KR.lonMax) return 'KR';
  if (lat>=TW_KAMCHATKA.latMin&&lat<=TW_KAMCHATKA.latMax&&lon>=TW_KAMCHATKA.lonMin&&lon<=TW_KAMCHATKA.lonMax) return 'TW_KAMCHATKA';
  return 'INT';
};

const HTTP = axios.create({
  timeout: 15_000,
  headers: { 'User-Agent': 'DisasterBot/10.0.0', 'Accept': 'application/json, application/xml, */*', 'Accept-Language': 'ko-KR,ko;q=0.9' },
  httpsAgent: new https.Agent({ keepAlive:true, rejectUnauthorized:false }),
  httpAgent:  new http.Agent({ keepAlive:true }),
});

async function withRetry(fn, src) {
  const logger = new Logger(src);
  let last;
  for (let i=0; i<=CFG.RETRY_BASE.length; i++) {
    try { return await fn(); } catch(e) {
      last=e;
      logger.debug(`재시도 (${i+1}/${CFG.RETRY_BASE.length+1})`, e.message);
      if (i<CFG.RETRY_BASE.length) await sleep(jitter(CFG.RETRY_BASE[i]));
    }
  }
  throw last;
}

/* ══════════════════════════════════════════════════════════════
   §8. 번역 엔진 (JMA 전용) & XML Parser
────────────────────────────────────────────────────────────── */
const JMA_DICT = new Map([
  ['緊急地震速報','긴급지진속보'],['震源地','진원지'],['震源域','진원역'],['震源','진원'],['震央','진앙'],
  ['震度','진도'],['規模','규모'],['深さ','깊이'],['地震','지진'],['津波','쓰나미'],['注意報','주의보'],['警報','경보'],['余震','여진'],['本震','본진'],
  ['マグニチュード','M'],['暫定値','잠정값'],['最大','최대'],['観測','관측'],['発生','발생'],['情報','정보'],['速報','속보'],['陸地','육지'],['海域','해역'],['沿岸','연안'],
  ['予想','예상'],['到達','도달'],['発表','발표'],['取消','취소'],['更新','갱신']
]);
const XL = new Map(); // 번역 캐시
function dictTr(t) { let r=t; for (const [j,k] of JMA_DICT) r=r.replaceAll(j,k); return r; }
async function toKo(raw) {
  const logger = new Logger('XL');
  if (!raw?.trim()) return '내용 없음';
  const key=raw.slice(0,200); if(XL.has(key)) return XL.get(key);
  const pre=dictTr(raw);
  if (!/[\u3040-\u30FF\u4E00-\u9FFF]/.test(pre)) { if(XL.size>=CFG.XL_MAX)XL.delete(XL.keys().next().value); XL.set(key,pre); return pre; }
  try {
    const r=await axios.get('https://translate.googleapis.com/translate_a/single', {params:{client:'gtx',sl:'ja',tl:'ko',dt:'t',q:pre},timeout:8_000});
    const out=r.data?.[0]?.map(x=>x?.[0]||'').join('').trim();
    if(out) { if(XL.size>=CFG.XL_MAX)XL.delete(XL.keys().next().value); XL.set(key,out); return out; }
  } catch(e) { logger.warn('Google Translate 실패', e.message); }
  try {
    const r=await axios.get('https://api.mymemory.translated.net/get', {params:{q:pre.slice(0,500),langpair:'ja|ko'},timeout:8_000});
    const out=r.data?.responseData?.translatedText?.trim();
    if(out&&out!==pre) { if(XL.size>=CFG.XL_MAX)XL.delete(XL.keys().next().value); XL.set(key,out); return out; }
  } catch(e) { logger.warn('MyMemory Translate 실패', e.message); }
  if(XL.size>=CFG.XL_MAX)XL.delete(XL.keys().next().value); XL.set(key,pre); return pre;
}
function parseJMANums(text) {
  if (typeof text!=='string') return {};
  return {
    mag: text.match(/M\s*([\d.]+)/)?.[1] ? +text.match(/M\s*([\d.]+)/)[1] : null,
    depth: (text.match(/深さ.*?([\d]+)\s*km/)?.[1]??text.match(/깊이.*?([\d]+)\s*km/)?.[1]) ? +(text.match(/深さ.*?([\d]+)\s*km/)?.[1]??text.match(/깊이.*?([\d]+)\s*km/)[1]) : null,
    lat: text.match(/北緯\s*([\d.]+)/)?.[1] ? +text.match(/北緯\s*([\d.]+)/)[1] : null,
    lon: text.match(/東経\s*([\d.]+)/)?.[1] ? +text.match(/東経\s*([\d.]+)/)[1] : null,
  };
}

/* ══════════════════════════════════════════════════════════════
   §9. Discord 클라이언트 (메모리 400MB 제한을 위한 캐시 제한)
══════════════════════════════════════════════════════════════ */
const discord = new Client({
  intents:[
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates,
  ],
  partials:[Partials.Message, Partials.Channel, Partials.GuildMember],
  // 🚀 메모리 최적화의 핵심: 사용하지 않는 캐시를 완전히 끄고, 메시지는 소량만 보관
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 50,
    PresenceManager: 0,
    ThreadManager: 0,
    VoiceStateManager: 0,
  }),
});

/* ══════════════════════════════════════════════════════════════
   §10. Broadcast Queue & Embed Builders
══════════════════════════════════════════════════════════════ */
const Q=[]; let qBusy=false;
const broadcastLogger = new Logger('BC');
const broadcast = payload => new Promise((res,rej)=>{Q.push({payload,res,rej});drain();});
async function drain() {
  if(qBusy||Q.length===0) return; qBusy=true;
  while(Q.length>0) {
    const {payload,res,rej}=Q.shift();
    try {
      for (const id of getAlertChannels()) {
        try { 
          const ch=await discord.channels.fetch(id); 
          if(ch?.isTextBased()) {
            await ch.send(payload); 
            broadcastLogger.debug(`메시지 전송 성공 (${id})`);
          }
        } catch(e){ 
          broadcastLogger.warn(`채널 전송 실패 (${id})`, e.message); 
        }
        await sleep(CFG.BROADCAST_GAP);
      }
      res();
    } catch(e){rej(e);}
  }
  qBusy=false;
}

function aiField(ai) {
  if (!ai) return null;
  return { name: `🤖 AI 예측 (${ai.provider})`, value: `**예상 최대여진:** M ${Number(ai.predictedMagnitude).toFixed(1)} (${sane(ai.aftershockProbability,100)})\n**💡 조언:** ${sane(ai.advice,500)}\n*(제공: ${sane(ai.provider,60)})*`, inline: false };
}

function buildKR({title,footer,loc,mag,depth,intensity,time,lat,lon,extra=[]}) {
  const {color,em}=magStyle(mag??0);
  const f=[
    {name:'📍 진원지',value:sane(loc||'알 수 없음',256),inline:false},
    {name:'📏 규모',value:mag!=null?`${em} M ${Number(mag).toFixed(1)}`:'-',inline:true},
    {name:'🕐 발생',value:fmtDate(time)||'-',inline:true},
  ];
  if(depth!=null) f.push({name:'🔽 깊이',value:`${Number(depth).toFixed(0)} km`,inline:true});
  if(intensity!=null) f.push({name:'📊 최대진도',value:sane(intensity,20),inline:true});
  for(const e of extra) if(e) f.push(e);
  f.push({name:'🗺️ 지도',value:`[Google Maps](${gmap(lat,lon,loc)})`,inline:true});
  return new EmbedBuilder().setTitle(sane(title,256)).setColor(color).addFields(f).setFooter({text:sane(footer,100)}).setTimestamp();
}
// JMA는 이제 지진과 쓰나미만 다룸 (화산 제거)
function buildJP({title,footer,titleKo,contentKo,mag,depth,lat,lon,isTsunami,extra=[]}) {
  const {color:bc,em}=mag?magStyle(mag):{color:0x5865F2,em:'⚪'};
  const color=isTsunami?0x0000FF:bc;
  const f=[{name:'📍 제목',value:sane(titleKo,256)}];
  if(mag!=null) f.push({name:'📏 규모',value:`${em} M ${Number(mag).toFixed(1)}`,inline:true});
  if(depth!=null) f.push({name:'🔽 깊이',value:`${Number(depth).toFixed(0)} km`,inline:true});
  for(const e of extra) if(e) f.push(e);
  f.push({name:'🗺️ 지도',value:`[Google Maps](${gmap(lat,lon,titleKo)})`,inline:true});
  const e2=new EmbedBuilder().setTitle(sane(title,256)).setColor(color).addFields(f).setFooter({text:sane(footer,100)}).setTimestamp();
  if(contentKo) e2.setDescription(sane(contentKo,CFG.EMBED_MAX));
  return e2;
}
function buildINT({mag,place,time,depth,lat,lon,alert,tsunami,sig,magType,url,extra=[], customTitle, customFooter}) {
  const {color:bc,em}=magStyle(mag??0);
  const pg=pagerMeta(alert); const color=alert&&alert!=='green'?pg.color:bc;
  const isMajor=tsunami||(alert&&alert!=='green')||(sig??0)>=600;
  const title = customTitle || (tsunami?'🌊 쓰나미 경보 동반 지진 (USGS)':isMajor?'🚨 중요 국외 지진 (USGS)':'🌐 국외 지진 발생 (USGS)');
  const footer = customFooter || 'USGS';

  const f=[
    {name:'📍 위치',value:sane(place,256),inline:false},
    {name:'📏 규모',value:mag!=null?`${em} M ${Number(mag).toFixed(1)}${magType?` (${magType})`:''}`:'-',inline:true},
    {name:'🕐 발생',value:fmtDate(time)||'-',inline:true},
  ];
  if(depth!=null) f.push({name:'🔽 깊이',value:`${Number(depth).toFixed(0)} km`,inline:true});
  if(alert) f.push({name:'⚠️ PAGER',value:`${pg.em} ${pg.label} (${sane(alert,20)})`,inline:true});
  if(tsunami) f.push({name:'🌊 쓰나미',value:'⚠️ 경보 발령',inline:true});
  if(sig>0) f.push({name:'📊 중요도',value:`${sig} / 1000`,inline:true});
  for(const e of extra) if(e) f.push(e);
  f.push({name:'🗺️ 지도',value:`[Google Maps](${gmap(lat,lon,place)})`,inline:true});
  if(url) f.push({name:'🔗 상세',value:`[USGS 페이지](${sane(url,300)})`,inline:true});
  return new EmbedBuilder().setTitle(title).setColor(color).addFields(f).setFooter({text:footer}).setTimestamp(time?new Date(time):new Date());
}
const ndmsMeta = t => {
  const TS = [
    {keys:['지진'],color:0xFF6600,em:'🌏'}, {keys:['화재','산불'],color:0xFF2200,em:'🔥'},
    {keys:['홍수','호우','침수','해일','쓰나미'],color:0x0055FF,em:'🌊'}, {keys:['태풍','강풍'],color:0x0099CC,em:'🌀'},
    {keys:['대설','폭설','한파'],color:0xAADDFF,em:'❄️'}, {keys:['폭염','고온'],color:0xFF4400,em:'🌡️'},
    {keys:['방사능','방사선','원전'],color:0xFFFF00,em:'☢️'}
  ];
  for (const e of TS) if (e.keys.some(k=>t.includes(k))) return e; return {color:0x778899,em:'📢'};
};

/* ══════════════════════════════════════════════════════════════
   §11. 에러 자동 알림 (Error / Recovery)
══════════════════════════════════════════════════════════════ */
const ERR_CD = Object.fromEntries(['kma','jma','ndms','usgs'].map(k=>[k,{msg:'',at:0}]));
async function notifyErr(src, err) {
  const logger = new Logger(src);
  if (err?.cbOpen) return;
  const msg = err?.response?.data ? JSON.stringify(err.response.data).slice(0,300) : (err?.message??'Unknown');
  logger.error(msg, err?.stack || 'no stack');
  const now = Date.now(), c = ERR_CD[src];
  if(c.msg === msg && now - c.at < CFG.ERR_CD_MS) {
    logger.debug('오류 알림 쿨다운 중');
    return;
  }
  c.msg = msg; c.at = now;

  const errorEmbed = new EmbedBuilder().setTitle(`⚠️ [${src.toUpperCase()}] API 오류`).setColor(0xFF0000).addFields({name:'내용',value:sane(msg,512)},{name:'다음 시도',value:'20분 후',inline:true}).setTimestamp();
  const gatekeeperResult = await aiManager.gatekeeperCheck(errorEmbed.toJSON().description || errorEmbed.toJSON().title).catch(() => ({ok: true, issues: []}));
  
  if (!gatekeeperResult.ok) {
    logger.critical(`Gatekeeper가 오류 알림 임베드 거부 (원본: ${src})`, gatekeeperResult.issues.join(', '));
    // Fallback: send simple text message to owner if gatekeeper blocks error notification
    if (ENV.OWNER_ID) {
        try {
            const owner = await discord.users.fetch(ENV.OWNER_ID);
            await owner.send(`[CRITICAL] Gatekeeper blocked error from ${src}: ${msg}. Issues: ${gatekeeperResult.issues.join(', ')}`)
                       .catch(e => logger.error('Fallback owner notification failed', e.message));
        } catch (e) {
            logger.error('Fallback owner user fetch failed', e.message);
        }
    }
    return; // Don't send potentially malformed error notification
  }
  await broadcast({embeds:[errorEmbed]}).catch(e => logger.error('오류 알림 전송 실패', e.message));
}
async function notifyRecover(src, n) {
  const logger = new Logger(src);
  logger.info(`복구 완료 (${n}번째)`);
  const recoveryEmbed = new EmbedBuilder().setTitle(`✅[${src.toUpperCase()}] 복구됨`).setColor(0x00FF99).setDescription(`${n}번째 시도에서 성공했습니다.`).setTimestamp();
  const gatekeeperResult = await aiManager.gatekeeperCheck(recoveryEmbed.toJSON().description || recoveryEmbed.toJSON().title).catch(() => ({ok: true, issues: []}));
  
  if (!gatekeeperResult.ok) {
    logger.critical(`Gatekeeper가 복구 알림 임베드 거부 (원본: ${src})`, gatekeeperResult.issues.join(', '));
    // Fallback: send simple text message to owner
    if (ENV.OWNER_ID) {
        try {
            const owner = await discord.users.fetch(ENV.OWNER_ID);
            await owner.send(`[CRITICAL] Gatekeeper blocked recovery from ${src}. Issues: ${gatekeeperResult.issues.join(', ')}`)
                       .catch(e => logger.error('Fallback owner recovery notification failed', e.message));
        } catch (e) {
            logger.error('Fallback owner user fetch failed', e.message);
        }
    }
    return;
  }
  await broadcast({embeds:[recoveryEmbed]}).catch(e => logger.error('복구 알림 전송 실패', e.message));
}

/* ══════════════════════════════════════════════════════════════
   §12. 데이터 수집 로직 (NDMS, KMA, JMA, USGS)
══════════════════════════════════════════════════════════════ */
async function fetchNDMS() {
  const logger = new Logger('NDMS');
  if (!ENV.SAFETY_KEY) { logger.warn('SAFETY_KEY 없음, 스킵'); return; }
  pruneSent();
  try {
    const items = await CB.ndms.exec(() => withRetry(async () => {
      const { data } = await HTTP.get(`https://www.safetydata.go.kr/V2/api/DSSP-IF-00247?serviceKey=${encodeURIComponent(ENV.SAFETY_KEY)}&returnType=json&numOfRows=5&pageNo=1`);
      const body = data?.body ?? data?.Body ?? data?.response?.body ?? data;
      if (Array.isArray(body)) return body[0]?.data ?? body[0]?.items ?? [];
      return body?.data ?? body?.items ??[];
    }, 'NDMS'));
    let dirty = false;
    for (const e of (Array.isArray(items)?items:(items?[items]:[]))) {
      const id = sane(e.MD101_SN??e.msgId??'', 100); if (!id || SENT.ndms.has(id)) continue;
      markSent('ndms', id); dirty = true;
      const type = sane(e.DSSTR_SE_NM??'기타', 50), meta = ndmsMeta(type);
      const embed = new EmbedBuilder().setTitle(`${meta.em} 긴급 재난 문자 — ${type}`).setColor(meta.color).setDescription(sane(e.MSG_CN??'',CFG.EMBED_MAX)).addFields({name:'📍 지역',value:sane(e.RCV_AREA_NM??'전국',200),inline:true},{name:'🕐 발령',value:fmtDate((e.CRT_DT??'').replace(/\//g,'-')),inline:true}).setFooter({text:'행정안전부'}).setTimestamp();
      
      const gatekeeperResult = await aiManager.gatekeeperCheck(embed.toJSON().description || embed.toJSON().title).catch(() => ({ok: true, issues: []}));
      if (!gatekeeperResult.ok) {
        logger.critical(`Gatekeeper가 NDMS 알림 거부`, gatekeeperResult.issues.join(', '));
        continue;
      }
      await broadcast({embeds:[embed]});
    }
    if(dirty) await persist('ndms');
    const rc = onOk('ndms'); if(rc) await notifyRecover('ndms',rc);
  } catch(err) { if(!err?.cbOpen) onErr('ndms'); await notifyErr('ndms',err); }
}

async function fetchKMA() {
  const logger = new Logger('KMA');
  if (!ENV.KMA_KEY) { logger.warn('KMA_KEY 없음, 스킵'); return; }
  try {
    const rows = await CB.kma.exec(() => withRetry(async () => {
      const now = new Date(Date.now() + 9*3_600_000), to = now.toISOString().slice(0,10).replace(/-/g,'');
      const from = new Date(+now - 2*86_400_000).toISOString().slice(0,10).replace(/-/g,'');
      const { data } = await HTTP.get(`http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg?serviceKey=${encodeURIComponent(ENV.KMA_KEY)}&numOfRows=10&pageNo=1&dataType=JSON&fromTmFc=${from}&toTmFc=${to}`);
      const code = String(data?.response?.header?.resultCode??'');
      if (code && !CFG.KMA_OK.has(code)) throw new Error(`API 응답 코드 오류: ${code}`);
      const raw = data?.response?.body?.items?.item; return Array.isArray(raw)?raw:(raw?[raw]:[]);
    }, 'KMA'));
    let dirty = false;
    for (const e of rows) {
      const id = `${e.tmEqk}_${sane(e.loc,100)}`; if (!e.tmEqk || SENT.kma.has(id)) continue;
      const mag = e.mt!=null?+e.mt:null, dep = e.dep!=null?+e.dep:null, lat = e.tmLa!=null?+e.tmLa:null, lon = e.tmLo!=null?+e.tmLo:null;
      if (isDuplicateEvent({src:'KMA',lat,lon,mag,timeMs:Date.now()})) { markSent('kma',id); dirty=true; continue; }
      markSent('kma',id); dirty=true;
      const ai = await predictAftershock({loc:sane(e.loc,200),time:String(e.tmEqk),mag,depth:dep,lat,lon});
      const embed = buildKR({title:'🌏 국내 지진 발생 (기상청)',footer:'기상청 지진 정보',loc:sane(e.loc,256),mag,depth:dep,intensity:e.mtSt!=null?sane(e.mtSt,20):null,time:String(e.tmEqk),lat,lon,extra:[aiField(ai)].filter(Boolean)});

      const gatekeeperResult = await aiManager.gatekeeperCheck(embed.toJSON().description || embed.toJSON().title).catch(() => ({ok: true, issues: []}));
      if (!gatekeeperResult.ok) {
        logger.critical(`Gatekeeper가 KMA 알림 거부`, gatekeeperResult.issues.join(', '));
        continue;
      }
      await broadcast({embeds:[embed]});
    }
    if(dirty) await persist('kma');
    const rc = onOk('kma'); if(rc) await notifyRecover('kma',rc);
  } catch(err) { if(!err?.cbOpen) onErr('kma'); await notifyErr('kma',err); }
}

async function fetchJMA() {
  const logger = new Logger('JMA');
  try {
    const entries = await CB.jma.exec(() => withRetry(async () => {
      const {data} = await HTTP.get('https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml', {headers:{Accept:'application/xml, text/xml'}});
      const parser = new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',trimValues:true});
      const e = parser.parse(data)?.feed?.entry; return Array.isArray(e)?e.slice(0,10):(e?[e]:[]);
    }, 'JMA'));
    let dirty = false;
    for (const e of entries) {
      const id = sane(e.id??e['@_id']??'',300); if(!id||SENT.jma.has(id)) continue;
      const rawTitle = typeof e.title==='string'?e.title:(e.title?.['#text']??'');
      const rawContent = typeof e.content==='string'?e.content:(e.content?.['#text']??rawTitle);
      const rawSummary = typeof e.summary==='string'?e.summary:(e.summary?.['#text']??'');
      
      // 화산 정보는 스킵 (제목에 '火山' 또는 '噴火'가 포함된 경우)
      if (rawTitle.includes('火山') || rawTitle.includes('噴火')) {
        logger.info(`화산 정보 스킵: ${rawTitle}`);
        markSent('jma', id); dirty = true;
        continue;
      }

      const [titleKo,contentKo] = await Promise.all([toKo(rawTitle),toKo(rawContent||rawSummary||rawTitle)]);
      const nums = parseJMANums(rawContent||rawSummary||rawTitle);
      const isTsunami = /津波/.test(rawTitle);
      const timeMs = e.updated ? new Date(e.updated).getTime() : null;
      if (isDuplicateEvent({src:'JMA',lat:nums.lat,lon:nums.lon,mag:nums.mag,timeMs})) { markSent('jma',id); dirty=true; continue; }
      markSent('jma',id); dirty = true;
      const ai = (nums.mag != null) ? await predictAftershock({loc:titleKo,time:e.updated??'',mag:nums.mag,depth:nums.depth,lat:nums.lat,lon:nums.lon}) : null;
      const title = isTsunami?'🌊 쓰나미 경보 (JMA)':'🌏 일본 지진 발생 (JMA)';
      const embed = buildJP({title,footer:'일본 기상청 (JMA)',titleKo,contentKo,mag:nums.mag,depth:nums.depth,lat:nums.lat,lon:nums.lon,isTsunami,extra:[aiField(ai)].filter(Boolean)});

      const gatekeeperResult = await aiManager.gatekeeperCheck(embed.toJSON().description || embed.toJSON().title).catch(() => ({ok: true, issues: []}));
      if (!gatekeeperResult.ok) {
        logger.critical(`Gatekeeper가 JMA 알림 거부`, gatekeeperResult.issues.join(', '));
        continue;
      }
      await broadcast({embeds:[embed]});
    }
    if(dirty) await persist('jma');
    const rc = onOk('jma'); if(rc) await notifyRecover('jma',rc);
  } catch(err) { if(!err?.cbOpen) onErr('jma'); await notifyErr('jma',err); }
}

let usgsAfter = null;
async function fetchUSGS() {
  const logger = new Logger('USGS');
  try {
    const features = await CB.usgs.exec(() => withRetry(async () => {
      const after = usgsAfter ?? new Date(Date.now()-10*60_000).toISOString();
      const qs = new URLSearchParams({format:'geojson',updatedafter:after,minmagnitude:String(CFG.USGS_MIN_MAG),orderby:'time',limit:String(CFG.USGS_LIMIT)});
      const {data} = await HTTP.get(`${CFG.USGS_URL}?${qs}`);
      if (!data?.features) throw new Error('features 없음');
      usgsAfter = new Date().toISOString(); return data.features;
    }, 'USGS'));
    let dirty = false;
    for (const f of features) {
      const id = sane(f.id??'',200); if(!id||SENT.usgs.has(id)) continue;
      const p = f.properties??{}, geo = f.geometry?.coordinates;
      const lon = geo?.[0]??null, lat = geo?.[1]??null, depth = geo?.[2]??null, mag = p.mag!=null?+p.mag:null, timeMs = p.time??null;
      if (isDuplicateEvent({src:'USGS',lat,lon,mag,timeMs})) { markSent('usgs',id); dirty=true; continue; }
      markSent('usgs',id); dirty=true;
      const ai = await predictAftershock({loc:sane(p.place,200),time:timeMs,mag,depth,lat,lon});
      const region = geoRegion(lat,lon), extraFields = [aiField(ai)].filter(Boolean);
      let embed;
      const isMajor = p.tsunami===1 || (p.alert && p.alert!=='green') || (p.sig??0)>=600;

      if (region==='KR') {
        embed = buildKR({
          title:'🌏 국내 인근 지진 (USGS 보조)',
          footer:'USGS · 한반도 지역',
          loc:sane(p.place,256),mag,depth,intensity:null,time:timeMs,lat,lon,
          extra:[...(p.alert?[{name:'⚠️ PAGER',value:`${pagerMeta(p.alert).em} ${pagerMeta(p.alert).label}`,inline:true}]:[]),...extraFields]
        });
      } else if (region==='TW_KAMCHATKA') {
        const placeKo = await toKo(p.place??'');
        embed = buildINT({
          mag,
          place: sane(p.place,256),
          time: timeMs,
          depth,
          lat,
          lon,
          alert: p.alert,
          tsunami: p.tsunami===1,
          sig: p.sig??0,
          magType: sane(p.magType,20),
          url: sane(p.url,300),
          extra: [
            { name: '📍 현지 위치 (번역)', value: placeKo, inline: false },
            ...extraFields
          ],
          customTitle: p.tsunami===1?'🌊 쓰나미 경보 동반 지진 (USGS 서태평양/극동)':isMajor?'🚨 중요 서태평양/극동 지진 (USGS)':'🌐 서태평양/극동 지진 발생 (USGS)',
          customFooter: 'USGS · 서태평양/극동 지역'
        });
      } else { // Default International
        embed = buildINT({
          mag,place:sane(p.place,256),time:timeMs,depth,lat,lon,
          alert:p.alert,tsunami:p.tsunami===1,sig:p.sig??0,magType:sane(p.magType,20),url:sane(p.url,300),
          extra:extraFields
        });
      }

      const gatekeeperResult = await aiManager.gatekeeperCheck(embed.toJSON().description || embed.toJSON().title).catch(() => ({ok: true, issues: []}));
      if (!gatekeeperResult.ok) {
        logger.critical(`Gatekeeper가 USGS 알림 거부`, gatekeeperResult.issues.join(', '));
        continue;
      }
      await broadcast({embeds:[embed]});
    }
    if(dirty) await persist('usgs');
    const rc = onOk('usgs'); if(rc) await notifyRecover('usgs',rc);
  } catch(err) { if(!err?.cbOpen) onErr('usgs'); await notifyErr('usgs',err); }
}

/* ══════════════════════════════════════════════════════════════
   §13. Anti-Raid & 감사 로그 빌더
══════════════════════════════════════════════════════════════ */
const mentionLog = new Map();
const channelLog = new Map();
const auditLogger = new Logger('AUDIT');

async function sendAuditLog(guildId, embed) {
  const chId = getLogChannel(guildId); 
  if (!chId) { auditLogger.debug(`감사 로그 채널 설정되지 않음 (${guildId})`); return; }
  try { 
    const ch = await discord.channels.fetch(chId); 
    if (ch?.isTextBased()) await ch.send({ embeds:[embed] }); 
  } catch(e){ auditLogger.warn(`감사 로그 전송 실패 (${chId})`, e.message); }
}
function buildAuditEmbed({ actor, actorAvatar, target, action, before, after, targetId, color=0x5865F2 }) {
  const timeStr = new Date().toLocaleString('en-US', { timeZone:'Asia/Seoul', hour:'numeric', minute:'2-digit', hour12:true });
  const embed = new EmbedBuilder().setColor(color).setAuthor({ name: sane(actor,100), iconURL: actorAvatar??undefined })
    .setDescription(`**${sane(target,100)}** ${sane(action,200)}`).setFooter({ text: `ID: ${sane(targetId,25)} | Today at ${timeStr}` });
  if (before != null) embed.addFields({ name:'**Before**', value:sane(before,512), inline:false });
  if (after  != null) embed.addFields({ name:'**After**',  value:sane(after,512),  inline:false });
  return embed;
}

async function handleEveryoneMention(msg) {
  const logger = new Logger('ANTI_RAID');
  if (!msg.guild || !msg.mentions.everyone) return;
  const uid = msg.author.id, now = Date.now(), win = CFG.RAID_MENTION_SEC * 1_000;
  const times = (mentionLog.get(uid) ??[]).filter(t => now - t < win);
  times.push(now); mentionLog.set(uid, times);
  if (mentionLog.size > 1000) mentionLog.clear(); // 메모리 관리

  if (times.length >= CFG.RAID_MENTION_LIMIT) {
    mentionLog.delete(uid);
    logger.critical(`@everyone 스팸 감지`, `User: ${uid}, Count: ${times.length}`);
    try {
      const fetched = await msg.channel.messages.fetch({ limit: 100 });
      const toDel = fetched.filter(m => m.author.id === uid && m.createdTimestamp > now - CFG.BULK_DELETE_MS);
      if (toDel.size > 0) {
        logger.warn(`사용자 메시지 ${toDel.size}개 삭제 시도`);
        await msg.channel.bulkDelete(toDel, true).catch(e=>logger.error(`대량 메시지 삭제 실패`,e.message));
      }
      logger.warn(`사용자 밴 시도: ${uid}`);
      await msg.guild.members.ban(uid, { reason: '[자동] @everyone 스팸 (Anti-Raid)', deleteMessageSeconds: 604800 }).catch(e=>logger.error(`사용자 밴 실패`,e.message));
      await sendAuditLog(msg.guild.id, buildAuditEmbed({actor:'봇 자동 처리 (Anti-Raid)', target:`@${sane(msg.author.tag,100)}`, action:'was permanently banned (everyone spam)', before:`${times.length}회 / ${CFG.RAID_MENTION_SEC}초`, after:'영구 서버 차단', targetId:uid, color:0xFF0000}));
    } catch(e) { logger.error(`@everyone 처리 중 오류`,e.message); }
  }
}
async function handleChannelCreate(channel) {
  const logger = new Logger('ANTI_RAID');
  if (!channel.guild) return;
  const now = Date.now(), win = CFG.RAID_CH_SEC * 1_000;
  const state = channelLog.get(channel.guild.id) ?? { timestamps:[], channels:[], creatorId:null };
  state.timestamps = state.timestamps.filter(t => now - t < win);
  state.timestamps.push(now); state.channels.push(channel.id);
  
  try {
    const logs = await channel.guild.fetchAuditLogs({type:AuditLogEvent.ChannelCreate,limit:1});
    const entry = logs.entries.first();
    if (entry && now - entry.createdTimestamp < 5_000) state.creatorId = entry.executor?.id ?? null;
  } catch(e) { logger.warn(`채널 생성 감사 로그 조회 실패`,e.message); }
  channelLog.set(channel.guild.id, state);

  if (state.timestamps.length >= CFG.RAID_CH_LIMIT) {
    channelLog.delete(channel.guild.id);
    logger.critical(`채널 홍수 감지`, `Guild: ${channel.guild.id}, Count: ${state.timestamps.length}`);
    const deleted =[];
    for (const chId of state.channels) {
      try { const ch = await discord.channels.fetch(chId).catch(()=>null); if (ch) { await ch.delete(); deleted.push(chId); } } catch(e){ logger.error(`채널 삭제 실패 (${chId})`,e.message); }
    }
    if (state.creatorId && state.creatorId !== discord.user?.id) {
      logger.warn(`채널 홍수 생성자 밴 시도: ${state.creatorId}`);
      try { await channel.guild.members.ban(state.creatorId, { reason: '[자동] 채널 홍수', deleteMessageSeconds: 604800 }); } catch(e){ logger.error(`채널 홍수 사용자 밴 실패`,e.message); }
    }
    await sendAuditLog(channel.guild.id, buildAuditEmbed({actor:'봇 자동 처리 (Anti-Raid)', target:state.creatorId?`<@${state.creatorId}>`:'알 수 없음', action:`channel flood detected — ${deleted.length}개 삭제`, before:`${state.timestamps.length}개 / ${CFG.RAID_CH_SEC}초`, after:`삭제 및 영구차단`, targetId:state.creatorId??'N/A', color:0xFF4500}));
  }
}

const auditHandlers = {
  nickChange: async (o,n) => { if (o.nickname!==n.nickname) await sendAuditLog(n.guild.id, buildAuditEmbed({actor:n.user.tag, actorAvatar:n.user.displayAvatarURL(), target:`@${n.user.username}`, action:'nickname changed', before:o.nickname??o.user.username, after:n.nickname??n.user.username, targetId:n.id, color:0x5865F2})); },
  roleChange: async (o,n) => {
    const added=n.roles.cache.filter(r=>!o.roles.cache.has(r.id)), removed=o.roles.cache.filter(r=>!n.roles.cache.has(r.id));
    if (added.size>0 || removed.size>0) await sendAuditLog(n.guild.id, buildAuditEmbed({actor:n.user.tag, actorAvatar:n.user.displayAvatarURL(), target:`@${n.user.username}`, action:'role updated', before:removed.size>0?`제거: ${removed.map(r=>`@${r.name}`).join(', ')}`:null, after:added.size>0?`추가: ${added.map(r=>`@${r.name}`).join(', ')}`:null, targetId:n.id, color:0xFFA500}));
  },
  memberJoin: async m => sendAuditLog(m.guild.id, buildAuditEmbed({actor:m.user.tag, actorAvatar:m.user.displayAvatarURL(), target:`@${m.user.username}`, action:'joined the server', before:null, after:`계정 생성: ${fmtDate(m.user.createdAt)}`, targetId:m.id, color:0x00FF99})),
  memberLeave: async m => sendAuditLog(m.guild.id, buildAuditEmbed({actor:m.user.tag, actorAvatar:m.user.displayAvatarURL(), target:`@${m.user.username}`, action:'left the server', before:`입장: ${fmtDate(m.joinedAt)}`, after:null, targetId:m.id, color:0x808080})),
  memberBan: async (g,u) => sendAuditLog(g.id, buildAuditEmbed({actor:u.tag, actorAvatar:u.displayAvatarURL?.(), target:`@${u.username}`, action:'was banned', before:null, after:'영구 차단', targetId:u.id, color:0xFF0000})),
  memberUnban: async (g,u) => sendAuditLog(g.id, buildAuditEmbed({actor:u.tag, actorAvatar:u.displayAvatarURL?.(), target:`@${u.username}`, action:'was unbanned', before:'차단됨', after:'차단 해제', targetId:u.id, color:0x00AAFF})),
  msgUpdate: async (o,n) => { if (n.guild&&n.author&&!n.author.bot&&o.content!==n.content) await sendAuditLog(n.guild.id, buildAuditEmbed({actor:n.author.tag, actorAvatar:n.author.displayAvatarURL(), target:`@${n.author.username}`, action:`message edited in <#${n.channel.id}>`, before:o.content||'(내용 없음)', after:n.content||'(내용 없음)', targetId:n.author.id, color:0xFFCC00})); },
  msgDelete: async m => { if (m.guild&&m.author&&!m.author.bot) await sendAuditLog(m.guild.id, buildAuditEmbed({actor:m.author.tag, actorAvatar:m.author.displayAvatarURL(), target:`@${m.author.username}`, action:`message deleted in <#${m.channel.id}>`, before:m.content||'(내용 없음)', after:null, targetId:m.author.id, color:0xFF6600})); },
  chCreate: async ch => { if (ch.guild) await sendAuditLog(ch.guild.id, buildAuditEmbed({actor:'서버', actorAvatar:ch.guild.iconURL()??undefined, target:`#${ch.name}`, action:'channel created', before:null, after:`타입: ${ch.type} · ID: ${ch.id}`, targetId:ch.id, color:0x27AE60})); },
  chDelete: async ch => { if (ch.guild) await sendAuditLog(ch.guild.id, buildAuditEmbed({actor:'서버', actorAvatar:ch.guild.iconURL()??undefined, target:`#${ch.name}`, action:'channel deleted', before:`ID: ${ch.id}`, after:null, targetId:ch.id, color:0xFF4500})); },
};

/* ══════════════════════════════════════════════════════════════
   §14. 슬래시 커맨드 (Slash Commands)
══════════════════════════════════════════════════════════════ */
const CMDS =[
  { name:'상태',   description:'봇 및 API 상태 확인' },
  { name:'마지막', description:'마지막 성공 조회 시각' },
  { name:'중복',   description:'Cross-Source 중복 판별 현황' },
  { name:'지역',   description:'USGS 지역 분류 기준' },
  { name:'도움말', description:'봇 기능 전체 안내' },
  { name:'청소',   description:'캐시 초기화 (OWNER 전용)' },
  { name:'알림', description:'재난 알림 채널 설정 (OWNER 전용)', options:[{name:'채널id',description:'채널 ID',type:ApplicationCommandOptionType.String,required:true}] },
  { name:'로그', description:'감사 로그 채널 설정 (OWNER 전용)', options:[{name:'채널id',description:'채널 ID',type:ApplicationCommandOptionType.String,required:true}] },
  { name:'지도', description:'구글 지도로 위치 검색', options:[{name:'위치', description:'검색할 위치 또는 지진 좌표 (예: 37.56,126.97)', type:ApplicationCommandOptionType.String, required:true}] },
  { name:'소스', description:'데이터 소스 관리 (OWNER 전용)', options:[
    {name:'액션', description:'수행할 액션', type:ApplicationCommandOptionType.String, required:true, choices:[
      {name:'상태', value:'status'}, {name:'새로고침_NDMS', value:'refresh_ndms'}, 
      {name:'새로고침_KMA', value:'refresh_kma'}, {name:'새로고침_JMA', value:'refresh_jma'}, 
      {name:'새로고침_USGS', value:'refresh_usgs'}, {name:'CB_초기화_NDMS', value:'reset_cb_ndms'},
      {name:'CB_초기화_KMA', value:'reset_cb_kma'}, {name:'CB_초기화_JMA', value:'reset_cb_jma'},
      {name:'CB_초기화_USGS', value:'reset_cb_usgs'}
    ]}
  ]}
];

discord.on(Events.InteractionCreate, async ix => {
  if (!ix.isChatInputCommand()) return;
  const cmd = ix.commandName;
  const logger = new Logger('CMD');
  const isOwner = !ENV.OWNER_ID || ix.user.id === ENV.OWNER_ID; 

  if (['청소','알림','로그','소스'].includes(cmd) && !isOwner) {
    return ix.reply({content:'❌ OWNER 전용 명령어입니다.',ephemeral:true}).catch(e=>logger.error(`답변 실패`,e.message));
  }

  try { 
    if (cmd === '알림') {
      const chId = ix.options.getString('채널id','').trim();
      if (!/^\d{17,20}$/.test(chId)) return ix.reply({content:'❌ 올바른 채널 ID (17~20자리 숫자)',ephemeral:true});
      const ch = await discord.channels.fetch(chId).catch(e => { throw new Error(`채널 조회 실패: ${e.message}`); }); 
      if (!ch?.isTextBased()) throw new Error('Text-based 채널이 아닙니다.');
      const gid = ix.guildId??'global'; const cfg = GUILD_CFG.get(gid) ?? {alertChannel:null,logChannel:null};
      cfg.alertChannel = chId; GUILD_CFG.set(gid,cfg); await persist('config');
      return ix.reply({content:`✅ 재난 알림 채널이 <#${chId}>로 설정되었습니다.`,ephemeral:true});
    }

    if (cmd === '로그') {
      const chId = ix.options.getString('채널id','').trim();
      if (!/^\d{17,20}$/.test(chId)) return ix.reply({content:'❌ 올바른 채널 ID (17~20자리 숫자)',ephemeral:true});
      const ch = await discord.channels.fetch(chId).catch(e => { throw new Error(`채널 조회 실패: ${e.message}`); }); 
      if (!ch?.isTextBased()) throw new Error('Text-based 채널이 아닙니다.');
      const gid = ix.guildId??'global'; const cfg = GUILD_CFG.get(gid) ?? {alertChannel:null,logChannel:null};
      cfg.logChannel = chId; GUILD_CFG.set(gid,cfg); await persist('config');
      return ix.reply({content:`✅ 감사 로그 채널이 <#${chId}>로 설정되었습니다.`,ephemeral:true});
    }

    if (cmd === '상태') {
      const up = process.uptime(), anyErr = Object.values(TRK).some(t=>t.streak>0);
      return ix.reply({embeds:[new EmbedBuilder().setTitle('📊 봇 시스템 상태').setColor(anyErr?0xFF6600:0x00FF99).addFields(
        {name:'🕐 가동',value:`${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m ${Math.floor(up%60)}s`,inline:false},
        {name:'📢 NDMS',value:CB.ndms.badge(),inline:true}, {name:'🌏 KMA',value:CB.kma.badge(),inline:true},
        {name:'🗾 JMA',value:CB.jma.badge(),inline:true}, {name:'🌐 USGS',value:CB.usgs.badge(),inline:true},
        {name:'🔄 중복 레코드',value:`${GEV.length} / ${CFG.DEDUP_MAX}`,inline:true},
        {name:'🤖 AI 예측',value:aiManager.isAvailable?'✅ 활성':'⚫ 비활성',inline:true}
      ).setTimestamp()]});
    }

    if (cmd === '마지막') return ix.reply({embeds:[new EmbedBuilder().setTitle('🕐 마지막 성공 조회').setColor(0x5865F2).addFields({name:'📢 NDMS',value:TRK.ndms.lastOk?fmtDate(TRK.ndms.lastOk):'없음',inline:true},{name:'🌏 KMA',value:TRK.kma.lastOk?fmtDate(TRK.kma.lastOk):'없음',inline:true},{name:'🗾 JMA',value:TRK.jma.lastOk?fmtDate(TRK.jma.lastOk):'없음',inline:true},{name:'🌐 USGS',value:TRK.usgs.lastOk?fmtDate(TRK.usgs.lastOk):'없음',inline:true}).setTimestamp()]});
    if (cmd === '중복') {
      const bySrc={}; for (const ev of GEV) bySrc[ev.src]=(bySrc[ev.src]??0)+1;
      return ix.reply({embeds:[new EmbedBuilder().setTitle('🔄 중복 판별').setColor(0x5865F2).addFields({name:'레코드 수',value:`${GEV.length} / ${CFG.DEDUP_MAX}`,inline:true},{name:'소스별',value:Object.entries(bySrc).map(([s,n])=>`${s}: ${n}`).join('\n')||'없음',inline:true},{name:'판별 기준',value:`거리 ≤${CFG.DEDUP_DIST_KM}km · 규모 ±${CFG.DEDUP_MAG_D} · 시각 ±${CFG.DEDUP_TIME_MS/60_000}분`,inline:false}).setTimestamp()]});
    }
    if (cmd === '지역') return ix.reply({embeds:[new EmbedBuilder().setTitle('🗺️ USGS 지역 분류 기준').setColor(0x5865F2).addFields({name:'🇰🇷 KR (대한민국)',value:`위도 ${CFG.GEO.KR.latMin}°~${CFG.GEO.KR.latMax}° / 경도 ${CFG.GEO.KR.lonMin}°~${CFG.GEO.KR.lonMax}°`,inline:false},{name:'🇹🇼🇷🇺 TW_KAMCHATKA (대만 ~ 캄차카반도)',value:`위도 ${CFG.GEO.TW_KAMCHATKA.latMin}°~${CFG.GEO.TW_KAMCHATKA.latMax}° / 경도 ${CFG.GEO.TW_KAMCHATKA.lonMin}°~${CFG.GEO.TW_KAMCHATKA.lonMax}°`,inline:false},{name:'🌐 INT (기타 국제)',value:'위 두 범위 외 전 세계',inline:false}).setTimestamp()]});
    
    if (cmd === '청소') {
      Object.values(SENT).forEach(m=>m.clear()); Object.values(ERR_CD).forEach(c=>{c.msg='';c.at=0;}); XL.clear(); GEV.length=0; usgsAfter=null; mentionLog.clear(); channelLog.clear();
      await Promise.all(Object.keys(FILE).map(key => persist(key))); // All files, including config
      return ix.reply({content:`🧹 캐시 완전 초기화 완료`, ephemeral:true});
    }

    if (cmd === '도움말') return ix.reply({embeds:[new EmbedBuilder().setTitle('📖 봇 v10.0.0 도움말').setColor(0x5865F2).setDescription('국내외 지진·쓰나미·재난문자 통합 실시간 알림 봇 (AI 예측 탑재)').addFields({name:'📢 수집 소스', value:'NDMS(2분) / KMA(5분) / JMA(5분, 자동번역) / USGS(5분, M4.5+ 분류)'},{name:'🤖 AI 예측 (M5.0+)', value:'Gemini → Groq(Llama 3.3) / Cerebras(Llama 3.1) 협의 파이프라인으로 여진 및 행동요령 분석'},{name:'🛡️ 기능', value:'Anti-Raid(도배 차단), 감사 로그, Cross-Source 중복 전송 방지'},{name:'⚙️ 관리자', value:'`/알림` `/로그` `/청소`'}, {name:'📍 지도', value:'`/지도` 명령어로 구글 맵스에서 위치 검색'}, {name:'🛠️ 소스 관리 (OWNER)', value:'`/소스` 명령어로 데이터 소스 상태 확인 및 제어'}).setTimestamp()]});

    if (cmd === '지도') {
      const query = ix.options.getString('위치');
      const geoMatch = query.match(/(\d+\.?\d*)\s*,\s*(\d+\.?\d*)/); // Check for lat,lon pattern
      let mapUrl;
      if (geoMatch) {
        const lat = parseFloat(geoMatch[1]);
        const lon = parseFloat(geoMatch[2]);
        mapUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
      } else {
        mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
      }
      await ix.reply({ embeds: [new EmbedBuilder().setTitle(`🗺️ ${sane(query, 256)} 검색 결과`).setDescription(`[Google Maps에서 보기](${mapUrl})`).setColor(0x34A853).setTimestamp()], ephemeral: true });
    }

    if (cmd === '소스') {
      const action = ix.options.getString('액션');
      const sourceMap = {
        'ndms': {fetch: fetchNDMS, cb: CB.ndms},
        'kma': {fetch: fetchKMA, cb: CB.kma},
        'jma': {fetch: fetchJMA, cb: CB.jma},
        'usgs': {fetch: fetchUSGS, cb: CB.usgs}
      };
      
      if (action === 'status') {
        return ix.reply({embeds:[new EmbedBuilder().setTitle('📊 데이터 소스 상태').setColor(0x5865F2).addFields(
          {name:'📢 NDMS',value:`상태: ${CB.ndms.badge()} | 마지막 성공: ${TRK.ndms.lastOk?fmtDate(TRK.ndms.lastOk):'없음'}`,inline:false},
          {name:'🌏 KMA',value:`상태: ${CB.kma.badge()} | 마지막 성공: ${TRK.kma.lastOk?fmtDate(TRK.kma.lastOk):'없음'}`,inline:false},
          {name:'🗾 JMA',value:`상태: ${CB.jma.badge()} | 마지막 성공: ${TRK.jma.lastOk?fmtDate(TRK.jma.lastOk):'없음'}`,inline:false},
          {name:'🌐 USGS',value:`상태: ${CB.usgs.badge()} | 마지막 성공: ${TRK.usgs.lastOk?fmtDate(TRK.usgs.lastOk):'없음'}`,inline:false},
        ).setTimestamp()], ephemeral:true});
      } else if (action.startsWith('refresh_')) {
        const srcId = action.split('_')[1];
        const source = sourceMap[srcId];
        if (source) {
          await ix.deferReply({ephemeral:true});
          await source.fetch();
          return ix.editReply(`✅ ${srcId.toUpperCase()} 데이터 새로고침을 시도했습니다.`);
        }
      } else if (action.startsWith('reset_cb_')) {
        const srcId = action.split('_')[2];
        const source = sourceMap[srcId];
        if (source) {
          source.cb.forceClose();
          return ix.reply({content:`✅ ${srcId.toUpperCase()} 서킷 브레이커를 강제로 초기화했습니다.`, ephemeral:true});
        }
      }
      return ix.reply({content:'❌ 알 수 없는 소스 액션입니다.', ephemeral:true});
    }

  } catch (e) {
    logger.error(`명령어 처리 중 오류 (${cmd})`, e.message);
    await ix.reply({content:`❌ 명령어를 처리하는 중 오류가 발생했습니다: ${sane(e.message,100)}`,ephemeral:true}).catch(e=>logger.error(`오류 답변 실패`,e.message));
  }
});

/* ══════════════════════════════════════════════════════════════
   §15. 웹 서버 (Express, Helmet, Rate Limit) & 시작 루프
══════════════════════════════════════════════════════════════ */
const app = express();
const webLogger = new Logger('WEB');
const server = app.listen(CFG.PORT, () => webLogger.info(`포트 ${CFG.PORT}`));

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(rateLimit({ windowMs: 15*60_000, max: 100, standardHeaders: true, legacyHeaders: false }));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_, res) => res.status(Object.values(CB).some(c=>c.isOpen)?503:200).json({ status: 'ok', memoryMB: (process.memoryUsage().rss / 1024 / 1024).toFixed(2), lastFetched: Object.fromEntries(Object.entries(TRK).map(([k,v]) => [k, v.lastOk])) }));
app.use((_,res)=>res.status(404).json({error:'Not Found'}));

discord.once(Events.ClientReady, async () => {
  mainLogger.info(`로그인 완료: ${discord.user.tag}`);
  await initStorage();

  const loops =[
    { fn: fetchNDMS, ms: CFG.MS_NDMS, id: 'ndms' }, { fn: fetchKMA, ms: CFG.MS_EQ, id: 'kma' },
    { fn: fetchJMA, ms: CFG.MS_EQ, id: 'jma' },     { fn: fetchUSGS, ms: CFG.MS_EQ, id: 'usgs' }
  ];
  
  loops.forEach(({ fn, ms, id }) => {
    const loopLogger = new Logger(id);
    const tick = async () => {
      try { await fn(); } catch(e) { /* errors are already logged by notifyErr */ }
      // 다음 실행 시간을 Circuit Breaker 상태 및 오류 스트릭에 따라 동적으로 조절
      const nextRunTime = (TRK[id].streak > 0 || CB[id].isOpen) ? CFG.MS_ERR : ms;
      setTimeout(tick, nextRunTime).unref(); // unref() added for graceful shutdown optimization
    }; 
    // Initial run with a small random delay to prevent thundering herd problem
    setTimeout(tick, Math.random() * 5000).unref();
  });

  if (ENV.APPLICATION_ID) {
    const rest = new REST({version:'10'}).setToken(ENV.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(ENV.APPLICATION_ID),{body:CMDS}).catch(e=>{mainLogger.error('슬래시 커맨드 등록 실패', e.message);});
    mainLogger.info('슬래시 커맨드 등록 완료');
  }
});

/* ══════════════════════════════════════════════════════════════
   §16. 이벤트 리스너 바인딩 (감사 로그, Anti-Raid)
══════════════════════════════════════════════════════════════ */
const eventLogger = new Logger('EVENT');
discord.on(Events.MessageCreate, async msg => { 
  if(!msg.author?.bot) {
    try { await handleEveryoneMention(msg); } catch(e){ eventLogger.error('MessageCreate 이벤트 처리 실패', e.message); }
  }
});
discord.on(Events.ChannelCreate, async ch  => { 
  try { await handleChannelCreate(ch); } catch(e){ eventLogger.error('ChannelCreate Anti-Raid 처리 실패', e.message); }
  try { await auditHandlers.chCreate(ch); } catch(e){ eventLogger.error('ChannelCreate 감사로그 실패', e.message); }
});
discord.on(Events.ChannelDelete, async ch  => { try { await auditHandlers.chDelete(ch); } catch(e){ eventLogger.error('ChannelDelete 감사로그 실패', e.message); } });
discord.on(Events.GuildMemberAdd, async m  => { try { await auditHandlers.memberJoin(m); } catch(e){ eventLogger.error('GuildMemberAdd 감사로그 실패', e.message); } });
discord.on(Events.GuildMemberRemove, async m => { try { await auditHandlers.memberLeave(m); } catch(e){ eventLogger.error('GuildMemberRemove 감사로그 실패', e.message); } });
discord.on(Events.GuildBanAdd, async (g,u) => { try { await auditHandlers.memberBan(g,u); } catch(e){ eventLogger.error('GuildBanAdd 감사로그 실패', e.message); } });
discord.on(Events.GuildBanRemove, async (g,u) => { try { await auditHandlers.memberUnban(g,u); } catch(e){ eventLogger.error('GuildBanRemove 감사로그 실패', e.message); } });
discord.on(Events.MessageUpdate, async (o,n) => { try { await auditHandlers.msgUpdate(o,n); } catch(e){ eventLogger.error('MessageUpdate 감사로그 실패', e.message); } });
discord.on(Events.MessageDelete, async m   => { try { await auditHandlers.msgDelete(m); } catch(e){ eventLogger.error('MessageDelete 감사로그 실패', e.message); } });
discord.on(Events.GuildMemberUpdate, async (o,n) => { 
  try { await auditHandlers.nickChange(o,n); } catch(e){ eventLogger.error('GuildMemberUpdate NickChange 감사로그 실패', e.message); } 
  try { await auditHandlers.roleChange(o,n); } catch(e){ eventLogger.error('GuildMemberUpdate RoleChange 감사로그 실패', e.message); } 
});

/* ══════════════════════════════════════════════════════════════
   §17. Graceful Shutdown (정상 종료 및 메모리 정리)
══════════════════════════════════════════════════════════════ */
async function graceful() {
  mainLogger.critical('종료 프로세스 시작 (SIGTERM/SIGINT 수신)');
  
  const shutdownTimeout = setTimeout(() => {
    mainLogger.fatal('강제 종료 (Graceful Shutdown 실패: 타임아웃)');
  }, CFG.SHUTDOWN_MS);
  shutdownTimeout.unref();

  try {
    mainLogger.info('웹 서버 종료 중...');
    await new Promise(r => server.close(r));
    mainLogger.info('웹 서버 종료 완료.');

    mainLogger.info('Discord 클라이언트 종료 중...');
    await discord.destroy(); 
    mainLogger.info('Discord 클라이언트 종료 완료.');

    mainLogger.info('영속화 데이터 저장 중...');
    await Promise.all(Object.keys(FILE).map(key => persist(key)));
    mainLogger.info('영속화 데이터 저장 완료.');

  } catch (e) {
    mainLogger.error('Graceful Shutdown 중 오류 발생', e.message);
  } finally {
    clearTimeout(shutdownTimeout);
    mainLogger.critical('프로세스 정상 종료.');
    process.exit(0);
  }
}

// Node.js 경고 메시지 로깅
process.on('warning', warning => {
  mainLogger.warn(`Node.js Warning: ${warning.name}`, warning.message);
  if (warning.stack) mainLogger.debug(warning.stack);
});

// Uncaught Exception 및 Unhandled Rejection 처리
process.on('uncaughtException', e => {
  mainLogger.fatal('Uncaught Exception', e.stack || e.message);
});
process.on('unhandledRejection', (reason, promise) => {
  mainLogger.fatal('Unhandled Rejection', `${reason?.stack || reason?.message || String(reason)} at ${promise}`);
});


process.once('SIGTERM', graceful);
process.once('SIGINT', graceful);

discord.login(ENV.DISCORD_TOKEN).catch(e => { mainLogger.fatal('Discord 로그인 실패', e.message); });