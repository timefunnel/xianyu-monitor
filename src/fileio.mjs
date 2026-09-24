/**
 * 文件写入的小工具。
 *
 * 存在的理由（实测踩到的坑）：配置文件的保存原来是「写 `config.json.tmp` 再 rename 覆盖」，
 * 这在正常磁盘上没问题，但**容器里把单个文件 bind mount 进来**时（`./config.json:/app/config.json`）
 * 挂载点**无法被 rename 覆盖**——内核直接返回 `EBUSY`。于是控制台里改配置、切任务全部失败，
 * 而且报出来的是 `EBUSY: resource busy or locked, rename ...`，跟"配置有问题"毫无关系。
 *
 * 所以这里在 rename 失败时退化成**直接写入**：牺牲"原子替换"换取"能改配置"。
 * 想保留原子性就把**目录**挂进去（`./conf:/app/conf`），而不是挂单个文件。
 */

import { renameSync, rmSync, writeFileSync } from 'node:fs';

/** rename 覆盖挂载点时内核可能返回的错误码。 */
const MOUNT_POINT_ERRORS = new Set(['EBUSY', 'EXDEV', 'EPERM']);

/** 把「写不进去」翻译成能直接照做的提示。只读挂载/属主不对是最常见的两种。 */
function describeWriteError(error, file) {
  if (error.code === 'EROFS' || error.code === 'EACCES') {
    return new Error(
      `${file} 不可写（${error.code}）：它多半是只读挂载（:ro）或属主不是容器内运行的用户。` +
        '容器部署时去掉 :ro，并把属主改成容器用户（例如 chown 1000:1000）。',
    );
  }
  return error;
}

/**
 * 原子写文件；目标是挂载点时退化为直接写。
 *
 * @param {string} file 目标路径。
 * @param {string} content 完整内容。
 * @param {{renameImpl?: typeof renameSync, writeImpl?: typeof writeFileSync, rmImpl?: typeof rmSync, logger?: any}} [options] 依赖注入（测试用）。
 * @returns {{atomic: boolean}} `atomic` 为 false 表示退化成了直接写。
 */
export function writeFileAtomic(file, content, { renameImpl = renameSync, writeImpl = writeFileSync, rmImpl = rmSync, logger } = {}) {
  const temp = `${file}.tmp`;
  try {
    writeImpl(temp, content, 'utf8');
  } catch (error) {
    // 连临时文件都写不进去（目录只读、属主不对），同样给出可照做的提示。
    throw describeWriteError(error, file);
  }

  try {
    renameImpl(temp, file);
    return { atomic: true };
  } catch (error) {
    if (!MOUNT_POINT_ERRORS.has(error.code)) {
      rmImpl(temp, { force: true });
      throw error;
    }
  }

  try {
    writeImpl(file, content, 'utf8');
  } catch (error) {
    rmImpl(temp, { force: true });
    throw describeWriteError(error, file);
  }

  rmImpl(temp, { force: true });
  logger?.warn?.(
    `${file} 是 bind mount 进来的单个文件，无法原子替换，已退化为直接写入；想保留原子性请改挂载目录`,
    'web',
  );
  return { atomic: false };
}
