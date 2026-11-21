/**
 * 产物基线（P1-1）：拍基线 / 读基线两个纯 IO 函数 + 落盘结构。
 *
 * 为什么单独一个模块：它只做「读一个 JSON、写一个 JSON」，与宿主无关；
 * 留在 `host.ts` 里会让 A6（入口层只减不增）继续膨胀。CHG-212 P4b 顺带搬出，逻辑零变化。
 */
import { existsSync, readFileSync } from 'node:fs'
import { writeTextAtomic } from '../fs/write-log.ts'
import type { ArtifactBaseline } from '../gates/artifact-freshness.ts'

/**
 * 拍基线时文件**还不存在**的哨兵指纹。
 *
 * 为什么需要它：产物通常由成员在本阶段**创建**，阶段起点上它并不存在。若按
 * `artifactBaseline` 的「读不到就不写键」处理，`artifactIsStale` 会把「本阶段新建的文件」
 * 判成陈旧（缺键 = 不可判 = 不认交付）——正常交付反而全被拒。
 * 哨兵与任何真实指纹（`size:mtimeMs`）都不相等，于是：后来出现 = 指纹变了 = 新鲜；
 * 一直没出现 = 当前读不到 = 陈旧。两种情形都判对。
 */
export const ABSENT_PATH_FINGERPRINT = 'absent'

/** 产物基线落盘结构（`.dsh-myteam/state/artifacts/<teamId>/<taskId>.json`） */
export interface ArtifactBaselineRecord {
  version: 1
  teamId: string
  taskId: string
  /** **首次**拍基线的时间（ISO）：重拍只补缺失键，这个时间不被覆盖 */
  capturedAt: string
  /** 路径 → 指纹（`size:mtimeMs`，或 `ABSENT_PATH_FINGERPRINT`） */
  baseline: ArtifactBaseline
}

/** 读产物基线记录（缺失 / 坏 JSON → undefined：调用方据此判「这个任务没拍过基线」） */
export function readArtifactBaselineRecord(filePath: string): ArtifactBaselineRecord | undefined {
  if (!existsSync(filePath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ArtifactBaselineRecord> | null
    if (!parsed || typeof parsed !== 'object' || !parsed.baseline || typeof parsed.baseline !== 'object') return undefined
    return {
      version: 1,
      teamId: String(parsed.teamId ?? ''),
      taskId: String(parsed.taskId ?? ''),
      capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : new Date(0).toISOString(),
      baseline: parsed.baseline as ArtifactBaseline,
    }
  } catch {
    // 坏记录当「没拍过」：宁可走兼容分支（有告警留痕），也不因为一条坏 JSON 让 archive 门炸掉
    return undefined
  }
}

/** 写产物基线记录（父目录自动创建；返回落盘路径） */
export function writeArtifactBaselineRecord(filePath: string, record: ArtifactBaselineRecord): string {
  writeTextAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`, { ensureParent: true })
  return filePath
}