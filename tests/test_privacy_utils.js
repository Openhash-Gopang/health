const {
  suppressSmallCells, suppressWithHistoryGuard, flagAccessGap
} = require('../k-health-privacy-utils.js');

let failures = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`); failures++; }
  else console.log(`OK: ${label}`);
}

// 1. 최소 셀 크기 미만은 억제되어야 함
const r1 = suppressSmallCells([{ key: 'A', count: 3 }], { k: 5 });
assertEq(r1[0].status, 'suppressed', '표본 3명(k=5) → 억제');
assertEq(r1[0].value, null, '억제된 셀은 value가 null');

// 2. 최소 셀 크기 이상은 공개 + 반올림
const r2 = suppressSmallCells([{ key: 'B', count: 23 }], { k: 5, roundTo: 5 });
assertEq(r2[0].status, 'published', '표본 23명(k=5) → 공개');
assertEq(r2[0].value, 25, '23 → 5의 배수로 반올림 시 25');

// 3. 경계값(정확히 k) — 공개되어야 함
const r3 = suppressSmallCells([{ key: 'C', count: 5 }], { k: 5 });
assertEq(r3[0].status, 'published', '표본 정확히 5명(k=5) → 공개(포함)');

// 4. 시계열 이력 가드 — 직전 억제였으면 이번에 조건 충족해도 계속 억제
const priorSuppressed = () => ({ wasSuppressed: true });
const r4 = suppressWithHistoryGuard('D', 8, priorSuppressed, { k: 5 });
assertEq(r4.status, 'suppressed', '직전 주기 억제 이력 있으면 이번 8명도 억제');

const priorNotSuppressed = () => ({ wasSuppressed: false });
const r5 = suppressWithHistoryGuard('E', 8, priorNotSuppressed, { k: 5, roundTo: 5 });
assertEq(r5.status, 'published', '직전 주기 정상 공개였으면 이번도 정상 로직');

// 5. 접근성 격차 플래그 — 표본 부족시 플래그 안함
const r6 = flagAccessGap({ key: 'F', patientReportedRate: 0.5, providerDiagnosisRate: 0.2, sampleSize: 3 }, { minSampleK: 5 });
assertEq(r6.flagged, false, '표본 3명(minSampleK=5 미만) → 플래그 안함');
assertEq(r6.reason, 'insufficient_sample', '사유는 표본부족');

// 6. 격차가 임계값 초과시 플래그
const r7 = flagAccessGap({ key: 'G', patientReportedRate: 0.5, providerDiagnosisRate: 0.2, sampleSize: 50 }, { gapThreshold: 0.15 });
assertEq(r7.flagged, true, '격차 0.3 > 임계값 0.15 → 플래그');

// 7. 격차가 임계값 이하면 플래그 안함
const r8 = flagAccessGap({ key: 'H', patientReportedRate: 0.25, providerDiagnosisRate: 0.2, sampleSize: 50 }, { gapThreshold: 0.15 });
assertEq(r8.flagged, false, '격차 0.05 <= 임계값 0.15 → 플래그 안함');

console.log(failures === 0 ? '\n✅ 전체 통과' : `\n❌ ${failures}건 실패`);
process.exit(failures === 0 ? 0 : 1);
