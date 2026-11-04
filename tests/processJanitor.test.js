/**
 * tests/processJanitor.test.js
 * Kiểm thử LUẬT của Process Janitor (hàm `analyze` thuần, không I/O, không kill thật).
 *
 * Trọng tâm là AN TOÀN: thà bỏ sót rác còn hơn kill nhầm agent đang chạy.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-janitor-db-'));
process.env.DB_PATH = path.join(TMP_DB_DIR, 'test-janitor.sqlite');

const janitor = require('../src/execution/processJanitor');
const db = require('../src/storage/db');

const MIN = 60 * 1000;

function proc(pid, ppid, name, cmd, ageMinutes, cpu = 0) {
  return { pid, ppid, name, cmd, ageMs: ageMinutes * MIN, cpu, cpuDeltaSec: 0 };
}

const baseOpts = { graceMinutes: 10, idleAgentTrees: false, idleAgentHours: 6 };

describe('processJanitor.analyze - an toàn là trên hết', () => {
  test('worker và toàn bộ con cháu KHÔNG BAO GIỜ bị coi là rác', () => {
    const procs = [
      proc(500, 1, 'node.exe', 'node src/index.js', 60),
      proc(501, 500, 'cmd.exe', 'cmd /c claude.exe -p ...', 60),
      // agent tự dựng vite trong worktree của job đang chạy
      proc(502, 501, 'node.exe', 'node .../vite/bin/vite.js --port 3011 --strictPort', 30)
    ];
    const listeners = [{ port: 3011, pid: 502 }];
    const res = janitor.analyze({ procs, listeners, leases: [], jobs: [], selfPid: 500, opts: baseOpts });
    assert.deepEqual(res.candidates, []);
    const guardedPids = res.protectedList.map((p) => p.pid);
    assert.ok(guardedPids.includes(500), 'worker phải được bảo vệ');
    assert.ok(guardedPids.includes(501), 'con của worker phải được bảo vệ');
    assert.ok(guardedPids.includes(502), 'cháu của worker phải được bảo vệ');
  });

  test('service đang giữ port lease còn hiệu lực thì không đụng tới', () => {
    const procs = [proc(600, 1, 'node.exe', 'vite --port 3015 --strictPort', 60)];
    const res = janitor.analyze({
      procs,
      listeners: [{ port: 3015, pid: 600 }],
      leases: [{ service_key: 'fe', port: 3015, job_id: 'j1' }],
      jobs: [],
      selfPid: 5000,
      opts: baseOpts
    });
    assert.deepEqual(res.candidates, []);
    assert.ok(res.protectedList.some((p) => p.pid === 600 && /lease/.test(p.reason)));
  });

  test('tiến trình trong worktree của job ĐANG CHẠY được bảo vệ', () => {
    const procs = [
      proc(700, 1, 'node.exe', 'node D:\\repo\\fe\\.worktrees\\PHUB-679\\node_modules\\vite\\bin\\vite.js --port 3015', 60)
    ];
    const res = janitor.analyze({
      procs,
      listeners: [{ port: 3015, pid: 700 }],
      leases: [],
      jobs: [{ task_code: 'PHUB-679', status: 'FIXING', worktree_path: 'D:\\repo\\fe\\.worktrees\\PHUB-679' }],
      selfPid: 5000,
      opts: baseOpts
    });
    assert.deepEqual(res.candidates, []);
    assert.ok(res.protectedList.some((p) => p.pid === 700 && /worktree/.test(p.reason)));
  });

  test('so khớp worktree theo ĐOẠN đường dẫn (PHUB-67 không khớp PHUB-679)', () => {
    assert.equal(janitor.isInsidePath('D:\\repo\\fe\\.worktrees\\PHUB-679\\x', 'D:\\repo\\fe\\.worktrees\\PHUB-67'), false);
    assert.equal(janitor.isInsidePath('D:\\repo\\fe\\.worktrees\\PHUB-679\\x', 'D:\\repo\\fe\\.worktrees\\PHUB-679'), true);
    assert.equal(janitor.isInsidePath('d:/repo/FE/.worktrees/phub-679/x', 'D:\\repo\\fe\\.worktrees\\PHUB-679'), true);
  });
});

describe('processJanitor.analyze - phát hiện rác', () => {
  test('LUẬT A: service chiếm cổng trong pool worker mà không có lease', () => {
    const procs = [
      proc(800, 999999, 'node.exe', 'node node_modules/vite/bin/vite.js --port 3011 --strictPort', 300),
      proc(801, 999999, 'nohup.exe', 'node node_modules/.bin/../vite/bin/vite.js --port 3011', 300)
    ];
    const res = janitor.analyze({
      procs,
      listeners: [{ port: 3011, pid: 800 }],
      leases: [],
      jobs: [],
      selfPid: 5000,
      opts: baseOpts
    });
    assert.equal(res.candidates.length, 1, 'cả cây chỉ được sinh 1 ứng viên (khử trùng theo gốc)');
    assert.equal(res.candidates[0].port, 3011);
    assert.match(res.candidates[0].reason, /KHÔNG có port lease/);
  });

  test('KHÔNG đụng dev server người dùng tự chạy ngoài pool, ngoài worktree', () => {
    // Cổng 3100 không thuộc pool 3010-3019/8081-8089 và cmdline không nhắc worktree nào.
    const procs = [proc(820, 999999, 'node.exe', 'node node_modules/vite/bin/vite.js --port 3100', 300)];
    const res = janitor.analyze({
      procs, listeners: [{ port: 3100, pid: 820 }], leases: [], jobs: [], selfPid: 5000, opts: baseOpts
    });
    assert.deepEqual(res.candidates, []);
  });

  test('tiến trình trong worktree đã biết nhưng job đang PENDING vẫn bị dọn (worker đã nhả port)', () => {
    const procs = [proc(830, 999999, 'node.exe', 'node D:\\repo\\fe\\.worktrees\\PHUB-679\\node_modules\\vite\\bin\\vite.js --port 3012', 300)];
    const res = janitor.analyze({
      procs,
      listeners: [{ port: 3012, pid: 830 }],
      leases: [],
      jobs: [{ task_code: 'PHUB-679', status: 'PENDING', worktree_path: 'D:\\repo\\fe\\.worktrees\\PHUB-679' }],
      selfPid: 5000,
      opts: baseOpts
    });
    assert.equal(res.candidates.length, 1);
  });

  test('dev server còn trẻ (dưới grace) thì bỏ qua, tránh đụng job vừa khởi động', () => {
    const procs = [proc(810, 1, 'node.exe', 'vite --port 3101', 2)];
    const res = janitor.analyze({
      procs, listeners: [{ port: 3101, pid: 810 }], leases: [], jobs: [], selfPid: 5000, opts: baseOpts
    });
    assert.deepEqual(res.candidates, []);
  });

  test('LUẬT B: service còn sót trong worktree của job đã DONE', () => {
    const procs = [
      proc(900, 1, 'java.exe', 'java -jar target/app.jar --server.port=8083', 120)
    ];
    const res = janitor.analyze({
      procs,
      listeners: [],
      leases: [],
      jobs: [{ task_code: 'PHUB-681', status: 'DONE', worktree_path: 'D:\\repo\\be\\.worktrees\\PHUB-681' }],
      selfPid: 5000,
      opts: baseOpts
    });
    assert.equal(res.candidates.length, 0, 'cmdline không chứa worktree nên không khớp luật B');

    const procs2 = [
      proc(901, 1, 'java.exe', 'java -jar D:\\repo\\be\\.worktrees\\PHUB-681\\target\\app.jar --server.port=8083', 120)
    ];
    const res2 = janitor.analyze({
      procs: procs2,
      listeners: [],
      leases: [],
      jobs: [{ task_code: 'PHUB-681', status: 'DONE', worktree_path: 'D:\\repo\\be\\.worktrees\\PHUB-681' }],
      selfPid: 5000,
      opts: baseOpts
    });
    assert.equal(res2.candidates.length, 1);
    assert.match(res2.candidates[0].reason, /PHUB-681/);
  });

  test('gốc cây được chọn là tiến trình bao ngoài (sh -> mvn -> java) để kill cả cây', () => {
    const procs = [
      proc(1000, 1, 'sh.exe', './mvnw spring-boot:run -Dspring-boot.run.profiles=dev', 1440),
      proc(1001, 1000, 'java.exe', 'java -classpath maven-wrapper.jar MavenWrapperMain spring-boot:run', 1439),
      proc(1002, 1001, 'java.exe', 'java -cp @argfile App --spring.profiles.active=dev', 1438)
    ];
    const res = janitor.analyze({
      procs,
      listeners: [{ port: 8081, pid: 1002 }],
      leases: [],
      jobs: [],
      selfPid: 5000,
      opts: baseOpts
    });
    assert.equal(res.candidates.length, 1);
    assert.equal(res.candidates[0].rootPid, 1000, 'phải kill từ gốc sh để không sót mvn/java');
    assert.equal(res.candidates[0].pid, 1002, 'vẫn ghi lại pid phát hiện được để audit');
  });

  test('tiến trình hệ thống / IDE không bao giờ là ứng viên', () => {
    const procs = [
      proc(1100, 1, 'explorer.exe', 'C:\\Windows\\explorer.exe', 9999),
      proc(1101, 1, 'Code.exe', 'code D:\\repo\\fe\\.worktrees\\PHUB-681', 9999),
      proc(1102, 1, 'services.exe', 'C:\\Windows\\system32\\services.exe', 9999)
    ];
    const res = janitor.analyze({
      procs, listeners: [], leases: [],
      jobs: [{ task_code: 'PHUB-681', status: 'DONE', worktree_path: 'D:\\repo\\fe\\.worktrees\\PHUB-681' }],
      selfPid: 5000, opts: baseOpts
    });
    assert.deepEqual(res.candidates, []);
  });

  test('LUẬT C mặc định TẮT: cây agent CLI bỏ hoang không bị kill', () => {
    const procs = [proc(1200, 1, 'node.exe', 'node D:\\mcp-servers\\x\\mcp-server-full.mjs', 3000)];
    const res = janitor.analyze({ procs, listeners: [], leases: [], jobs: [], selfPid: 5000, opts: baseOpts });
    assert.deepEqual(res.candidates, []);
  });

  test('LUẬT C khi bật: chỉ kill cây agent đã idle (không tiêu CPU)', () => {
    const idle = [proc(1300, 1, 'omp.exe', 'omp.exe --extension x', 3000)];
    const busy = [proc(1310, 1, 'omp.exe', 'omp.exe --extension y', 3000)];
    busy[0].cpuDeltaSec = 1.5;
    const opts = { ...baseOpts, idleAgentTrees: true, idleAgentHours: 6 };

    const resIdle = janitor.analyze({ procs: idle, listeners: [], leases: [], jobs: [], selfPid: 5000, opts });
    assert.equal(resIdle.candidates.length, 1);

    const resBusy = janitor.analyze({ procs: busy, listeners: [], leases: [], jobs: [], selfPid: 5000, opts });
    assert.deepEqual(resBusy.candidates, []);
  });

  test('không có tiến trình nào thì trả về rỗng, không lỗi', () => {
    const res = janitor.analyze({ procs: [], listeners: [], leases: [], jobs: [], selfPid: 5000, opts: baseOpts });
    assert.deepEqual(res.candidates, []);
    assert.equal(res.scanned, 0);
  });
});

describe('processJanitor - lưu lịch sử chạy vào DB', () => {
  before(() => db.initDb());
  after(() => {
    try { fs.rmSync(TMP_DB_DIR, { recursive: true, force: true }); } catch (e) {}
  });

  test('tạo / hoàn tất / đọc lại bản ghi janitor_run', () => {
    const id = 'janitor-test-1';
    db.createJanitorRun({ id, started_at: new Date().toISOString(), trigger: 'manual' });
    db.finishJanitorRun(id, {
      finished_at: new Date().toISOString(),
      duration_ms: 123,
      scanned: 40,
      killed: 2,
      protected_count: 12,
      freed_ports: [8081, 8082],
      report: { killed_list: [{ pid: 1, reason: 'x' }] },
      log: ['[SCAN] 40 tien trinh', '[KILL] pid=1']
    });
    const run = db.getJanitorRun(id);
    assert.equal(run.killed, 2);
    assert.equal(run.scanned, 40);
    assert.deepEqual(run.freed_ports, [8081, 8082]);
    assert.equal(run.log.length, 2);
    assert.equal(run.report.killed_list[0].pid, 1);

    const list = db.listJanitorRuns(10);
    assert.ok(list.some((r) => r.id === id));
  });

  test('pruneJanitorRuns chỉ giữ N bản ghi mới nhất', () => {
    for (let i = 0; i < 15; i += 1) {
      db.createJanitorRun({
        id: `janitor-prune-${i}`,
        started_at: new Date(Date.now() + i * 1000).toISOString(),
        trigger: 'auto'
      });
    }
    const removed = db.pruneJanitorRuns(10);
    assert.ok(removed > 0, 'phải xoá bớt bản ghi cũ');
    assert.ok(db.listJanitorRuns(100).length <= 12, 'số bản ghi còn lại phải quanh ngưỡng giữ');
  });
});
