/**
 * pdv.js — K-Health PDV 기록 모듈 v2.0
 * gopang-proxy /pdv/report 엔드포인트 연동
 * school/report.js 의 sendToPDV() 패턴 준수
 *
 * PDV 6하원칙:
 *   who   — 사용자 ipv6 (gopang-sso 세션)
 *   when  — 이벤트 발생 시각 + 기간
 *   where — health.gopang.net
 *   what  — 행위 요약
 *   how   — K-Health AI 건강 상담
 *   why   — 건강 관리 + 진료 연계
 */

const PROXY   = 'https://gopang-proxy.tensor-city.workers.dev';
const SVC_ID  = 'health';
const PDV_VER = '1.0';

// ── 세션에서 사용자 ipv6 추출 (subsystem-auth 기반) ────────
function _getUserIpv6() {
  return window._healthUser?.ipv6 || 'anonymous';
}

// ── 보고서 해시 (중복 방지) ──────────────────────────────
async function _hashReport(obj) {
  const buf = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(JSON.stringify(obj))
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── /pdv/report 전송 (school/report.js sendToPDV 동일 패턴) ──
async function _sendToPDV(reportPayload) {
  try {
    const res = await fetch(`${PROXY}/pdv/report`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ report: reportPayload }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `PDV HTTP ${res.status}`);
    }
    const ack = await res.json();
    console.info('[K-Health PDV] 기록 완료:', ack.pdv_entry);
    return ack;
  } catch(e) {
    console.warn('[K-Health PDV] 전송 실패 (로컬 백업):', e.message);
    _localBackup(reportPayload);
    return null;
  }
}

// ── 로컬 백업 (전송 실패 시) ──────────────────────────────
function _localBackup(payload) {
  try {
    const key  = 'khealth_pdv_pending';
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    list.push({ payload, failedAt: new Date().toISOString() });
    if (list.length > 100) list.splice(0, list.length - 100);
    localStorage.setItem(key, JSON.stringify(list));
  } catch {}
}

// ── 대기 중인 로컬 백업 재전송 ───────────────────────────
async function _flushPending() {
  try {
    const key  = 'khealth_pdv_pending';
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    if (!list.length) return;
    const failed = [];
    for (const item of list) {
      const ack = await _sendToPDV(item.payload);
      if (!ack) failed.push(item);
    }
    localStorage.setItem(key, JSON.stringify(failed));
  } catch {}
}

// ═══════════════════════════════════════════════════════════
// 공개 PDV API
// ═══════════════════════════════════════════════════════════

