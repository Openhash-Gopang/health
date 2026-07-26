/**
 * k-health-privacy-utils.js — 소규모 셀 억제 · 교차검증 유틸리티 v1.0
 * 설계 문서: docs/K_HEALTH_PUBLIC_HEALTH_DATA_SYSTEM_v1_0.md §3, §5
 *
 * 이 파일은 순수 함수만 담는다 — 어디서 실행되든(PDV 샌드박스 내부,
 * 집계 배치 워커, 혹은 로컬 테스트) 동일하게 동작해야 하므로 외부
 * 상태·네트워크 호출에 의존하지 않는다.
 *
 * 사용 방식: PDV_SANDBOX_EXECUTION_DESIGN_v1_0.md의 샌드박스 실행
 * 결과(등급형 출력)를 정책 통계로 집계하는 마지막 단계에서 이 함수들을
 * 거쳐야 한다 — 캡슐 API가 개별 실행 단위의 노출을 막아주는 것과
 * 별개로, 여러 실행을 모은 "집계 통계" 자체도 이 억제 규칙을 통과해야
 * 공개 가능하다.
 */

/* ════════════════════════════════════════════════════════════
   §3.1 최소 셀 크기 억제 + 통제된 반올림
   ════════════════════════════════════════════════════════════ */

/**
 * 교차 집계 셀(지역×질병군×연령대 등) 배열을 받아, 표본 수가 k 미만인
 * 셀을 억제하고 나머지는 roundTo 배수로 반올림한다.
 *
 * @param {Array<{key: string, count: number, parentKey?: string}>} cells
 *   - key: 셀을 식별하는 문자열(예: "제주시|호흡기|20-39")
 *   - count: 해당 셀의 표본 수(원본, 절대 외부에 그대로 노출하지 않음)
 *   - parentKey: 이 셀이 억제될 경우 롤업할 상위 셀의 key (예: "제주도|호흡기|20-39")
 * @param {object} opts
 *   - k: 최소 공개 셀 크기 (기본 5, §3.1)
 *   - roundTo: 통제된 반올림 단위 (기본 5, §3.2 — 차분 공격 방지)
 * @returns {Array<{key:string, status:'suppressed'|'published', value:number|null, rolledUpTo?:string}>}
 */
function suppressSmallCells(cells, opts = {}) {
  const k = opts.k ?? 5;
  const roundTo = opts.roundTo ?? 5;

  return cells.map(cell => {
    if (cell.count < k) {
      return {
        key: cell.key,
        status: 'suppressed',
        value: null,
        rolledUpTo: cell.parentKey || null,
        note: `표본 ${k}명 미만 — 비공개. 상위 지역 단위 통계를 참고하십시오.`,
      };
    }
    // 통제된 반올림: 정확한 원본 값이 아니라 roundTo 배수로만 공개해,
    // "상위 집계 - 나머지 셀 합"으로 억제된 셀을 역산하는 것을 막는다.
    const rounded = Math.round(cell.count / roundTo) * roundTo;
    return { key: cell.key, status: 'published', value: rounded };
  });
}

/**
 * 낙인 위험이 높은 질병군은 일반 임계값보다 높은 k를 적용한다.
 * 대상 목록은 정책 검토위원회 승인 없이 임의로 추가·삭제하지 않는다
 * (§3.3 — 이 배열 자체가 검토 대상 문서다).
 */
const STIGMA_SENSITIVE_DISEASE_GROUPS = [
  // 예시 — 실제 목록은 의료윤리·법률 자문을 거쳐 확정 전까지 비워둔다.
  // { code: 'F', name: '정신·행동 장애', k: 20 },
  // { code: 'A63', name: '성매개 감염', k: 20 },
];

function kFor(diseaseGroupCode, defaultK = 5) {
  const found = STIGMA_SENSITIVE_DISEASE_GROUPS.find(g => g.code === diseaseGroupCode);
  return found ? found.k : defaultK;
}

