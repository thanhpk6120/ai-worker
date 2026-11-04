/**
 * tests/portContractMarker.test.js
 * Bảo vệ [PORT-CONTRACT]: worker chỉ được nói với agent là đã ghi
 * `__aiworker_build.json` khi marker THẬT SỰ tồn tại.
 *
 * Vì sao cần: `bankhub-admin-fe` không có thư mục `public/` và `bankhub-admin-be`
 * không có `src/main/resources/static`, nên `writeBuildMarker()` luôn trả
 * `NO_STATIC_DIR`. Trước đây prompt vẫn khẳng định "Worker đã ghi file..." khiến
 * agent lùng file ma hơn 20 phút mỗi vòng (PHUB-679 mất 9 tool call chỉ để tìm),
 * cạn token rồi bị provider trả 429 và job FAILED.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildPortContract } = require('../src/execution/portLeaseManager');

describe('buildPortContract - hợp đồng port phải trung thực về build marker', () => {
  const ports = { 'bankhub-admin-fe': 3015, 'bankhub-admin-be': 8083 };

  test('không cấp port nào thì không sinh contract', () => {
    assert.equal(buildPortContract({}), '');
    assert.equal(buildPortContract(null), '');
  });

  test('marker ĐÃ ghi thì contract có nhắc __aiworker_build.json', () => {
    const text = buildPortContract(ports, { markerWritten: true });
    assert.match(text, /__aiworker_build\.json/);
    assert.match(text, /GET \/__aiworker_build\.json/);
    assert.doesNotMatch(text, /KHÔNG ghi/);
  });

  test('marker KHÔNG ghi được thì contract cấm agent đi tìm file', () => {
    const text = buildPortContract(ports, { markerWritten: false });
    assert.match(text, /KHÔNG ghi/);
    assert.match(text, /TUYỆT ĐỐI KHÔNG tìm/);
    // Không được hứa hão là worker đã ghi file.
    assert.doesNotMatch(text, /Worker đã ghi file/);
    assert.doesNotMatch(text, /GET \/__aiworker_build\.json/);
  });

  test('mặc định (không truyền options) = chưa có marker, không hứa hão', () => {
    const text = buildPortContract(ports);
    assert.match(text, /KHÔNG ghi/);
    assert.doesNotMatch(text, /Worker đã ghi file/);
  });

  test('luôn giữ nguyên danh sách port và luật restart service', () => {
    for (const markerWritten of [true, false]) {
      const text = buildPortContract(ports, { markerWritten });
      assert.match(text, /bankhub-admin-fe: \*\*3015\*\*/);
      assert.match(text, /bankhub-admin-be: \*\*8083\*\*/);
      assert.match(text, /BẮT BUỘC RESTART SERVICE/);
      assert.match(text, /AIWORKER_PORT_MAP/);
    }
  });
});
