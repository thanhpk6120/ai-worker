/**
 * tests/apiEvidenceShape.test.js
 * Bảo vệ [API-EVIDENCE-RECORDS]: bằng chứng API dạng MẢNG bản ghi thật
 * (`{ baseUrl, results: [{method,url,responseStatus,responseBody}] }`) phải được
 * công nhận là API runtime.
 *
 * Vì sao: gate cũ chỉ soi key cố định ở cấp cao nhất (`endpointsChecked`) nên chấm
 * sai file đúng của PHUB-682 suốt 3 vòng FIXING (~1 giờ). File đó có 9/9 lệnh gọi
 * API thật với status 200 và response body thật.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { apiEvidenceHasRuntimeRecords } = require('../src/server');

describe('apiEvidenceHasRuntimeRecords - công nhận mảng bản ghi HTTP thật', () => {
  test('cấu trúc thật của PHUB-682: results[] có method+url+responseStatus+responseBody', () => {
    const doc = {
      capturedAt: '2026-11-04T15:47:18.040Z',
      baseUrl: 'http://localhost:8081',
      total: 9,
      matched: 9,
      failed: [],
      results: [
        {
          name: 'api_test_1_dashboard_metrics',
          method: 'GET',
          url: 'http://localhost:8081/api/be/admin/dashboard/metrics',
          expectedStatus: 200,
          responseStatus: 200,
          matched: true,
          requestBody: null,
          responseBody: { status: 200, code: 'SUCCESS', body: { summary: { totalPartners: 4 } } }
        }
      ]
    };
    assert.equal(apiEvidenceHasRuntimeRecords(doc), true);
  });

  test('mảng bản ghi ở cấp cao nhất (không bọc object) cũng được', () => {
    const doc = [
      { method: 'POST', url: 'http://localhost:3010/api/be/qr', status: 200, response: { ok: true } }
    ];
    assert.equal(apiEvidenceHasRuntimeRecords(doc), true);
  });

  test('endpointsChecked[] vẫn được hỗ trợ (tương thích cũ)', () => {
    const doc = { endpointsChecked: [{ endpoint: '/api/be/x', method: 'GET', statusCode: 200, body: { a: 1 } }] };
    assert.equal(apiEvidenceHasRuntimeRecords(doc), true);
  });

  test('object phẳng có đủ 4 thành phần vẫn được', () => {
    assert.equal(
      apiEvidenceHasRuntimeRecords({ method: 'GET', url: 'http://localhost:8081/api/be/x', status: 200, response: { ok: true } }),
      true
    );
  });

  test('bản ghi thiếu status hoặc body thì KHÔNG được công nhận', () => {
    assert.equal(apiEvidenceHasRuntimeRecords({ results: [{ method: 'GET', url: 'http://localhost:8081/a' }] }), false);
    assert.equal(apiEvidenceHasRuntimeRecords({ results: [{ method: 'GET', url: '/a', status: 200 }] }), false);
  });

  test('build log / dữ liệu rỗng / null không được công nhận', () => {
    assert.equal(apiEvidenceHasRuntimeRecords(null), false);
    assert.equal(apiEvidenceHasRuntimeRecords({}), false);
    assert.equal(apiEvidenceHasRuntimeRecords({ log: 'npm run build && vite build' }), false);
    assert.equal(apiEvidenceHasRuntimeRecords({ results: [] }), false);
  });

  test('request lồng trong record vẫn nhận method/url', () => {
    const doc = {
      calls: [{ request: { method: 'PATCH', url: 'http://localhost:8081/api/be/u/1' }, response: { status: 200, body: { ok: 1 } } }]
    };
    assert.equal(apiEvidenceHasRuntimeRecords(doc), true);
  });
});