/* ════════════════════════════════════════════════════════════
   §3.4 시계열 조합 공격 방지
   ════════════════════════════════════════════════════════════ */

/**
 * 동일 셀이 이전 주기엔 억제(count < k)였다가 이번 주기에 공개
 * 전환되면, 그 차이 자체가 "지난 주기 값의 상한선"을 노출한다
 * (예: 이번 달 공개 10명, 지난달 억제(5명 미만) → 지난달이 정확히
 * 몇 명이었는지 좁혀짐). 직전 상태가 억제였던 셀은 한 주기 더
 * 억제해 이 추론을 어렵게 한다.
 *
 * @param {string} cellKey
 * @param {number} currentCount
 * @param {(key:string) => {wasSuppressed:boolean}} getPriorState — 이전 주기 상태 조회 함수(주입)
 * @param {object} opts — suppressSmallCells와 동일한 옵션
 */
function suppressWithHistoryGuard(cellKey, currentCount, getPriorState, opts = {}) {
  const k = opts.k ?? 5;
  const prior = getPriorState(cellKey);
  if (prior?.wasSuppressed && currentCount >= k) {
    return {
      key: cellKey, status: 'suppressed', value: null,
      note: '직전 주기 억제 이력으로 인해 이번 주기도 보수적으로 억제(연속 노출 방지). 다음 주기부터 재평가됩니다.',
    };
  }
  return suppressSmallCells([{ key: cellKey, count: currentCount }], opts)[0];
}

/* ════════════════════════════════════════════════════════════
   §5 교차 검증 — 자기보고 유병률 vs 실제 진단율
   ════════════════════════════════════════════════════════════ */

/**
 * 환자 PDV(자기보고)와 의료진 PDV(실제 진단) 집계를 비교해
 * "진료 접근성 격차 의심 지역"을 플래그한다.
 *
 * @param {object} region
 *   - key: 지역·질병군 식별자
 *   - patientReportedRate: 자기보고 유병률 [0,1] (이미 소규모 셀 억제 통과한 값)
 *   - providerDiagnosisRate: 실제 진단율 [0,1] (이미 소규모 셀 억제 통과한 값)
 *   - sampleSize: 두 소스 중 더 작은 표본 크기(보수적으로 선택)
 * @param {object} opts
 *   - gapThreshold: 격차 플래그 임계값(기본 0.15, §5 — 실측 데이터로 보정 필요한 잠정치)
 *   - minSampleK: 플래그를 발행하기 위한 최소 표본(기본 5)
 */
function flagAccessGap(region, opts = {}) {
  const gapThreshold = opts.gapThreshold ?? 0.15;
  const minSampleK = opts.minSampleK ?? 5;

  if (region.sampleSize < minSampleK) {
    return { key: region.key, flagged: false, reason: 'insufficient_sample' };
  }

  const gap = region.patientReportedRate - region.providerDiagnosisRate;
  if (gap > gapThreshold) {
    return {
      key: region.key,
      flagged: true,
      gapMagnitude: Math.round(gap * 100) / 100, // 대략적 크기만 — 정밀 소수점 노출 안 함
      interpretation: '자기보고 유병률이 실제 진단율보다 유의하게 높음 — 진료 접근성 격차 의심',
    };
  }
  return { key: region.key, flagged: false };
}

/* ════════════════════════════════════════════════════════════
   내보내기
   ════════════════════════════════════════════════════════════ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    suppressSmallCells,
    suppressWithHistoryGuard,
    flagAccessGap,
    kFor,
    STIGMA_SENSITIVE_DISEASE_GROUPS,
  };
}
if (typeof window !== 'undefined') {
  window.KHealthPrivacyUtils = {
    suppressSmallCells,
    suppressWithHistoryGuard,
    flagAccessGap,
    kFor,
    STIGMA_SENSITIVE_DISEASE_GROUPS,
  };
}