const PDV = {

  /**
   * AI 건강 상담 기록
   * @param {object} opts
   *   userMsg   — 사용자 메시지 (요약)
   *   aiMsg     — K-Health 응답 (요약)
   *   symptoms  — 증상 키워드 배열
   *   category  — 'consult'|'vitals'|'appointment'|'prescription'|'prognosis'
   */
  async writeConsult({ userMsg = '', aiMsg = '', symptoms = [], category = 'consult' } = {}) {
    const ipv6 = _getUserIpv6();
    const now  = new Date().toISOString();
    const id   = `RPT-health-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;

    const reportPayload = {
      svc:          SVC_ID,
      type:         `health_${category}`,
      id,
      content_hash: await _hashReport({ id, userMsg, aiMsg, symptoms, now }),

      who: {
        ipv6,
        role:       'patient',
        recipients: ['gopang-pdv'],
      },
      when: {
        generated_at: now,
        period_start: now,
        period_end:   now,
      },
      where: {
        svc_url: 'https://health.gopang.net',
        label:   'K-Health 건강 상담',
      },
      what: {
        summary:  userMsg.slice(0, 200) || `건강 ${category} 기록`,
        response: aiMsg.slice(0, 300),
        symptoms,
        category,
      },
      how:  { method: 'K-Health AI 건강 상담 + 증상 분석' },
      why:  { goal: '건강 관리 및 최적 진료 기관 연계', triggered: `health_${category}` },
    };

    return _sendToPDV(reportPayload);
  },

  /**
   * 생체 지표 측정 기록
   * @param {object} vitals — { temp, heartRate, bloodPressure, oxygen, bloodSugar }
   * @param {string} source — '보건소'|'스마트워치'|'수동 입력'
   */
  async writeVitals({ vitals = {}, source = '수동 입력' } = {}) {
    const ipv6 = _getUserIpv6();
    const now  = new Date().toISOString();
    const id   = `RPT-health-vitals-${Date.now()}`;

    const vitalsSummary = Object.entries(vitals)
      .map(([k, v]) => `${k}:${v}`).join(', ');

    const reportPayload = {
      svc:          SVC_ID,
      type:         'health_vitals',
      id,
      content_hash: await _hashReport({ id, vitals, source, now }),

      who:  { ipv6, role: 'patient', recipients: ['gopang-pdv'] },
      when: { generated_at: now, period_start: now, period_end: now },
      where: {
        svc_url: 'https://health.gopang.net',
        label:   source,
      },
      what: {
        summary: `생체 지표 측정: ${vitalsSummary}`,
        vitals,
        source,
      },
      how:  { method: `생체 측정 (${source})` },
      why:  { goal: '건강 상태 모니터링 및 이상 감지', triggered: 'health_vitals' },
    };

    return _sendToPDV(reportPayload);
  },

  /**
   * 진료 예약 기록
   * @param {object} opts — { facilityName, facilityType, datetime, purpose, aiSummary }
   */
  async writeAppointment({ facilityName = '', facilityType = '', datetime = '', purpose = '', aiSummary = '' } = {}) {
    const ipv6 = _getUserIpv6();
    const now  = new Date().toISOString();
    const id   = `RPT-health-appt-${Date.now()}`;

    const reportPayload = {
      svc:          SVC_ID,
      type:         'health_appointment',
      id,
      content_hash: await _hashReport({ id, facilityName, datetime, purpose, now }),

      who:  { ipv6, role: 'patient', recipients: ['gopang-pdv'] },
      when: {
        generated_at:  now,
        period_start:  datetime || now,
        period_end:    datetime || now,
      },
      where: {
        svc_url:       'https://health.gopang.net',
        label:         facilityName,
        facility_type: facilityType,
      },
      what: {
        summary:    `${facilityName} 진료 예약 — ${purpose}`,
        facility:   facilityName,
        purpose,
        ai_summary: aiSummary,
      },
      how:  { method: 'K-Health AI 진료 기관 추천 및 자동 예약' },
      why:  { goal: '최적 진료 기관 연계 및 사전 브리핑 전달', triggered: 'health_appointment' },
    };

    return _sendToPDV(reportPayload);
  },

  /**
   * 처방 기록 (사람 의사 처방 후)
   * @param {object} opts — { medications, prescribedBy, pharmacyName }
   */
  async writePrescription({ medications = [], prescribedBy = '', pharmacyName = '' } = {}) {
    const ipv6 = _getUserIpv6();
    const now  = new Date().toISOString();
    const id   = `RPT-health-rx-${Date.now()}`;

    const reportPayload = {
      svc:          SVC_ID,
      type:         'health_prescription',
      id,
      content_hash: await _hashReport({ id, medications, prescribedBy, now }),

      who:  { ipv6, role: 'patient', recipients: ['gopang-pdv'] },
      when: { generated_at: now, period_start: now, period_end: now },
      where: {
        svc_url: 'https://health.gopang.net',
        label:   prescribedBy,
      },
      what: {
        summary:     `처방: ${medications.map(m => m.name || m).join(', ')}`,
        medications,
        prescribed_by: prescribedBy,
        pharmacy:    pharmacyName,
      },
      how:  { method: '면허 의사 처방 → K-Health PDV 기록 → 약국 자동 전송' },
      why:  { goal: '처방 기록 보관 및 약국 사전 준비', triggered: 'health_prescription' },
    };

    return _sendToPDV(reportPayload);
  },

  /**
   * 예후 추적 기록
   * @param {object} opts — { appointmentId, status, notes, nextAction }
   */
  async writePrognosis({ appointmentId = '', status = '', notes = '', nextAction = '' } = {}) {
    const ipv6 = _getUserIpv6();
    const now  = new Date().toISOString();
    const id   = `RPT-health-prog-${Date.now()}`;

    const reportPayload = {
      svc:          SVC_ID,
      type:         'health_prognosis',
      id,
      content_hash: await _hashReport({ id, appointmentId, status, now }),

      who:  { ipv6, role: 'patient', recipients: ['gopang-pdv'] },
      when: { generated_at: now, period_start: now, period_end: now },
      where: { svc_url: 'https://health.gopang.net', label: 'K-Health 예후 추적' },
      what: {
        summary:        `예후 추적: ${status} — ${notes.slice(0, 100)}`,
        appointment_id: appointmentId,
        status,
        notes,
        next_action:    nextAction,
      },
      how:  { method: 'K-Health AI 예후 자동 추적 (1일·3일·1주)' },
      why:  { goal: '건강 회복 모니터링 및 치료 방향 갱신', triggered: 'health_prognosis' },
    };

    return _sendToPDV(reportPayload);
  },

  /** 대기 중인 오프라인 기록 재전송 */
  flushPending: _flushPending,
};

// 페이지 로드 시 미전송 기록 재시도
window.addEventListener('load', () => {
  setTimeout(_flushPending, 3000);
});

window.PDV = PDV;
export { PDV };
