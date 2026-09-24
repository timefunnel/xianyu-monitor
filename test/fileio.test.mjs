// writeFileAtomic：正常磁盘走原子替换；目标是 bind mount 的单个文件时退化。
//
// 这条路径是实测踩出来的：容器里把 config.json 单文件挂进去之后，控制台保存配置会报
// `EBUSY: resource busy or locked, rename '/app/config.json.tmp' -> '/app/config.json'`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../src/fileio.mjs';

const makeDir = () => mkdtempSync(path.join(tmpdir(), 'xianyu-fileio-'));

test('正常路径：原子替换，且不留临时文件', () => {
  const dir = makeDir();
  const file = path.join(dir, 'config.json');
  const result = writeFileAtomic(file, '{"a":1}\n');
  assert.equal(result.atomic, true);
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n');
  assert.deepEqual(readdirSync(dir), ['config.json'], '不该留下 .tmp');
});

test('rename 遇到挂载点（EBUSY）时退化为直接写入，内容正确且清掉临时文件', () => {
  const dir = makeDir();
  const file = path.join(dir, 'config.json');
  const warnings = [];
  const busy = () => {
    const error = new Error("EBUSY: resource busy or locked, rename '/app/config.json.tmp' -> '/app/config.json'");
    error.code = 'EBUSY';
    throw error;
  };

  const result = writeFileAtomic(file, '{"b":2}\n', {
    renameImpl: busy,
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(result.atomic, false, '应该报告退化成了非原子写');
  assert.equal(readFileSync(file, 'utf8'), '{"b":2}\n');
  assert.deepEqual(readdirSync(dir), ['config.json'], '临时文件要清掉');
  assert.equal(warnings.length, 1, '要留一条告警，说明为什么退化了');
  assert.match(warnings[0], /bind mount|挂载/);
});

test('退化后仍然只读（:ro 挂载）时给出能直接照做的提示', () => {
  const dir = makeDir();
  const file = path.join(dir, 'config.json');
  const busy = () => {
    const error = new Error('EBUSY');
    error.code = 'EBUSY';
    throw error;
  };
  // 只让**目标文件**写不进去（临时文件所在的目录是可写的），这才是 :ro 挂载的真实形态
  const readOnlyTarget = (target, ...rest) => {
    if (target === file) {
      const error = new Error('EROFS: read-only file system');
      error.code = 'EROFS';
      throw error;
    }
    return writeFileSync(target, ...rest);
  };

  assert.throws(
    () => writeFileAtomic(file, '{}', { renameImpl: busy, writeImpl: readOnlyTarget }),
    /不可写（EROFS）.*:ro.*chown/s,
  );
});

test('连临时文件都写不进去（目录只读）时给同样的提示', () => {
  const dir = makeDir();
  const file = path.join(dir, 'config.json');
  const readOnly = () => {
    const error = new Error('EROFS: read-only file system');
    error.code = 'EROFS';
    throw error;
  };
  assert.throws(() => writeFileAtomic(file, '{}', { writeImpl: readOnly }), /不可写（EROFS）.*:ro/);
});

test('别的错误照常抛出，不被这段容错吞掉', () => {
  const dir = makeDir();
  const file = path.join(dir, 'config.json');
  const weird = () => {
    const error = new Error('ENOSPC: no space left on device');
    error.code = 'ENOSPC';
    throw error;
  };
  assert.throws(() => writeFileAtomic(file, '{}', { renameImpl: weird }), /ENOSPC/);
  assert.equal(existsSync(file), false, '失败时不该写坏目标文件');
});
