const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyTaskEvidence } = require('../src/server');

describe('Runtime Evidence Gate (build log vs runtime log)', () => {
  let fdir; let edir;
  beforeEach(() => {
    fdir = fss.mkdtempSync(path.join(os.tmpdir(), 'feature-runtime-'));
    edir = path.join(fdir, 'evidence');
    fss.mkdirSync(edir, { recursive: true });
    fss.writeFileSync(path.join(fdir, 'test_plan.md'), '# Test Plan\n## TC-API-01: API nghiep vu\n');
  });
  afterEach(() => { try { fss.rmSync(fdir, { recursive: true, force: true }); } catch (e) {} });
  const meta = (tests) => ({ taskCode: 'RT-01', verdict: 'PASSED', tests });
  it('1. API json chi la build log -> FAIL', () => {
    fss.writeFileSync(path.join(edir, '02_api_verification.json'), JSON.stringify({ log: 'npm install done, building vite compiled successfully' }));
    fss.writeFileSync(path.join(edir, '01_test_execution.log'), 'npm run build\nbuilding... vite compiled successfully\n');
    fss.writeFileSync(path.join(edir, 'metadata.json'), JSON.stringify(meta([{ id: 'TC-API-01', name: 'API', status: 'PASSED', evidence: ['02_api_verification.json'], note: 'build ok' }])));
    const r = verifyTaskEvidence({ jobId: 'rt-build-only', evidenceDir: edir, featureDir: fdir, taskCode: 'RT-01', emit: () => {} });
    assert.strictEqual(r.failed, true);
  });
  it('2. Co API nhung log chi build, thieu runtime service -> FAIL', () => {
    fss.writeFileSync(path.join(edir, '02_api_verification.json'), JSON.stringify({ method: 'GET', url: 'http://localhost:8080/api/v1/orders', responseStatus: 200, body: [{ id: 1 }] }));
    fss.writeFileSync(path.join(edir, '01_test_execution.log'), 'npm test passed 5 tests\n');
    fss.writeFileSync(path.join(edir, 'metadata.json'), JSON.stringify(meta([{ id: 'TC-API-01', name: 'API', status: 'PASSED', evidence: ['02_api_verification.json', '01_test_execution.log'], note: 'API 200' }])));
    const r = verifyTaskEvidence({ jobId: 'rt-no-runtime', evidenceDir: edir, featureDir: fdir, taskCode: 'RT-01', emit: () => {} });
    assert.strictEqual(r.failed, true);
  });
  it('3. Du API nghiep vu + runtime log service -> PASS', () => {
    fss.writeFileSync(path.join(edir, '02_api_verification.json'), JSON.stringify({ method: 'GET', url: 'http://localhost:8080/api/v1/orders', responseStatus: 200, body: [{ id: 1 }] }));
    fss.writeFileSync(path.join(edir, '05_service_runtime.log'), 'Server listening on port 8080\nGET /api/v1/orders 200 OK 8ms\nrequest received response sent status 200\n');
    fss.writeFileSync(path.join(edir, 'metadata.json'), JSON.stringify(meta([{ id: 'TC-API-01', name: 'API', status: 'PASSED', evidence: ['02_api_verification.json', '05_service_runtime.log'], note: 'service running, API 200' }])));
    const r = verifyTaskEvidence({ jobId: 'rt-ok', evidenceDir: edir, featureDir: fdir, taskCode: 'RT-01', emit: () => {} });
    assert.strictEqual(r.failed, false);
  });
  it('4. API json co UTF-8 BOM + nested test cases -> PASS khi runtime log hop le', () => {
    const bomPayload = '\uFEFF' + JSON.stringify({
      baseUrl: 'http://localhost:6012',
      login: { endpoint: 'POST /api/authenticate', httpStatus: 200 },
      tc15_hub_list: { httpStatus: 200, httpMethodValue: 'POST', itemCount: 10 }
    });
    fss.writeFileSync(path.join(edir, '02_api_verification.json'), bomPayload, 'utf8');
    fss.writeFileSync(path.join(edir, '05_service_runtime.log'), 'Server listening on port 6012\nPOST /api/authenticate 200 OK\nGET /api/recon/hub 200 OK\n');
    fss.writeFileSync(path.join(edir, 'metadata.json'), '\uFEFF' + JSON.stringify(meta([{ id: 'TC-API-01', name: 'API', status: 'PASSED', evidence: ['02_api_verification.json', '05_service_runtime.log'], note: 'API 200' }])));
    const r = verifyTaskEvidence({ jobId: 'rt-bom-nested-ok', evidenceDir: edir, featureDir: fdir, taskCode: 'RT-01', emit: () => {} });
    assert.strictEqual(r.failed, false, 'Phai parse duoc file co UTF-8 BOM va nested testcase');
  });
  it('5. API json kieu api_tc15_hub_list (httpStatus, firstItem, itemCount) co BOM -> PASS', () => {
    const tcPayload = '\uFEFF' + JSON.stringify({
      method: 'GET',
      url: 'http://localhost:6012/api/recon/hub?page=0&size=10',
      httpStatus: 200,
      itemCount: 10,
      firstItem: { id: 1, httpMethod: 'POST' }
    });
    fss.writeFileSync(path.join(edir, 'api_tc15_hub_list.json'), tcPayload, 'utf8');
    fss.writeFileSync(path.join(edir, '05_service_runtime.log'), 'Server listening on port 6012\nGET /api/recon/hub 200 OK\n');
    fss.writeFileSync(path.join(edir, 'metadata.json'), JSON.stringify(meta([{ id: 'TC-API-01', name: 'API', status: 'PASSED', evidence: ['api_tc15_hub_list.json', '05_service_runtime.log'], note: 'API 200' }])));
    const r = verifyTaskEvidence({ jobId: 'rt-tc15-ok', evidenceDir: edir, featureDir: fdir, taskCode: 'RT-01', emit: () => {} });
    assert.strictEqual(r.failed, false, 'Phai chap nhan httpStatus + firstItem + itemCount');
  });
  it('6. API json co mang cases chua method, endpoint, responseStatus, responseBody -> PASS khi runtime log hop le', () => {
    const casesPayload = JSON.stringify({
      testSuite: 'API_VERIFICATION_EVIDENCE',
      baseUrl: 'http://localhost:6012',
      cases: [
        {
          testId: 'TC-01',
          method: 'PUT',
          endpoint: '/api/v1/jobs/test-1',
          responseStatus: 200,
          responseBody: { success: true }
        }
      ]
    });
    fss.writeFileSync(path.join(edir, '02_api_verification.json'), casesPayload, 'utf8');
    fss.writeFileSync(path.join(edir, '05_service_runtime.log'), 'Server listening on port 6012\nPUT /api/v1/jobs/test-1 200 OK\n');
    fss.writeFileSync(path.join(edir, 'metadata.json'), JSON.stringify(meta([{ id: 'TC-API-01', name: 'API', status: 'PASSED', evidence: ['02_api_verification.json', '05_service_runtime.log'], note: 'API 200' }])));
    const r = verifyTaskEvidence({ jobId: 'rt-cases-array-ok', evidenceDir: edir, featureDir: fdir, taskCode: 'RT-01', emit: () => {} });
    assert.strictEqual(r.failed, false, 'Phai chap nhan cau truc mang cases voi method va responseStatus');
  });
});
